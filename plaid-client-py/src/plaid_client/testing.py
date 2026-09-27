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

``FakeClient`` also answers a caller that works on a whole project, such as
plaid-agent's assistants: given its documents as a dict by id, a project, an
audit log, guidelines and comments, it reads them back and records every
write in the same ``(kind, payload)`` log.

Where the fake and the real client meet, the fake is the stricter: a write
is run through the real method first, so a call PlaidClient would refuse is
refused here the same way, and a batch refuses what the real batch refuses.
What it does NOT do is keep the documents up to date: a write is recorded,
not applied, and a later read sees the fixture as it was given. Nor does it
lose a lock, apply an ``as_of`` read, or check that an id exists before a
write names it.

It lives in the shipped package rather than beside the tests because a
test-only copy had no home either app could import from, and the two apps kept
byte-identical copies of it instead.
"""

import contextlib
import copy
import fnmatch
import importlib.util
import inspect
import itertools
import json
import pathlib
import sys
from datetime import datetime, timezone
from urllib.parse import quote

from plaid_client import client as _client
from plaid_client.document_lock import DocumentLock
from plaid_client.http import PlaidAPIError
from plaid_client.metadata_ops import apply_metadata_ops
from plaid_client.services import CancelScope, requester_message
from plaid_client.transforms import transform_request, transform_response


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


def checked_ops(ops):
    """A metadata patch as the server takes it, a list of ops (see
    ``plaid_client.metadata_ops``), refused here as there when it is not."""
    if not isinstance(ops, list):
        raise PlaidAPIError('HTTP 400 A metadata patch is a list of ops', status=400)
    try:
        apply_metadata_ops({}, ops)
    except ValueError as e:
        raise PlaidAPIError(f'HTTP 400 {e}', status=400)
    return ops


def as_fragment(ops):
    """A recorded metadata patch read back as the object it writes, a key an
    op deletes reading as None, so a test can look a key up."""
    out = {}
    for op in checked_ops(ops):
        node = out
        *parents, last = op['path']
        for k in parents:
            node = node.setdefault(k, {})
        node[last] = op['value'] if op['op'] == 'set' else None
    return out


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _payload(args, kwargs):
    """What a call records: its one positional argument bare, several as a
    tuple, or ``{'args', 'kwargs'}`` when it was given keywords."""
    if kwargs:
        return {'args': args, 'kwargs': kwargs}
    return args[0] if len(args) == 1 else args


def _root(writer):
    """The client behind a writer, which is the client itself or a batch on it."""
    return getattr(writer, 'client', writer)


def _refusal(root, status, text, method, path):
    """An error spelled as the real client spells one the server sent."""
    url = f'{root.base_url}{path}'
    return PlaidAPIError(f'HTTP {status} {text} at {url}', status=status, url=url,
                         method=method, response_data={'error': text})


class _Sent(Exception):
    """The request a real resource method made, caught before it went out."""

    def __init__(self, method, path, options):
        super().__init__(method, path)
        self.method = method
        self.path = path
        self.options = options


class _Wire:
    """What a real resource method is built on here in place of a client:
    the first request it makes is caught, not sent."""

    def _request(self, method, path, **options):
        raise _Sent(method, path, options)


def _request_of(real_cls, method, args, kwargs):
    """The request the REAL ``real_cls.method(*args, **kwargs)`` would make,
    as a ``_Sent``, or None for a method that makes none when called (a
    context manager, a generator). A call the real method refuses raises its
    TypeError here, so the fake takes exactly the arguments the client does."""
    try:
        getattr(real_cls(_Wire()), method)(*args, **kwargs)
    except _Sent as sent:
        return sent
    return None


class _Batch:
    """The batch a caller writes on (``client.batched()`` / ``client.batch()``):
    the same resources as the fake client, recording into this batch's queue
    rather than the client's log until it submits. A write made on the client
    itself is never held by an open batch. A read made on a batch answers from
    the client.

    It refuses what the real ``PlaidBatch`` refuses: a write once it has been
    submitted or aborted, a second submit, nesting, a user-data write. A
    batch holding two single deletes of one id fails its submit with the 404
    the server answers, and nothing in it is recorded. A guideline written on
    it changes the rows only when it submits, and an ``expected_updated_at``
    that no longer matches refuses the whole batch then."""

    def __init__(self, client):
        self.client = client
        self.queued = []
        self.results = []
        self.open = True
        self._effects = []
        self._single_deletes = set()
        self._refused = None
        for name in client.RESOURCES:
            setattr(self, name, Resource(self, name))
        # The client's own resources, bound to this batch so their writes
        # queue. One a test swapped in for its own is used as it is.
        for name in ('documents', 'comments', 'guidelines'):
            resource = getattr(client, name)
            if isinstance(resource, (FakeClient._Documents, FakeClient._Comments,
                                     FakeClient._Guidelines)):
                setattr(self, name, type(resource)(self))
        if isinstance(client.user_data, FakeClient._UserData):
            self.user_data = _BatchUserData(self, client.user_data)

    def __getattr__(self, name):
        return getattr(self.client, name)

    def batch(self):
        raise PlaidAPIError('A batch is not nestable: queue on the batch you have')

    def batched(self):
        raise PlaidAPIError('A batch is not nestable: queue on the batch you have')

    def new_id(self, prefix):
        return self.client.new_id(prefix)

    def fail_if_asked(self, kind):
        self.client.fail_if_asked(kind)

    def check_open(self, path=''):
        if not self.open:
            raise PlaidAPIError(f'This batch was already submitted or aborted: {path}')

    def record(self, kind, payload=None, result=None):
        self.check_open()
        self.queued.append((kind, payload))
        self.results.append(result if result is not None else {'body': {}})

    def defer(self, effect):
        """Run ``effect`` when the batch submits, where the server would."""
        self._effects.append(effect)

    def note_single_delete(self, resource, entity_id):
        key = (resource, entity_id)
        if key in self._single_deletes and self._refused is None:
            self._refused = _refusal(self.client, 404,
                                     f'{resource} {entity_id} was already deleted in this batch',
                                     'POST', '/api/v1/batch')
        self._single_deletes.add(key)

    def submit(self):
        if not self.open:
            raise PlaidAPIError('This batch was already submitted or aborted')
        self.open = False
        queued, effects, results = self.queued, self._effects, self.results
        self.queued, self._effects, self.results = [], [], []
        if not queued:
            return self.results  # nothing is sent
        if self._refused is not None:
            raise self._refused
        # One transaction: an effect that refuses rolls back the ones before it.
        rows = self.client.guideline_rows
        before = [dict(r) for r in rows]
        try:
            for effect in effects:
                effect()
        except BaseException:
            rows[:] = before
            raise
        self.client.batches.append(list(queued))
        self.client.calls.extend(queued)
        self.results = results
        return self.results

    def abort(self):
        # Nothing it queued reaches the server.
        self.open = False
        self.queued = []
        self.results = []
        self._effects = []


#: the real client's class for each resource the fake writes through, so the
#: fake accepts only a method PlaidClient has, called as PlaidClient takes it.
_REAL_RESOURCES = {
    'tokens': _client.TokensResource,
    'spans': _client.SpansResource,
    'relations': _client.RelationsResource,
    'texts': _client.TextsResource,
    'vocab_links': _client.VocabLinksResource,
    'vocab_items': _client.VocabItemsResource,
    'documents': _client.DocumentsResource,
}

#: the keys a bulk update entry may carry, and the ones it must, per resource
#: (plaid-core's PATCH /<resource>/bulk body schemas). The server drops a key
#: outside the first set without a word, so the fake refuses it: a caller
#: sending one believes it wrote something it did not.
_BULK_UPDATE_KEYS = {
    'tokens': ({'id', 'metadata'}, {'id', 'metadata'}),
    'spans': ({'id', 'value', 'metadata'}, {'id'}),
    'relations': ({'id', 'value', 'metadata'}, {'id'}),
    'vocab_items': ({'id', 'form', 'metadata'}, {'id'}),
}


class Resource:
    """One resource of the fake client: records every write in order, as
    ``('<resource>.<method>', payload)``, and hands back plausible ids, which
    is what a batch's ``results`` carry.

    Every call is first run through the REAL resource method against a wire
    that sends nothing, which is how the fake learns what it is: a method
    PlaidClient lacks is an AttributeError, arguments it would refuse are its
    TypeError, a read nobody modelled here is a NotImplementedError rather
    than a write answering ``{}``, an out-of-band signal (a lock) goes
    straight to the client's log even from a batch, and a call the transport
    cannot batch (an upload) is refused on one.

    A create records ``{'args', 'kwargs'}``, a bulk call its list, a metadata
    patch ``(id, ops)``. Any other write records its one positional argument
    bare, several as a tuple, or ``{'args', 'kwargs'}`` when it was given
    keywords. A metadata patch, direct or in a bulk update entry, must be a
    list of ops, and a bulk update entry may carry only the keys the server
    keeps (``_BULK_UPDATE_KEYS``)."""

    def __init__(self, client, name):
        self._client = client
        self._name = name

    def __getattr__(self, method):
        if method.startswith('_'):
            raise AttributeError(method)
        real = _REAL_RESOURCES.get(self._name)
        if real is None or not hasattr(real, method) or method.startswith(('get', 'list')):
            raise AttributeError(f'the fake {self._name} resource has no {method!r}')

        def call(*args, **kwargs):
            return self._write(real, method, args, kwargs)
        call.__name__ = method
        return call

    def _write(self, real, method, args, kwargs):
        sent = _request_of(real, method, args, kwargs)
        if sent is None or sent.method == 'GET':
            raise NotImplementedError(
                f'the fake {self._name} resource does not model {method!r}, which is not a write')
        writer = self._client
        on_batch = isinstance(writer, _Batch)
        if sent.options.get('out_of_band'):
            # A signal, not project data: made now, and never queued.
            writer, on_batch = _root(writer), False
        elif on_batch:
            writer.check_open(sent.path)
            if sent.options.get('no_batch'):
                raise PlaidAPIError(f'This endpoint cannot be used in a batch: {sent.path}')
        arguments = inspect.signature(getattr(real, method)).bind(None, *args, **kwargs).arguments
        first = list(arguments.values())[1] if len(arguments) > 1 else None
        payload, result, answer = self._shape(writer, method, args, kwargs, arguments, first, sent)
        kind = f'{self._name}.{method}'
        writer.fail_if_asked(kind)
        writer.record(kind, payload, result)
        if on_batch and method == 'delete':
            writer.note_single_delete(self._name, first)
        return {'batched': True} if on_batch else answer

    def _shape(self, writer, method, args, kwargs, arguments, first, sent):
        """What a write records, what a batch's results carry for it, and
        what it answers made on the client."""
        if method == 'create':
            new = writer.new_id(self._name)
            return {'args': args, 'kwargs': kwargs}, {'body': {'id': new}}, {'id': new}
        if method == 'bulk_create':
            ops = list(arguments['body'])
            ids = [writer.new_id(self._name) for _ in ops]
            return ops, {'body': {'ids': ids}}, {'ids': ids}
        if method == 'bulk_update':
            items = list(arguments['body'])
            self._check_bulk_update(items, sent)
            return items, {'body': {'count': len(items)}}, {'count': len(items)}
        if method == 'bulk_delete':
            return list(arguments['body']), {'body': {}}, None
        if method == 'patch_metadata':
            return (first, checked_ops(arguments['body'])), {'body': {}}, None
        return _payload(args, kwargs), {'body': {}}, {}

    def _check_bulk_update(self, items, sent):
        allowed, required = _BULK_UPDATE_KEYS[self._name]
        for item in items:
            missing = sorted(required - set(item))
            extra = sorted(set(item) - allowed)
            if missing or extra:
                raise _refusal(_root(self._client), 400,
                               f'A {self._name} bulk update entry takes '
                               f'{", ".join(sorted(allowed))}, needs {", ".join(sorted(required))}'
                               f' (missing {missing}, not kept {extra})',
                               sent.method, sent.path)
            if 'metadata' in item:
                checked_ops(item['metadata'])


class _Operation:
    """What ``with client.operation(...) as op`` yields: ``op.message`` is the
    label the audit log ends up with, refined by ``set_message`` only on the
    outermost operation, as the real client does."""

    def __init__(self, op_id, message, outermost):
        self.id = op_id
        self.message = message
        self._outermost = outermost

    def set_message(self, message):
        if self._outermost:
            self.message = message


def _layer_ids(doc):
    """Every layer id a document or project carries, of every kind."""
    out = set()
    for tl in (doc or {}).get('text_layers') or []:
        out.add(tl.get('id'))
        for kl in tl.get('token_layers') or []:
            out.add(kl.get('id'))
            for sl in kl.get('span_layers') or []:
                out.add(sl.get('id'))
                out.update(rl.get('id') for rl in sl.get('relation_layers') or [])
    return out


def _pruned(doc, named):
    """The server's ``?layers=`` rule (plaid-core ``doc/prune-to-layers``): a
    layer comes back when it is named or is an ancestor of a named layer, and
    carries its own text, tokens, vocab links, spans or relations only when it
    is itself named. The fixture is not changed."""
    def relation_layer(rl):
        return rl if rl.get('id') in named else None

    def span_layer(sl):
        rls = [rl for rl in sl.get('relation_layers') or [] if relation_layer(rl)]
        own = sl.get('id') in named
        if not own and not rls:
            return None
        return {**sl, 'relation_layers': rls, 'spans': (sl.get('spans') or []) if own else []}

    def token_layer(kl):
        sls = [x for x in map(span_layer, kl.get('span_layers') or []) if x]
        own = kl.get('id') in named
        if not own and not sls:
            return None
        return {**kl, 'span_layers': sls,
                'tokens': (kl.get('tokens') or []) if own else [],
                'vocabs': (kl.get('vocabs') or []) if own else []}

    def text_layer(tl):
        kls = [x for x in map(token_layer, tl.get('token_layers') or []) if x]
        own = tl.get('id') in named
        if not own and not kls:
            return None
        return {**tl, 'token_layers': kls, 'text': tl.get('text') if own else None}

    return {**doc, 'text_layers': [x for x in map(text_layer, doc.get('text_layers') or []) if x]}


def _audit_filter(root, entries, path, start_time, end_time, as_of, op_types):
    """An audit read's filters, as the server applies them: the time range is
    inclusive at both ends, and ``op_types`` keeps an entry one of whose
    operations matches, carrying only the ones that do. ``as_of`` is refused
    on an audit route, as the server refuses it."""
    if as_of is not None:
        raise _refusal(root, 400, 'as-of query parameter is not supported on this endpoint',
                       'GET', path)
    out = [e for e in entries
           if (not start_time or (e.get('time') or '') >= start_time)
           and (not end_time or (e.get('time') or '') <= end_time)]
    if op_types:
        types = set(op_types.split(',') if isinstance(op_types, str) else op_types)
        out = [{**e, 'ops': [o for o in e.get('ops') or [] if o.get('type') in types]}
               for e in out]
        out = [e for e in out if e['ops']]
    return out


class FakeClient:
    """Enough of PlaidClient to drive a handler or an assistant: documents to
    read back, and a log of everything it is asked to do, in order.

    Models the two things a handler test must get right: a batch ABORTS on an
    exception, so nothing it queued reaches the server, and ``locked()``
    releases on the way out however the block ends. A batch also refuses
    what the real one refuses (see ``_Batch``), and every write is checked
    against the real method's signature (see ``Resource``).

    ``documents`` is either a list or a dict. A list is the one document a
    handler works on, as each read finds it: the first read answers with the
    first, the next with the next, and the last is repeated. A dict is a
    project's documents by id, which is what a caller reading several asks.
    A read without ``include_body`` has no ``text_layers``, and one with
    ``layers`` has only what those layers carry, as the server answers.

    A project-level caller also finds ``project`` (``projects.get``), its
    ``audit`` log, its ``guidelines`` and ``comments``, the user's private
    store (``user_data``, kept in memory and not logged) and a document
    restore that answers, done or dry, with ``restore_summary``. The fake
    does not apply a write to the documents, the comments or the audit log: a
    later read sees the fixture as it was given. Guidelines and user data
    are the two it keeps up to date.
    """

    #: resources a caller may write through, each recording under its own name.
    RESOURCES = ('tokens', 'spans', 'relations', 'texts', 'vocab_links', 'vocab_items')

    def __init__(self, documents, fails=None, *, project=None, audit=None, guidelines=None,
                 comments=None, restore_summary=None):
        self._documents = documents if isinstance(documents, dict) else list(documents)
        self.base_url = 'http://plaid.internal:8085'
        self.token = 'tok'
        #: (kind, payload) for everything that reached the server, in order.
        #: kind is 'lock' / 'unlock' / 'read' / 'operation' / '<resource>.<method>'.
        self.calls = []
        #: each submitted batch, as the (kind, payload) entries it sent together.
        #: An empty batch sends nothing and is not here.
        self.batches = []
        #: {'id', 'layers'} per document read
        self.reads = []
        #: {'order', 'start_time'} per paged audit read
        self.audit_pages = []
        #: the label each operation was begun with (see ``_Operation`` for the
        #: label it ends with)
        self.operations = []
        #: {'tokens.bulk_create': <exception>} -- raised when that call is made.
        self.fails = dict(fails or {})
        self.project = project
        self.audit = list(audit or [])
        self.guideline_rows = list(guidelines or [])
        self.comment_rows = list(comments or [])
        self.restore_summary = restore_summary
        self._ids = itertools.count(1)
        self._operation_depth = 0
        self.documents = FakeClient._Documents(self)
        self.projects = FakeClient._Projects(self)
        self.comments = FakeClient._Comments(self)
        self.guidelines = FakeClient._Guidelines(self)
        self.user_data = FakeClient._UserData(self.base_url)
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

    def patches(self, resource):
        """Every metadata patch that reached ``resource``, as ``(id, ops)`` in
        order, whether it was sent alone or as an entry of a bulk update."""
        out = []
        for kind, payload in self.calls:
            if kind == f'{resource}.patch_metadata':
                out.append(tuple(payload))
            elif kind == f'{resource}.bulk_update':
                out.extend((item['id'], item['metadata']) for item in payload
                           if item.get('metadata'))
        return out

    def updates(self, resource):
        """Every value written to ``resource``, as ``(id, value)`` in order,
        whether by ``update(id, value)`` or as an entry of a bulk update."""
        out = []
        for kind, payload in self.calls:
            if kind == f'{resource}.update' and isinstance(payload, tuple) and len(payload) == 2:
                out.append(payload)
            elif kind == f'{resource}.bulk_update':
                out.extend((item['id'], item['value']) for item in payload if 'value' in item)
        return out

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
        op = _Operation(f'op-{len(self.operations)}', message, self._operation_depth == 0)
        self._operation_depth += 1
        try:
            yield op
        finally:
            self._operation_depth -= 1

    def _audit_page(self, entries, order, limit, cursor, start_time):
        """One page of ``entries`` in time order. The cursor is opaque to a
        caller, so here it is the offset the next page starts at."""
        self.audit_pages.append({'order': order, 'start_time': start_time})
        entries = sorted(entries, key=lambda e: e.get('time') or '', reverse=(order == 'desc'))
        start = int(cursor) if cursor else 0
        end = start + limit if limit else len(entries)
        return {'entries': entries[start:end],
                'next_cursor': str(end) if end < len(entries) else None}

    class _Documents(Resource):
        """Reads answer from the fixture. Writes record like any resource's,
        and queue when made on a batch."""

        def __init__(self, writer):
            super().__init__(writer, 'documents')
            self._root = _root(writer)

        def get(self, document_id, *, include_body=None, as_of=None, layers=None):
            """The fixture document, shaped as the server shapes a read (see
            ``_pruned``). ``as_of`` is accepted and answered with the fixture as
            it is: the fake has no history."""
            root = self._root
            root.reads.append({'id': document_id, 'layers': layers})
            root.record('read', document_id)
            path = f'/api/v1/documents/{document_id}'
            named = _client._layers_param(layers)
            if named and not include_body:
                raise _refusal(root, 400, '?layers= selects which layers a body read returns, '
                               'so it requires include-body=true.', 'GET', path)
            if isinstance(root._documents, dict):
                if document_id not in root._documents:
                    raise _refusal(root, 404, 'Document not found', 'GET', path)
                doc = root._documents[document_id]
            else:
                doc = root._documents[min(len(root.reads) - 1, len(root._documents) - 1)]
            if not include_body:
                return {k: v for k, v in doc.items() if k != 'text_layers'}
            if not named:
                return doc
            named = set(named.split(','))
            unknown = sorted(named - _layer_ids(doc) - _layer_ids(root.project))
            if unknown:
                raise _refusal(root, 400, 'No such layer in this document\'s project: '
                               + ', '.join(unknown), 'GET', path)
            return _pruned(doc, named)

        @contextlib.contextmanager
        def locked(self, document_id, *, keep_alive=True):
            # The lock routes are out-of-band signals: made on the client, and
            # logged straight through. The fake's lock is never lost.
            self._root.calls.append(('lock', document_id))
            try:
                yield DocumentLock(document_id)
            finally:
                self._root.calls.append(('unlock', document_id))

        def audit(self, document_id, *, start_time=None, end_time=None, as_of=None,
                  op_types=None):
            entries = [e for e in self._root.audit
                       if any(d['id'] == document_id for d in e.get('documents', []))]
            return _audit_filter(self._root, entries, f'/api/v1/documents/{document_id}/audit',
                                 start_time, end_time, as_of, op_types)

        def audit_page(self, document_id, *, start_time=None, end_time=None, as_of=None,
                       op_types=None, order=None, limit=None, cursor=None):
            entries = self.audit(document_id, start_time=start_time, end_time=end_time,
                                 as_of=as_of, op_types=op_types)
            return self._root._audit_page(entries, order, limit, cursor, start_time)

        def restore(self, document_id, as_of, *, dry_run=False, audit_message=None):
            """The server's restore, recorded dry or not. Either way it answers
            with ``restore_summary``: what WOULD change, or what did."""
            path = f'/api/v1/documents/{document_id}/restore'
            writer = self._client
            if isinstance(writer, _Batch):
                writer.check_open(path)
            return self._record_write('restore',
                                      {'args': (document_id, as_of), 'kwargs': {'dry_run': dry_run}},
                                      {'body': self._root.restore_summary},
                                      self._root.restore_summary)

        def _record_write(self, method, payload, result, answer):
            writer = self._client
            writer.fail_if_asked(f'documents.{method}')
            writer.record(f'documents.{method}', payload, result)
            return {'batched': True} if isinstance(writer, _Batch) else answer

    class _Projects:
        def __init__(self, client):
            self._client = client

        def get(self, id, *, as_of=None):
            return self._client.project

        def audit(self, project_id, *, start_time=None, end_time=None, as_of=None,
                  op_types=None):
            return _audit_filter(self._client, self._client.audit,
                                 f'/api/v1/projects/{project_id}/audit',
                                 start_time, end_time, as_of, op_types)

        def audit_page(self, project_id, *, start_time=None, end_time=None, as_of=None,
                       op_types=None, order=None, limit=None, cursor=None):
            entries = self.audit(project_id, start_time=start_time, end_time=end_time,
                                 as_of=as_of, op_types=op_types)
            return self._client._audit_page(entries, order, limit, cursor, start_time)

        def list_documents(self, id):
            docs = self._client._documents
            docs = docs.values() if isinstance(docs, dict) else docs
            return [{'id': d.get('id'), 'name': d.get('name'), 'version': d.get('version'),
                     'time_created': d.get('time_created'),
                     'time_modified': d.get('time_modified')} for d in docs]

    class _Comments:
        """The project's comments, read from the fixture. A comment posted is
        recorded, queued when made on a batch, and not added to the rows a
        later ``list`` reads."""

        def __init__(self, writer):
            self._writer = writer
            self._root = _root(writer)

        def list(self, project_id, *, document_id=None, entity_type=None, entity_id=None):
            return [r for r in self._root.comment_rows
                    if (not document_id or r.get('document_id') == document_id)
                    and (not entity_type or r.get('entity_type') == entity_type)
                    and (not entity_id or r.get('entity_id') == entity_id)]

        def create(self, entity_type, entity_id, body, *, anchor_label=None):
            writer = self._writer
            on_batch = isinstance(writer, _Batch)
            if on_batch:
                writer.check_open('/api/v1/comments')
            new = writer.new_id('comments')
            writer.fail_if_asked('comments.create')
            kwargs = {} if anchor_label is None else {'anchor_label': anchor_label}
            comment = {'id': new, 'entity_type': entity_type, 'entity_id': entity_id,
                       'body': body, 'anchor_label': anchor_label, 'edited': False}
            writer.record('comments.create',
                          {'args': (entity_type, entity_id, body), 'kwargs': kwargs},
                          {'body': comment})
            return {'batched': True} if on_batch else comment

    class _Guidelines:
        """The project's annotation manual. A write is recorded like any
        other and changes the rows, at once on the client and when the batch
        submits on a batch."""

        def __init__(self, writer):
            self._writer = writer
            self._root = _root(writer)
            self._rows = self._root.guideline_rows

        def _row(self, guideline_id, method):
            row = next((r for r in self._rows if r.get('id') == guideline_id), None)
            if row is None:
                raise _refusal(self._root, 404, 'Guideline not found', method,
                               f'/api/v1/guidelines/{guideline_id}')
            return row

        def _write(self, kind, path, payload, result, effect):
            """Record a write and apply ``effect``, now on the client and at
            submit on a batch, where the server checks what it checks."""
            writer = self._writer
            on_batch = isinstance(writer, _Batch)
            if on_batch:
                writer.check_open(path)
            writer.fail_if_asked(kind)
            if on_batch:
                writer.record(kind, payload, result)
                writer.defer(effect)
                return {'batched': True}
            answer = effect()
            writer.record(kind, payload, result)
            return answer

        def list(self, project_id, *, include_bodies=None):
            out = []
            for r in self._rows:
                row = {'project': project_id, 'created_at': r.get('updated_at'), **r}
                if not include_bodies:
                    row = {k: v for k, v in row.items() if k != 'body'} | {
                        'body_chars': len(r.get('body') or '')}
                out.append(row)
            return out

        def get(self, guideline_id):
            return dict(self._row(guideline_id, 'GET'))

        def create(self, project_id, title, *, body=None, pinned=None, audit_message=None):
            new = self._writer.new_id('guidelines')
            now = _now_iso()
            row = {'id': new, 'project': project_id, 'title': title, 'body': body or '',
                   'pinned': bool(pinned), 'created_at': now, 'updated_at': now}

            def effect():
                self._rows.append(row)
                return {'id': new}
            return self._write('guidelines.create', f'/api/v1/projects/{project_id}/guidelines',
                               {'args': (project_id, title), 'kwargs': {'body': body or ''}},
                               {'body': {'id': new}}, effect)

        def update(self, guideline_id, *, title=None, body=None, pinned=None,
                   expected_updated_at=None, audit_message=None):
            """The server's own rule: given ``expected_updated_at`` and no
            longer matching, nothing is written and this is a 409. Omitted, the
            write is unconditional."""
            changed = {k: v for k, v in (('title', title), ('body', body), ('pinned', pinned))
                       if v is not None}
            path = f'/api/v1/guidelines/{guideline_id}'

            def effect():
                row = self._row(guideline_id, 'PATCH')
                if expected_updated_at and expected_updated_at != row.get('updated_at'):
                    raise _refusal(self._root, 409, 'This guideline was changed by someone '
                                   'else after you opened it', 'PATCH', path)
                row.update(changed)
                row['updated_at'] = _now_iso()
                return dict(row)
            return self._write('guidelines.update', path,
                               {'args': (guideline_id,),
                                'kwargs': {'expected_updated_at': expected_updated_at, **changed}},
                               {'body': {'id': guideline_id}}, effect)

        def delete(self, guideline_id, audit_message=None):
            path = f'/api/v1/guidelines/{guideline_id}'

            def effect():
                self._rows.remove(self._row(guideline_id, 'DELETE'))
            return self._write('guidelines.delete', path, guideline_id, {'body': {}}, effect)

    class _UserData:
        """The user's private key/value store, in memory and not logged. A
        value comes back as the real client hands it back: its keys recased
        on the way out and in (``kebab-key`` reads ``kebab_key``, ``ns/k``
        reads ``k``), apart from what sits under ``metadata``."""

        def __init__(self, base_url='http://plaid.internal:8085'):
            self.base_url = base_url
            #: (user_id, key) -> {'value', 'updated_at'}
            self.store = {}

        def _missing(self, user_id, key, method):
            return _refusal(self, 404, 'No such entry', method,
                            f'/api/v1/users/{user_id}/data/{quote(key, safe="")}')

        def get(self, user_id, key):
            entry = self.store.get((user_id, key))
            if entry is None:
                raise self._missing(user_id, key, 'GET')
            return {'key': key, 'updated_at': entry['updated_at'],
                    'value': copy.deepcopy(entry['value'])}

        def put(self, user_id, key, value):
            wire = json.loads(json.dumps(transform_request(value)))
            entry = {'value': transform_response(wire), 'updated_at': _now_iso()}
            self.store[(user_id, key)] = entry
            return {'key': key, 'updated_at': entry['updated_at']}

        def delete(self, user_id, key):
            if self.store.pop((user_id, key), None) is None:
                raise self._missing(user_id, key, 'DELETE')

        def _entries(self, user_id, prefix, pattern, include_values):
            """Every matching entry, ordered by key like the server's listing."""
            rows = [{'key': k, 'updated_at': e['updated_at'],
                     **({'value': copy.deepcopy(e['value'])} if include_values else {})}
                    for (u, k), e in self.store.items()
                    if u == user_id
                    and (not prefix or k.startswith(prefix))
                    and (not pattern or fnmatch.fnmatchcase(k, pattern))]
            rows.sort(key=lambda r: r['key'])
            return rows

        def list(self, user_id, *, prefix=None, pattern=None, include_values=False,
                 page_size=100):
            """The full flat list, as the real client's auto-paginating list.

            ``pattern`` is a GLOB over the whole key (``*`` any run, ``?`` one
            character). ``page_size`` only sets how many entries a request
            carries, so here it is accepted and unused.
            """
            return self._entries(user_id, prefix, pattern, include_values)

        def list_page(self, user_id, *, prefix=None, pattern=None, include_values=False,
                      limit=None, cursor=None):
            """One page, as the envelope the real client hands back. The cursor
            is opaque to a caller, so it is the last key of the page it came
            from."""
            rows = self._entries(user_id, prefix, pattern, include_values)
            if cursor is not None:
                rows = [r for r in rows if r['key'] > cursor]
            page, rest = rows[:limit or 100], rows[limit or 100:]
            return {'entries': page,
                    'next_cursor': page[-1]['key'] if rest else None}


class _BatchUserData:
    """The user's store reached through a batch: a read goes over the wire as
    on the client, and a write is refused, as the real batch refuses it."""

    def __init__(self, batch, store):
        self._batch = batch
        self._store = store

    def _refuse(self, user_id, key):
        path = f'/api/v1/users/{user_id}/data/{quote(key, safe="")}'
        self._batch.check_open(path)
        raise PlaidAPIError(f'This endpoint cannot be used in a batch: {path}')

    def get(self, user_id, key):
        return self._store.get(user_id, key)

    def put(self, user_id, key, value):
        self._refuse(user_id, key)

    def delete(self, user_id, key):
        self._refuse(user_id, key)

    def list(self, user_id, *, prefix=None, pattern=None, include_values=False,
             page_size=100):
        return self._store.list(user_id, prefix=prefix, pattern=pattern,
                                include_values=include_values, page_size=page_size)

    def list_page(self, user_id, *, prefix=None, pattern=None, include_values=False,
                  limit=None, cursor=None):
        return self._store.list_page(user_id, prefix=prefix, pattern=pattern,
                                     include_values=include_values, limit=limit, cursor=cursor)
