"""Batches: the batch object a client opens, how its writes queue, the batch
refs that let a later write use an id an earlier one creates, and how the
queued operations go out (in requests of at most MAX_BATCH_OPS). The twin of
plaid-client-js's batch.js and batchRef.js. Which calls a batch carries is
said at the top of http.py.
"""

from __future__ import annotations

import json
import urllib.parse
from typing import TYPE_CHECKING, Any

from plaid_client.document_lock import writes_landed, writes_started
from plaid_client.http import (
    _UNSET, IDEMPOTENCY_HEADER, NO_PIN, REPLAYED_HEADER, PlaidAPIError, build_api_error,
    extract_document_versions, is_replayed, network_error, next_idempotency_key, note_server_clock,
    prepare_request, restamp_document_version, wire_timeout, with_retries,
)
from plaid_client.replayed import mark_replayed, was_replayed
from plaid_client.transforms import transform_response

if TYPE_CHECKING:
    from plaid_client.client import PlaidClient

# The server's cap on operations per batch request (plaid.rest-api.v1.batch).
# A batch queued past it is submitted as consecutive requests.
MAX_BATCH_OPS = 1000


# ---------------------------------------------------------------------------
# Batch refs: a write in a batch that uses the id an earlier write in the same
# batch creates.
#
# ``b.ref()`` returns a BatchRef, which the caller puts in a later write's body
# where the id goes. When that write is queued, each BatchRef is taken out of
# the body (None is left in its place) and recorded beside it as
# ``refs: [{'at': [key or index, ...], 'op': n, 'index'?: k}]``, which the
# server fills in. The server never searches a body, so user data of any
# shape, ``{'$ref': 0}`` included, is stored as sent. A BatchRef is an object
# no JSON value can be, so data can never be taken for one here either.
# ---------------------------------------------------------------------------

_MISPLACED_REF = 'b.ref() stands for an id only in the body of a later write on the same batch'


class BatchRef:
    """The stand-in :meth:`PlaidBatch.ref` returns: op ``op`` (counted from 0
    in the batch), or with ``index`` the k-th id of that bulk create."""

    __slots__ = ('_batch', 'op', 'index')

    def __init__(self, batch, op, index=None):
        self._batch = batch
        self.op = op
        self.index = index

    def __repr__(self):
        return f'BatchRef(op={self.op}, index={self.index})'

    # Read as the plain ``{'$ref': n, 'index': k}`` it once was, so
    # ``b.ref()['$ref']`` and comparing a recorded payload with that map
    # keep their meaning. Only the class makes a ref: a map of that shape
    # in a body is data.
    def _as_map(self):
        return {'$ref': self.op} if self.index is None else {'$ref': self.op, 'index': self.index}

    def __getitem__(self, key):
        return self._as_map()[key]

    def __eq__(self, other):
        if isinstance(other, BatchRef):
            return (other._batch, other.op, other.index) == (self._batch, self.op, self.index)
        if isinstance(other, dict):
            return other == self._as_map()
        return NotImplemented

    def __hash__(self):
        return hash((id(self._batch), self.op, self.index))

    # A ref names one op of one batch, so a copy is the ref itself.
    def __copy__(self):
        return self

    def __deepcopy__(self, memo):
        return self

    # Put in a path or a query, a ref would go out as text the server takes
    # for an id.
    def __format__(self, spec):
        raise PlaidAPIError(_MISPLACED_REF)

    def __str__(self):
        raise PlaidAPIError(_MISPLACED_REF)


def make_batch_ref(batch, op_index, index):
    """A BatchRef for op ``op_index`` of ``batch`` (negative counts from the
    end, -1 is the op queued last), fixed when it is called."""
    n = len(batch.operations) + op_index if op_index < 0 else op_index
    if not isinstance(n, int) or n < 0 or n >= len(batch.operations):
        raise PlaidAPIError(f'No operation {op_index} has been queued on this batch')
    if index is not None and not (isinstance(index, int) and index >= 0):
        raise PlaidAPIError(f"A ref's index must be a whole number, not {index!r}")
    return BatchRef(batch, n, index)


def _holds_ref(v):
    if isinstance(v, BatchRef):
        return True
    # A tuple is a JSON list to json.dumps, so a ref can be in one too.
    if isinstance(v, (list, tuple)):
        return any(_holds_ref(x) for x in v)
    if isinstance(v, dict):
        return any(_holds_ref(x) for x in v.values())
    return False


def take_refs(batch, body):
    """``(body, refs)``: ``body`` with each BatchRef in it replaced by None,
    and the refs that say where they were, or None when it holds none (the
    body is then returned as it was)."""
    if not _holds_ref(body):
        return body, None
    refs = []
    at = []

    def take(v):
        if isinstance(v, BatchRef):
            if v._batch is not batch:
                raise PlaidAPIError(_MISPLACED_REF)
            refs.append({'at': list(at), 'op': v.op} if v.index is None
                        else {'at': list(at), 'op': v.op, 'index': v.index})
            return None
        if not _holds_ref(v):
            return v
        items = v.items() if isinstance(v, dict) else enumerate(v)
        out = {} if isinstance(v, dict) else []
        for k, x in items:
            at.append(k)
            taken = take(x)
            at.pop()
            if isinstance(out, list):
                out.append(taken)
            else:
                out[k] = taken
        return out

    return take(body), refs


def rebase_refs(refs, start):
    """``refs`` counted from ``start``, for an op in a batch sent in several
    requests (the server counts within one request). A ref to an op of an
    earlier request cannot resolve, so it raises before anything goes."""
    out = []
    for r in refs:
        if r['op'] < start:
            raise PlaidAPIError(
                f"Operation {start} and later are sent in a request of their own, so an operation "
                f"among them cannot use the id operation {r['op']} creates")
        out.append({**r, 'op': r['op'] - start})
    return out


def _unsendable(v):
    """``json.dumps``'s ``default``: a BatchRef outside a queued body is a
    caller's mistake the error should name."""
    if isinstance(v, BatchRef):
        raise PlaidAPIError(_MISPLACED_REF)
    raise TypeError(f'Object of type {type(v).__name__} is not JSON serializable')


def queue_request(batch, method, path, *, no_batch=False, out_of_band=False, **kwargs):
    """A call made on a batch (see ``PlaidClient.batch``). A write of project
    data is queued as one operation of the batch and answers
    ``{'batched': True}``; its result is the matching entry of what
    ``submit()`` returns. A read, and a signal marked ``out_of_band``, is the
    client's to make and goes over the wire now, exactly as if it had been
    made on the client."""
    if method == 'GET' or out_of_band:
        return batch.client._request(method, path, out_of_band=out_of_band, **kwargs)
    if not batch.open:
        raise PlaidAPIError(f'This batch was already submitted or aborted: {path}')
    if no_batch:
        raise PlaidAPIError(f'This endpoint cannot be used in a batch: {path}')
    prep = {k: v for k, v in kwargs.items()
            if k in ('body', 'raw_body', 'form_data', 'query_params', 'no_operation',
                     'audit_message', 'versioned')}
    url, request_body, stamped_document, stamped_group, _ = prepare_request(
        batch.client, method, path, **prep)
    operation = {
        'path': url.replace(batch.client.base_url, ''),
        'method': method.upper(),
    }
    if request_body is not None:
        # Each b.ref() in the body goes beside it, as the path to a None the
        # server fills with the id (see BatchRef).
        operation['body'], refs = take_refs(batch, request_body)
        if refs:
            operation['refs'] = refs
    batch.operations.append(operation)
    batch.stamped_documents.append(stamped_document)
    batch.stamped_groups.append(stamped_group)
    return {'batched': True}


def _claimed_version(path):
    """The document-version an op's path claims, as an int, or None."""
    query = path.split('?', 1)[1] if '?' in path else ''
    values = urllib.parse.parse_qs(query).get('document-version')
    return int(values[0]) if values else None


def post_batch(client, url, data, key, timeout):
    """POST one batch request (at most MAX_BATCH_OPS operations, ``data``
    already encoded) through the same retries and version learning as every
    other request, and return ``(results, replayed)``: the server's answer per
    operation as it came, and whether it was replayed from a first send.
    ``key`` is the request's Idempotency-Key: a batch whose answer is lost (no
    response, 502, 504) is sent again under it, and answered from the first
    send if that landed. A refused batch wrote nothing (it is atomic), so a
    503 is retried too. ``timeout`` is the request's own budget, longer than
    a single request's: giving up does not stop the server's transaction.

    Each sub-response's ``X-Document-Versions`` is learned, and the batch's
    own, which holds each document's version after the whole batch, the layer
    rules' remedies at its end included (a split that deletes a relation
    crossing the new boundary moves the version once more). The batch's own
    ``X-Document-Versions-Omitted`` is not taken up: each sub-response keeps
    its own list. Every answer notes the server's clock, as a single
    request's does."""
    headers = {
        'Authorization': f'Bearer {client.token}',
        'Content-Type': 'application/json',
        IDEMPOTENCY_HEADER: key,
    }
    started = writes_started(client)

    def attempt():
        try:
            resp = client.session.post(url, headers=headers, data=data,
                                       timeout=wire_timeout(timeout))
        except PlaidAPIError:
            raise
        except Exception as e:
            raise network_error(e, url, 'POST') from e
        note_server_clock(client, getattr(resp, 'headers', None))
        if not resp.ok:
            raise build_api_error(resp, url, 'POST')
        return resp

    try:
        response = with_retries(client, attempt, keyed=True)
    except PlaidAPIError as e:
        e.idempotency_key = key
        raise
    results = response.json()
    # A replayed batch carries the versions right after its first send.
    replayed = is_replayed(getattr(response, 'headers', None))
    replayed_header = 'true' if replayed else None
    for result in results:
        if isinstance(result, dict) and 'headers' in result:
            extract_document_versions(client, {
                'X-Document-Versions': result['headers'].get('X-Document-Versions'),
                REPLAYED_HEADER: replayed_header})
    extract_document_versions(client, {
        'X-Document-Versions': (getattr(response, 'headers', None) or {}).get('X-Document-Versions'),
        REPLAYED_HEADER: replayed_header})
    writes_landed(client, started, replayed)
    return results, replayed


def send_chunks(client, ops: list[dict], stamped_documents: list | None, stamped_groups: list | None,
                budget) -> list[Any]:
    """Send a batch's queued operations as ``PlaidClient._post_batch``
    describes, ``budget`` being each request's timeout."""

    url = f'{client.base_url}/api/v1/batch'
    # Each request is atomic, the whole is not: a failure leaves the
    # requests before it saved. The error says so, as ``committed`` (how
    # many operations were saved) and ``committed_results`` (their
    # results, in queue order), so a caller can tell a partial write from
    # a batch that saved nothing. The failed request itself counts as
    # unsaved, even when its answer was lost.
    # The results are marked replayed (see replayed.py) when any request
    # was: then some of the batch stored nothing new, which is what a
    # caller reading the mark needs to know. The same holds for
    # ``committed_results``.
    results_out: list[Any] = []
    try:
        # The server caps a batch at MAX_BATCH_OPS so one transaction
        # cannot hold the write lock without bound. A larger batch goes
        # as consecutive requests, results concatenated in queue order:
        # it could not have been one transaction anyway, and a repair or
        # bulk edit over a big document must not fail on its size alone.
        # Past the first request, a strict-mode stamp claims the version
        # the requests before it left (learned from their results), not
        # the one the document had when the op was queued, which the first
        # request has already moved on.
        stamps = stamped_documents or [None] * len(ops)
        # A ref counts ops within one request, so each later request's
        # refs count from its own first op. Every chunk is checked before
        # the first request goes, so refs that cannot resolve write nothing.
        chunks = [[{**op, 'refs': rebase_refs(op['refs'], start)}
                   if start > 0 and 'refs' in op else op
                   for op in ops[start:start + MAX_BATCH_OPS]]
                  for start in range(0, len(ops), MAX_BATCH_OPS)]
        groups = stamped_groups or [None] * len(ops)
        for start, body in zip(range(0, len(ops), MAX_BATCH_OPS), chunks):
            chunk_stamps = stamps[start:start + MAX_BATCH_OPS]
            # One Idempotency-Key per request, minted as the request is
            # formed. Inside an operation opened with keys, a request
            # whose ops joined it takes the operation's next key and
            # claims the version its first run claimed.
            group = client._operation_group
            joins = group is not None and any(
                g is group for g in groups[start:start + MAX_BATCH_OPS])
            key, pin, record = next_idempotency_key(client, joins)

            def claim(doc_id, pin=pin):
                return pin if pin is not NO_PIN else client.document_versions.get(doc_id)

            if start > 0 or pin is not NO_PIN:
                body = [
                    {**op, 'path': restamp_document_version(op['path'], claim(doc_id))}
                    if doc_id else op
                    for op, doc_id in zip(body, chunk_stamps)
                ]
            # Pin what the request actually claims: the first stamped
            # op's version as its path now carries it.
            stamped = next((op for op, d in zip(body, chunk_stamps) if d), None)
            record(_claimed_version(stamped['path']) if stamped else None)
            # Encoded once, before anything goes: a body that cannot be
            # sent is the caller's mistake, never an unknown outcome.
            data = json.dumps(body, default=_unsendable)
            results, replayed = post_batch(client, url, data, key, budget)
            # The server took the request, so each operation it joined exists.
            for group in (stamped_groups or [])[start:start + MAX_BATCH_OPS]:
                if group is not None:
                    group['written'] = True

            results_out.extend({**r, 'body': transform_response(r.get('body'))}
                               if isinstance(r, dict) else r
                               for r in results)
            if replayed and not was_replayed(results_out):
                results_out = mark_replayed(results_out)
        return results_out
    except PlaidAPIError as e:
        e.committed = len(results_out)
        e.committed_results = results_out
        raise
    except Exception as e:
        error = PlaidAPIError(f'Network error: {e} at {client.base_url}/api/v1/batch',
                              url=f'{client.base_url}/api/v1/batch', method='POST',
                              original_error=e)
        error.committed = len(results_out)
        error.committed_results = results_out
        raise error


class PlaidBatch:
    """One batch of writes, opened by :meth:`PlaidClient.batch`.

    The same resources as the client (``documents``, ``tokens``, ...), built
    on this object, so a write made through them queues instead of going out.
    Everything else (the token and base URL, strict mode and the document
    versions it tracks, the open logical operation, ``query``) is the client's
    and resolves to it.
    """

    def __init__(self, client: PlaidClient, *, timeout: float | None = _UNSET):
        # Here, not at the top: client.py imports this module.
        from plaid_client.client import _install_resources

        self.client = client
        #: this batch's own timeout per request, in place of the client's
        #: ``batch_timeout`` (unset: the client's)
        self.timeout = timeout
        self.operations: list[dict] = []
        #: the document each queued op's strict-mode stamp is for (None for
        #: none), index for index with ``operations``
        self.stamped_documents: list[str | None] = []
        #: the logical operation each queued op joined (None for none), index
        #: for index with ``operations``
        self.stamped_groups: list[dict | None] = []
        self.open = True
        self.results: list[Any] = []
        _install_resources(self)

    def __getattr__(self, name):
        # Only reached for what the batch does not have itself.
        return getattr(self.client, name)

    def _request(self, method, path, **kwargs):
        return queue_request(self, method, path, **kwargs)

    def batch(self):
        raise PlaidAPIError('A batch is not nestable: queue on the batch you have')

    def batched(self):
        raise PlaidAPIError('A batch is not nestable: queue on the batch you have')

    def submit(self) -> list[Any]:
        """Send the queued operations and return one result per operation, in
        order (also kept on ``.results``). Up to MAX_BATCH_OPS operations go
        as one atomic request. A larger batch goes as consecutive requests,
        each atomic on its own, so a failure in a later one leaves the earlier
        ones committed. The error then carries ``committed``, how many
        operations were saved (0 when none were), and ``committed_results``,
        their results in queue order."""
        if not self.open:
            raise PlaidAPIError('This batch was already submitted or aborted')
        self.open = False
        ops, self.operations = self.operations, []
        stamps, self.stamped_documents = self.stamped_documents, []
        groups, self.stamped_groups = self.stamped_groups, []
        self.results = self.client._post_batch(ops, stamps, groups, timeout=self.timeout) if ops else []
        return self.results

    def abort(self) -> None:
        """Drop the queued operations without sending them."""
        self.operations = []
        self.stamped_documents = []
        self.stamped_groups = []
        self.open = False

    def ref(self, op_index: int = -1, index: int | None = None) -> BatchRef:
        """A stand-in for the id a queued operation will create, to put in a
        later operation's body on this batch, so a create and the write that
        uses it go in one transaction: op n's ``id``, or with ``index`` the
        k-th of the ``ids`` a bulk create answers. ``op_index`` counts from 0,
        or from the end when negative (-1, the default, is the op queued
        last), and is fixed when ``ref`` is called. It goes only in the body
        of a later write on this batch, at any depth. Anywhere else (a path,
        another batch, a call made on the client) the client refuses it::

            with client.batched() as b:
                b.vocab_items.create(vocab_id, 'dog')
                b.vocab_links.create(b.ref(), [token_id])
        """
        return make_batch_ref(self, op_index, index)
