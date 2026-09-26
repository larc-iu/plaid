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
audit log, guidelines and comments, it reads them back the way the server
would and records every write in the same ``(kind, payload)`` log.

It lives in the shipped package rather than beside the tests because a
test-only copy had no home either app could import from, and the two apps kept
byte-identical copies of it instead.
"""

import contextlib
import copy
import fnmatch
import importlib.util
import itertools
import pathlib
import sys
from datetime import datetime, timezone

from plaid_client import client as _client
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


class _Batch:
    """The batch a caller writes on (``client.batched()`` / ``client.batch()``):
    the same resources as the fake client, recording into this batch's queue
    rather than the client's log until it submits. A write made on the client
    itself is never held by an open batch. A read made on a batch answers from
    the client."""

    def __init__(self, client):
        self.client = client
        self.queued = []
        self.results = []
        self.open = True
        for name in client.RESOURCES:
            setattr(self, name, Resource(self, name))
        # The client's own resources, bound to this batch so their writes
        # queue. One a test swapped in for its own is used as it is.
        for name in ('documents', 'comments', 'guidelines'):
            resource = getattr(client, name)
            if isinstance(resource, (FakeClient._Documents, FakeClient._Comments,
                                     FakeClient._Guidelines)):
                setattr(self, name, type(resource)(self))

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
        assert self.open, 'this batch was already submitted or aborted'
        self.open = False
        self.client.batches.append(list(self.queued))
        for entry in self.queued:
            self.client.calls.append(entry)
        return self.results

    def abort(self):
        # Nothing it queued reaches the server.
        self.open = False
        self.queued = []
        self.results = []


#: the real client's class for each resource the fake writes through, so the
#: fake accepts only a method PlaidClient has.
_REAL_RESOURCES = {
    'tokens': _client.TokensResource,
    'spans': _client.SpansResource,
    'relations': _client.RelationsResource,
    'texts': _client.TextsResource,
    'vocab_links': _client.VocabLinksResource,
    'vocab_items': _client.VocabItemsResource,
    'documents': _client.DocumentsResource,
}


class Resource:
    """One resource of the fake client: records every call in order, as
    ``('<resource>.<method>', payload)``, and hands back plausible ids, which
    is what a batch's ``results`` carry. A create records ``{'args',
    'kwargs'}``. Any other method records its one positional argument bare,
    several as a tuple, or ``{'args', 'kwargs'}`` when it was given keywords.
    A metadata patch, direct or in a bulk update entry, must be a list of ops."""

    def __init__(self, client, name):
        self._client = client
        self._name = name

    def _call(self, method, payload, result, answer):
        """Record the call and answer it. A write queued on a batch answers
        as the real PlaidBatch does, ``{'batched': True}``: its ids arrive in
        the results when the batch submits."""
        self._client.fail_if_asked(f'{self._name}.{method}')
        self._client.record(f'{self._name}.{method}', payload, result)
        return {'batched': True} if isinstance(self._client, _Batch) else answer

    def create(self, *args, **kwargs):
        new = self._client.new_id(self._name)
        return self._call('create', {'args': args, 'kwargs': kwargs}, {'body': {'id': new}},
                          {'id': new})

    def bulk_create(self, ops):
        ops = list(ops)
        ids = [self._client.new_id(self._name) for _ in ops]
        return self._call('bulk_create', ops, {'body': {'ids': ids}}, {'ids': ids})

    def bulk_update(self, items):
        items = list(items)
        for item in items:
            if 'metadata' in item:
                checked_ops(item['metadata'])
        return self._call('bulk_update', items, {'body': {'count': len(items)}},
                          {'count': len(items)})

    def bulk_delete(self, ids):
        return self._call('bulk_delete', list(ids), {'body': {}}, None)

    def patch_metadata(self, entity_id, ops):
        checked_ops(ops)
        return self._call('patch_metadata', (entity_id, ops), {'body': {}}, None)

    def __getattr__(self, method):
        """Any other write the real resource has (``update``, ``delete``,
        ``split``, ``merge``, ``set_metadata`` ...), recorded by the rule above.
        A name the real resource lacks (a typo) is an AttributeError, and so is
        a read nobody modelled here (``get``, ``list...``), which would
        otherwise answer ``{}`` as if it had been a write."""
        real = _REAL_RESOURCES.get(self._name)
        if (method.startswith('_') or real is None or not hasattr(real, method)
                or method.startswith(('get', 'list'))):
            raise AttributeError(f'the fake {self._name} resource has no {method!r}')

        def call(*args, **kwargs):
            return self._call(method, _payload(args, kwargs), {'body': {}}, {})
        return call


class FakeClient:
    """Enough of PlaidClient to drive a handler or an assistant: documents to
    read back, and a log of everything it is asked to do, in order.

    Models the two things a handler test must get right: a batch ABORTS on an
    exception, so nothing it queued reaches the server, and ``locked()``
    releases on the way out however the block ends.

    ``documents`` is either a list or a dict. A list is the one document a
    handler works on, as each read finds it: the first read answers with the
    first, the next with the next, and the last is repeated. A dict is a
    project's documents by id, which is what a caller reading several asks.

    A project-level caller also finds ``project`` (``projects.get``), its
    ``audit`` log, its ``guidelines`` and ``comments``, the user's private
    store (``user_data``, kept in memory and not logged) and a document
    restore that answers a dry run with ``restore_summary``.
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
        #: each submitted batch, as the (kind, payload) entries it sent together
        self.batches = []
        #: {'id', 'layers'} per document read
        self.reads = []
        #: {'order', 'start_time'} per paged audit read
        self.audit_pages = []
        self.operations = []
        #: {'tokens.bulk_create': <exception>} -- raised when that call is made.
        self.fails = dict(fails or {})
        self.project = project
        self.audit = list(audit or [])
        self.guideline_rows = list(guidelines or [])
        self.comment_rows = list(comments or [])
        self.restore_summary = restore_summary
        self._ids = itertools.count(1)
        self.documents = FakeClient._Documents(self)
        self.projects = FakeClient._Projects(self)
        self.comments = FakeClient._Comments(self)
        self.guidelines = FakeClient._Guidelines(self)
        self.user_data = FakeClient._UserData()
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
        yield self

    def _audit_page(self, entries, order, limit, start_time):
        self.audit_pages.append({'order': order, 'start_time': start_time})
        entries = [e for e in entries if not start_time or (e.get('time') or '') >= start_time]
        entries = sorted(entries, key=lambda e: e.get('time') or '', reverse=(order == 'desc'))
        return {'entries': entries[:limit] if limit else entries, 'next_cursor': None}

    class _Documents(Resource):
        """Reads answer from the fixture. Writes record like any resource's,
        and queue when made on a batch."""

        def __init__(self, writer):
            super().__init__(writer, 'documents')
            self._root = _root(writer)

        def get(self, document_id, include_body=None, layers=None, **kw):
            root = self._root
            root.reads.append({'id': document_id, 'layers': layers})
            root.record('read', document_id)
            if isinstance(root._documents, dict):
                if document_id not in root._documents:
                    raise PlaidAPIError('Document not found', status=404)
                return root._documents[document_id]
            index = min(len(root.reads) - 1, len(root._documents) - 1)
            return root._documents[index]

        @contextlib.contextmanager
        def locked(self, document_id):
            # The lock routes are out-of-band signals: made on the client, and
            # logged straight through.
            self._root.calls.append(('lock', document_id))
            try:
                yield self
            finally:
                self._root.calls.append(('unlock', document_id))

        def audit(self, document_id, **kw):
            return [e for e in self._root.audit
                    if any(d['id'] == document_id for d in e.get('documents', []))]

        def audit_page(self, document_id, *, order=None, limit=None, cursor=None,
                       start_time=None, **kw):
            return self._root._audit_page(self.audit(document_id), order, limit, start_time)

        def restore(self, document_id, as_of, dry_run=False, **kw):
            """The server's restore, recorded dry or not. A dry run answers
            with ``restore_summary``, what WOULD change."""
            answer = self._root.restore_summary if dry_run else {'id': document_id}
            return self._call('restore',
                              {'args': (document_id, as_of), 'kwargs': {'dry_run': dry_run}},
                              {'body': {'id': document_id}}, answer)

    class _Projects:
        def __init__(self, client):
            self._client = client

        def get(self, project_id, **kw):
            return self._client.project

        def audit(self, project_id, start_time=None, **kw):
            return [e for e in self._client.audit
                    if not start_time or (e.get('time') or '') >= start_time]

        def audit_page(self, project_id, *, order=None, limit=None, cursor=None,
                       start_time=None, **kw):
            return self._client._audit_page(self._client.audit, order, limit, start_time)

        def list_documents(self, project_id, **kw):
            docs = self._client._documents
            docs = docs.values() if isinstance(docs, dict) else docs
            return [{'id': d.get('id'), 'name': d.get('name'), 'version': d.get('version'),
                     'time_modified': d.get('time_modified')} for d in docs]

    class _Comments:
        def __init__(self, writer):
            self._writer = writer
            self._root = _root(writer)

        def list(self, project_id, document_id=None, entity_type=None, entity_id=None, **kw):
            rows = self._root.comment_rows
            if document_id:
                rows = [r for r in rows if r.get('document_id') == document_id]
            if entity_id:
                rows = [r for r in rows
                        if r.get('entity_type') == entity_type and r.get('entity_id') == entity_id]
            return list(rows)

        def create(self, entity_type, entity_id, body, **kwargs):
            new = self._writer.new_id('comments')
            self._writer.fail_if_asked('comments.create')
            self._writer.record('comments.create',
                                {'args': (entity_type, entity_id, body), 'kwargs': kwargs},
                                {'body': {'id': new}})
            return {'id': new}

    class _Guidelines:
        """The project's annotation manual. A write changes the rows at once
        and is recorded like any other, queued when made on a batch."""

        def __init__(self, writer):
            self._writer = writer
            self._rows = _root(writer).guideline_rows

        def list(self, project_id, *, include_bodies=None, **kw):
            if include_bodies:
                return [dict(r) for r in self._rows]
            return [{k: v for k, v in r.items() if k != 'body'} | {'body_chars': len(r.get('body') or '')}
                    for r in self._rows]

        def get(self, guideline_id, **kw):
            for r in self._rows:
                if r.get('id') == guideline_id:
                    return dict(r)
            raise PlaidAPIError('Guideline not found', status=404)

        def create(self, project_id, title, *, body=None, pinned=None, **kw):
            self._writer.fail_if_asked('guidelines.create')
            row = {'id': f'gl-new-{len(self._rows)}', 'title': title, 'body': body or '',
                   'pinned': bool(pinned), 'updated_at': _now_iso()}
            self._rows.append(row)
            self._writer.record('guidelines.create',
                                {'args': (project_id, title), 'kwargs': {'body': body or ''}},
                                {'body': {'id': row['id']}})
            return {'id': row['id']}

        def update(self, guideline_id, *, title=None, body=None, pinned=None,
                   expected_updated_at=None, **kw):
            """The server's own rule: given ``expected_updated_at`` and no
            longer matching, nothing is written and this is a 409. Omitted, the
            write is unconditional."""
            self._writer.fail_if_asked('guidelines.update')
            row = next((r for r in self._rows if r.get('id') == guideline_id), None)
            if row is None:
                raise PlaidAPIError('Guideline not found', status=404)
            if expected_updated_at and expected_updated_at != row.get('updated_at'):
                raise PlaidAPIError('This guideline was changed by someone else after you '
                                    'opened it', status=409)
            changed = {k: v for k, v in (('title', title), ('body', body), ('pinned', pinned))
                       if v is not None}
            row.update(changed)
            row['updated_at'] = _now_iso()
            self._writer.record('guidelines.update',
                                {'args': (guideline_id,),
                                 'kwargs': {'expected_updated_at': expected_updated_at, **changed}},
                                {'body': {'id': guideline_id}})
            return {'id': guideline_id}

    class _UserData:
        """The user's private key/value store, in memory."""

        def __init__(self):
            self.store = {}

        def get(self, user_id, key):
            if (user_id, key) not in self.store:
                raise PlaidAPIError(f'No entry {key}', status=404)
            return {'key': key, 'value': copy.deepcopy(self.store[(user_id, key)])}

        def put(self, user_id, key, value):
            self.store[(user_id, key)] = copy.deepcopy(value)
            return {'key': key, 'updated_at': _now_iso()}

        def delete(self, user_id, key):
            self.store.pop((user_id, key), None)

        def _entries(self, user_id, prefix, pattern, include_values):
            """Every matching entry, ordered by key like the server's listing."""
            rows = [{'key': k, **({'value': copy.deepcopy(v)} if include_values else {})}
                    for (u, k), v in self.store.items()
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
