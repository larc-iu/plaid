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
import types
import sys
from datetime import datetime, timezone
from urllib.parse import quote

from plaid_client import client as _client
from plaid_client.document_lock import DocumentLock
from plaid_client.http import BatchRef, PlaidAPIError
from plaid_client.ids import uuid7
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


def _find_entity(tree, entity_id):
    """The first dict anywhere in the fixture ``tree`` whose ``id`` is
    ``entity_id``, as it was given (the fake never writes the fixture), or
    None."""
    stack = [tree]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if node.get('id') == entity_id:
                return node
            # Not into metadata: an id there is user data, not an entity.
            stack.extend(reversed([v for k, v in node.items() if k != 'metadata']))
        elif isinstance(node, (list, tuple)):
            stack.extend(reversed(node))
    return None


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
    batch holding a single delete of an id an earlier delete in it already
    took, single or bulk, fails its submit with the 404 the server answers,
    and nothing in it is recorded. A guideline written on
    it changes the rows only when it submits, and an ``expected_updated_at``
    that no longer matches refuses the whole batch then."""

    def __init__(self, client):
        self.client = client
        self.queued = []
        self.results = []
        self.open = True
        self._effects = []
        self._deleted = set()
        self._refused = None
        for name in client.RESOURCES:
            setattr(self, name, Resource(self, name))
        # The client's own resources, bound to this batch so their writes
        # queue. One a test swapped in for its own is used as it is.
        for name in ('documents', 'comments', 'guidelines', 'vocab_layers', 'vocab_items'):
            resource = getattr(client, name, None)
            if isinstance(resource, (FakeClient._Documents, FakeClient._Comments,
                                     FakeClient._Guidelines, FakeClient._VocabLayers,
                                     FakeClient._VocabItems)):
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

    def ref(self, op_index=-1, index=None):
        """The real batch's stand-in for the id a queued op will create
        (``PlaidBatch.ref``): a BatchRef for op n, or with ``index`` the k-th
        id of a bulk create. The fake records it as given."""
        n = len(self.queued) + op_index if op_index < 0 else op_index
        if not isinstance(n, int) or n < 0 or n >= len(self.queued):
            raise PlaidAPIError(f'No operation {op_index} has been queued on this batch')
        return BatchRef(self, n, index)

    def fail_if_asked(self, kind):
        self.client.fail_if_asked(kind)

    def check_open(self, path=''):
        if not self.open:
            raise PlaidAPIError(f'This batch was already submitted or aborted: {path}')

    def record(self, kind, payload=None, result=None):
        self.check_open()
        self.client.note_stamp(kind)
        self.queued.append((kind, payload))
        self.results.append(result if result is not None else {'body': {}})

    def defer(self, effect):
        """Run ``effect`` when the batch submits, where the server would."""
        self._effects.append(effect)

    def note_deletes(self, resource, entity_ids, single):
        """A single delete finds its row gone when an earlier delete in this
        batch took it, and the server 404s the batch. A bulk delete of a gone
        id is accepted."""
        for entity_id in entity_ids:
            key = (resource, entity_id)
            if single and key in self._deleted and self._refused is None:
                self._refused = _refusal(self.client, 404,
                                         f'{resource} {entity_id} was already deleted in this batch',
                                         'POST', '/api/v1/batch')
            self._deleted.add(key)

    def submit(self):
        if not self.open:
            raise PlaidAPIError('This batch was already submitted or aborted')
        self.open = False
        queued, effects, results = self.queued, self._effects, self.results
        self.queued, self._effects, self.results = [], [], []
        if not queued:
            return self.results  # nothing is sent
        # The fake never splits a batch, so a refusal saved nothing, which
        # the real error says as ``committed`` and ``committed_results``.
        if self._refused is not None:
            self._refused.committed, self._refused.committed_results = 0, []
            raise self._refused
        # One transaction: an effect that refuses rolls back the ones before it.
        tables = self.client._guideline_tables()
        before = [[dict(r) for r in rows] for rows in tables]
        try:
            for effect in effects:
                effect()
        except BaseException as error:
            for rows, saved in zip(tables, before):
                rows[:] = saved
            if isinstance(error, PlaidAPIError):
                error.committed, error.committed_results = 0, []
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
    'token_layers': _client.TokenLayersResource,
    'span_layers': _client.SpanLayersResource,
    'relation_layers': _client.RelationLayersResource,
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
    keeps (``_BULK_UPDATE_KEYS``). A bulk create or bulk update of no
    entries, or a bulk update naming one id twice, is the server's 400.

    A metadata write answers the entity as the fixture holds it, with the
    metadata the write leaves (just ``{'id', 'metadata'}`` for an id the
    fixture does not hold). A copy or a split answers a new ``{'id'}``, as a
    create does."""

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
            writer.note_deletes(self._name, [first], single=True)
        elif on_batch and method == 'bulk_delete':
            writer.note_deletes(self._name, payload, single=False)
        return {'batched': True} if on_batch else answer

    def _shape(self, writer, method, args, kwargs, arguments, first, sent):
        """What a write records, what a batch's results carry for it, and
        what it answers made on the client."""
        if method == 'create':
            # A create given the id to make it under answers that id.
            new = arguments.get('id') or writer.new_id(self._name)
            if self._name == 'texts':
                _root(self._client).text_bodies[new] = arguments.get('body') or ''
            return {'args': args, 'kwargs': kwargs}, {'body': {'id': new}}, {'id': new}
        if method == 'bulk_create':
            ops = list(arguments['body'])
            if not ops:
                raise _refusal(_root(self._client), 400, f'A {self._name} bulk create needs '
                               'at least one entry', sent.method, sent.path)
            self._check_bulk_create(ops, sent)
            ids = [writer.new_id(self._name) for _ in ops]
            return ops, {'body': {'ids': ids}}, {'ids': ids}
        if method == 'bulk_update':
            items = list(arguments['body'])
            self._check_bulk_update(items, sent)
            return items, {'body': {'count': len(items)}}, {'count': len(items)}
        if method == 'bulk_delete':
            return list(arguments['body']), {'body': {}}, None
        if method in ('set_metadata', 'patch_metadata', 'delete_metadata'):
            entity = _find_entity(_root(self._client)._documents, first) or {'id': first}
            if method == 'patch_metadata':
                payload = (first, checked_ops(arguments['body']))
                metadata = apply_metadata_ops(entity.get('metadata') or {}, arguments['body'])
            else:
                payload = _payload(args, kwargs)
                metadata = dict(arguments['body']) if method == 'set_metadata' else {}
            answer = {**entity, 'metadata': metadata}
            return payload, {'body': answer}, answer
        if method in ('copy', 'split'):
            new = arguments.get('id') or writer.new_id(self._name)
            return _payload(args, kwargs), {'body': {'id': new}}, {'id': new}
        if method == 'check_constraints':
            # The fake holds no layer data, so nothing breaks a rule.
            answer = {'violations': [], 'violation_count': 0}
            return _payload(args, kwargs), {'body': answer}, answer
        if method == 'repair_constraints':
            answer = {'repaired': [], 'locked': [], 'violations': [], 'violation_count': 0}
            return _payload(args, kwargs), {'body': answer}, answer
        return _payload(args, kwargs), {'body': {}}, {}

    #: the key naming the one layer every entry of a bulk create must share
    _BULK_LAYER_KEY = {'tokens': 'token_layer_id', 'spans': 'span_layer_id',
                       'relations': 'relation_layer_id'}

    def _check_bulk_create(self, ops, sent):
        """The server's two rules on a bulk create: every entry in one layer,
        and on a partitioning layer (the sentence layer, by its role) the
        whole of the text, in tokens with no gap and no overlap."""
        root = _root(self._client)
        key = self._BULK_LAYER_KEY.get(self._name)
        if not key:
            return
        layers = {op.get(key) for op in ops}
        if len(layers) > 1:
            noun = self._name[:-1].capitalize()
            raise _refusal(root, 400, f'{noun}s must all belong to the same layer',
                           sent.method, sent.path)
        if self._name != 'tokens' or layers.pop() not in root.partitioning_layers():
            return
        length = root.text_length(ops[0].get('text'))
        if length is None:
            return
        spans = sorted((op['begin'], op['end']) for op in ops)
        if spans[0][0] != 0:
            raise _refusal(root, 400, "Partition must start at the extent's begin",
                           sent.method, sent.path)
        if spans[-1][1] != length:
            raise _refusal(root, 400, "Partition must end at the extent's end",
                           sent.method, sent.path)
        if any(a[1] != b[0] for a, b in zip(spans, spans[1:])):
            raise _refusal(root, 400, 'Partition requires contiguous tokens (no gaps or overlaps)',
                           sent.method, sent.path)

    def _check_bulk_update(self, items, sent):
        allowed, required = _BULK_UPDATE_KEYS[self._name]
        ids = [item.get('id') for item in items]
        if not items or len(ids) != len(set(ids)):
            raise _refusal(_root(self._client), 400, f'A {self._name} bulk update needs at least '
                           'one entry, and names each id once', sent.method, sent.path)
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
    """What ``with client.operation(...) as op`` yields: an ``id`` and
    ``set_message``, which refines the label only on the outermost operation,
    as the real client's handle does and nothing more. The label the audit
    log ends up with is the client's ``operation_labels`` entry."""
    __slots__ = ('id', '_labels', '_index', '_outermost')

    def __init__(self, op_id, labels, index, outermost):
        self.id = op_id
        self._labels = labels
        self._index = index
        self._outermost = outermost

    def set_message(self, message):
        if self._outermost:
            self._labels[self._index] = message


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


def _with_end_times(entry):
    """A copy of a fixture audit entry carrying ``end_time`` on each op as the
    server sends it, where the fixture left it out: the time to read at to see
    that op done (its own ``time``, or the last ``time`` among the entry's ops
    of its ``batch_id``). An op with no ``time`` of its own takes the entry's.
    A value the fixture gives is kept."""
    ops = [dict(o) for o in entry.get('ops') or []]
    batch_end = {}
    for o in ops:
        if o.get('batch_id') and o.get('time'):
            batch_end[o['batch_id']] = max(batch_end.get(o['batch_id'], ''), o['time'])
    fallback = entry.get('end_time') or entry.get('time')
    for o in ops:
        o.setdefault('end_time', batch_end.get(o.get('batch_id')) or o.get('time') or fallback)
    out = {**entry}
    if 'ops' in entry:
        out['ops'] = ops
    return out


def _with_entry_end_time(entry, given):
    """``entry`` with the ``end_time`` the server gives it, its last op's
    (after an ``op_types`` filter, the last op the filter kept), unless the
    fixture ``given`` carried one."""
    if 'end_time' in given:
        return entry
    ops = entry.get('ops') or []
    return {**entry, 'end_time': ops[-1]['end_time'] if ops else entry.get('time')}


def _audit_filter(entries, start_time, end_time, op_types, kinds=None):
    """An audit read's filters, as the server applies them: the time range is
    inclusive at both ends, ``op_types`` keeps an entry one of whose
    operations matches, carrying only the ones that do, and ``kinds`` keeps
    whole the entries whose operation has one of those kinds."""
    wanted = set(kinds.split(',') if isinstance(kinds, str) else kinds or [])
    out = [(_with_end_times(e), e) for e in entries
           if (not start_time or (e.get('time') or '') >= start_time)
           and (not end_time or (e.get('time') or '') <= end_time)
           and (not wanted or e.get('kind') in wanted)]
    if op_types:
        types = set(op_types.split(',') if isinstance(op_types, str) else op_types)
        out = [({**e, 'ops': [o for o in e.get('ops') or [] if o.get('type') in types]}, given)
               for e, given in out]
        out = [(e, given) for e, given in out if e['ops']]
    return [_with_entry_end_time(e, given) for e, given in out]


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

    A caller that reads SEVERAL projects (an assistant a user has added other
    projects to) also gives ``projects``, the other projects this user can
    read, as ``{pid: {'project', 'documents', 'guidelines', 'comments',
    'audit'}}`` (every key but ``project`` optional, ``documents`` by id).
    ``projects.get``, ``projects.list``, ``projects.list_documents``,
    ``projects.audit``, ``guidelines.list`` and ``comments.list`` then answer
    for the project they name, ``documents.get`` and ``documents.audit`` for
    the project holding the document, and a project that is neither this one
    nor in the map is the 403 the server gives a user who cannot read it.
    Without ``projects``, ``projects.get`` answers ``project`` whatever id it
    is given. ``services`` is ``{pid: [service entries]}``, what
    ``messages.discover_services`` answers for each project.

    ``vocabularies`` is ``{vid: vocabulary}``, each as the server's
    ``vocab_layers.get(..., include_items=True)`` answers (``items`` included),
    and ``vocab_audit`` is ``{vid: [audit entries]}``, with a key ``(vid,
    item_id)`` for what an ``item_id=`` read answers. ``vocab_layers.get``,
    ``get_item_at``, ``audit`` and ``audit_page`` answer from them, and an
    entry restore answers, done or dry, with ``vocab_restore_summary``. An
    ``as_of`` is accepted and answered with the fixture as it is: the fake
    has no history. ``vocab_items.get`` reads one entry out of them, and an
    entry no vocabulary holds is the server's 404.
    """

    #: resources a caller may write through, each recording under its own name.
    RESOURCES = ('tokens', 'spans', 'relations', 'texts', 'vocab_links', 'vocab_items',
                 'token_layers', 'span_layers', 'relation_layers')

    def __init__(self, documents, fails=None, *, project=None, audit=None, guidelines=None,
                 comments=None, restore_summary=None, projects=None, services=None,
                 vocabularies=None, vocab_audit=None, vocab_restore_summary=None,
                 limits=None):
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
        #: the label each operation was begun with
        self.operations = []
        #: the label each operation ends with, index for index with
        #: ``operations``: the one it was begun with, or what the outermost
        #: operation's ``set_message`` refined it to
        self.operation_labels = []
        #: {'kind', 'ref'} each operation was begun with, index for index
        #: with ``operations``
        self.operation_tags = []
        #: {'tokens.bulk_create': <exception>} -- raised when that call is made.
        self.fails = dict(fails or {})
        self.project = project
        self.audit = list(audit or [])
        self.guideline_rows = list(guidelines or [])
        self.comment_rows = list(comments or [])
        self.restore_summary = restore_summary
        #: the other projects this user can read, each as ``{'project',
        #: 'documents', 'guidelines', 'comments', 'audit'}``, or None when the
        #: fake knows one project only
        self.other_projects = None if projects is None else {
            pid: {'project': spec['project'],
                  'documents': dict(spec.get('documents') or {}),
                  'guidelines': list(spec.get('guidelines') or []),
                  'comments': list(spec.get('comments') or []),
                  'audit': list(spec.get('audit') or [])}
            for pid, spec in projects.items()}
        #: {pid: [service entries]} for ``messages.discover_services``
        self.services = {pid: list(entries) for pid, entries in (services or {}).items()}
        #: {vid: vocabulary with its ``items``} for ``vocab_layers`` reads
        self.vocabularies = dict(vocabularies or {})
        #: {vid: [audit entries]} for ``vocab_layers.audit``
        self.vocab_audit = {vid: list(entries) for vid, entries in (vocab_audit or {}).items()}
        self.vocab_restore_summary = vocab_restore_summary
        #: strict mode, as the real client keeps it: the document every write
        #: is stamped for, and the versions it has learned
        self.strict_mode_document_id = None
        self.document_versions = {}
        #: ``(kind, document id, version)`` for each write asked for while
        #: strict mode was on, queued or not, in order: the stamp it carried
        self.stamps = []
        self._ids = itertools.count(1)
        self._operation_depth = 0
        self.documents = FakeClient._Documents(self)
        self.projects = FakeClient._Projects(self)
        self.comments = FakeClient._Comments(self)
        self.guidelines = FakeClient._Guidelines(self)
        self.user_data = FakeClient._UserData(self.base_url)
        self.messages = FakeClient._Messages(self)
        # A subclass that answers vocabulary reads its own way, as a property,
        # keeps it.
        if not isinstance(inspect.getattr_static(self, 'vocab_layers', None), property):
            self.vocab_layers = FakeClient._VocabLayers(self)
        for name in self.RESOURCES:
            setattr(self, name, Resource(self, name))
        self.vocab_items = FakeClient._VocabItems(self)
        #: what ``server.limits()`` answers, GET /info's limits (none given:
        #: the fake reports none, as an older server would)
        self.limits = dict(limits or {})
        #: each body ``query`` was asked, in order
        self.queries = []
        #: the body of each text made by ``texts.create``, by its id
        self.text_bodies = {}
        self.server = types.SimpleNamespace(limits=lambda: dict(self.limits),
                                            info=lambda: {'limits': dict(self.limits)})

    # -- recording --
    def new_id(self, prefix):
        return f'{prefix}-{next(self._ids)}'

    def fail_if_asked(self, kind):
        error = self.fails.get(kind)
        if error is not None:
            raise error

    def record(self, kind, payload=None, result=None):
        self.note_stamp(kind)
        self.calls.append((kind, payload))

    def note_stamp(self, kind):
        """Remember the strict-mode stamp a write carries, as the real client
        puts it on the request when the write is made (queued or not)."""
        if self.strict_mode_document_id and kind not in ('lock', 'unlock', 'read', 'operation'):
            doc = self.strict_mode_document_id
            self.stamps.append((kind, doc, self.document_versions.get(doc)))

    def enter_strict_mode(self, document_id):
        self.strict_mode_document_id = document_id

    def exit_strict_mode(self):
        self.strict_mode_document_id = None

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

    def _fixture_token_layers(self):
        docs = self._documents.values() if isinstance(self._documents, dict) else self._documents
        for holder in [self.project or {}, *docs]:
            for text_layer in (holder or {}).get('text_layers') or []:
                yield text_layer, text_layer.get('token_layers') or []

    def partitioning_layers(self):
        """The token layers the server keeps as a partition of the text: the
        sentence layer, known by its role."""
        return {layer['id'] for _, layers in self._fixture_token_layers() for layer in layers
                if ((layer.get('config') or {}).get('plaid') or {}).get('role') == 'sentence'}

    def text_length(self, text_id):
        """The length of a text a document holds or a create made, or None."""
        if text_id in self.text_bodies:
            return len(self.text_bodies[text_id])
        for text_layer, _ in self._fixture_token_layers():
            text = text_layer.get('text') or {}
            if text.get('id') == text_id and text.get('body') is not None:
                return len(text['body'])
        return None

    def query(self, body):
        """The one query the fake runs: the ids of a lexicon entry's links
        (``where [['link', '?l', {'item': id}]]``, grouped by ``'?l.id'``),
        answered from the documents as given, in document order, ``limit`` at
        most. Each query is kept in ``queries``. Any other is refused, as the
        server refuses a query it cannot run, so a test that needs one sets
        ``client.query`` to its own engine."""
        self.queries.append(body)
        where = body.get('where') or []
        group = (body.get('return') or {}).get('group') if isinstance(body.get('return'), dict) else None
        if not (len(where) == 1 and where[0][:1] == ['link'] and len(where[0]) == 3
                and set(where[0][2]) == {'item'} and group == [f'{where[0][1]}.id']):
            raise _refusal(self, 400, 'The fake client runs no such query', 'POST', '/api/v1/query')
        item = where[0][2]['item']
        docs = self._documents.values() if isinstance(self._documents, dict) else self._documents[-1:]
        rows = []
        for doc in docs:
            for text_layer in doc.get('text_layers') or []:
                for token_layer in text_layer.get('token_layers') or []:
                    for vocab in token_layer.get('vocabs') or []:
                        for link in vocab.get('vocab_links') or []:
                            target = link.get('vocab_item')
                            if (target.get('id') if isinstance(target, dict) else target) == item:
                                rows.append([link['id'], 1])
        rows = rows[:body['limit']] if body.get('limit') else rows
        return {'return': 'aggregate', 'columns': ['l_id', 'count'], 'results': rows,
                'count': len(rows), 'truncated': False}

    # -- which project answers --
    def _home(self):
        """This project's own fixture, in the shape of an ``other_projects``
        entry. The lists are the fake's own, so a guideline write shows."""
        return {'project': self.project, 'documents': self._documents,
                'guidelines': self.guideline_rows, 'comments': self.comment_rows,
                'audit': self.audit}

    def _project(self, project_id, path):
        """The fixture of the project ``project_id`` names. Knowing several,
        one it does not know is the server's 403 for a user who cannot read
        it. Knowing one, every id is that one."""
        if self.other_projects is None or project_id == (self.project or {}).get('id'):
            return self._home()
        if project_id in self.other_projects:
            return self.other_projects[project_id]
        raise _refusal(self, 403, 'You do not have access to this project', 'GET', path)

    def _holder(self, document_id):
        """The fixture of the project holding the document: another
        project's when one of them has it, else this one's."""
        for spec in (self.other_projects or {}).values():
            if document_id in spec['documents']:
                return spec
        return self._home()

    def _guideline_tables(self):
        """Every project's guideline rows, this one's first."""
        return [self.guideline_rows,
                *(spec['guidelines'] for spec in (self.other_projects or {}).values())]

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

    def key_seed(self):
        """The real client's seed for an operation's Idempotency-Keys. The
        fake sends no headers, so ``keys`` is accepted and ignored."""
        return {'seed': uuid7(), 'stamps': {}}

    @contextlib.contextmanager
    def operation(self, message, *, kind=None, ref=None, group_id=None, keys=None, minted=None):
        self.operations.append(message)
        self.operation_tags.append({'kind': kind, 'ref': ref})
        self.operation_labels.append(message)
        self.record('operation', message)
        op = _Operation(group_id or f'op-{len(self.operations)}', self.operation_labels,
                        len(self.operations) - 1, self._operation_depth == 0)
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
            holder = root._holder(document_id)
            documents = holder['documents']
            if isinstance(documents, dict):
                if document_id not in documents:
                    raise _refusal(root, 404, 'Document not found', 'GET', path)
                doc = documents[document_id]
            else:
                doc = documents[min(len(root.reads) - 1, len(documents) - 1)]
            if not include_body:
                return {k: v for k, v in doc.items() if k != 'text_layers'}
            if not named:
                return doc
            named = set(named.split(','))
            unknown = sorted(named - _layer_ids(doc) - _layer_ids(holder['project']))
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

        def audit(self, document_id, *, start_time=None, end_time=None, op_types=None,
                  kinds=None):
            entries = [e for e in self._root._holder(document_id)['audit']
                       if any(d['id'] == document_id for d in e.get('documents', []))]
            return _audit_filter(entries, start_time, end_time, op_types, kinds)

        def audit_page(self, document_id, *, start_time=None, end_time=None,
                       op_types=None, kinds=None, order=None, limit=None, cursor=None):
            entries = self.audit(document_id, start_time=start_time, end_time=end_time,
                                 op_types=op_types, kinds=kinds)
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

        def get(self, id):
            return self._client._project(id, f'/api/v1/projects/{id}')['project']

        def list(self):
            c = self._client
            home = [c.project] if c.project else []
            return home + [spec['project'] for spec in (c.other_projects or {}).values()]

        def audit(self, project_id, *, start_time=None, end_time=None, op_types=None,
                  kinds=None):
            spec = self._client._project(project_id, f'/api/v1/projects/{project_id}/audit')
            return _audit_filter(spec['audit'], start_time, end_time, op_types, kinds)

        def audit_page(self, project_id, *, start_time=None, end_time=None,
                       op_types=None, kinds=None, order=None, limit=None, cursor=None):
            entries = self.audit(project_id, start_time=start_time, end_time=end_time,
                                 op_types=op_types, kinds=kinds)
            return self._client._audit_page(entries, order, limit, cursor, start_time)

        def list_documents(self, id):
            docs = self._client._project(id, f'/api/v1/projects/{id}/documents')['documents']
            docs = docs.values() if isinstance(docs, dict) else docs
            return [{'id': d.get('id'), 'name': d.get('name'), 'version': d.get('version'),
                     'time_created': d.get('time_created'),
                     'time_modified': d.get('time_modified')} for d in docs]

    class _VocabLayers:
        """A vocabulary's reads, its log and the restore of one entry. Reads
        answer from ``vocabularies`` and ``vocab_audit`` (a vocabulary the fake
        does not hold is the server's 404). The restore records like any
        write, and queues when made on a batch."""

        def __init__(self, writer):
            self._client = writer
            self._root = _root(writer)

        def _vocabulary(self, id, path):
            vocabulary = self._root.vocabularies.get(id)
            if vocabulary is None:
                raise _refusal(self._root, 404, 'Vocab layer not found', 'GET', path)
            return vocabulary

        def get(self, id, *, include_items=None, as_of=None):
            vocabulary = self._vocabulary(id, f'/api/v1/vocab-layers/{id}')
            if include_items:
                return copy.deepcopy(vocabulary)
            return copy.deepcopy({k: v for k, v in vocabulary.items() if k != 'items'})

        def get_item_at(self, id, item_id, as_of):
            path = f'/api/v1/vocab-layers/{id}/items/{item_id}'
            for item in self._vocabulary(id, path).get('items') or []:
                if item.get('id') == item_id:
                    return copy.deepcopy(item)
            raise _refusal(self._root, 404, 'The entry did not exist at that time.', 'GET', path)

        def audit(self, id, *, start_time=None, end_time=None, op_types=None, item_id=None,
                  kinds=None):
            self._vocabulary(id, f'/api/v1/vocab-layers/{id}/audit')
            key = (id, item_id) if item_id else id
            return _audit_filter(self._root.vocab_audit.get(key, []), start_time, end_time,
                                 op_types, kinds)

        def audit_page(self, id, *, start_time=None, end_time=None,
                       op_types=None, kinds=None, order=None, limit=None, cursor=None,
                       item_id=None):
            entries = self.audit(id, start_time=start_time, end_time=end_time, op_types=op_types,
                                 item_id=item_id, kinds=kinds)
            return self._root._audit_page(entries, order, limit, cursor, start_time)

        def restore_item(self, id, item_id, as_of, *, dry_run=False, audit_message=None):
            """The server's entry restore, recorded dry or not. Either way it
            answers with ``vocab_restore_summary``: what WOULD change, or what
            did."""
            writer = self._client
            if isinstance(writer, _Batch):
                writer.check_open(f'/api/v1/vocab-layers/{id}/items/{item_id}/restore')
            summary = self._root.vocab_restore_summary
            writer.fail_if_asked('vocab_layers.restore_item')
            writer.record('vocab_layers.restore_item',
                          {'args': (id, item_id, as_of), 'kwargs': {'dry_run': dry_run}},
                          {'body': summary})
            return {'batched': True} if isinstance(writer, _Batch) else summary

    class _VocabItems(Resource):
        """One entry read by id, answered from ``vocabularies`` as the server
        shapes it (the entry with its vocabulary as ``layer``). An entry no
        vocabulary holds, deleted or merged away, is the server's 404 (an
        administrator's answer: anyone else gets a 403, which a test gives
        through ``fails``). Writes record like any resource's, and queue when
        made on a batch."""

        def __init__(self, writer):
            super().__init__(writer, 'vocab_items')
            self._root = _root(writer)

        def get(self, id):
            root = self._root
            root.fail_if_asked('vocab_items.get')
            for vid, vocabulary in root.vocabularies.items():
                for item in vocabulary.get('items') or []:
                    if item.get('id') == id:
                        return copy.deepcopy({**item, 'layer': vid})
            raise _refusal(root, 404, 'Vocab item not found', 'GET', f'/api/v1/vocab-items/{id}')

    class _Comments:
        """The project's comments, read from the fixture. A comment posted is
        recorded, queued when made on a batch, and not added to the rows a
        later ``list`` reads."""

        def __init__(self, writer):
            self._writer = writer
            self._root = _root(writer)

        def list(self, project_id, *, document_id=None, entity_type=None, entity_id=None):
            rows = self._root._project(project_id, f'/api/v1/projects/{project_id}/comments')
            return [r for r in rows['comments']
                    if (not document_id or r.get('document_id') == document_id)
                    and (not entity_type or r.get('entity_type') == entity_type)
                    and (not entity_id or r.get('entity_id') == entity_id)]

        def create(self, entity_type, entity_id, body, *, anchor_label=None, id=None):
            writer = self._writer
            on_batch = isinstance(writer, _Batch)
            if on_batch:
                writer.check_open('/api/v1/comments')
            new = id or writer.new_id('comments')
            writer.fail_if_asked('comments.create')
            kwargs = {} if anchor_label is None else {'anchor_label': anchor_label}
            if id is not None:
                kwargs['id'] = id
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

        def _rows(self, project_id):
            path = f'/api/v1/projects/{project_id}/guidelines'
            return self._root._project(project_id, path)['guidelines']

        def _table(self, guideline_id, method):
            """The rows of whichever project holds the guideline."""
            for rows in self._root._guideline_tables():
                if any(r.get('id') == guideline_id for r in rows):
                    return rows
            raise _refusal(self._root, 404, 'Guideline not found', method,
                           f'/api/v1/guidelines/{guideline_id}')

        def _row(self, guideline_id, method):
            rows = self._table(guideline_id, method)
            return next(r for r in rows if r.get('id') == guideline_id)

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
            for r in self._rows(project_id):
                row = {'project': project_id, 'created_at': r.get('updated_at'), **r}
                if not include_bodies:
                    row = {k: v for k, v in row.items() if k != 'body'} | {
                        'body_chars': len(r.get('body') or '')}
                out.append(row)
            return out

        def get(self, guideline_id):
            return dict(self._row(guideline_id, 'GET'))

        def create(self, project_id, title, *, body=None, pinned=None, audit_message=None,
                   id=None):
            new = id or self._writer.new_id('guidelines')
            now = _now_iso()
            row = {'id': new, 'project': project_id, 'title': title, 'body': body or '',
                   'pinned': bool(pinned), 'created_at': now, 'updated_at': now}

            rows = self._rows(project_id)

            def effect():
                rows.append(row)
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
                self._table(guideline_id, 'DELETE').remove(self._row(guideline_id, 'DELETE'))
            return self._write('guidelines.delete', path, guideline_id, {'body': {}}, effect)

    class _Messages:
        """Service discovery, answered from ``services``. The route is
        reader-gated, so a project the fake does not know is a 403."""

        def __init__(self, client):
            self._client = client

        def discover_services(self, project_id):
            c = self._client
            c._project(project_id, f'/api/v1/projects/{project_id}/services')
            return [dict(s) for s in c.services.get(project_id, [])]

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
