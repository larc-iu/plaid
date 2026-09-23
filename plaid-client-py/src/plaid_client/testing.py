"""Drive a ``BaseService`` REQUEST HANDLER end to end, with no server.

This is how to test a service you have written. A service's pure helpers are
easy to test on their own, but the handler is where the contract lives (what
it writes, what it refuses, when it takes the lock, what it reports and how
many times), and it is reached only through
``BaseService.handle_service_request`` -- the one funnel every failure and
every stop passes through. So a handler test drives that, on the thread the
server would, rather than calling ``process_request`` directly.

Three pieces::

    from plaid_client import testing

    service = testing.load_service(SERVICES / 'my_service.py')
    service.client = testing.FakeClient([a_document])
    helper = testing.run(service, {'document_id': 'd1'})

    assert helper.errors == []
    assert [kind for kind, _ in service.client.writes] == ['tokens.bulk_create']

``load_service`` imports the service by path, standing in for the heavy model
libraries it imports at module level. ``FakeClient`` is enough of a
``PlaidClient`` to answer a handler and record everything it is asked to do,
in order, modelling the two things a handler test must get right: a batch
ABORTS on an exception, and ``locked()`` releases however the block ends.
``Helper`` stands in for ``serve``'s ``ResponseHelper`` with its real
cancellation semantics: ``progress`` is a cancellation checkpoint, a real
``CancelScope`` is behind ``critical()``, and EVERY terminal report is
remembered, so a test can see a request reported twice.

It lives in the shipped package rather than beside the tests because a
test-only copy had no home either app could import from, and the two apps kept
byte-identical copies of it instead.
"""

import contextlib
import importlib.util
import itertools
import pathlib
import sys

from plaid_client.http import PlaidAPIError
from plaid_client.metadata_ops import apply_metadata_ops
from plaid_client.services import CancelScope, requester_message


def load_service(path, fake_modules=None):
    """Import a service module from its ``.py`` file.

    A service is a script, not an installed module, so a test names its path::

        SERVICES = pathlib.Path(__file__).resolve().parent.parent
        service = load_service(SERVICES / 'my_service.py')

    ``fake_modules`` stands in for the heavy model libraries a service imports
    at module level (whisper, torch), so a suite runs in seconds and does not
    depend on a model being installed. The service keeps the object it
    imported, so the stand-ins come back out of ``sys.modules`` once the
    import is done.
    """
    path = pathlib.Path(path)
    saved = {}
    for mod_name, module in (fake_modules or {}).items():
        saved[mod_name] = sys.modules.get(mod_name)
        sys.modules[mod_name] = module
    try:
        spec = importlib.util.spec_from_file_location(path.stem, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    finally:
        for mod_name, prior in saved.items():
            if prior is None:
                sys.modules.pop(mod_name, None)
            else:
                sys.modules[mod_name] = prior


class Helper:
    """What a service reports to, with the real cancellation semantics."""

    request_id = 'r1'
    requester_id = 'asker@x.com'

    def __init__(self, stop_when=None):
        #: every terminal report, as ('completed', payload) / ('error', text)
        self.reports = []
        #: every progress update, as (percent, message)
        self.beats = []
        #: called with each (percent, message); returning True presses Stop,
        #: which the NEXT checkpoint sees -- the way a stop arrives over the
        #: channel while the work is running.
        self._stop_when = stop_when
        self._stopped = False
        self._scope = CancelScope(lambda: self._stopped)

    # -- the cancellation surface, as ResponseHelper exposes it --
    @property
    def cancelled(self):
        return self._scope.cancelled

    def raise_if_cancelled(self):
        self._scope.raise_if_cancelled()

    def critical(self):
        return self._scope.critical()

    def stop(self):
        """The requester pressed Stop."""
        self._stopped = True

    # -- reporting --
    def progress(self, percent, msg='', **extra):
        self.raise_if_cancelled()
        self.beats.append((percent, msg))
        if self._stop_when and self._stop_when(percent, msg):
            self._stopped = True

    def complete(self, data=None):
        self.reports.append(('completed', data))

    def stopped(self, data=None):
        self.reports.append(('completed', {**(data or {}), 'stopped': True}))

    def error(self, err):
        # The real helper scrubs here, whoever reports: a service that catches
        # its own exception reaches the requester the same way.
        self.reports.append(('error', requester_message(err)))

    # -- what a test asks --
    @property
    def errors(self):
        return [text for kind, text in self.reports if kind == 'error']

    @property
    def results(self):
        return [data for kind, data in self.reports if kind == 'completed']

    @property
    def messages(self):
        return [msg for _, msg in self.beats]


def run(service, request, helper=None):
    """Drive one request the way the server does, and wait for it to end."""
    helper = helper or Helper()
    thread = service.handle_service_request(dict(request), helper)
    assert thread is not None, 'the request was rejected before it ran'
    thread.join(30)
    assert not thread.is_alive(), 'the handler never finished'
    return helper


class _Batch:
    """The batch a handler writes on (``client.batched()`` / ``client.batch()``):
    the same resources as the fake client, recording into this batch's queue
    rather than the client's log until it submits."""

    def __init__(self, client):
        self.client = client
        self.queued = []
        self.results = []
        self.open = True
        for name in client.RESOURCES:
            setattr(self, name, Resource(self, name))

    def __getattr__(self, name):
        return getattr(self.client, name)

    def new_id(self, prefix):
        return self.client.new_id(prefix)

    def fail_if_asked(self, kind):
        self.client.fail_if_asked(kind)

    def record(self, kind, payload=None, result=None):
        self.queued.append((kind, payload))
        self.results.append(result if result is not None else {'body': {}})

    def submit(self):
        self.open = False
        for entry in self.queued:
            self.client.calls.append(entry)
        return self.results

    def abort(self):
        # Nothing it queued reaches the server.
        self.open = False
        self.queued = []
        self.results = []


def _checked_ops(ops):
    """A metadata patch as the server takes it, a list of ops (see
    ``plaid_client.metadata_ops``), refused here as there when it is not."""
    if not isinstance(ops, list):
        raise PlaidAPIError('HTTP 400 A metadata patch is a list of ops', status=400)
    try:
        apply_metadata_ops({}, ops)
    except ValueError as e:
        raise PlaidAPIError(f'HTTP 400 {e}', status=400)
    return ops


class Resource:
    """One resource of the fake client: records every call in order and hands
    back plausible ids, which is what a batch's ``results`` carry. A metadata
    patch, direct or in a bulk update entry, must be a list of ops."""

    def __init__(self, client, name):
        self._client = client
        self._name = name

    def _call(self, method, payload, result):
        self._client.fail_if_asked(f'{self._name}.{method}')
        self._client.record(f'{self._name}.{method}', payload, result)

    def create(self, *args, **kwargs):
        new = self._client.new_id(self._name)
        self._call('create', {'args': args, 'kwargs': kwargs}, {'body': {'id': new}})
        return {'id': new}

    def bulk_create(self, ops):
        ops = list(ops)
        ids = [self._client.new_id(self._name) for _ in ops]
        self._call('bulk_create', ops, {'body': {'ids': ids}})
        return {'ids': ids}

    def bulk_update(self, items):
        items = list(items)
        for item in items:
            if 'metadata' in item:
                _checked_ops(item['metadata'])
        self._call('bulk_update', items, {'body': {'count': len(items)}})
        return {'count': len(items)}

    def delete(self, entity_id):
        self._call('delete', entity_id, {'body': {}})

    def bulk_delete(self, ids):
        self._call('bulk_delete', list(ids), {'body': {}})

    def patch_metadata(self, entity_id, ops):
        _checked_ops(ops)
        self._call('patch_metadata', (entity_id, ops), {'body': {}})

    def set_metadata(self, entity_id, metadata):
        self._call('set_metadata', (entity_id, metadata), {'body': {}})

    def update(self, entity_id, ops):
        self._call('update', (entity_id, ops), {'body': {}})


class FakeClient:
    """Enough of PlaidClient to drive a handler: documents to read back, and a
    log of everything it is asked to do, in order.

    Models the two things a handler test must get right: a batch ABORTS on an
    exception, so nothing it queued reaches the server, and ``locked()``
    releases on the way out however the block ends.
    """

    #: resources a handler may reach for; each records under its own name.
    RESOURCES = ('tokens', 'spans', 'relations', 'texts', 'vocab_links')

    def __init__(self, documents, fails=None):
        self._documents = list(documents)
        self.base_url = 'http://plaid.internal:8085'
        self.token = 'tok'
        #: (kind, payload) for everything that reached the server, in order.
        #: kind is 'lock' / 'unlock' / 'read' / 'operation' / '<resource>.<method>'.
        self.calls = []
        self.reads = []
        self.operations = []
        #: {'tokens.bulk_create': <exception>} -- raised when that call is made.
        self.fails = dict(fails or {})
        self._ids = itertools.count(1)
        self.documents = self._Documents(self)
        for name in self.RESOURCES:
            setattr(self, name, Resource(self, name))

    # -- recording --
    def new_id(self, prefix):
        return f'{prefix}-{next(self._ids)}'

    def fail_if_asked(self, kind):
        error = self.fails.get(kind)
        if error is not None:
            raise error

    def record(self, kind, payload=None, result=None):
        self.calls.append((kind, payload))

    @property
    def kinds(self):
        return [kind for kind, _ in self.calls]

    @property
    def writes(self):
        """Everything that reached the server and changed something."""
        return [c for c in self.calls
                if c[0] not in ('lock', 'unlock', 'read', 'operation')]

    def payloads(self, kind):
        return [payload for k, payload in self.calls if k == kind]

    def document(self, index=-1):
        return self._documents[index]

    # -- the client surface --
    def batch(self):
        return _Batch(self)

    @contextlib.contextmanager
    def batched(self):
        batch = _Batch(self)
        try:
            yield batch
        except BaseException:
            batch.abort()
            raise
        batch.submit()

    @contextlib.contextmanager
    def operation(self, message):
        self.operations.append(message)
        self.record('operation', message)
        yield self

    class _Documents:
        def __init__(self, client):
            self._client = client

        def get(self, document_id, include_body=None, layers=None):
            self._client.reads.append({'id': document_id, 'layers': layers})
            self._client.record('read', document_id)
            index = min(len(self._client.reads) - 1, len(self._client._documents) - 1)
            return self._client._documents[index]

        @contextlib.contextmanager
        def locked(self, document_id):
            # The lock routes are out-of-band signals: made on the client, and
            # logged straight through.
            self._client.calls.append(('lock', document_id))
            try:
                yield self
            finally:
                self._client.calls.append(('unlock', document_id))
