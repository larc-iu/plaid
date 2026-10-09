from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.parse
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote, urlencode

import requests as req_lib

from plaid_client.document_lock import DocumentLock, LockKeeper, lock_ttl_s
from plaid_client.http import (
    PlaidAPIError, make_request, queue_request, extract_document_versions,
    restamp_document_version, BatchRef, make_batch_ref, rebase_refs, _unsendable,
    list_all, list_page, iter_pages, build_api_error, retry_while_busy,
    retry_unknown, is_unknown_outcome, next_idempotency_key, merge_versions, is_replayed, NO_PIN,
    IDEMPOTENCY_HEADER, DEFAULT_TIMEOUT_S, DEFAULT_BATCH_TIMEOUT_S, wire_timeout, query_timeout,
)
from plaid_client.ids import normalize_user_id, uuid7
from plaid_client.replayed import mark_replayed, was_replayed
from plaid_client.transforms import transform_response
from plaid_client.sse import SSEConnection

# The server's cap on operations per batch request (plaid.rest-api.v1.batch).
# A batch queued past it is submitted as consecutive requests.
MAX_BATCH_OPS = 1000
# How long ``admin.backup()`` waits for the server to finish writing a backup:
# minutes on a large database, past the usual per-request timeout.
BACKUP_TIMEOUT_S = 30 * 60
# The kinds an operation may say it is (``?group-kind=``), the server's closed
# list (plaid.sql.operation-group/kinds). An operation of any other kind is
# refused when it begins, before it writes anything.
_OPERATION_KINDS = ('assistant-plan', 'service-run', 'import', 'bulk-edit',
                    'guess-adoption', 'repair', 'review')


def _check_operation_kind(kind) -> None:
    """Raise ``ValueError`` for a ``kind`` the server would refuse."""
    if kind is not None and str(kind) not in _OPERATION_KINDS:
        raise ValueError(f'Unknown operation kind "{kind}". It is one of: '
                         f'{", ".join(_OPERATION_KINDS)}.')


from plaid_client import services as svc


# Sentinel for "argument not supplied". The clients follow a three-state
# convention that mirrors the server: an omitted argument is left out of the
# request body entirely (the server leaves that field unchanged), an explicit
# ``None`` is sent as JSON ``null`` (the server clears / sets the field to
# null), and any other value is sent as-is. ``None`` is therefore a meaningful
# value distinct from "not supplied", so every optional/nullable body parameter
# defaults to ``_UNSET`` rather than ``None``. (This matches the JS client,
# where ``undefined`` is omitted and ``null`` is sent through.)
_UNSET = object()


def _body_of(**kwargs):
    return {k: v for k, v in kwargs.items() if v is not _UNSET}


def _config_request(audit_message, value, expected):
    """The request options of a config write (``value`` is ``_UNSET`` for a
    delete). With ``expected`` given (``None`` meaning the key was absent) the
    write is a compare-and-set: ``?if-unchanged=true`` and the body
    ``{expected, value}``, which the server refuses with a 409 when the stored
    value is no longer ``expected``. Without it the body is the value itself.
    Config is opaque, so neither body is re-cased."""
    opts = {'skip_response_transform': True, 'audit_message': audit_message}
    if expected is _UNSET:
        if value is not _UNSET:
            opts['raw_body'] = value
        return opts
    body = {'expected': expected}
    if value is not _UNSET:
        body['value'] = value
    opts['raw_body'] = body
    opts['query_params'] = {'if-unchanged': True}
    return opts


def _constraints_body(constraints, expected):
    body = {} if constraints is _UNSET else {'constraints': constraints}
    if expected is not _UNSET:
        body['expected'] = expected
    return body


class _ConstraintMethods:
    """The four layer-constraint methods of a layer resource, on
    ``/api/v1/<_kind>``. See ``plaid_client.constraints`` and the core manual,
    "Layer constraints"."""

    _kind = None

    def _constraints_path(self, layer_id):
        return f'/api/v1/{self._kind}/{layer_id}/constraints'

    def set_constraints(self, layer_id: str, namespace: str, constraints: list, audit_message=None,
                        expected: Any = _UNSET) -> Any:
        """Declare an app namespace's constraints on this layer, replacing that
        namespace's list. Refused with 422 and the violations when the layer's
        stored data breaks them (see ``violations_of``).

        Args:
            layer_id: The layer ID
            namespace: The declaring app's namespace, e.g. ``'igt'``
            constraints: e.g. ``[{'type': 'single-span'}, {'type': 'value-set', 'values': ['N']}]``
            expected: The list read for this namespace (``None`` when it was absent). When given,
                the write is refused with a 409 when the stored list differs.

        Returns the layer's whole constraint map as ``{'constraints': {...}}``.
        """
        return self._request('PUT', f'{self._constraints_path(layer_id)}/{namespace}',
                             body=_constraints_body(constraints, expected), audit_message=audit_message)

    def delete_constraints(self, layer_id: str, namespace: str, audit_message=None,
                           expected: Any = _UNSET) -> Any:
        """Remove an app namespace's constraints from this layer.

        Args:
            layer_id: The layer ID
            namespace: The declaring app's namespace
            expected: As on ``set_constraints``.
        """
        body = _constraints_body(_UNSET, expected)
        kwargs = {'body': body} if body else {}
        return self._request('DELETE', f'{self._constraints_path(layer_id)}/{namespace}',
                             audit_message=audit_message, **kwargs)

    def check_constraints(self, layer_id: str, constraints: list) -> Any:
        """The violations the given constraints would meet in this layer's
        stored data, as ``{'violations', 'violation_count'}``. Writes nothing.

        Args:
            layer_id: The layer ID
            constraints: The list to check
        """
        return self._request('POST', f'{self._constraints_path(layer_id)}/check',
                             body={'constraints': constraints})

    def repair_constraints(self, layer_id: str, constraints: list, audit_message=None,
                           document: str = None) -> Any:
        """Apply the remedies of the given constraints' remediable types
        (coextensive, single-span, single-link, same-ancestor) to every
        violation in this layer's stored data, one operation per document.
        With ``document``, only that document is repaired, and a writer may
        ask. A document another user holds the lock on is left as it is and
        listed under ``locked``. Answers ``{'repaired', 'locked',
        'violations', 'violation_count'}``.

        Args:
            layer_id: The layer ID
            constraints: The list to repair for
            document: The one document to repair, or None for every one
        """
        body = {'constraints': constraints}
        if document:
            body['document'] = document
        return self._request('POST', f'{self._constraints_path(layer_id)}/repair',
                             body=body, audit_message=audit_message)


_UNSET_MESSAGE = object()


class _OperationContext:
    """Yielded by ``with client.operation(...)``; lets the block refine the
    label (sent when the outermost operation ends)."""
    __slots__ = ('_group',)

    def __init__(self, group):
        self._group = group

    @property
    def id(self) -> str:
        return self._group['id']

    def set_message(self, message: str | None) -> None:
        if self._group['depth'] == 1:
            self._group['refined'] = message


def _layers_param(layers):
    """Normalize a ``layers`` filter to the wire's comma-separated form.
    Accepts a list of layer ids or a ready-made string; anything empty becomes
    ``None`` so no ``?layers=`` is sent at all.
    """
    if layers is None:
        return None
    joined = layers if isinstance(layers, str) else ','.join(str(x) for x in layers)
    return joined or None


def _op_types_param(op_types):
    """Normalize an audit ``op_types`` filter to the wire's comma-separated
    form. Accepts a list of op types or a ready-made string; anything empty
    becomes ``None`` so no ``?op-types=`` is sent at all.
    """
    if op_types is None:
        return None
    joined = op_types if isinstance(op_types, str) else ','.join(op_types)
    return joined or None


class _Resource:
    def __init__(self, client):
        self._client = client

    def _request(self, method, path, **kwargs):
        # The client's, or the batch's (see PlaidBatch): the same resource
        # built on a batch queues instead of sending.
        return self._client._request(method, path, **kwargs)


class VocabLinksResource(_Resource):
    def create(self, vocab_item: str, tokens: list, metadata: Any = _UNSET, audit_message=None,
               *, id: str | None = None) -> Any:
        """Create a new vocab link between tokens and a vocab item.

        Args:
            vocab_item: The vocab item to link
            tokens: The tokens to link
            metadata: Metadata for the link. Omit to leave unset; pass ``None``
                to send JSON null.
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/vocab-links',
                             body=_body_of(id=_UNSET if id is None else id, vocab_item=vocab_item, tokens=tokens, metadata=metadata), audit_message=audit_message)

    def bulk_create(self, body: list, audit_message=None) -> dict:
        """Create multiple vocab links in a single operation.

        Entries may reference different vocab items, but all tokens across the
        call must belong to one document. Each entry is a dict with keys
        ``vocab_item``, ``tokens``, and optional ``metadata``.

        Args:
            body: The vocab links to create

        Returns:
            ``{"ids": [...]}`` — the created link IDs, in input order. (All
            bulk_create endpoints share this shape; bulk_delete returns no body.)
        """
        return self._request('POST', '/api/v1/vocab-links/bulk', body=body, audit_message=audit_message)

    def bulk_delete(self, body: list, audit_message=None) -> Any:
        """Delete multiple vocab links in a single operation. Provide a list of IDs.

        Args:
            body: The request body
        """
        return self._request('DELETE', '/api/v1/vocab-links/bulk', body=body, audit_message=audit_message)

    def set_metadata(self, id: str, body: Any, audit_message=None) -> Any:
        """Replace all metadata for a vocab link.

        The entire metadata map is replaced - existing metadata keys not
        included in the request will be removed.

        Args:
            id: The resource ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/vocab-links/{id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def delete_metadata(self, id: str, audit_message=None) -> Any:
        """Remove all metadata from a vocab link.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-links/{id}/metadata',
                             audit_message=audit_message)

    def patch_metadata(self, id: str, body: Any, audit_message=None) -> Any:
        """Edit metadata for a vocab link with a list of ops applied in order.

        ``{"op": "set", "path": [...], "value": v}`` writes v at the path,
        creating missing objects along it; ``{"op": "delete", "path": [...]}``
        removes the key at the path (a no-op when absent). A path is a
        non-empty list of keys, the first a top-level key. A path through a
        non-object is refused (400). See :func:`metadata_ops` and
        :func:`apply_metadata_ops`.

        Args:
            id: The resource ID
            body: The metadata ops
        """
        return self._request('PATCH', f'/api/v1/vocab-links/{id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def get(self, id: str) -> Any:
        """Get a vocab link by ID.

        Args:
            id: The resource ID
        """
        return self._request('GET', f'/api/v1/vocab-links/{id}')

    def delete(self, id: str, audit_message=None) -> Any:
        """Delete a vocab link.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-links/{id}', audit_message=audit_message)


class VocabLayersResource(_Resource):
    def get(self, id: str, *, include_items: bool | None = None,
            as_of: str | None = None) -> Any:
        """Get a vocab layer by ID.

        With ``as_of``, the vocabulary as it was at that instant, read from
        its history: the same shape as the live read, its entries with
        ``include_items``. A vocabulary that did not exist then is a 404, a
        malformed or pruned time a 400.

        Args:
            id: The resource ID
            include_items: Include vocab items
            as_of: The moment to read at (ISO-8601 instant)
        """
        return self._request('GET', f'/api/v1/vocab-layers/{id}',
                             query_params={'include-items': include_items, 'as-of': as_of})

    def get_item_at(self, id: str, item_id: str, as_of: str) -> Any:
        """One entry of the vocabulary as it was at ``as_of``, also when it
        has been deleted since.

        The same shape as ``vocab_items.get``. A 404 when the entry was not
        in this vocabulary at that time.

        Args:
            id: The vocabulary ID
            item_id: The entry ID
            as_of: The moment to read at (ISO-8601 instant)
        """
        return self._request('GET', f'/api/v1/vocab-layers/{id}/items/{item_id}',
                             query_params={'as-of': as_of})

    def audit(self, id: str, *, start_time: str | None = None,
              end_time: str | None = None,
              op_types=None, item_id: str | None = None, kinds=None) -> Any:
        """Get the audit log of a vocabulary.

        Every change to the vocabulary or to its entries, folded into entries
        as the document log is. Links are not listed, they belong to the
        document they annotate. Transparently follows server-side pagination
        cursors and returns the full flat list of audit entries.

        Args:
            id: The vocabulary ID
            start_time: Start of time range
            end_time: End of time range
            op_types: Only return operations of these types, spelled as in an
                entry's ``op/type`` (e.g.
                ``['vocab-item/delete', 'vocab-item/restore']``)
            item_id: Only the changes that wrote this one entry, each with
                only its operations that did
            kinds: Only the entries of operations of these kinds, as a list or
                comma-separated string (e.g. ``['review']``), each whole
        """
        return list_all(self._client, f'/api/v1/vocab-layers/{id}/audit',
                        query={'start-time': start_time, 'end-time': end_time,
                               'op-types': _op_types_param(op_types),
                               'kinds': _op_types_param(kinds),
                               'item-id': item_id})

    def audit_page(self, id: str, *, start_time: str | None = None,
                   end_time: str | None = None,
                   op_types: Any = None, kinds: Any = None, order: str | None = None,
                   limit: int | None = None, cursor: str | None = None,
                   ops_limit: int | None = None, entry_id: str | None = None,
                   item_id: str | None = None) -> Any:
        """One page of the same log, newest-first with ``order='desc'``.

        Use this rather than audit() wherever the caller wants the recent end
        of a log that may be long: audit() walks every page before it returns.

        Args:
            order: ``'desc'`` pages newest-first; a cursor belongs to the
                direction that produced it
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            ops_limit: Keep only each entry's oldest N operations in
                ``ops`` (1..1000). ``op_count`` on every entry says how many
                it has
            entry_id: Read only this entry, not a page
            item_id: Only the changes that wrote this one entry
        """
        return list_page(self._client, f'/api/v1/vocab-layers/{id}/audit', limit=limit, cursor=cursor,
                         query={'start-time': start_time, 'end-time': end_time,
                                'op-types': _op_types_param(op_types),
                                'kinds': _op_types_param(kinds),
                                'order': order, 'ops-limit': ops_limit, 'entry-id': entry_id, 'item-id': item_id})

    def restore_item(self, id: str, item_id: str, as_of: str, *, dry_run: bool = False,
                     audit_message: str | None = None) -> Any:
        """Put one entry of the vocabulary back as it was at ``as_of``, as one
        operation.

        A deleted entry comes back under its original id with its form and
        fields, and a living one has its form and fields set back. Links are
        not part of an entry: a deleted entry's links come back through each
        document's own ``documents.restore``. Returns ``{'inserted', 'form',
        'metadata', 'total'}``, ``total`` 0 when nothing changes. A form set
        back bumps every linking document, and the new versions come back in
        X-Document-Versions (or, past fifty documents,
        X-Document-Versions-Omitted), which the client takes up as on any
        write. A time when the entry did not exist is a 400. Maintainers of
        the vocabulary only.

        Args:
            id: The vocabulary ID
            item_id: The entry ID
            as_of: The moment to go back to (ISO-8601 instant), typically a
                history entry's ``end_time``
            dry_run: When true nothing is written and the summary says what
                would change
            audit_message: Custom audit message for this operation
        """
        return self._request('POST', f'/api/v1/vocab-layers/{id}/items/{item_id}/restore',
                             query_params={'as-of': as_of,
                                           'dry-run': 'true' if dry_run else None},
                             audit_message=audit_message)

    def delete(self, id: str, audit_message=None) -> Any:
        """Delete a vocab layer.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}', audit_message=audit_message)

    def update(self, id: str, name: str, audit_message=None) -> Any:
        """Update a vocab layer's name.

        Args:
            id: The resource ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/vocab-layers/{id}',
                             body=_body_of(name=name), audit_message=audit_message)

    def set_config(self, id: str, namespace: str, config_key: str, config_value: Any, audit_message=None,
                   expected: Any = _UNSET) -> Any:
        """Set a configuration value for a vocab layer in an editor namespace.

        Args:
            id: The resource ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
            expected: The value read for this key (``None`` when it was absent). When given, the
                write is refused with a 409 when the stored value is no longer ``expected``.
        """
        return self._request('PUT', f'/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, config_value, expected))

    def delete_config(self, id: str, namespace: str, config_key: str, audit_message=None,
                      expected: Any = _UNSET) -> Any:
        """Remove a configuration value for a vocab layer.

        Args:
            id: The resource ID
            namespace: The config namespace
            config_key: The config key
            expected: As on ``set_config``.
        """
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, _UNSET, expected))

    def list(self) -> Any:
        """List all vocab layers accessible to the current user.

        Transparently follows server-side pagination cursors and returns the
        full flat list.
        """
        return list_all(self._client, '/api/v1/vocab-layers')

    def list_page(self, *, limit: int | None = None, cursor: str | None = None) -> Any:
        """List one page of vocab layers.

        Args:
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, '/api/v1/vocab-layers',
                         limit=limit, cursor=cursor)

    def iter_pages(self, *, page_size: int = 1000):
        """Iterate over pages of vocab layers, yielding each page's entries list.

        Args:
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, '/api/v1/vocab-layers',
                          page_size=page_size)

    def create(self, name: str, audit_message=None, *, id: str | None = None) -> Any:
        """Create a new vocab layer.

        Also registers the current user as a maintainer.

        Args:
            name: The name
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/vocab-layers',
                             body=_body_of(id=_UNSET if id is None else id, name=name), audit_message=audit_message)

    def add_maintainer(self, id: str, user_id: str, audit_message=None) -> Any:
        """Assign a user as a maintainer for this vocab layer.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('POST', f'/api/v1/vocab-layers/{id}/maintainers/{user_id}', audit_message=audit_message)

    def remove_maintainer(self, id: str, user_id: str, audit_message=None) -> Any:
        """Remove a user's maintainer privileges for this vocab layer.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}/maintainers/{user_id}', audit_message=audit_message)


class RelationsResource(_Resource):
    def set_metadata(self, relation_id: str, body: Any, audit_message=None) -> Any:
        """Replace all metadata for a relation.

        Args:
            relation_id: The relation ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/relations/{relation_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def delete_metadata(self, relation_id: str, audit_message=None) -> Any:
        """Remove all metadata from a relation.

        Args:
            relation_id: The relation ID
        """
        return self._request('DELETE', f'/api/v1/relations/{relation_id}/metadata',
                             audit_message=audit_message)

    def patch_metadata(self, relation_id: str, body: Any, audit_message=None) -> Any:
        """Edit metadata for a relation with a list of ops applied in order.

        ``{"op": "set", "path": [...], "value": v}`` writes v at the path,
        creating missing objects along it; ``{"op": "delete", "path": [...]}``
        removes the key at the path (a no-op when absent). A path is a
        non-empty list of keys, the first a top-level key. A path through a
        non-object is refused (400). See :func:`metadata_ops` and
        :func:`apply_metadata_ops`.

        Args:
            relation_id: The relation ID
            body: The metadata ops
        """
        return self._request('PATCH', f'/api/v1/relations/{relation_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def set_target(self, relation_id: str, span_id: str, audit_message=None) -> Any:
        """Update the target span of a relation.

        Args:
            relation_id: The relation ID
            span_id: The span ID
        """
        return self._request('PUT', f'/api/v1/relations/{relation_id}/target',
                             body=_body_of(span_id=span_id), audit_message=audit_message)

    def set_source(self, relation_id: str, span_id: str, audit_message=None) -> Any:
        """Update the source span of a relation.

        Args:
            relation_id: The relation ID
            span_id: The span ID
        """
        return self._request('PUT', f'/api/v1/relations/{relation_id}/source',
                             body=_body_of(span_id=span_id), audit_message=audit_message)

    def get(self, relation_id: str) -> Any:
        """Get a relation by ID.

        Args:
            relation_id: The relation ID
        """
        return self._request('GET', f'/api/v1/relations/{relation_id}')

    def delete(self, relation_id: str, audit_message=None) -> Any:
        """Delete a relation.

        Args:
            relation_id: The relation ID
        """
        return self._request('DELETE', f'/api/v1/relations/{relation_id}', audit_message=audit_message)

    def update(self, relation_id: str, value: Any, audit_message=None) -> Any:
        """Update a relation's value.

        Args:
            relation_id: The relation ID
            value: The value
        """
        return self._request('PATCH', f'/api/v1/relations/{relation_id}',
                             body=_body_of(value=value), audit_message=audit_message)

    def create(self, layer_id: str, source_id: str, target_id: str, value: Any,
               metadata: Any = _UNSET, audit_message=None, *, id: str | None = None) -> Any:
        """Create a new relation.

        A relation is a directed edge between two spans with a value, useful
        for expressing phenomena such as syntactic or semantic relations.

        Args:
            layer_id: The relation layer ID
            source_id: The source span ID
            target_id: The target span ID
            value: The value
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/relations',
                             body=_body_of(id=_UNSET if id is None else id, layer_id=layer_id, source_id=source_id,
                                           target_id=target_id, value=value, metadata=metadata), audit_message=audit_message)

    def bulk_create(self, body: list, audit_message=None) -> dict:
        """Create multiple relations in a single operation.

        Args:
            body: The request body

        Returns:
            ``{"ids": [...]}`` — the created relation IDs, in input order.
        """
        return self._request('POST', '/api/v1/relations/bulk', body=body, audit_message=audit_message)

    def bulk_delete(self, body: list, audit_message=None) -> Any:
        """Delete multiple relations in a single operation. Provide a list of IDs.

        Args:
            body: The request body
        """
        return self._request('DELETE', '/api/v1/relations/bulk', body=body, audit_message=audit_message)

    def bulk_update(self, body: list, audit_message=None) -> dict:
        """Update many relations in a single operation: set values and/or patch metadata.

        Args:
            body: A list of ``{"id": ..., "value": ..., "metadata": [...]}``
                objects. ``value`` is set only when the key is present (``None``
                sends JSON null); ``metadata`` is a list of metadata ops, as for
                ``patch_metadata``. The relations may lie in several documents of
                one project. Every document touched has its version bumped, and
                every new version comes back in ``X-Document-Versions`` (past
                fifty documents, only their number, in
                ``X-Document-Versions-Omitted``). A
                ``document-version`` precondition is accepted only when every
                entry lies in one document. An unknown id refuses the whole
                update.

        Returns:
            ``{"count": n}``, how many relations were updated.
        """
        return self._request('PATCH', '/api/v1/relations/bulk', body=body, audit_message=audit_message)


class SpanLayersResource(_ConstraintMethods, _Resource):
    _kind = 'span-layers'

    def get(self, span_layer_id: str) -> Any:
        """Get a span layer by ID.

        Args:
            span_layer_id: The span layer ID
        """
        return self._request('GET', f'/api/v1/span-layers/{span_layer_id}')

    def delete(self, span_layer_id: str, audit_message=None) -> Any:
        """Delete a span layer.

        Args:
            span_layer_id: The span layer ID
        """
        return self._request('DELETE', f'/api/v1/span-layers/{span_layer_id}', audit_message=audit_message)

    def update(self, span_layer_id: str, name: str, audit_message=None) -> Any:
        """Update a span layer's name.

        Args:
            span_layer_id: The span layer ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/span-layers/{span_layer_id}',
                             body=_body_of(name=name), audit_message=audit_message)

    def set_config(self, span_layer_id: str, namespace: str, config_key: str, config_value: Any, audit_message=None,
                   expected: Any = _UNSET) -> Any:
        """Set a configuration value for a span layer in an editor namespace.

        Args:
            span_layer_id: The span layer ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
            expected: The value read for this key (``None`` when it was absent). When given, the
                write is refused with a 409 when the stored value is no longer ``expected``.
        """
        return self._request('PUT', f'/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, config_value, expected))

    def delete_config(self, span_layer_id: str, namespace: str, config_key: str, audit_message=None,
                      expected: Any = _UNSET) -> Any:
        """Remove a configuration value for a span layer.

        Args:
            span_layer_id: The span layer ID
            namespace: The config namespace
            config_key: The config key
            expected: As on ``set_config``.
        """
        return self._request('DELETE', f'/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, _UNSET, expected))

    def shift(self, span_layer_id: str, direction: str, audit_message=None) -> Any:
        """Shift a span layer's display order.

        Args:
            span_layer_id: The span layer ID
            direction: The direction ("up" or "down")
        """
        return self._request('POST', f'/api/v1/span-layers/{span_layer_id}/shift',
                             body=_body_of(direction=direction), audit_message=audit_message)

    def create(self, token_layer_id: str, name: str, audit_message=None, *,
               id: str | None = None) -> Any:
        """Create a new span layer.

        Args:
            token_layer_id: The token layer ID
            name: The name
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/span-layers',
                             body=_body_of(id=_UNSET if id is None else id, token_layer_id=token_layer_id, name=name), audit_message=audit_message)


class SpansResource(_Resource):
    def set_metadata(self, span_id: str, body: Any, audit_message=None) -> Any:
        """Replace all metadata for a span.

        Args:
            span_id: The span ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/spans/{span_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def delete_metadata(self, span_id: str, audit_message=None) -> Any:
        """Remove all metadata from a span.

        Args:
            span_id: The span ID
        """
        return self._request('DELETE', f'/api/v1/spans/{span_id}/metadata',
                             audit_message=audit_message)

    def patch_metadata(self, span_id: str, body: Any, audit_message=None) -> Any:
        """Edit metadata for a span with a list of ops applied in order.

        ``{"op": "set", "path": [...], "value": v}`` writes v at the path,
        creating missing objects along it; ``{"op": "delete", "path": [...]}``
        removes the key at the path (a no-op when absent). A path is a
        non-empty list of keys, the first a top-level key. A path through a
        non-object is refused (400). See :func:`metadata_ops` and
        :func:`apply_metadata_ops`.

        Args:
            span_id: The span ID
            body: The metadata ops
        """
        return self._request('PATCH', f'/api/v1/spans/{span_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def set_tokens(self, span_id: str, tokens: list, audit_message=None) -> Any:
        """Replace the tokens associated with a span.

        Args:
            span_id: The span ID
            tokens: The tokens
        """
        return self._request('PUT', f'/api/v1/spans/{span_id}/tokens',
                             body=_body_of(tokens=tokens), audit_message=audit_message)

    def get(self, span_id: str) -> Any:
        """Get a span by ID.

        Args:
            span_id: The span ID
        """
        return self._request('GET', f'/api/v1/spans/{span_id}')

    def delete(self, span_id: str, audit_message=None) -> Any:
        """Delete a span.

        Args:
            span_id: The span ID
        """
        return self._request('DELETE', f'/api/v1/spans/{span_id}', audit_message=audit_message)

    def update(self, span_id: str, value: Any, audit_message=None) -> Any:
        """Update a span's value.

        Args:
            span_id: The span ID
            value: The value
        """
        return self._request('PATCH', f'/api/v1/spans/{span_id}',
                             body=_body_of(value=value), audit_message=audit_message)

    def create(self, span_layer_id: str, tokens: list, value: Any, metadata: Any = _UNSET,
               audit_message=None, *, id: str | None = None) -> Any:
        """Create a new span.

        A span holds a primary atomic value and optional metadata, and must
        at all times be associated with one or more tokens.

        Args:
            span_layer_id: The span layer ID
            tokens: The tokens
            value: The value
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/spans',
                             body=_body_of(id=_UNSET if id is None else id, span_layer_id=span_layer_id, tokens=tokens,
                                           value=value, metadata=metadata), audit_message=audit_message)

    def bulk_create(self, body: list, audit_message=None) -> dict:
        """Create multiple spans in a single operation.

        Args:
            body: The request body

        Returns:
            ``{"ids": [...]}`` — the created span IDs, in input order.
        """
        return self._request('POST', '/api/v1/spans/bulk', body=body, audit_message=audit_message)

    def bulk_delete(self, body: list, audit_message=None) -> Any:
        """Delete multiple spans in a single operation. Provide a list of IDs.

        Args:
            body: The request body
        """
        return self._request('DELETE', '/api/v1/spans/bulk', body=body, audit_message=audit_message)

    def bulk_update(self, body: list, audit_message=None) -> dict:
        """Update many spans in a single operation: set values and/or patch metadata.

        Args:
            body: A list of ``{"id": ..., "value": ..., "metadata": [...]}``
                objects. ``value`` is set only when the key is present (``None``
                sends JSON null); ``metadata`` is a list of metadata ops, as for
                ``patch_metadata``. The spans may lie in several documents of
                one project. Every document touched has its version bumped, and
                every new version comes back in ``X-Document-Versions`` (past
                fifty documents, only their number, in
                ``X-Document-Versions-Omitted``). A
                ``document-version`` precondition is accepted only when every
                entry lies in one document. An unknown id refuses the whole
                update.

        Returns:
            ``{"count": n}``, how many spans were updated.
        """
        return self._request('PATCH', '/api/v1/spans/bulk', body=body, audit_message=audit_message)


class TextsResource(_Resource):
    def create(self, text_layer_id: str, document_id: str, body: str,
               metadata: Any = _UNSET, audit_message=None, *, id: str | None = None,
               token_edges: list | None = None) -> Any:
        """Create a new text in a document's text layer.

        A text is a container for one long string in ``body`` for a given layer.

        Args:
            text_layer_id: The text layer ID
            document_id: The document ID
            body: The request body
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
            token_edges: Optional. The code-point offsets where the tokens
                made next on this text begin and end. The body is stored
                composed, except a character one of them falls inside, which
                stays as sent (see ``compose_text``).
        """
        return self._request('POST', '/api/v1/texts',
                             body=_body_of(id=_UNSET if id is None else id, text_layer_id=text_layer_id, document_id=document_id,
                                           body=body,
                                           token_edges=_UNSET if token_edges is None else list(token_edges),
                                           metadata=metadata), audit_message=audit_message)

    def get(self, text_id: str) -> Any:
        """Get a text.

        Args:
            text_id: The text ID
        """
        return self._request('GET', f'/api/v1/texts/{text_id}')

    def delete(self, text_id: str, audit_message=None) -> Any:
        """Delete a text and all dependent data.

        Args:
            text_id: The text ID
        """
        return self._request('DELETE', f'/api/v1/texts/{text_id}', audit_message=audit_message)

    def update(self, text_id: str, body: Any, audit_message=None, *, base: str | None = None,
               versioned: bool | None = None) -> Any:
        """Update a text's ``body``.

        A diff is computed and token indices are updated so that tokens
        remain intact. Alternatively, ``body`` can be a list of edit
        directives, applied exactly as sent.

        Args:
            text_id: The text ID
            body: The request body
            base: Optional. The ``digest`` of the body the update was made on,
                as every read of a text gives it. The update then applies only
                to that body, and is refused with 409 and ``text_changed``
                otherwise, and strict mode does not stamp it unless ``versioned``
                is True (a batch whose later writes are stamped needs its first
                write stamped too).
        """
        return self._request('PATCH', f'/api/v1/texts/{text_id}',
                             body=_body_of(body=body, base=_UNSET if base is None else base),
                             audit_message=audit_message,
                             versioned=(base is None) if versioned is None else versioned)

    def edit(self, text_id: str, edits: list, audit_message=None, *, base: str | None = None,
             versioned: bool | None = None) -> Any:
        """Change a text's body by the edits made at the caret.

        ``edits`` are edit directives as ``update`` takes them (code-point
        indices, applied in order, each index in the body the ones before it
        left). Only their net change counts: an insert or a delete stays where
        it was made, and a stretch deleted and typed over is read as a whole
        new body is. The answer is the text with its new ``digest`` and
        ``reshape`` (the tokens moved, the spans and vocab links trimmed, the
        rows deleted). See ``compose_text_edits`` and ``gaps_to_ops``.

        Args:
            text_id: The text ID
            edits: The edit directives
            base: Optional. The ``digest`` of the body the edits were made on.
                The edit then applies only to that body, and is refused with
                409 and ``text_changed`` otherwise, and strict mode does not
                stamp it.
        """
        return self._request('PATCH', f'/api/v1/texts/{text_id}',
                             body=_body_of(edits=edits, base=_UNSET if base is None else base),
                             audit_message=audit_message,
                             versioned=(base is None) if versioned is None else versioned)

    def set_metadata(self, text_id: str, body: Any, audit_message=None) -> Any:
        """Replace all metadata for a text.

        Args:
            text_id: The text ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/texts/{text_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def delete_metadata(self, text_id: str, audit_message=None) -> Any:
        """Remove all metadata from a text.

        Args:
            text_id: The text ID
        """
        return self._request('DELETE', f'/api/v1/texts/{text_id}/metadata',
                             audit_message=audit_message)

    def patch_metadata(self, text_id: str, body: Any, audit_message=None) -> Any:
        """Edit metadata for a text with a list of ops applied in order.

        ``{"op": "set", "path": [...], "value": v}`` writes v at the path,
        creating missing objects along it; ``{"op": "delete", "path": [...]}``
        removes the key at the path (a no-op when absent). A path is a
        non-empty list of keys, the first a top-level key. A path through a
        non-object is refused (400). See :func:`metadata_ops` and
        :func:`apply_metadata_ops`.

        Args:
            text_id: The text ID
            body: The metadata ops
        """
        return self._request('PATCH', f'/api/v1/texts/{text_id}/metadata',
                             raw_body=body, audit_message=audit_message)


class UsersResource(_Resource):
    def list(self, *, q: str | None = None) -> Any:
        """List (or search) users. Admin-or-maintainer only.

        Transparently follows server-side pagination cursors and returns the
        full flat list.

        Args:
            q: Filter to users whose display name contains this text, or whose email starts with it (contains it, when the text has an @), case-insensitive
        """
        return list_all(self._client, '/api/v1/users',
                        query={'q': q})

    def list_page(self, *, q: str | None = None, limit: int | None = None,
                  cursor: str | None = None) -> Any:
        """List one page of users (optionally filtered by ``q``).

        Args:
            q: Filter to users whose display name contains this text, or whose email starts with it (contains it, when the text has an @), case-insensitive
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, '/api/v1/users',
                         limit=limit, cursor=cursor, query={'q': q})

    def iter_pages(self, *, q: str | None = None, page_size: int = 1000):
        """Iterate over pages of users, yielding each page's entries list.

        Args:
            q: Filter to users whose display name contains this text, or whose email starts with it (contains it, when the text has an @), case-insensitive
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, '/api/v1/users',
                          page_size=page_size, query={'q': q})

    def create(self, email: str, password: str, is_admin: bool,
               display_name: str | None = None, audit_message=None) -> Any:
        """Create a new user.

        Admin only, and not with a named API token (403): it needs a
        sign-in token.

        Args:
            email: The account's email address. It becomes the user's id and
                is what they log in with; it can never be changed.
            password: The password
            is_admin: Whether the user is an admin
            display_name: How the user is shown in the UI. Defaults to the
                local part of the email.
        """
        return self._request('POST', '/api/v1/users',
                             body=_body_of(email=normalize_user_id(email), password=password,
                                           is_admin=is_admin,
                                           display_name=_UNSET if display_name is None else display_name),
                             audit_message=audit_message)

    def get(self, id: str) -> Any:
        """Get a user by ID.

        Args:
            id: The resource ID
        """
        return self._request('GET', f'/api/v1/users/{id}')

    def delete(self, id: str, audit_message=None) -> Any:
        """Deactivate a user.

        Users are never hard-deleted: deactivation rejects their logins and
        tokens, strips their project memberships and vocab maintainerships,
        and revokes their API tokens. The user stays visible in listings with
        a ``deactivated-at`` timestamp. Reversible via :meth:`activate`,
        which restores login only.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/users/{id}', audit_message=audit_message)

    def activate(self, id: str, audit_message=None) -> Any:
        """Reactivate a deactivated user, restoring their ability to log in.

        Project memberships, vocab maintainerships, and API tokens removed at
        deactivation are NOT restored — re-grant them deliberately.

        Args:
            id: The resource ID
        """
        return self._request('POST', f'/api/v1/users/{id}/activate', audit_message=audit_message)

    def update(self, id: str, *, password: Any = _UNSET, display_name: Any = _UNSET,
               is_admin: Any = _UNSET, audit_message=None) -> Any:
        """Modify a user.

        Admins may change the display name, password, and admin status of any
        user. All other users may only modify their own display name or
        password. A password change cannot be made with a named API token
        (403): it needs a sign-in token.

        A user's id is their email address and is fixed for the life of the
        account — it is what they log in with, so nothing can change it.

        Args:
            id: The resource ID (the user's email address)
            password: New password. Omit to leave unchanged; pass ``None`` to
                send JSON null.
            display_name: New display name. Omit to leave unchanged; pass
                ``None`` to send JSON null.
            is_admin: New admin status. Omit to leave unchanged; pass ``None``
                to send JSON null.
        """
        return self._request('PATCH', f'/api/v1/users/{id}',
                             body=_body_of(password=password, display_name=display_name,
                                           is_admin=is_admin), audit_message=audit_message)

    def audit(self, user_id: str, *, start_time: str | None = None,
              end_time: str | None = None,
              op_types=None, kinds=None) -> Any:
        """Get audit log for a user's actions.

        Transparently follows server-side pagination cursors and returns the
        full flat list of audit entries.

        Args:
            user_id: The user ID
            start_time: Start of time range
            end_time: End of time range
            op_types: Only return operations of these types, spelled as in an
                entry's ``op/type`` (e.g.
                ``['span-layer/create', 'span-layer/delete']``). An entry
                appears when one of its operations matches, carrying only the
                ones that did.
            kinds: Only the entries of operations of these kinds, as a list or
                comma-separated string (e.g. ``['review']``), each whole
        """
        return list_all(self._client, f'/api/v1/users/{user_id}/audit',
                        query={'start-time': start_time, 'end-time': end_time,
                               'op-types': _op_types_param(op_types),
                               'kinds': _op_types_param(kinds)})

    def audit_page(self, user_id: str, *, start_time: str | None = None,
                   end_time: str | None = None,
                   op_types: Any = None, kinds: Any = None, order: str | None = None,
                   limit: int | None = None, cursor: str | None = None,
                   ops_limit: int | None = None, entry_id: str | None = None) -> Any:
        """One page of the same log, newest-first with ``order='desc'``.

        Use this rather than audit() wherever the caller wants the recent end
        of a log that may be long: audit() walks every page before it returns.

        Args:
            order: ``'desc'`` pages newest-first; a cursor belongs to the
                direction that produced it
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            ops_limit: Keep only each entry's oldest N operations in
                ``ops`` (1..1000). ``op_count`` on every entry says how many
                it has
            entry_id: Read only this entry, not a page
        """
        return list_page(self._client, f'/api/v1/users/{user_id}/audit', limit=limit, cursor=cursor,
                         query={'start-time': start_time, 'end-time': end_time,
                                'op-types': _op_types_param(op_types),
                                'kinds': _op_types_param(kinds),
                                'order': order, 'ops-limit': ops_limit, 'entry-id': entry_id})

    def get_avatar(self, id: str) -> bytes:
        """Get a user's profile picture as raw bytes.

        Raises for 404 when the user has no picture, so check the user
        record's ``avatar_hash`` first if that is not an error for you.

        Args:
            id: The user ID
        """
        return self._request('GET', f'/api/v1/users/{id}/avatar',
                             binary_response=True)

    def set_avatar(self, id: str, file, audit_message=None) -> Any:
        """Upload a profile picture. Your own, or anyone's if you are an admin.

        The server center-crops to a square, scales to the configured edge
        length, and re-encodes, so no client-side resizing is needed. Accepts
        PNG, JPEG, WebP, and GIF. Returns the updated user record, whose
        ``avatar_hash`` is the new picture's cache key.

        Args:
            id: The user ID
            file: The image to upload (an open binary file object or bytes)
        """
        return self._request('PUT', f'/api/v1/users/{id}/avatar',
                             body={'file': file}, form_data=True, no_batch=True,
                             audit_message=audit_message)

    def delete_avatar(self, id: str, audit_message=None) -> Any:
        """Remove a profile picture. Your own, or anyone's if you are an admin.

        Args:
            id: The user ID
        """
        # No flag: the upload above is multipart and cannot be batched, but a
        # DELETE carries no blob, so the batch transport takes it. It is an
        # ordinary audited write and queues like any other.
        return self._request('DELETE', f'/api/v1/users/{id}/avatar',
                             audit_message=audit_message)

    def avatar_url(self, id: str, avatar_hash: str | None = None) -> str:
        """URL for a user's profile picture, with the session token in the
        query string so it works in contexts that cannot set an Authorization
        header (an HTML image element, say).

        Pass the user record's ``avatar_hash`` whenever you have it: the URL
        then addresses that exact picture, so it can be cached indefinitely and
        still picks up a replacement the moment the user changes it.

        Args:
            id: The user ID
            avatar_hash: The user record's ``avatar_hash``
        """
        params = {'token': self._client.token}
        if avatar_hash:
            params['v'] = avatar_hash
        return f'{self._client.base_url}/api/v1/users/{id}/avatar?{urlencode(params)}'


class ApiTokensResource(_Resource):
    def list(self, user_id: str) -> Any:
        """List a user's named API tokens.

        Never includes the signed token string itself — that is only returned
        once, by create(). Transparently follows server-side pagination cursors
        and returns the full flat list.

        Args:
            user_id: The user ID who owns the tokens
        """
        return list_all(self._client, f'/api/v1/users/{user_id}/tokens')

    def list_page(self, user_id: str, *, limit: int | None = None,
                  cursor: str | None = None) -> Any:
        """List one page of a user's named API tokens.

        Args:
            user_id: The user ID who owns the tokens
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, f'/api/v1/users/{user_id}/tokens',
                         limit=limit, cursor=cursor)

    def iter_pages(self, user_id: str, *, page_size: int = 1000):
        """Iterate over pages of a user's API tokens, yielding each page's entries.

        Args:
            user_id: The user ID who owns the tokens
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, f'/api/v1/users/{user_id}/tokens',
                          page_size=page_size)

    def create(self, user_id: str, name: str, audit_message=None) -> Any:
        """Mint a named API token for a user.

        The returned ``token`` is the signed credential and is shown ONLY
        here — store it immediately. API tokens do not expire and survive
        password changes / logout; revoke to kill. Returns a dict with
        ``id``, ``name`` and ``token``. A client signed in with a named API
        token cannot do this (403): it needs a sign-in token.

        Args:
            user_id: The user ID who will own the token
            name: A human label, e.g. "Stanza parser"

        Returns:
            A dict with ``id``, ``name`` and ``token``.
        """
        # no_batch: the answer is the secret, which the server never keeps, so
        # it takes no Idempotency-Key and a batch cannot carry it.
        return self._request('POST', f'/api/v1/users/{user_id}/tokens',
                             body=_body_of(name=name), audit_message=audit_message,
                             no_batch=True)

    def revoke(self, user_id: str, token_id: str, audit_message=None) -> Any:
        """Revoke a named API token (soft-revoke; idempotent).

        A client signed in with a named API token cannot do this (403): it
        needs a sign-in token.

        Args:
            user_id: The user ID who owns the token
            token_id: The token ID to revoke
        """
        return self._request('DELETE', f'/api/v1/users/{user_id}/tokens/{token_id}', audit_message=audit_message)


class UserDataResource(_Resource):
    """Private per-user key/value storage: small JSON documents that follow a
    user across devices and sessions (assistant conversations, drafts,
    preferences). Owner or admin only, and never audited. A write refuses to
    join an open batch, a read goes over the wire around one."""

    def list(self, user_id: str, *, prefix: str | None = None, pattern: str | None = None,
             include_values: bool = False, page_size: int = 100) -> Any:
        """List a user's entries ({key, updated_at}, plus value when requested),
        ordered by key.

        Transparently follows server-side pagination cursors and returns the
        full flat list.

        Narrow with ``prefix`` (the literal head of a key) and/or ``pattern``, a
        GLOB over the whole key (``*`` any run, ``?`` one character) - the way to
        ask for a key convention identified by a segment in the middle, e.g.
        ``igt:assistant:*:meta:*`` for every conversation's sidebar entry across
        every project without dragging down the transcripts beside them.

        Args:
            user_id: The owning user
            prefix: Only keys starting with this prefix
            pattern: Only keys matching this GLOB
            include_values: Also return each entry's value
            page_size: Entries per request (1..1000). Exposed here, and lower
                than elsewhere, because one value runs to megabytes
                (``user_data_value_bytes`` in ``server.limits()``): a page of
                them with ``include_values`` is the largest response this API
                can be asked for. Raise it when the listing is keys, or the values are
                known to be small.
        """
        return list_all(self._client, f'/api/v1/users/{user_id}/data', page_size=page_size,
                        query={'prefix': prefix, 'pattern': pattern,
                               'include-values': include_values or None})

    def list_page(self, user_id: str, *, prefix: str | None = None, pattern: str | None = None,
                  include_values: bool = False, limit: int | None = None,
                  cursor: str | None = None) -> Any:
        """One page of a user's entries, ordered by key.

        Args:
            user_id: The owning user
            prefix: Only keys starting with this prefix
            pattern: Only keys matching this GLOB
            include_values: Also return each entry's value
            limit: Page size (1..1000; server default 100)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, f'/api/v1/users/{user_id}/data', limit=limit, cursor=cursor,
                         query={'prefix': prefix, 'pattern': pattern,
                                'include-values': include_values or None})

    def iter_pages(self, user_id: str, *, prefix: str | None = None, pattern: str | None = None,
                   include_values: bool = False, page_size: int = 100):
        """Yield a user's entries one page at a time, following the cursors.

        Args:
            user_id: The owning user
            prefix: Only keys starting with this prefix
            pattern: Only keys matching this GLOB
            include_values: Also return each entry's value
            page_size: Entries per request (1..1000)
        """
        return iter_pages(self._client, f'/api/v1/users/{user_id}/data', page_size=page_size,
                          query={'prefix': prefix, 'pattern': pattern,
                                 'include-values': include_values or None})

    def get(self, user_id: str, key: str) -> Any:
        """Read one entry ({key, updated_at, version, value}); 404 if absent."""
        return self._request('GET', f'/api/v1/users/{user_id}/data/{quote(key, safe="")}')

    def put(self, user_id: str, key: str, value: Any, version: int | None = None) -> Any:
        """Create or replace one entry. ``value`` is any JSON, up to the
        server's ``user_data_value_bytes`` (``server.limits()``, 5 MB by
        default), and is refused with 413 over it, after which
        ``server.limits()`` answers the figure the server has now. Answers
        ``{key, updated_at, version}``.

        The server stores it verbatim, but this client recases object keys on
        the way out and back like any other body (``my_key`` <-> ``my-key``),
        so a value whose keys are snake_case round-trips unchanged while one
        keyed by arbitrary strings does not. Put such a map under a
        ``metadata`` key, which both clients pass through untouched.

        Every write raises the entry's ``version`` by one, and reads answer
        it. With ``version``, the write lands only when the entry is still at
        that version (0: only when there is no entry), and is otherwise
        refused with 409, ``error: "version-mismatch"``, and the stored
        ``version`` and ``updated_at`` on the error's ``response_data``: read
        it again and make the change on what is there.
        """
        try:
            return self._request('PUT', f'/api/v1/users/{user_id}/data/{quote(key, safe="")}',
                                 body=value, no_batch=True,
                                 **({'query_params': {'version': version}} if version is not None else {}))
        except PlaidAPIError as e:
            if e.status == 413:
                # The cap may have changed since it was read: the caller
                # deciding what to do next reads the server's figure now.
                try:
                    self._client.server.refresh()
                except Exception:  # noqa: BLE001 - the 413 is the answer either way
                    pass
            raise

    def delete(self, user_id: str, key: str) -> Any:
        """Delete one entry; 404 if absent."""
        return self._request('DELETE', f'/api/v1/users/{user_id}/data/{quote(key, safe="")}',
                             no_batch=True)


class CommentsResource(_Resource):
    """Free-text discussion anchored to a document, text, token, span or
    relation, or to a vocabulary entry (``vocab-item``).

    Comments are social data, not annotation data: they are never audited,
    they do not bump the document version, and no export target carries them.
    Posting takes WRITE access to the owner: the entity's project, or the
    vocabulary for an entry (readers may read a thread but not add to it).
    Only the AUTHOR may edit a comment; the author or a maintainer of the
    owner may delete one.

    A comment outlives its anchor: deleting the entity does not delete the
    comment. It is then shown as outdated with its ``anchor_label``, the
    caption passed when it was posted."""

    def create(self, entity_type: str, entity_id: str, body: str, *,
               anchor_label: str | None = None, id: str | None = None) -> Any:
        """Post a comment on an entity.

        Args:
            entity_type: One of ``document``, ``text``, ``token``, ``span``,
                ``relation``, ``vocab-item``
            entity_id: The commented entity's id
            body: The comment text (1..10000 characters)
            anchor_label: What the comment is about, in words (at most 200
                characters); shown once the anchor has been deleted
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        # A comment is not audited, so it never joins an open operation, and
        # never takes a number from an operation's Idempotency-Key seed.
        return self._request('POST', '/api/v1/comments',
                             body=_body_of(id=_UNSET if id is None else id, entity_type=entity_type, entity_id=entity_id, body=body,
                                           anchor_label=_UNSET if anchor_label is None else anchor_label),
                             no_operation=True)

    def get(self, comment_id: str) -> Any:
        """Read one comment."""
        return self._request('GET', f'/api/v1/comments/{comment_id}')

    def update(self, comment_id: str, body: str) -> Any:
        """Edit a comment's body.

        Only the comment's author may do this — not maintainers, not admins.
        Sets ``edited`` on the returned comment.
        """
        return self._request('PATCH', f'/api/v1/comments/{comment_id}',
                             body=_body_of(body=body), no_operation=True)

    def delete(self, comment_id: str) -> Any:
        """Delete a comment (author, or a maintainer of its project)."""
        return self._request('DELETE', f'/api/v1/comments/{comment_id}', no_operation=True)

    def list(self, project_id: str, *, document_id: str | None = None,
             entity_type: str | None = None, entity_id: str | None = None) -> Any:
        """List comments in a project, oldest first.

        Transparently follows server-side pagination cursors and returns the
        full flat list.

        Args:
            project_id: The project to read
            document_id: Only comments anywhere in this document
            entity_type: With entity_id, only this entity's thread
            entity_id: With entity_type, only this entity's thread
        """
        return list_all(self._client, f'/api/v1/projects/{project_id}/comments',
                        query={'document-id': document_id, 'entity-type': entity_type,
                               'entity-id': entity_id})

    def list_page(self, project_id: str, *, limit: int | None = None,
                  cursor: str | None = None, document_id: str | None = None,
                  entity_type: str | None = None, entity_id: str | None = None) -> Any:
        """List one page of a project's comments.

        Args:
            project_id: The project to read
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            document_id: Only comments anywhere in this document
            entity_type: With entity_id, only this entity's thread
            entity_id: With entity_type, only this entity's thread
        """
        return list_page(self._client, f'/api/v1/projects/{project_id}/comments',
                         limit=limit, cursor=cursor,
                         query={'document-id': document_id, 'entity-type': entity_type,
                                'entity-id': entity_id})

    def iter_pages(self, project_id: str, *, page_size: int = 1000,
                   document_id: str | None = None, entity_type: str | None = None,
                   entity_id: str | None = None):
        """Iterate over pages of a project's comments, yielding each page's entries.

        Args:
            project_id: The project to read
            page_size: Page size (1..1000)
            document_id: Only comments anywhere in this document
            entity_type: With entity_id, only this entity's thread
            entity_id: With entity_type, only this entity's thread
        """
        return iter_pages(self._client, f'/api/v1/projects/{project_id}/comments',
                          page_size=page_size,
                          query={'document-id': document_id, 'entity-type': entity_type,
                                 'entity-id': entity_id})

    def counts(self, project_id: str, *, document_id: str | None = None,
               entity_type: str | None = None, entity_id: str | None = None) -> Any:
        """Comment counts per entity, as an ``{entity_id: n}`` dict.

        Same scope and filters as :meth:`list`. One cheap request paints a
        comment indicator on every annotated item in a document without paging
        through the bodies.

        The response is NOT key-transformed: its keys are entity ids, and
        recasing would mangle the hyphens in a UUID.
        """
        return self._request('GET', f'/api/v1/projects/{project_id}/comments/counts',
                             query_params={'document-id': document_id,
                                           'entity-type': entity_type,
                                           'entity-id': entity_id},
                             skip_response_transform=True)

    def list_in_vocab(self, vocab_id: str, *, entity_id: str | None = None) -> Any:
        """List the comments on a vocabulary's entries, oldest first.

        Requires read access to the vocabulary. Transparently follows
        server-side pagination cursors and returns the full flat list.

        Args:
            vocab_id: The vocab layer to read
            entity_id: Only this entry's thread
        """
        return list_all(self._client, f'/api/v1/vocab-layers/{vocab_id}/comments',
                        query={'entity-id': entity_id})

    def list_in_vocab_page(self, vocab_id: str, *, limit: int | None = None,
                           cursor: str | None = None, entity_id: str | None = None) -> Any:
        """List one page of a vocabulary's comments.

        Args:
            vocab_id: The vocab layer to read
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            entity_id: Only this entry's thread
        """
        return list_page(self._client, f'/api/v1/vocab-layers/{vocab_id}/comments',
                         limit=limit, cursor=cursor, query={'entity-id': entity_id})

    def iter_in_vocab_pages(self, vocab_id: str, *, entity_id: str | None = None,
                            page_size: int = 1000):
        """Iterate over pages of a vocabulary's comments, oldest first,
        yielding each page's entries list.

        Args:
            vocab_id: The vocab layer to read
            entity_id: Only this entry's thread
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, f'/api/v1/vocab-layers/{vocab_id}/comments',
                          page_size=page_size, query={'entity-id': entity_id})

    def counts_in_vocab(self, vocab_id: str, *, entity_id: str | None = None) -> Any:
        """Comment counts per entry of a vocabulary, as an ``{entry_id: n}`` dict.

        The response is NOT key-transformed: its keys are entry ids.
        """
        return self._request('GET', f'/api/v1/vocab-layers/{vocab_id}/comments/counts',
                             query_params={'entity-id': entity_id},
                             skip_response_transform=True)


class GuidelinesResource(_Resource):
    """A project's annotation manual: a flat list of short Markdown documents
    stating the conventions the project follows.

    Reading takes READ access to the project and writing takes WRITE access,
    matching comments: the people who annotate are the people who discover
    what the conventions have to be.

    ``title`` is the handle an assistant asks for one by, and the only thing a
    person has to keep current. It is NOT required to be unique: refusing a
    write because a title is taken would throw away a document that had just
    been typed, so a client warns about it instead. A ``pinned`` guideline is
    one the assistant is given in full on every turn.

    Writes are audited, so a change shows in the project's activity. They are
    NOT time-travelable: ``as_of`` reads and restore are document-scoped."""

    def create(self, project_id: str, title: str, *,
               body: str | None = None, pinned: bool | None = None,
               audit_message=None, id: str | None = None) -> Any:
        """Create a guideline in a project.

        Args:
            project_id: The project the guideline belongs to
            title: The handle an assistant asks for one by (1..100 characters)
            body: The Markdown text (up to 20000 characters; may be empty)
            pinned: Send this one to the assistant in full on every turn
            audit_message: Message recorded on the operation
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', f'/api/v1/projects/{project_id}/guidelines',
                             body=_body_of(id=_UNSET if id is None else id, title=title,
                                           body=_UNSET if body is None else body,
                                           pinned=_UNSET if pinned is None else pinned),
                             audit_message=audit_message)

    def get(self, guideline_id: str) -> Any:
        """Read one guideline, Markdown body included."""
        return self._request('GET', f'/api/v1/guidelines/{guideline_id}')

    def update(self, guideline_id: str, *, title: str | None = None,
               body: str | None = None, pinned: bool | None = None,
               expected_updated_at: str | None = None,
               audit_message=None) -> Any:
        """Update a guideline.

        Every field is optional and an omitted one is left alone, so an edit to
        the body need not restate the title.

        Pass ``expected_updated_at`` (the ``updated_at`` you last read) when a
        person has been editing prose: the write then fails with 409 rather
        than overwriting somebody who saved in between. Leave it off for a pin
        toggle or a script, which have nothing of anyone's to lose.

        Args:
            guideline_id: The guideline to change
            title: The new handle
            body: The new Markdown text
            pinned: Whether the assistant always gets it in full
            expected_updated_at: Write only if this is still the stored updated_at
            audit_message: Message recorded on the operation
        """
        return self._request('PATCH', f'/api/v1/guidelines/{guideline_id}',
                             query_params={'updated-at': expected_updated_at},
                             body=_body_of(title=_UNSET if title is None else title,
                                           body=_UNSET if body is None else body,
                                           pinned=_UNSET if pinned is None else pinned),
                             audit_message=audit_message)

    def delete(self, guideline_id: str, audit_message=None) -> Any:
        """Delete a guideline."""
        return self._request('DELETE', f'/api/v1/guidelines/{guideline_id}',
                             audit_message=audit_message)

    def list(self, project_id: str, *, include_bodies: bool | None = None) -> Any:
        """List a project's guidelines, by title.

        Transparently follows server-side pagination cursors and returns the
        full flat list.

        Without ``include_bodies`` each entry carries ``body_chars``, the length
        of its body, so a caller can budget before fetching any. Pinned
        guidelines are NOT sorted first: ``pinned`` is on every entry and
        grouping is the caller's.

        Args:
            project_id: The project to read
            include_bodies: Return each body instead of its length
        """
        return list_all(self._client, f'/api/v1/projects/{project_id}/guidelines',
                        query={'include-bodies': include_bodies})

    def list_page(self, project_id: str, *, limit: int | None = None,
                  cursor: str | None = None, include_bodies: bool | None = None) -> Any:
        """List one page of a project's guidelines.

        Args:
            project_id: The project to read
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            include_bodies: Return each body instead of its length
        """
        return list_page(self._client, f'/api/v1/projects/{project_id}/guidelines',
                         limit=limit, cursor=cursor,
                         query={'include-bodies': include_bodies})

    def iter_pages(self, project_id: str, *, page_size: int = 1000,
                   include_bodies: bool | None = None):
        """Iterate a project's guidelines page by page, yielding each page's entries.

        Args:
            project_id: The project to read
            page_size: Per-request page size
            include_bodies: Return each body instead of its length
        """
        return iter_pages(self._client, f'/api/v1/projects/{project_id}/guidelines',
                          page_size=page_size,
                          query={'include-bodies': include_bodies})


class InvitesResource(_Resource):
    """Invite links (signup) and admin-issued password reset links.

    Minting, listing and revoking live here because they need a logged-in
    client. Looking a code up and redeeming it do NOT — the redeemer has no
    account yet — so those are classmethods on ``PlaidClient``:
    :meth:`PlaidClient.lookup_invite` and :meth:`PlaidClient.redeem_invite`.
    """

    def list(self, *, project_id: str | None = None, all: bool | None = None) -> Any:
        """List invites you minted, oldest first.

        With ``project_id``, lists that project's invites instead (including
        ones minted by co-maintainers), which requires maintainer or admin on
        that project. With ``all``, lists every invite on the server, which
        requires admin. Never includes invite codes — a code is returned once,
        by create(), and is not recoverable afterward. Transparently follows
        server-side pagination cursors and returns the full flat list.

        Args:
            project_id: List this project's invites rather than your own
            all: List every invite on the server (admin only)
        """
        return list_all(self._client, '/api/v1/invites',
                        query={'project-id': project_id, 'all': all})

    def list_page(self, *, project_id: str | None = None, all: bool | None = None,
                  limit: int | None = None, cursor: str | None = None) -> Any:
        """List one page of invites.

        Args:
            project_id: List this project's invites rather than your own
            all: List every invite on the server (admin only)
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, '/api/v1/invites', limit=limit, cursor=cursor,
                         query={'project-id': project_id, 'all': all})

    def iter_pages(self, *, project_id: str | None = None, all: bool | None = None,
                   page_size: int = 1000):
        """Iterate over pages of invites, yielding each page's entries.

        Args:
            project_id: List this project's invites rather than your own
            all: List every invite on the server (admin only)
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, '/api/v1/invites', page_size=page_size,
                          query={'project-id': project_id, 'all': all})

    def create(self, *, project_id: Any = _UNSET, project_role: Any = _UNSET,
               grant_admin: Any = _UNSET, target_user_id: Any = _UNSET,
               max_uses: Any = _UNSET, ttl_days: Any = _UNSET,
               note: Any = _UNSET, audit_message=None) -> Any:
        """Mint an invite.

        The returned ``code`` is shown ONLY here — it is never stored and
        cannot be recovered, so build and hand off the link now
        (:meth:`PlaidClient.invite_url` turns it into one).

        Admins may mint anything. A project maintainer may mint role grants on
        projects they maintain, and nothing else: no admin grant, no grantless
        invite, no password resets — so for a non-admin, ``project_id`` and
        ``project_role`` are required in practice (403 without them).

        Needs a signed-in session: a client signed in with a named API token
        cannot mint any invite (403).

        EVERY argument is optional; ``create()`` with none mints a single-use
        signup link granting nothing but an account. Two pairing rules the
        server enforces with a 400: ``project_id`` and ``project_role`` must be
        given TOGETHER, and ``target_user_id`` may not be combined with
        ``project_id``, ``grant_admin``, or a ``max_uses`` above 1.

        Args:
            project_id: Project the redeemer joins (requires ``project_role``)
            project_role: "reader", "writer" or "maintainer" (requires ``project_id``)
            grant_admin: Make the new account a global admin (admin only)
            target_user_id: Password reset for that user instead of a signup;
                admin only, single-use, grants nothing
            max_uses: How many accounts this link may create (default 1)
            ttl_days: Days until it expires (default 14, max 365)
            note: Human label shown in your invite list

        Returns:
            The invite, plus the one-time ``code``.
        """
        return self._request('POST', '/api/v1/invites',
                             body=_body_of(project_id=project_id, project_role=project_role,
                                           grant_admin=grant_admin, target_user_id=target_user_id,
                                           max_uses=max_uses, ttl_days=ttl_days, note=note),
                             audit_message=audit_message,
                             # The answer is the code, which the server never keeps,
                             # so it takes no Idempotency-Key and a batch cannot
                             # carry it.
                             no_batch=True)

    def revoke(self, invite_id: str, audit_message=None) -> Any:
        """Revoke an invite, killing the link immediately.

        Idempotent. Allowed for the invite's creator, an admin, or a maintainer
        of the project the invite grants access to.

        Args:
            invite_id: The invite ID
        """
        return self._request('DELETE', f'/api/v1/invites/{invite_id}',
                             audit_message=audit_message)


class TokenLayersResource(_ConstraintMethods, _Resource):
    _kind = 'token-layers'

    def get(self, token_layer_id: str) -> Any:
        """Get a token layer by ID.

        Args:
            token_layer_id: The token layer ID
        """
        return self._request('GET', f'/api/v1/token-layers/{token_layer_id}')

    def delete(self, token_layer_id: str, audit_message=None) -> Any:
        """Delete a token layer.

        Args:
            token_layer_id: The token layer ID
        """
        return self._request('DELETE', f'/api/v1/token-layers/{token_layer_id}', audit_message=audit_message)

    def update(self, token_layer_id: str, name: str, audit_message=None) -> Any:
        """Update a token layer's name.

        Args:
            token_layer_id: The token layer ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/token-layers/{token_layer_id}',
                             body=_body_of(name=name), audit_message=audit_message)

    def set_config(self, token_layer_id: str, namespace: str, config_key: str, config_value: Any, audit_message=None,
                   expected: Any = _UNSET) -> Any:
        """Set a configuration value for a token layer in an editor namespace.

        Args:
            token_layer_id: The token layer ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
            expected: The value read for this key (``None`` when it was absent). When given, the
                write is refused with a 409 when the stored value is no longer ``expected``.
        """
        return self._request('PUT', f'/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, config_value, expected))

    def delete_config(self, token_layer_id: str, namespace: str, config_key: str, audit_message=None,
                      expected: Any = _UNSET) -> Any:
        """Remove a configuration value for a token layer.

        Args:
            token_layer_id: The token layer ID
            namespace: The config namespace
            config_key: The config key
            expected: As on ``set_config``.
        """
        return self._request('DELETE', f'/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, _UNSET, expected))

    def shift(self, token_layer_id: str, direction: str, audit_message=None) -> Any:
        """Shift a token layer's display order.

        Args:
            token_layer_id: The token layer ID
            direction: The direction ("up" or "down")
        """
        return self._request('POST', f'/api/v1/token-layers/{token_layer_id}/shift',
                             body=_body_of(direction=direction), audit_message=audit_message)

    def create(self, text_layer_id: str, name: str, *, overlap_mode: Any = _UNSET,
               parent_token_layer_id: Any = _UNSET, audit_message=None,
               id: str | None = None) -> Any:
        """Create a new token layer.

        ``overlap_mode`` sets a per-layer, immutable invariant on the layer's
        tokens: ``any`` (default; tokens may overlap and leave gaps),
        ``non-overlapping`` (tokens in a document may not overlap), or
        ``partitioning`` (tokens must form a gap-free, non-overlapping,
        zero-width-free cover of the text). On partitioning layers, single token create/update/delete are
        rejected -- use bulk-create plus the token split/merge/shift methods.

        ``parent_token_layer_id`` (immutable) makes this a nested layer: every
        token must be contained within a token of the parent layer, which must
        belong to the same text layer and be ``non-overlapping`` or
        ``partitioning`` (an ``any`` parent is rejected). A nested layer may be
        ``any`` or ``non-overlapping`` but not ``partitioning`` (partitioning is
        only for root layers) -- e.g. words (non-overlapping, parent=sentences)
        within sentences (partitioning).

        Args:
            text_layer_id: The text layer ID
            name: The name
            overlap_mode: Per-layer, immutable token invariant: ``any``
                (default), ``non-overlapping``, or ``partitioning``. Omit to
                leave unset; pass ``None`` to send JSON null.
            parent_token_layer_id: Optional immutable parent token layer. Omit
                to leave unset; pass ``None`` to send JSON null.
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/token-layers',
                             body=_body_of(id=_UNSET if id is None else id,
                                           text_layer_id=text_layer_id, name=name,
                                           overlap_mode=overlap_mode,
                                           parent_token_layer_id=parent_token_layer_id), audit_message=audit_message)


#: The pause before sending again an acquire whose outcome is unknown, which
#: grows by this much each time (three sends in all).
LOCK_ACQUIRE_RETRY_S = 0.5


class DocumentsResource(_Resource):
    def check_lock(self, document_id: str) -> Any:
        """Get information about a document lock.

        Args:
            document_id: The document ID
        """
        return self._request('GET', f'/api/v1/documents/{document_id}/lock')

    def acquire_lock(self, document_id: str, audit_message=None, new_lock_id=None) -> Any:
        """Acquire a document lock as a new holder.

        The answer's ``lock_id`` names the holder: :meth:`renew_lock` and
        :meth:`release_lock` take it. While the lock is held, a second acquire
        is refused with HTTP 423, whoever makes it, this user included.

        ``new_lock_id`` names the holder from the client's side (a fresh UUID).
        An acquire whose answer never arrived can then be sent again, which
        answers 200 while that holder has the lock, or released. Without it
        the server mints the id, and a lost answer leaves a lock nobody can
        release until it expires.

        out_of_band: the lock is a signal, not project data (see the note at
        the top of http.py). Queued on a batch it would be taken only at
        submit, after every write it was meant to guard, and until then answer
        success to a caller that does not hold it and cannot see the 423
        saying somebody else does.

        Args:
            document_id: The document ID
            new_lock_id: Optional holder id this client minted
        """
        return self._request('POST', f'/api/v1/documents/{document_id}/lock',
                             query_params=({'new-lock-id': new_lock_id}
                                           if new_lock_id is not None else None),
                             audit_message=audit_message, out_of_band=True)

    def renew_lock(self, document_id: str, lock_id: str, audit_message=None) -> Any:
        """Renew the lock ``lock_id`` holds while it is live. HTTP 423 if
        another holder has it, and also once it has expired or been dropped,
        even when nobody holds the document now: a renewal never takes a free
        document.

        out_of_band, for the same reason as :meth:`acquire_lock`.

        Args:
            document_id: The document ID
            lock_id: The ``lock_id`` :meth:`acquire_lock` answered with
        """
        return self._request('POST', f'/api/v1/documents/{document_id}/lock',
                             query_params={'lock-id': lock_id},
                             audit_message=audit_message, out_of_band=True)

    def release_lock(self, document_id: str, lock_id: str, audit_message=None) -> Any:
        """Release the lock ``lock_id`` holds. Idempotent: a lock that holder
        no longer has is left alone.

        out_of_band, for the same reason as :meth:`acquire_lock`: queued, the
        lock would be held until the batch submits, and not released at all
        if it aborts.

        Args:
            document_id: The document ID
            lock_id: The ``lock_id`` :meth:`acquire_lock` answered with
        """
        return self._request('DELETE', f'/api/v1/documents/{document_id}/lock',
                             query_params={'lock-id': lock_id},
                             audit_message=audit_message, out_of_band=True)

    def _take_lock(self, document_id: str, lock_id: str) -> Any:
        """The acquire of a :meth:`locked` block, under the holder id it minted.

        An acquire whose outcome is unknown (no answer, a timeout, a 502 or a
        504) may have taken the lock. It is sent again under the same id as
        any write is (``retry_unknown``), which the server answers 200 while
        that holder has it. When every send is unknown, the lock it may hold
        is released on the way out, so it does not stand in everyone's way
        until it expires.
        """
        try:
            return retry_unknown(
                lambda: self.acquire_lock(document_id, new_lock_id=lock_id),
                delays=[LOCK_ACQUIRE_RETRY_S, 2 * LOCK_ACQUIRE_RETRY_S])
        except PlaidAPIError as e:
            if e.status == 423:
                data = e.response_data or {}
                holder = data.get('user-id') or data.get('user_id') or 'another user'
                raise PlaidAPIError(
                    f"This document is being edited by {holder}. "
                    f"Try again once they're done.",
                    status=423, url=e.url, method=e.method,
                    response_data=e.response_data, status_text=e.status_text,
                    original_error=e) from e
            if is_unknown_outcome(e):
                try:
                    self.release_lock(document_id, lock_id)
                except Exception as release_err:
                    logging.getLogger(__name__).warning(
                        "Failed to release lock on document %s: %s", document_id, release_err)
            raise

    @contextmanager
    def locked(self, document_id: str, *, keep_alive: bool = True):
        """Hold this document's server-enforced lock for a ``with`` block,
        releasing it on exit (including on error).

        Wrap any multi-step, server-side mutation of a document that must not
        interleave with a human editor or another service — e.g. a parser or
        tokenizer that deletes and recreates a document's tokens/spans/relations
        (a single atomic call doesn't need this). While the lock is held, writes
        to the document by ANOTHER user are rejected by the server with HTTP 423;
        the holder's own writes pass and refresh the lock. If anyone already
        holds it, another block of this same user included, this raises
        :class:`PlaidAPIError` (``status == 423``, the same Locked code the
        server returns when rejecting another user's write) with a readable
        message and the block does NOT run::

            with client.documents.locked(doc_id):
                ...delete + recreate tokens...

        The block is renewed for as long as it runs, so work that computes for
        minutes before it writes holds the lock the whole time rather than only
        for its first minute. If a renewal fails the lock is gone: every later
        write from this client raises :class:`DocumentLockLost`, and a block
        that got to the end anyway ends with that error rather than reporting
        success. The block may also read ``lock.lost`` to give up sooner::

            with client.documents.locked(doc_id) as lock:
                for sentence in sentences:
                    lock.raise_if_lost()
                    ...

        Args:
            document_id: The document to hold.
            keep_alive: Renew the lock on a timer while the block runs
                (default). Pass False for a block that writes as it goes and
                wants no background thread.

        Notes:
        - The lock is per HOLDER and TTL-bound (server default 60s, and the
          acquire response's ``expires_at`` is what the renewal reads). Each
          block is its own holder, named by ``lock.lock_id``, and only that id
          renews or releases it. Writes carry no id: they pass for the user
          who holds the lock, and renew it server-side too.
        - The block mints its holder id and sends it with the acquire, so an
          acquire whose answer was lost is sent again (up to three tries) and,
          if none is answered, released rather than left to expire.
        - NOT re-entrant: a nested ``locked(same_doc)`` block is a second
          holder and gets the 423. Lock at exactly one level per call path.
        - A lost lock is recorded on the CLIENT, like strict mode, so it stops
          every write the client makes (on any batch of it too) and not only
          the ones this block makes.
        """
        minted = str(uuid.uuid4())
        info = self._take_lock(document_id, minted)
        client = self._client
        lock_id = (info or {}).get('lock_id') or minted
        keeper = None
        if keep_alive:
            ttl_s = lock_ttl_s((info or {}).get('expires_at'), client.server_now().timestamp())
            client.document_lock_lost = None
            keeper = LockKeeper(
                lambda doc_id: self.renew_lock(doc_id, lock_id), document_id, ttl_s,
                on_lost=lambda lost: setattr(client, 'document_lock_lost', lost))
            keeper.start()
        raised = False
        try:
            yield DocumentLock(document_id, keeper, lock_id)
        except BaseException:
            raised = True
            raise
        finally:
            if keeper is not None:
                keeper.stop()
            lost = keeper.lost if keeper is not None else None
            client.document_lock_lost = None
            # Best-effort release: the server TTL reclaims a stranded lock, and
            # we must not let a release failure mask the real error from the body.
            try:
                self.release_lock(document_id, lock_id)
            except Exception as release_err:
                logging.getLogger(__name__).warning(
                    "Failed to release lock on document %s: %s", document_id, release_err)
            # A block that ran to the end without the lock it asked for did not
            # do what it says it did. Only raise when nothing else is already
            # propagating, so the real failure is never masked.
            if lost is not None and not raised:
                raise lost

    def get_media(self, document_id: str) -> bytes:
        """Get the media file for a document.

        Media is not versioned, so there is no as-of form: the route refuses the
        parameter. Prefer the document's own media URL, which carries the file's
        version for caching.

        Args:
            document_id: The document ID
        """
        return self._request('GET', f'/api/v1/documents/{document_id}/media',
                             binary_response=True)

    def media_link(self, document_id: str) -> Any:
        """Get a link that plays the document's recording without an
        Authorization header, for an audio or video element, which cannot send
        one.

        Answers ``{'url': ..., 'expires_at': ...}``. ``url`` is the document's
        media URL with a ``media-token`` added, resolved against the client's
        base URL. The token opens only this recording, for this user, and the
        server refuses it on every other route. It expires at ``expires_at``
        (an ISO-8601 instant, six hours on by default), and sooner when the
        user signs out, changes password or loses access to the project: ask
        for a new link then. A document with no recording is a 404. Writes
        nothing, so it takes no Idempotency-Key and goes over the wire when
        made on a batch.

        Args:
            document_id: The document ID
        """
        link = self._request('POST', f'/api/v1/documents/{document_id}/media/link',
                             out_of_band=True)
        return {**link, 'url': f"{self._client.base_url}{link['url']}"}

    def upload_media(self, document_id: str, file, audit_message=None, *,
                     on_progress=None) -> Any:
        """Upload a media file for a document. Uses Apache Tika for content validation.
        A document that already has a recording refuses it with a 409
        (``media-exists``, and the current ``media-url``): delete that one first.
        A WAV whose samples are not PCM, 32-bit float, A-law or mu-law (IMA or
        MS ADPCM, GSM, 64-bit float and the rest), which browsers cannot play,
        is refused with a 415 whose ``error`` names its coding.

        Args:
            document_id: The document ID
            file: The file to upload (an open binary file, or a
                ``(filename, bytes_or_file, content_type)`` tuple as for
                ``requests``)
            audit_message: Custom audit-log message for this write
            on_progress: Optional callback called with
                ``{'loaded': bytes_sent, 'total': body_bytes}`` as the file
                goes up, for a progress bar; the same payload as the JS
                client's ``onProgress``.
        """
        return self._request('PUT', f'/api/v1/documents/{document_id}/media',
                             body={'file': file}, form_data=True, no_batch=True,
                             audit_message=audit_message, on_upload_progress=on_progress)

    def delete_media(self, document_id: str, audit_message=None,
                     media_version: str = None) -> Any:
        """Delete media file for a document.

        Args:
            document_id: The document ID
            audit_message: Custom audit-log message for this write
            media_version: The recording meant, the ``?v=`` of the document's
                ``media_url``. The delete is refused with a 409
                (``media-changed``, and the current ``media-url``) when the
                stored recording is another one.
        """
        # No flag: the upload above is multipart and cannot be batched, but a
        # DELETE carries no blob, so the batch transport takes it. It is a
        # write of the document's own data and queues like any other. Note that
        # the file removal happens outside the server's transaction, so a batch
        # that aborts after this op does not bring the file back.
        return self._request('DELETE', f'/api/v1/documents/{document_id}/media',
                             query_params={'media-version': media_version},
                             audit_message=audit_message)

    def get(self, document_id: str, *, include_body: bool | None = None,
            as_of: str | None = None, layers=None) -> Any:
        """Get a document.

        Set ``include_body`` to true to include all data contained in the
        document.

        ``layers`` narrows a body read to the layers you name (ids of any
        kind: text, token, span, or relation). A layer comes back when it is
        named or is an ancestor of a named layer, and carries its own
        texts/tokens/spans/relations/vocabs only when it is itself named — so
        name the text layer too if you also want the text body. An id that is
        not a layer of this document's project is an error, not a quietly
        smaller response. Requires ``include_body``.

        Args:
            document_id: The document ID
            include_body: Include document body data
            as_of: Temporal query timestamp
            layers: Layer ids to restrict a body read to
        """
        return self._request('GET', f'/api/v1/documents/{document_id}',
                             query_params={'include-body': include_body, 'as-of': as_of,
                                           'layers': _layers_param(layers)})

    def delete(self, document_id: str, audit_message=None) -> Any:
        """Delete a document and all data contained.

        Args:
            document_id: The document ID
        """
        return self._request('DELETE', f'/api/v1/documents/{document_id}', audit_message=audit_message)

    def update(self, document_id: str, name: str, audit_message=None) -> Any:
        """Update a document's name.

        Args:
            document_id: The document ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/documents/{document_id}',
                             body=_body_of(name=name), audit_message=audit_message)

    def create(self, project_id: str, name: str, metadata: Any = _UNSET, audit_message=None,
               *, id: str | None = None) -> Any:
        """Create a new document in a project.

        Args:
            project_id: The project ID
            name: The name
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/documents',
                             body=_body_of(id=_UNSET if id is None else id, project_id=project_id, name=name, metadata=metadata), audit_message=audit_message)

    def set_metadata(self, document_id: str, body: Any, audit_message=None) -> Any:
        """Replace all metadata for a document.

        Args:
            document_id: The document ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/documents/{document_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def delete_metadata(self, document_id: str, audit_message=None) -> Any:
        """Remove all metadata from a document.

        Args:
            document_id: The document ID
        """
        return self._request('DELETE', f'/api/v1/documents/{document_id}/metadata',
                             audit_message=audit_message)

    def patch_metadata(self, document_id: str, body: Any, audit_message=None) -> Any:
        """Edit metadata for a document with a list of ops applied in order.

        ``{"op": "set", "path": [...], "value": v}`` writes v at the path,
        creating missing objects along it; ``{"op": "delete", "path": [...]}``
        removes the key at the path (a no-op when absent). A path is a
        non-empty list of keys, the first a top-level key. A path through a
        non-object is refused (400). See :func:`metadata_ops` and
        :func:`apply_metadata_ops`.

        Args:
            document_id: The document ID
            body: The metadata ops
        """
        return self._request('PATCH', f'/api/v1/documents/{document_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def audit(self, document_id: str, *, start_time: str | None = None,
              end_time: str | None = None,
              op_types=None, kinds=None) -> Any:
        """Get audit log for a document.

        Transparently follows server-side pagination cursors and returns the
        full flat list of audit entries. Each entry, and each of its ``ops``,
        says what kind of credential made it as ``credential``: ``login``,
        ``named-token`` or ``delegated`` (absent on older operations,
        ``service`` on some from 2026-10-06 to 2026-10-08), beside ``api_token`` (the named token's id and name)
        when there was one.

        Args:
            document_id: The document ID
            start_time: Start of time range
            end_time: End of time range
            op_types: Only return operations of these types, spelled as in an
                entry's ``op/type`` (e.g.
                ``['span-layer/create', 'span-layer/delete']``). An entry
                appears when one of its operations matches, carrying only the
                ones that did.
            kinds: Only the entries of operations of these kinds, as a list or
                comma-separated string (e.g. ``['review']``), each whole
        """
        return list_all(self._client, f'/api/v1/documents/{document_id}/audit',
                        query={'start-time': start_time, 'end-time': end_time,
                               'op-types': _op_types_param(op_types),
                               'kinds': _op_types_param(kinds)})

    def audit_page(self, document_id: str, *, start_time: str | None = None,
                   end_time: str | None = None,
                   op_types: Any = None, kinds: Any = None, order: str | None = None,
                   limit: int | None = None, cursor: str | None = None,
                   ops_limit: int | None = None, entry_id: str | None = None) -> Any:
        """One page of the same log, newest-first with ``order='desc'``.

        Use this rather than audit() wherever the caller wants the recent end
        of a log that may be long: audit() walks every page before it returns.

        Args:
            order: ``'desc'`` pages newest-first; a cursor belongs to the
                direction that produced it
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            ops_limit: Keep only each entry's oldest N operations in
                ``ops`` (1..1000). ``op_count`` on every entry says how many
                it has
            entry_id: Read only this entry, not a page
        """
        return list_page(self._client, f'/api/v1/documents/{document_id}/audit', limit=limit, cursor=cursor,
                         query={'start-time': start_time, 'end-time': end_time,
                                'op-types': _op_types_param(op_types),
                                'kinds': _op_types_param(kinds),
                                'order': order, 'ops-limit': ops_limit, 'entry-id': entry_id})

    def restore(self, document_id: str, as_of: str, *, dry_run: bool = False,
                audit_message: str | None = None) -> Any:
        """Restore a document to its state at an earlier time, as one operation.

        What was deleted since then comes back under its original id, what
        was added since is removed, and what changed is set back, across
        every layer. A layer deleted since then, or a vocabulary entry that
        no longer exists, is skipped and reported under ``skipped``. Returns
        a summary of the changes. Maintainers only.

        Args:
            document_id: The document ID
            as_of: The moment to go back to (ISO-8601 instant), typically a
                history entry's ``end_time``
            dry_run: When true nothing is written and the summary says what
                would change
            audit_message: Custom audit message for this operation
        """
        return self._request('POST', f'/api/v1/documents/{document_id}/restore',
                             query_params={'as-of': as_of,
                                           'dry-run': 'true' if dry_run else None},
                             audit_message=audit_message)

    def copy(self, document_id: str, name: str, *, include_media: Any = _UNSET,
             audit_message: str | None = None, id: str | None = None) -> Any:
        """Copy a document and everything in it, as one operation.

        The copy lands in the same project, sharing the source's layers and
        the vocabulary entries its links name, and holds the source's texts,
        tokens, spans, relations and vocab links under fresh ids, with their
        metadata. Comments do not travel. Returns ``{'id': ...}``, plus
        ``media_error`` when the source had media the copy could not take
        with it. Writers only.

        Args:
            document_id: The document to copy
            name: The new document's name
            include_media: Omit to take the media file along; False leaves it
                behind
            audit_message: Custom audit message for this operation
            id: Optional. The id to create the copy under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', f'/api/v1/documents/{document_id}/copy',
                             body=_body_of(id=_UNSET if id is None else id, name=name, include_media=include_media),
                             audit_message=audit_message)


class MessagesResource(_Resource):
    def listen(self, project_id: str, on_event, path: str | None = None) -> SSEConnection:
        """Open a Server-Sent Events stream for a project.

        Args:
            project_id: The UUID of the project to listen to
            on_event: Callback function that receives (event_type, data). If it
                returns true, listening will stop.
            path: Stream path under the base URL. Defaults to the project
                /listen bus (audit-log + broadcast messages); service request
                channels pass their own path.

        Returns:
            SSE connection object with .close() and .get_stats() methods
        """
        return SSEConnection(self._client, project_id, on_event, path=path)

    def send_message(self, project_id: str, data: Any) -> Any:
        """Send a message to project listeners.

        ``data`` may be any JSON value and is sent VERBATIM (``raw_body``): a
        message payload is opaque application data, like ``metadata`` and
        ``config``, so its keys must not be re-cased on the way out. Without
        this a key such as ``case-marker`` would reach listeners as
        ``case_marker`` in Python and ``caseMarker`` in JavaScript.
        :meth:`listen` restores it verbatim on the way in.

        A message is not saved and writes nothing to History, so it never
        joins an open operation (:meth:`PlaidClient.operation`). Made on a
        batch it still queues, so a message queued after the writes goes out
        after them.

        Args:
            project_id: The UUID of the project to send to
            data: The message data to send

        Returns:
            Response from the send operation
        """
        return self._request('POST', f'/api/v1/projects/{project_id}/message',
                             raw_body={'body': data}, no_operation=True)

    def discover_services(self, project_id: str) -> list:
        """Discover the services seen on a project.

        Reads the server-side service registry synchronously. Returns every
        service ever registered on the project: currently connected ones carry
        ``online: True``; previously-seen offline ones carry ``online: False``
        plus a ``last_seen_at`` stamp. Goes over the wire even while a batch
        is open on the client.

        Args:
            project_id: The UUID of the project to query

        Returns:
            List of discovered service information
        """
        return svc.discover_services(self._client, project_id)

    def discard_service(self, project_id: str, service_id: str) -> Any:
        """Forget a previously-seen (offline) service.

        Removes the service's row from the project's persistent registry.
        Maintainer-only; 409 if the service is currently connected.

        Args:
            project_id: The UUID of the project
            service_id: The ID of the service to forget
        """
        return svc.discard_service(self._client, project_id, service_id)

    def serve(self, project_id: str, service_info: dict, on_service_request,
              extras: dict | None = None, on_status=None) -> svc.ServiceRegistration:
        """Register as a service and handle incoming work requests.

        Requests are delivered over the service's own addressed channel (not the
        broadcast bus); replies stream back to the one requester.

        The registration reopens its channel whenever it drops, so a server
        restart needs no service restart, and a server that is not up yet is
        waited for rather than treated as an error. Only a failure retrying
        cannot fix (bad token, no write access, unknown project) raises
        ``ServiceRegistrationError``.

        Args:
            project_id: The UUID of the project to serve
            service_info: Service information {service_id, service_name, description}
            on_service_request: Callback (data, response_helper)
            extras: Optional additional service metadata
            on_status: Optional callback (event, project_id, detail) for
                connection-state transitions ('registered', 'reconnected',
                'disconnected', 'waiting', and 'stopped' when the server
                refuses the channel for good, which ends the registration), one
                call per transition

        Returns:
            Service registration object with .stop(), .is_running() and
            .is_connected()
        """
        return svc.serve(
            self._client, project_id, service_info, on_service_request, extras,
            on_status=on_status)

    def request_service(self, project_id: str, service_id: str, data: Any,
                        timeout: float = 10.0, on_progress=None,
                        request_id: str | None = None, on_accepted=None,
                        project_ids: list[str] | None = None, no_operation: bool = False) -> Any:
        """Request a service to perform work and await its result.

        Streams the service's progress + result back over a single
        server-mediated response. Raises if no service is connected.

        The request outlives this call: after a timeout or a dropped
        connection the service goes on, and :meth:`attach_service_request`
        collects the result given the request id (``on_accepted`` receives it
        as soon as the server has taken the request). Pass ``request_id`` (a
        UUID you mint) to know the id before submitting; submitting an id that
        names a request you already made rejoins it instead of starting
        another.

        Args:
            project_id: The UUID of the project
            service_id: The ID of the service to request
            data: The request data
            timeout: Timeout in seconds (default: 10.0)
            on_progress: Optional callback invoked with each progress payload
            request_id: Optional client-minted request id (a UUID)
            on_accepted: Optional callback invoked with the request id
            project_ids: Optional other projects the request is about. A
                delegating service's token is scoped to project_id and to
                those of these the requester can read, and nothing else.
            no_operation: If True, carry no open operation: the service's
                writes are a group of their own, not part of whatever
                operation this client has open.

        Returns:
            Service response
        """
        return svc.request_service(
            self._client, project_id, service_id, data, timeout, on_progress,
            request_id=request_id, on_accepted=on_accepted, project_ids=project_ids,
            no_operation=no_operation)

    def attach_service_request(self, project_id: str, request_id: str,
                               timeout: float = 10.0, on_progress=None) -> Any:
        """Rejoin a service request made earlier and await its result: the
        latest progress is replayed, then the result comes, or at once if the
        request already finished. Only the user who submitted it (or an
        admin). Raises :class:`PlaidAPIError` with status 404 when the request
        is unknown or expired (a finished request's result is kept for a
        while, not forever).

        Args:
            project_id: The UUID of the project
            request_id: The request id (from ``on_accepted`` or your own)
            timeout: Timeout in seconds (default: 10.0)
            on_progress: Optional callback invoked with each progress payload
        """
        return svc.attach_service_request(self._client, project_id, request_id, timeout, on_progress)

    def cancel_service_request(self, project_id: str, request_id: str) -> Any:
        """Ask the service to stop a request made earlier. The request still
        ends with whatever the service then reports, on the stream of whoever
        is awaiting it. 404 if unknown or expired, 409 once finished.

        Args:
            project_id: The UUID of the project
            request_id: The request id
        """
        return svc.cancel_service_request(self._client, project_id, request_id)


class ProjectsResource(_Resource):
    def create(self, name: str, audit_message=None, *, id: str | None = None) -> Any:
        """Create a new project.

        Also registers the current user as a maintainer.

        Args:
            name: The name
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/projects',
                             body=_body_of(id=_UNSET if id is None else id, name=name), audit_message=audit_message)

    def list(self) -> Any:
        """List all projects accessible to the current user.

        Transparently follows server-side pagination cursors and returns the
        full flat list.
        """
        return list_all(self._client, '/api/v1/projects')

    def list_page(self, *, limit: int | None = None, cursor: str | None = None) -> Any:
        """List one page of projects.

        Args:
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, '/api/v1/projects',
                         limit=limit, cursor=cursor)

    def iter_pages(self, *, page_size: int = 1000):
        """Iterate over pages of projects, yielding each page's entries list.

        Args:
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, '/api/v1/projects',
                          page_size=page_size)

    def list_documents(self, id: str) -> Any:
        """List all documents (IDs and names) in a project.

        Transparently follows server-side pagination cursors and returns the
        full flat list. Replaces the removed ``include_documents`` param on
        ``get``.

        Note: this endpoint does not support temporal (``as-of``) queries; the
        server rejects ``?as-of=`` on the documents-list route with a 400.

        Args:
            id: The project ID
        """
        return list_all(self._client, f'/api/v1/projects/{id}/documents')

    def list_documents_page(self, id: str, *, limit: int | None = None,
                            cursor: str | None = None) -> Any:
        """List one page of a project's documents.

        Note: this endpoint does not support temporal (``as-of``) queries; the
        server rejects ``?as-of=`` on the documents-list route with a 400.

        Args:
            id: The project ID
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, f'/api/v1/projects/{id}/documents',
                         limit=limit, cursor=cursor)

    def iter_documents(self, id: str, *, page_size: int = 1000):
        """Iterate over pages of a project's documents, yielding each page's entries.

        Note: this endpoint does not support temporal (``as-of``) queries; the
        server rejects ``?as-of=`` on the documents-list route with a 400.

        Args:
            id: The project ID
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, f'/api/v1/projects/{id}/documents',
                          page_size=page_size)

    def get(self, id: str) -> Any:
        """Get a project by ID.

        To fetch the project's document IDs and names, use ``list_documents``
        (the former ``include_documents`` param has been removed server-side).

        Args:
            id: The resource ID
        """
        return self._request('GET', f'/api/v1/projects/{id}')

    def delete(self, id: str, audit_message=None, timeout=_UNSET) -> Any:
        """Delete a project and everything in it. This is irrecoverable. The
        project is gone when this returns, and what it holds is removed on
        the server afterwards.

        Args:
            id: The resource ID
            audit_message: Custom audit-log message.
            timeout: Per-request timeout in seconds, the client's own by
                default. ``None`` or 0 disables it.
        """
        return self._request('DELETE', f'/api/v1/projects/{id}',
                              audit_message=audit_message,
                              **_body_of(timeout=timeout))

    def update(self, id: str, name: str, audit_message=None) -> Any:
        """Update a project's name.

        Args:
            id: The resource ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/projects/{id}',
                             body=_body_of(name=name), audit_message=audit_message)

    def add_writer(self, id: str, user_id: str, audit_message=None) -> Any:
        """Set a user's access level to read and write for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('POST', f'/api/v1/projects/{id}/writers/{user_id}', audit_message=audit_message)

    def remove_writer(self, id: str, user_id: str, audit_message=None) -> Any:
        """Remove a user's writer privileges for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/writers/{user_id}', audit_message=audit_message)

    def add_reader(self, id: str, user_id: str, audit_message=None) -> Any:
        """Set a user's access level to read-only for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('POST', f'/api/v1/projects/{id}/readers/{user_id}', audit_message=audit_message)

    def remove_reader(self, id: str, user_id: str, audit_message=None) -> Any:
        """Remove a user's reader privileges for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/readers/{user_id}', audit_message=audit_message)

    def add_maintainer(self, id: str, user_id: str, audit_message=None) -> Any:
        """Assign a user as a maintainer for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('POST', f'/api/v1/projects/{id}/maintainers/{user_id}', audit_message=audit_message)

    def remove_maintainer(self, id: str, user_id: str, audit_message=None) -> Any:
        """Remove a user's maintainer privileges for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/maintainers/{user_id}', audit_message=audit_message)

    def set_config(self, id: str, namespace: str, config_key: str, config_value: Any, audit_message=None,
                   expected: Any = _UNSET) -> Any:
        """Set a configuration value for a project in an editor namespace.

        Args:
            id: The resource ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
            expected: The value read for this key (``None`` when it was absent). When given, the
                write is refused with a 409 when the stored value is no longer ``expected``.
        """
        return self._request('PUT', f'/api/v1/projects/{id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, config_value, expected))

    def delete_config(self, id: str, namespace: str, config_key: str, audit_message=None,
                      expected: Any = _UNSET) -> Any:
        """Remove a configuration value for a project.

        Args:
            id: The resource ID
            namespace: The config namespace
            config_key: The config key
            expected: As on ``set_config``.
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, _UNSET, expected))

    def audit(self, project_id: str, *, start_time: str | None = None,
              end_time: str | None = None,
              op_types=None, kinds=None) -> Any:
        """Get audit log for a project.

        Transparently follows server-side pagination cursors and returns the
        full flat list of audit entries. Each entry, and each of its ``ops``,
        says what kind of credential made it as ``credential``: ``login``,
        ``named-token`` or ``delegated`` (absent on older operations,
        ``service`` on some from 2026-10-06 to 2026-10-08), beside ``api_token`` (the named token's id and name)
        when there was one.

        Args:
            project_id: The project ID
            start_time: Start of time range
            end_time: End of time range
            op_types: Only return operations of these types, spelled as in an
                entry's ``op/type`` (e.g.
                ``['span-layer/create', 'span-layer/delete']``). An entry
                appears when one of its operations matches, carrying only the
                ones that did.
            kinds: Only the entries of operations of these kinds, as a list or
                comma-separated string (e.g. ``['review']``), each whole
        """
        return list_all(self._client, f'/api/v1/projects/{project_id}/audit',
                        query={'start-time': start_time, 'end-time': end_time,
                               'op-types': _op_types_param(op_types),
                               'kinds': _op_types_param(kinds)})

    def audit_page(self, project_id: str, *, start_time: str | None = None,
                   end_time: str | None = None,
                   op_types: Any = None, kinds: Any = None, order: str | None = None,
                   limit: int | None = None, cursor: str | None = None,
                   ops_limit: int | None = None, entry_id: str | None = None) -> Any:
        """One page of the same log, newest-first with ``order='desc'``.

        Use this rather than audit() wherever the caller wants the recent end
        of a log that may be long: audit() walks every page before it returns.

        Args:
            order: ``'desc'`` pages newest-first; a cursor belongs to the
                direction that produced it
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            ops_limit: Keep only each entry's oldest N operations in
                ``ops`` (1..1000). ``op_count`` on every entry says how many
                it has
            entry_id: Read only this entry, not a page
        """
        return list_page(self._client, f'/api/v1/projects/{project_id}/audit', limit=limit, cursor=cursor,
                         query={'start-time': start_time, 'end-time': end_time,
                                'op-types': _op_types_param(op_types),
                                'kinds': _op_types_param(kinds),
                                'order': order, 'ops-limit': ops_limit, 'entry-id': entry_id})

    def my_last_edits(self, project_id: str) -> Any:
        """When you last wrote to each document in a project, as a
        ``{document_id: timestamp}`` dict.

        Documents you have never written to are absent. One request covers a
        whole document list.

        The response is NOT key-transformed: its keys are document ids, and
        recasing would mangle the hyphens in a UUID.

        Args:
            project_id: The project ID
        """
        return self._request('GET', f'/api/v1/projects/{project_id}/audit/last-edits',
                             skip_response_transform=True)

    def link_vocab(self, id: str, vocab_id: str, audit_message=None) -> Any:
        """Link a vocabulary to a project.

        Args:
            id: The resource ID
            vocab_id: The vocab layer ID
        """
        return self._request('POST', f'/api/v1/projects/{id}/vocabs/{vocab_id}', audit_message=audit_message)

    def unlink_vocab(self, id: str, vocab_id: str, audit_message=None) -> Any:
        """Unlink a vocabulary from a project.

        Args:
            id: The resource ID
            vocab_id: The vocab layer ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/vocabs/{vocab_id}', audit_message=audit_message)


class TextLayersResource(_Resource):
    def get(self, text_layer_id: str) -> Any:
        """Get a text layer by ID.

        Args:
            text_layer_id: The text layer ID
        """
        return self._request('GET', f'/api/v1/text-layers/{text_layer_id}')

    def delete(self, text_layer_id: str, audit_message=None) -> Any:
        """Delete a text layer.

        Args:
            text_layer_id: The text layer ID
        """
        return self._request('DELETE', f'/api/v1/text-layers/{text_layer_id}', audit_message=audit_message)

    def update(self, text_layer_id: str, name: str, audit_message=None) -> Any:
        """Update a text layer's name.

        Args:
            text_layer_id: The text layer ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/text-layers/{text_layer_id}',
                             body=_body_of(name=name), audit_message=audit_message)

    def set_config(self, text_layer_id: str, namespace: str, config_key: str, config_value: Any, audit_message=None,
                   expected: Any = _UNSET) -> Any:
        """Set a configuration value for a text layer in an editor namespace.

        Args:
            text_layer_id: The text layer ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
            expected: The value read for this key (``None`` when it was absent). When given, the
                write is refused with a 409 when the stored value is no longer ``expected``.
        """
        return self._request('PUT', f'/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, config_value, expected))

    def delete_config(self, text_layer_id: str, namespace: str, config_key: str, audit_message=None,
                      expected: Any = _UNSET) -> Any:
        """Remove a configuration value for a text layer.

        Args:
            text_layer_id: The text layer ID
            namespace: The config namespace
            config_key: The config key
            expected: As on ``set_config``.
        """
        return self._request('DELETE', f'/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, _UNSET, expected))

    def shift(self, text_layer_id: str, direction: str, audit_message=None) -> Any:
        """Shift a text layer's order within the project.

        Args:
            text_layer_id: The text layer ID
            direction: The direction ("up" or "down")
        """
        return self._request('POST', f'/api/v1/text-layers/{text_layer_id}/shift',
                             body=_body_of(direction=direction), audit_message=audit_message)

    def create(self, project_id: str, name: str, audit_message=None, *,
               id: str | None = None) -> Any:
        """Create a new text layer for a project.

        Args:
            project_id: The project ID
            name: The name
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/text-layers',
                             body=_body_of(id=_UNSET if id is None else id, project_id=project_id, name=name), audit_message=audit_message)


class VocabItemsResource(_Resource):
    def create(self, vocab_layer_id: str, form: str, metadata: Any = _UNSET, audit_message=None,
               *, id: str | None = None) -> Any:
        """Create a new vocab item.

        Args:
            vocab_layer_id: The vocab layer ID
            form: The vocab item form
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/vocab-items',
                             body=_body_of(id=_UNSET if id is None else id, vocab_layer_id=vocab_layer_id, form=form, metadata=metadata), audit_message=audit_message)

    def bulk_create(self, body: list, audit_message=None) -> dict:
        """Create multiple vocab items in a single operation.

        Entries may target different vocab layers; the user must have write
        access to each. Each entry is a dict with keys ``vocab_layer_id``,
        ``form``, and optional ``metadata``.

        Args:
            body: The vocab items to create

        Returns:
            ``{"ids": [...]}`` — the created item IDs, in input order. (All
            bulk_create endpoints share this shape; bulk_delete returns no body.)
        """
        return self._request('POST', '/api/v1/vocab-items/bulk', body=body, audit_message=audit_message)

    def bulk_update(self, body: list, audit_message=None) -> dict:
        """Update many vocab items in a single operation: set forms and/or
        patch metadata.

        Each entry is a dict with ``id`` and either or both of ``form`` (set
        only when the key is present) and ``metadata`` (a list of metadata
        ops, as for ``patch_metadata``). The entries may lie in several vocab
        layers; the user must have write access to each. An unknown id
        refuses the whole update, and an id may appear only once. Only an
        entry whose form really changes restates the documents linking it,
        and a strict-mode client picks up their new versions from the
        response.

        Args:
            body: The vocab item updates

        Returns:
            ``{"count": n}`` — how many vocab items were updated.
        """
        return self._request('PATCH', '/api/v1/vocab-items/bulk', body=body, audit_message=audit_message)

    def bulk_delete(self, body: list, audit_message=None) -> Any:
        """Delete multiple vocab items in a single operation. Provide a list of IDs.

        Each item's descendant vocab links are deleted too. Every document
        holding one of those links has its version bumped, and a strict-mode
        client picks up their new versions from the response.

        Args:
            body: The vocab item IDs to delete
        """
        return self._request('DELETE', '/api/v1/vocab-items/bulk', body=body, audit_message=audit_message)

    def get(self, id: str) -> Any:
        """Get a vocab item by ID.

        Args:
            id: The resource ID
        """
        return self._request('GET', f'/api/v1/vocab-items/{id}')

    def delete(self, id: str, audit_message=None, expected_link_count: int = None) -> Any:
        """Delete a vocab item, and every link to it.

        Every document holding one of those links has its version bumped, and a
        strict-mode client picks up their new versions from the response.

        Args:
            id: The resource ID
            expected_link_count: The number of links the caller showed. The
                delete is refused with a 409 when the entry has any other
                number of links by then.
        """
        return self._request('DELETE', f'/api/v1/vocab-items/{id}',
                             query_params={'expected-link-count': expected_link_count},
                             audit_message=audit_message)

    def merge(self, survivor_id: str, loser_ids: list, audit_message=None) -> Any:
        """Merge entries into this one, in one operation.

        Every link to a loser moves to the survivor (keeping its id and
        metadata), except a link on words the survivor is already linked to,
        which is deleted, and then the losers are deleted. Links are read when
        the merge runs, so one made after the caller looked moves too. Every
        loser must be in the survivor's vocabulary, and a loser that is already
        gone is skipped, so a repeated merge changes nothing. Metadata naming a
        loser by its id, in the vocabulary's other entries and in the documents
        of every project it is linked to, is rewritten to name the survivor. A
        reference to a loser in the survivor's own metadata is the caller's to
        rewrite, in the same batch. Needs maintainer rights on the vocabulary.

        Args:
            survivor_id: The entry that stays
            loser_ids: The entries merged into it

        Returns:
            ``{'moved': n, 'duplicates': n, 'removed': [ids]}``
        """
        return self._request('POST', f'/api/v1/vocab-items/{survivor_id}/merge',
                             body={'losers': list(loser_ids)}, audit_message=audit_message)

    def update(self, id: str, form: str, audit_message=None) -> Any:
        """Update a vocab item's form.

        A document read carries the entry's form on every link to it, so a
        rename restates those documents: each has its version bumped, and a
        strict-mode client picks up their new versions from the response.

        Args:
            id: The resource ID
            form: The vocab item form
        """
        return self._request('PATCH', f'/api/v1/vocab-items/{id}',
                             body=_body_of(form=form), audit_message=audit_message)

    def set_metadata(self, id: str, body: Any, audit_message=None) -> Any:
        """Replace all metadata for a vocab item.

        Args:
            id: The resource ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/vocab-items/{id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def delete_metadata(self, id: str, audit_message=None) -> Any:
        """Remove all metadata from a vocab item.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-items/{id}/metadata',
                             audit_message=audit_message)

    def patch_metadata(self, id: str, body: Any, audit_message=None) -> Any:
        """Edit metadata for a vocab item with a list of ops applied in order.

        ``{"op": "set", "path": [...], "value": v}`` writes v at the path,
        creating missing objects along it; ``{"op": "delete", "path": [...]}``
        removes the key at the path (a no-op when absent). A path is a
        non-empty list of keys, the first a top-level key. A path through a
        non-object is refused (400). See :func:`metadata_ops` and
        :func:`apply_metadata_ops`.

        Args:
            id: The resource ID
            body: The metadata ops
        """
        return self._request('PATCH', f'/api/v1/vocab-items/{id}/metadata',
                             raw_body=body, audit_message=audit_message)


class RelationLayersResource(_ConstraintMethods, _Resource):
    _kind = 'relation-layers'

    def get(self, relation_layer_id: str) -> Any:
        """Get a relation layer by ID.

        Args:
            relation_layer_id: The relation layer ID
        """
        return self._request('GET', f'/api/v1/relation-layers/{relation_layer_id}')

    def delete(self, relation_layer_id: str, audit_message=None) -> Any:
        """Delete a relation layer.

        Args:
            relation_layer_id: The relation layer ID
        """
        return self._request('DELETE', f'/api/v1/relation-layers/{relation_layer_id}', audit_message=audit_message)

    def update(self, relation_layer_id: str, name: str, audit_message=None) -> Any:
        """Update a relation layer's name.

        Args:
            relation_layer_id: The relation layer ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/relation-layers/{relation_layer_id}',
                             body=_body_of(name=name), audit_message=audit_message)

    def set_config(self, relation_layer_id: str, namespace: str, config_key: str, config_value: Any, audit_message=None,
                   expected: Any = _UNSET) -> Any:
        """Set a configuration value for a relation layer in an editor namespace.

        Args:
            relation_layer_id: The relation layer ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
            expected: The value read for this key (``None`` when it was absent). When given, the
                write is refused with a 409 when the stored value is no longer ``expected``.
        """
        return self._request('PUT', f'/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, config_value, expected))

    def delete_config(self, relation_layer_id: str, namespace: str, config_key: str, audit_message=None,
                      expected: Any = _UNSET) -> Any:
        """Remove a configuration value for a relation layer.

        Args:
            relation_layer_id: The relation layer ID
            namespace: The config namespace
            config_key: The config key
            expected: As on ``set_config``.
        """
        return self._request('DELETE', f'/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}',
                             **_config_request(audit_message, _UNSET, expected))

    def shift(self, relation_layer_id: str, direction: str, audit_message=None) -> Any:
        """Shift a relation layer's display order.

        Args:
            relation_layer_id: The relation layer ID
            direction: The direction ("up" or "down")
        """
        return self._request('POST', f'/api/v1/relation-layers/{relation_layer_id}/shift',
                             body=_body_of(direction=direction), audit_message=audit_message)

    def create(self, span_layer_id: str, name: str, audit_message=None, *,
               id: str | None = None) -> Any:
        """Create a new relation layer.

        Args:
            span_layer_id: The span layer ID
            name: The name
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/relation-layers',
                             body=_body_of(id=_UNSET if id is None else id, span_layer_id=span_layer_id, name=name), audit_message=audit_message)


class TokensResource(_Resource):
    def set_metadata(self, token_id: str, body: Any, audit_message=None) -> Any:
        """Replace all metadata for a token.

        Args:
            token_id: The token ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/tokens/{token_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def delete_metadata(self, token_id: str, audit_message=None) -> Any:
        """Remove all metadata from a token.

        Args:
            token_id: The token ID
        """
        return self._request('DELETE', f'/api/v1/tokens/{token_id}/metadata',
                             audit_message=audit_message)

    def patch_metadata(self, token_id: str, body: Any, audit_message=None) -> Any:
        """Edit metadata for a token with a list of ops applied in order.

        ``{"op": "set", "path": [...], "value": v}`` writes v at the path,
        creating missing objects along it; ``{"op": "delete", "path": [...]}``
        removes the key at the path (a no-op when absent). A path is a
        non-empty list of keys, the first a top-level key. A path through a
        non-object is refused (400). See :func:`metadata_ops` and
        :func:`apply_metadata_ops`.

        Args:
            token_id: The token ID
            body: The metadata ops
        """
        return self._request('PATCH', f'/api/v1/tokens/{token_id}/metadata',
                             raw_body=body, audit_message=audit_message)

    def get(self, token_id: str) -> Any:
        """Get a token.

        Args:
            token_id: The token ID
        """
        return self._request('GET', f'/api/v1/tokens/{token_id}')

    def delete(self, token_id: str, audit_message=None) -> Any:
        """Delete a token and remove it from any spans.

        If this causes a span to have no remaining tokens, the span will
        also be deleted.

        Args:
            token_id: The token ID
        """
        return self._request('DELETE', f'/api/v1/tokens/{token_id}', audit_message=audit_message)

    def update(self, token_id: str, *, begin: Any = _UNSET, end: Any = _UNSET,
               precedence: Any = _UNSET, audit_message=None) -> Any:
        """Update a token's ``begin``, ``end``, or ``precedence``.

        ``precedence`` distinguishes three cases: omit it to leave the value
        unchanged; pass an int to set it; pass ``None`` explicitly to CLEAR it
        (revert to no explicit ordering) -- the server reads key-presence, not
        non-nil-ness, so a sent JSON ``null`` is an explicit clear.
        ``begin``/``end`` are left unchanged when omitted.

        Args:
            token_id: The token ID
            begin: New start offset, inclusive (Unicode code points). Omit to leave unchanged.
            end: New end offset, exclusive (Unicode code points). Omit to leave unchanged.
            precedence: Ordering precedence. Omit to leave unchanged; pass an
                int to set; pass ``None`` explicitly to CLEAR it (revert to no
                explicit ordering).
        """
        return self._request('PATCH', f'/api/v1/tokens/{token_id}',
                             body=_body_of(begin=begin, end=end, precedence=precedence), audit_message=audit_message)

    def create(self, token_layer_id: str, text: str, begin: int, end: int, *,
               precedence: Any = _UNSET, metadata: Any = _UNSET, audit_message=None,
               id: str | None = None) -> Any:
        """Create a new token in a token layer.

        Tokens define text substrings using ``begin`` and ``end`` offsets.
        Tokens may be zero-width and may overlap. For tokens sharing the
        same ``begin``, ``precedence`` controls the linear ordering.

        Offsets are 0-based indices in Unicode CODE POINTS (not UTF-16 code
        units or bytes): a supplementary-plane character (emoji, SMP script)
        counts as one. Python ``str`` is code-point native, so ``len(s)`` and
        ``s[begin:end]`` already give the right offsets and surface.

        Args:
            token_layer_id: The token layer ID
            text: The text ID
            begin: Start offset, inclusive (Unicode code points)
            end: End offset, exclusive (Unicode code points)
            precedence: Ordering precedence. Omit to leave unset; pass ``None``
                to send JSON null.
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
            id: Optional. The id to create it under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
        """
        return self._request('POST', '/api/v1/tokens',
                             body=_body_of(id=_UNSET if id is None else id, token_layer_id=token_layer_id, text=text,
                                           begin=begin, end=end, precedence=precedence,
                                           metadata=metadata), audit_message=audit_message)

    def bulk_create(self, body: list, audit_message=None) -> dict:
        """Create multiple tokens in a single operation.

        Args:
            body: The request body

        Returns:
            ``{"ids": [...]}`` — the created token IDs, in input order.
        """
        return self._request('POST', '/api/v1/tokens/bulk', body=body, audit_message=audit_message)

    def bulk_delete(self, body: list, audit_message=None) -> Any:
        """Delete multiple tokens in a single operation. Provide a list of IDs.

        Args:
            body: The request body
        """
        return self._request('DELETE', '/api/v1/tokens/bulk', body=body, audit_message=audit_message)

    def bulk_update(self, body: list, audit_message=None) -> dict:
        """Patch the metadata of many tokens in a single operation.

        Args:
            body: A list of ``{"id": ..., "metadata": [...]}`` objects; each
                ``metadata`` is a list of metadata ops, as for ``patch_metadata``. The
                tokens may lie in several documents of one project. Every document
                touched has its version bumped, and every new version comes back
                in ``X-Document-Versions`` (past fifty documents, only their
                number, in ``X-Document-Versions-Omitted``). A ``document-version`` precondition is
                accepted only when every entry lies in one document. An unknown id
                refuses the whole update.

        Returns:
            ``{"count": n}``, how many tokens were updated.
        """
        return self._request('PATCH', '/api/v1/tokens/bulk', body=body, audit_message=audit_message)

    def split(self, token_id: str, position: int, audit_message=None,
              *, id: str | None = None, keep: str | None = None) -> Any:
        """Split a token at a Unicode code-point offset.

        The original token becomes the left half (keeping its ID, spans, and
        vocab-links), or the right half with ``keep='right'``; a new token is
        created for the other half and its ID is returned. ``position`` must
        be strictly between the token's begin and end.
        A relation layer whose relations must stay inside one token of this
        layer declares a same-ancestor constraint, and the server deletes the
        relations the split leaves crossing in the same transaction.

        Args:
            token_id: The token ID
            position: Code-point offset to split at (strictly between begin and end)
            id: Optional. The id to create the new token under, a UUIDv7 this client
                minted (``plaid_client.uuid7()``), so a create sent again after
                its answer was lost lands once (409 with ``id_taken`` when the
                id was used before).
            keep: Optional. The half the original token (its id, spans,
                vocab-links, comments and metadata) stays on, ``'left'`` by
                default. With ``'right'`` the new token, whose id is answered,
                is the left half.
        """
        return self._request('POST', f'/api/v1/tokens/{token_id}/split',
                             body=_body_of(id=_UNSET if id is None else id,
                                           keep=_UNSET if keep is None else keep, position=position),
                             audit_message=audit_message)

    def merge(self, token_id: str, other_token_id: str, audit_message=None) -> Any:
        """Merge two tokens.

        The left token (smaller ``begin``) survives with the combined extent;
        the right is deleted and its spans and vocab-links are reparented to the
        left. On partitioning layers the two tokens must be adjacent; on
        non-overlapping layers the merged extent must not engulf a third token.

        Args:
            token_id: The anchor token ID
            other_token_id: The other token to merge in
        """
        return self._request('POST', f'/api/v1/tokens/{token_id}/merge',
                             body=_body_of(other_token_id=other_token_id), audit_message=audit_message)

    def shift(self, token_id: str, *, begin: Any = _UNSET, end: Any = _UNSET, audit_message=None) -> Any:
        """Shift a token's boundary.

        On partitioning layers the adjacent token is auto-adjusted to preserve
        the partition; on non-overlapping layers the shift is rejected if it
        would create an overlap.

        Args:
            token_id: The token ID
            begin: New start offset, inclusive (Unicode code points). Omit to leave unchanged.
            end: New end offset, exclusive (Unicode code points). Omit to leave unchanged.
        """
        return self._request('POST', f'/api/v1/tokens/{token_id}/shift',
                             body=_body_of(begin=begin, end=end), audit_message=audit_message)


class ServerFacts:
    """``GET /info`` as a client last read it, and whether it may be out of
    date. The limits change only when the server restarts with another
    configuration, and a restart always drops this client's streams, so a
    stream that drops marks the facts stale and the next stream to open reads
    them again (:meth:`PlaidClient._note_stream_opened`). A 413 from a
    user-data write reads them again too. A service hands its facts to the
    clients it makes for its requesters, so a turn reads none of its own.
    """

    def __init__(self):
        self.info: Any = None
        self.stale = False
        self.lock = threading.Lock()


class ServerResource(_Resource):
    """Server-level facts. Read once, and again only when they may have
    changed: after this client's connection to the server was lost and came
    back, or after the server refused a user-data write as too large. A caller
    asking "will this file be accepted" does not pay a round trip to find out.
    """

    def info(self) -> Any:
        """This server's version and the limits it enforces. Sizes are in
        bytes. Unauthenticated."""
        facts = self._client._server_facts
        with facts.lock:
            if facts.info is None:
                # Only a success is kept: a client that starts before the
                # server is up would otherwise never see the limits at all.
                facts.info = self._request('GET', '/api/v1/info')
            return facts.info

    def limits(self) -> Any:
        """Just the limits, which is what a caller almost always wants."""
        return self.info()['limits']

    def refresh(self) -> Any:
        """Read ``GET /info`` again and answer it. The facts known before are
        kept when the server does not answer, and the error is raised."""
        facts = self._client._server_facts
        with facts.lock:
            facts.info = self._request('GET', '/api/v1/info')
            facts.stale = False
            return facts.info

    def health(self) -> Any:
        """Liveness, version and database size.

        Unauthenticated, and served outside the REST router at ``/health``, so
        it answers even when the API is refusing requests. Never cached — the
        point is that it is current.
        """
        return self._request('GET', '/health')


class AuthResource(_Resource):
    """The signed-in user's sign-ins. Signing in is :meth:`PlaidClient.login`,
    which makes the client."""

    def logout_everywhere(self) -> None:
        """End every sign-in of this user on every device: each browser tab,
        script and service holding one of the user's sign-in tokens is refused
        from now on, this client included. Named API tokens are not affected
        (revoke one with ``api_tokens.revoke``). To sign out of one tab only,
        discard its token instead. A signal rather than project data: made on
        a batch it still goes out at once, and it never joins an operation.
        """
        self._request('POST', '/api/v1/logout', out_of_band=True)


class AdminResource(_Resource):
    """Instance-wide operations, for whoever runs the server. Admin only.

    These endpoints report freely and write almost never. The three writes —
    ``backup``, ``clear_rate_limits`` and ``release_lock`` — can only unblock
    something: take an extra snapshot, forget recorded failures, drop an
    advisory lock that expires on its own within a minute anyway. Nothing here
    edits configuration or deletes data.
    """

    def server(self) -> Any:
        """Everything about the server in one read.

        Version and JVM uptime, database size and per-table row counts, media
        directory usage, backup configuration and the backups on disk, and the
        settings an operator gets asked to confirm. Carries no secrets. Runs a
        count per table and walks the media directory, so call it when someone
        asks, not on a timer.
        """
        return self._request('GET', '/api/v1/admin/server')

    def backup(self) -> Any:
        """Take a database backup right now, outside the nightly schedule.

        Returns the backup block, with ``ok`` reporting whether the snapshot
        succeeded. Uses VACUUM INTO, which only reads, so it is safe while
        people are working.

        The server answers once the backup is written, which takes minutes on
        a large database, so this waits up to ``BACKUP_TIMEOUT_S`` (30
        minutes) rather than the client's usual timeout. A proxy in front of
        the server may still give up first (a 504): the backup goes on, and
        its file shows in ``server()['backup']['backups']`` once it is written.

        out_of_band, as every admin action on the server itself is: none of
        them writes project data (see the note at the top of http.py).
        """
        return self._request('POST', '/api/v1/admin/backup', out_of_band=True,
                             timeout=BACKUP_TIMEOUT_S)

    def locks(self) -> Any:
        """Documents currently held by an editing lock, with who holds each
        and when it expires on its own."""
        return self._request('GET', '/api/v1/admin/locks')

    def release_lock(self, document_id: str) -> Any:
        """Drop the lock on a document whoever holds it. Idempotent.

        For a client that went away without releasing one, which otherwise
        leaves the document unwritable until the lock expires.

        Args:
            document_id: The document to unlock
        """
        return self._request('DELETE', f'/api/v1/admin/locks/{document_id}',
                             out_of_band=True)

    def rate_limits(self) -> Any:
        """Live login and invite rate-limit buckets: the address, the account
        where there is one, failures inside the window, the limit, and whether
        it is currently blocking."""
        return self._request('GET', '/api/v1/admin/rate-limits')

    def clear_rate_limits(self, *, ip: str | None = None,
                          user_id: str | None = None) -> Any:
        """Forget recorded rate-limit failures. Only ever unblocks.

        Args:
            ip: Clear only this address; omit to clear every bucket
            user_id: Narrow to one account on that address
        """
        return self._request('DELETE', '/api/v1/admin/rate-limits',
                             query_params={'ip': ip, 'user-id': user_id},
                             out_of_band=True)

    def logs(self, *, limit: int | None = None, q: str | None = None,
             level: str | None = None, status: str | None = None,
             user: str | None = None, method: str | None = None) -> Any:
        """What the server has logged, structured and filtered.

        Read from an in-memory buffer kept whether or not a log file is
        configured. ``requests`` is one entry per HTTP request (method, path,
        status, duration, and who made it), ``events`` is everything else,
        with a stack trace where there was one. They are buffered separately
        so a burst of requests cannot evict an error. Both come newest first,
        ``matched`` counts what passed the filters, and request ``stats``
        describe the filtered set. Covers Plaid's own log stream since the
        last restart: for library messages and older history, see
        :meth:`log_file`.

        Args:
            limit: Max entries per kind (default 200, max 2000)
            q: Substring of any field, case-insensitive
            level: Minimum level for events, e.g. ``"warn"``
            status: ``"2xx"``..``"5xx"``, an exact code, or ``"failures"``
            user: Only requests made by this account
            method: Only requests with this HTTP method
        """
        return self._request('GET', '/api/v1/admin/logs',
                             query_params={'limit': limit, 'q': q,
                                           'level': level, 'status': status,
                                           'user': user, 'method': method})

    def log_file(self, *, lines: int | None = None) -> Any:
        """The tail of the configured log file, as text lines.

        The only place third-party library messages (connection pool, SQLite
        driver, HTTP server) and anything from before the last restart can be
        read. Returns an ``error`` string instead of lines when no log file is
        configured or it does not exist yet. The server also logs to stdout,
        where a file is not required.

        Args:
            lines: How many lines (default 200, max 2000)
        """
        return self._request('GET', '/api/v1/admin/logs/file',
                             query_params={'lines': lines})

    def user_data(self, *, prefix: str | None = None, pattern: str | None = None,
                  include_values: bool = False) -> Any:
        """Private user-data entries across every account, each with its ``user_id``.

        ``/users/<user_id>/data`` has always been owner-or-admin; this is the
        same reach across accounts at once. Transparently follows server-side
        pagination cursors and returns the full flat list, ordered by
        (user, key).

        Args:
            prefix: Only keys starting with this literal head
            pattern: Only keys matching this GLOB (``*`` any run, ``?`` one
                character) — the way to ask for a key convention identified by
                a segment in the middle, e.g. ``igt:assistant:*:meta:*``
            include_values: Also return each entry's value, recased like any
                other body (see ``user_data.put``)
        """
        return list_all(self._client, '/api/v1/admin/user-data',
                        query={'prefix': prefix, 'pattern': pattern,
                               'include-values': include_values or None})

    def user_data_page(self, *, prefix: str | None = None, pattern: str | None = None,
                       include_values: bool = False, limit: int | None = None,
                       cursor: str | None = None) -> Any:
        """One page of private user-data entries across accounts.

        Args:
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, '/api/v1/admin/user-data', limit=limit, cursor=cursor,
                         query={'prefix': prefix, 'pattern': pattern,
                                'include-values': include_values or None})


class AuditResource(_Resource):
    """The audit log across every project, and the per-user aggregate.

    Per-project, per-document and per-user reads live on their own resources
    (``projects.audit``, ``documents.audit``, ``users.audit``). What is here is
    the unscoped feed and the tally, which are the two shapes a dashboard
    wants.
    """

    def list(self, *, start_time: str | None = None, end_time: str | None = None,
             op_types: Any = None, kinds: Any = None) -> Any:
        """The audit log across every project, oldest first. Admin only.

        Same fold, window and op-type filter as the per-project read, with the
        entity scope dropped. Transparently follows server-side pagination
        cursors and returns the full flat list.

        Args:
            start_time: Only operations at or after this instant
            end_time: Only operations at or before this instant
            op_types: Only these op types, as a list or comma-separated string
                (e.g. ``['span-layer/create']``). An entry appears when one of
                its operations matches, carrying only the ones that did.
            kinds: Only the entries of operations of these kinds, as a list or
                comma-separated string (e.g. ``['review']``), each whole
        """
        return list_all(self._client, '/api/v1/audit',
                        query={'start-time': start_time, 'end-time': end_time,
                               'op-types': _op_types_param(op_types),
                               'kinds': _op_types_param(kinds)})

    def list_page(self, *, start_time: str | None = None, end_time: str | None = None,
                  op_types: Any = None, kinds: Any = None, order: str | None = None,
                  limit: int | None = None, cursor: str | None = None,
                  ops_limit: int | None = None, entry_id: str | None = None) -> Any:
        """One page of the instance-wide audit log. Admin only.

        Args:
            order: ``'desc'`` pages newest-first, which is what a feed wants;
                a cursor belongs to the direction that produced it
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            ops_limit: Keep only each entry's oldest N operations in
                ``ops`` (1..1000). ``op_count`` on every entry says how many
                it has
            entry_id: Read only this entry, not a page
        """
        return list_page(self._client, '/api/v1/audit', limit=limit, cursor=cursor,
                         query={'start-time': start_time, 'end-time': end_time,
                                'op-types': _op_types_param(op_types),
                                'kinds': _op_types_param(kinds),
                                'order': order, 'ops-limit': ops_limit, 'entry-id': entry_id})

    def iter_pages(self, *, start_time: str | None = None, end_time: str | None = None,
                   op_types: Any = None, kinds: Any = None, page_size: int = 1000):
        """Iterate the instance-wide audit log page by page. Admin only.

        """
        return iter_pages(self._client, '/api/v1/audit', page_size=page_size,
                          query={'start-time': start_time, 'end-time': end_time,
                                 'op-types': _op_types_param(op_types),
                                 'kinds': _op_types_param(kinds)})

    def tally(self, *, project_id: str | None = None, start_time: str | None = None,
              end_time: str | None = None, daily: bool | None = None) -> Any:
        """Per-user activity counts.

        ``changes`` is the number of logical actions, folded the way the audit
        feed folds them, so one "Confirm word analysis" counts once however
        many rows it wrote; ``operations`` is the unfolded row count. Only
        users who did something appear — subtract from the roster you already
        hold to find the ones who did not.

        With ``project_id``, scoped to that project and open to its
        maintainers. Without one, instance-wide and admin only.

        Args:
            project_id: Scope to one project
            start_time: Only count at or after this instant
            end_time: Only count at or before this instant
            daily: Also return ``by_day``, a list of ``{date, changes}`` per
                user, oldest first, at the cost of a second grouped scan
        """
        path = (f'/api/v1/projects/{project_id}/audit/tally' if project_id
                else '/api/v1/audit/tally')
        result = self._request('GET', path,
                               query_params={'start-time': start_time, 'end-time': end_time,
                                             'daily': daily})
        return result['entries']


class EventsResource(_Resource):
    """Client events, the opt-in research telemetry of a project.

    A project records them only while its config holds
    ``plaid.research.telemetry = True`` (``projects.set_config(id, 'plaid',
    'research', {'telemetry': True})``); otherwise the server refuses every
    event with a 403. The types are a closed set: ``suggestion.shown``,
    ``suggestion.adopted``, ``suggestion.dismissed`` and ``plan.opened``.
    Events are not audited and change no document version.

    The browser's buffered recorder (``events.record`` in the JavaScript
    client) has no counterpart here: a script that wants to record events
    sends them with :meth:`create`.
    """

    def create(self, project_id: str, events: list) -> Any:
        """Record events in a project. Requires write access.

        The server stamps the user and its own time. All or nothing: one bad
        event refuses the request with a 400 naming it.

        Args:
            project_id: The project the events happened in
            events: At most 500 dicts, each with ``type`` and optional
                ``document_id``, ``target_id``, ``data`` (an object) and
                ``client_ts`` (an ISO-8601 instant)

        Returns:
            ``{'count': n}``, the number stored
        """
        return self._request('POST', f'/api/v1/projects/{project_id}/events',
                             body=list(events), out_of_band=True)

    def list(self, project_id: str, *, types: Any = None, start_time: str | None = None,
             end_time: str | None = None) -> Any:
        """A project's events in arrival order. Maintainer or admin only.

        Transparently follows server-side pagination cursors and returns the
        full flat list.

        Args:
            project_id: The project to read
            types: Only these types, as a list or comma-separated string
            start_time: Only events the server stamped at or after this instant
            end_time: Only events the server stamped at or before this instant
        """
        return list_all(self._client, f'/api/v1/projects/{project_id}/events',
                        query={'types': _op_types_param(types), 'start-time': start_time,
                               'end-time': end_time})

    def list_page(self, project_id: str, *, types: Any = None, start_time: str | None = None,
                  end_time: str | None = None, limit: int | None = None,
                  cursor: str | None = None) -> Any:
        """One page of a project's events. Maintainer or admin only.

        Args:
            project_id: The project to read
            types: Only these types, as a list or comma-separated string
            start_time: Only events the server stamped at or after this instant
            end_time: Only events the server stamped at or before this instant
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
        """
        return list_page(self._client, f'/api/v1/projects/{project_id}/events',
                         limit=limit, cursor=cursor,
                         query={'types': _op_types_param(types), 'start-time': start_time,
                                'end-time': end_time})

    def iter_pages(self, project_id: str, *, types: Any = None, start_time: str | None = None,
                   end_time: str | None = None, page_size: int = 1000):
        """Iterate a project's events page by page, yielding each page's entries.

        Args:
            project_id: The project to read
            types: Only these types, as a list or comma-separated string
            start_time: Only events the server stamped at or after this instant
            end_time: Only events the server stamped at or before this instant
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, f'/api/v1/projects/{project_id}/events',
                          page_size=page_size,
                          query={'types': _op_types_param(types), 'start-time': start_time,
                                 'end-time': end_time})


class OperationGroupsResource(_Resource):
    """Logical-operation groups (audit-log grouping). There is no create: a
    group row is made lazily by the first write carrying ``?group-id=`` (see
    ``PlaidClient.begin_operation``). Not an audited write, so no
    ``audit_message`` parameter."""

    def get(self, id: str) -> Any:
        """Get a logical-operation group (its label + creator).

        Args:
            id: The group id
        """
        return self._request('GET', f'/api/v1/operation-groups/{id}')

    def update(self, id: str, message: str | None) -> Any:
        """Relabel a logical-operation group after the fact. Owner or admin only.

        Args:
            id: The group id
            message: The new label
        """
        return self._request('PATCH', f'/api/v1/operation-groups/{id}', body={'message': message})


def _install_resources(target):
    """The API resources (``documents``, ``tokens``, ...), built on ``target``:
    the client, or a batch opened on it (see PlaidBatch)."""
    target.vocab_links = VocabLinksResource(target)
    target.vocab_layers = VocabLayersResource(target)
    target.relations = RelationsResource(target)
    target.span_layers = SpanLayersResource(target)
    target.spans = SpansResource(target)
    target.texts = TextsResource(target)
    target.users = UsersResource(target)
    target.api_tokens = ApiTokensResource(target)
    target.user_data = UserDataResource(target)
    target.invites = InvitesResource(target)
    target.comments = CommentsResource(target)
    target.events = EventsResource(target)
    target.guidelines = GuidelinesResource(target)
    target.token_layers = TokenLayersResource(target)
    target.documents = DocumentsResource(target)
    target.messages = MessagesResource(target)
    target.projects = ProjectsResource(target)
    target.text_layers = TextLayersResource(target)
    target.vocab_items = VocabItemsResource(target)
    target.relation_layers = RelationLayersResource(target)
    target.tokens = TokensResource(target)
    target.server = ServerResource(target)
    target.auth = AuthResource(target)
    target.admin = AdminResource(target)
    target.audit = AuditResource(target)
    target.operation_groups = OperationGroupsResource(target)


def _claimed_version(path):
    """The document-version an op's path claims, as an int, or None."""
    query = path.split('?', 1)[1] if '?' in path else ''
    values = urllib.parse.parse_qs(query).get('document-version')
    return int(values[0]) if values else None


class PlaidClient:
    def __init__(self, base_url: str, token: str, timeout: float | None = DEFAULT_TIMEOUT_S,
                 batch_timeout: float | None = _UNSET, retry_delays: list[float] | None = None):
        """Create a new PlaidClient instance.

        Args:
            base_url: The base URL for the API
            token: The authentication token
            timeout: Per-request timeout in seconds (default 30; ``None`` or 0
                disables it). Also bounds media up/downloads — raise it for large files.
            batch_timeout: Timeout for batch submissions in seconds (default 180;
                ``None`` or 0 disables it). Batches get their own, longer budget:
                aborting one does NOT stop the server, which keeps running the
                transaction and holding the single SQLite write lock. Defaults
                to ``timeout`` when that was given explicitly and this was not.
            retry_delays: Delays in seconds before sending a keyed write again
                when its answer was lost (no response, 502 or 504). Default
                ``[1.0, 3.0, 9.0]``. See the Idempotency-Key note in http.py.
        """
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.timeout = timeout
        if batch_timeout is not _UNSET:
            self.batch_timeout = batch_timeout
        elif timeout is not DEFAULT_TIMEOUT_S:
            self.batch_timeout = timeout
        else:
            self.batch_timeout = DEFAULT_BATCH_TIMEOUT_S
        # Delays (seconds) before sending a keyed write again when its answer
        # was lost (no response, 502, 504). None for the default.
        self.retry_delays = None if retry_delays is None else list(retry_delays)
        self.document_versions: dict[str, str] = {}
        # The server's clock minus this machine's, in seconds, from the last
        # response with a Date header (None before one). See server_now().
        self.server_clock_offset_s: float | None = None
        self.strict_mode_document_id: str | None = None
        # Set to a DocumentLockLost while a ``documents.locked()`` block's
        # keep-alive has failed. Every write raises it until the block exits;
        # see plaid_client.document_lock.
        self.document_lock_lost: Exception | None = None
        # The open logical operation (audit-log group), or None. While set, every
        # write is stamped with ``?group-id=`` (+ ``group-message``) so the audit
        # log folds them into ONE expandable entry. See begin_operation /
        # operation(). Shape: {'id', 'message', 'kind', 'ref', 'depth', 'written', 'refined',
        # 'frames'}, each frame {'keys', 'count', 'minted', 'depth', 'owned'}.
        self._operation_group: dict | None = None
        self.session = req_lib.Session()
        # Who hears that a request is being sent again (on_retry).
        self._retry_listeners: list = []
        # GET /info as last read (``server.info()``).
        self._server_facts = ServerFacts()

        _install_resources(self)

    def _note_stream_dropped(self) -> None:
        """A stream of this client ended without being closed here: the
        server may have restarted, with other limits."""
        self._server_facts.stale = True

    def _note_stream_opened(self) -> None:
        """A stream of this client is open. After a drop, the limits are read
        again, once however many streams reopen."""
        facts = self._server_facts
        if not facts.stale:
            return
        with facts.lock:
            if not facts.stale:
                return
            try:
                facts.info = self._request('GET', '/api/v1/info')
                facts.stale = False
            except Exception as e:  # noqa: BLE001 - the figures known before stand, the next open asks again
                logging.getLogger(__name__).debug('Could not read the server limits again: %s', e)

    def on_retry(self, listener):
        """Hear every time a request is sent again: after a 503 (the database
        was busy), or for a keyed write after its answer was lost (no response,
        502, 504). ``listener`` gets ``{'attempt', 'retries', 'delay',
        'error'}`` (delay in seconds) before the wait. Returns the unsubscribe.
        The JS twin is ``client.onRetry``."""
        self._retry_listeners.append(listener)

        def unsubscribe():
            if listener in self._retry_listeners:
                self._retry_listeners.remove(listener)
        return unsubscribe

    def _note_retry(self, info):
        """Tell every ``on_retry`` listener. A listener that raises is passed
        over."""
        for listener in list(self._retry_listeners):
            try:
                listener(info)
            except Exception:
                pass

    def server_now(self) -> datetime:
        """The server's time now (UTC), as its last response's Date header
        put it (to the second), else this machine's. Judge a time the server
        stamped, such as an audit entry's ``ts``, against this rather than the
        machine's own clock, which can be minutes off."""
        return datetime.fromtimestamp(time.time() + (self.server_clock_offset_s or 0),
                                      tz=timezone.utc)

    def query(self, body: Any) -> Any:
        """Run a query over every project you can read.

        ``body`` is the query AST. Its keys follow the usual client convention
        (snake_case, e.g. ``scope['project_ids']``) and are converted to the
        wire format automatically; clause heads and variables are plain strings
        you write literally (e.g. ``'span'``, ``'?s1'``, ``'vocab-link'``).

        Example::

            client.query({
                'find': ['?s1', '?s2'],
                'where': [
                    ['span', '?s1', {'layer': pos_layer_id, 'value': 'NOUN'}],
                    ['span', '?s2', {'layer': pos_layer_id, 'value': 'VERB'}],
                    ['covers', '?s1', '?t1'], ['covers', '?s2', '?t2'],
                    ['precedes', '?t1', '?t2'],
                ],
                'return': 'entities',   # 'ids' (default) | 'entities' | 'count'
                'limit': 100,
            })

        A ``layer`` is referenced by its id (its UUID) only — not by name
        or path. To match a layer by name, bind it with a ``*-layer`` clause (e.g.
        ``['span-layer', '?sl', {'name': 'pos'}]``) and use the variable.

        Optional keys: ``scope`` (restrict to projects by id, ``{'project_ids': [...]}``),
        ``order_by`` (sort rows), and ``bindings`` (substitute ``?name`` placeholders
        with literals). ``return`` may also be an aggregate spec ``{group, aggregates}``.
        See the query language reference.

        Args:
            body: The query AST ({find, where, scope?, limit?, order_by?,
                return?, bindings?}).

        Returns:
            For 'ids'/'entities': {columns, results, count, truncated}. For
            'count': {return: 'count', count, truncated}, where ``truncated``
            says the count stopped at the server's cap. Entity cells are full
            entity dicts (same shape as the GET endpoints).
        """
        # out_of_band: a query is a read that travels as a POST (see the note
        # at the top of http.py). Made on a batch it goes over the wire like
        # any read, and it never joins a logical operation. It waits past
        # core's own query limit, so a query too broad answers with core's 408,
        # and a 503 from core's full queue of large queries is not retried.
        return self._request('POST', '/api/v1/query', body=body, out_of_band=True,
                             timeout=query_timeout(self), no_busy_retry=True)

    def _request(self, method, path, **kwargs):
        return make_request(self, method, path, **kwargs)

    def enter_strict_mode(self, document_id: str) -> None:
        """Enter strict mode for a specific document.

        Enables strict mode, requiring document version headers on writes.

        Args:
            document_id: The ID of the document to track versions for
        """
        self.strict_mode_document_id = document_id

    def exit_strict_mode(self) -> None:
        """Exit strict mode and stop tracking document versions for writes."""
        self.strict_mode_document_id = None

    def begin_operation(self, message: str | None, *, group_id: str | None = None,
                        kind: str | None = None, ref: str | None = None,
                        keys: dict | None = None, minted=None) -> str:
        """Begin a LOGICAL OPERATION: a user-meaningful action ("Merge
        morphemes", "Re-transcribe") implemented as many low-level writes,
        possibly across several batches and even a service round-trip. Until
        ``end_operation()``, every write is stamped with a client-minted
        ``?group-id=`` (and the message) so the audit log shows the whole run
        as ONE expandable entry labeled ``message``, with each write's own
        description underneath.

        Grouping is orthogonal to batches: a batch is a transaction boundary,
        an operation is an intent boundary. An operation is NOT atomic — if
        write 3 of 5 fails, writes 1–2 stay committed (and logged under the
        group). Use a batch inside the operation for any step that must be
        all-or-nothing.

        Nesting flattens: a ``begin_operation`` while one is open is a no-op
        that joins the outer operation (the outer label wins), and the
        matching ``end_operation`` is likewise a no-op. The label is recorded
        on the FIRST write, so an operation that is never ended (crash) is
        still labeled in the log.

        "Every write" is the writes of project data. Reads never join, and
        neither do the out-of-band signals shaped like a write (a document lock
        taken or renewed, a stopped service request, a service reporting
        itself, an admin control), and neither does a broadcast message
        (``messages.send_message``): none of them is audited, so there would
        be nothing under the label.

        ``kind`` says what kind of operation this is, for a program reading
        the log: one of ``assistant-plan``, ``service-run``, ``import``,
        ``bulk-edit``, ``guess-adoption``, ``repair`` or ``review`` (the server
        refuses any other, and so does this method: any other kind raises
        ``ValueError`` here, before anything is written). ``ref`` is a short string naming what the operation came from,
        in the shape its kind documents (the core manual, "Kinds of
        operation"). Both are recorded from the first write like the label,
        and a nested operation keeps the outer one's.

        ``keys`` (from ``key_seed()``) makes a run of the operation send the
        same requests as an earlier run with the same keys: the nth keyed
        request that joins it takes the Idempotency-Key ``<seed>.<n>`` and the
        document-version its first run claimed, so a request that landed is
        answered from its first send and writes nothing again. The count
        starts at 0 at each outermost begin. A nested operation joins the
        outer one's keys, unless it brings its own: then it numbers from 0
        under its own seed until its matching end, and the outer numbering
        resumes after it.

        Prefer the ``operation()`` context manager; this is the manual form.

        Args:
            message: Human label for the operation (shown as the audit-log entry).
            group_id: Optional. Adopt an existing group id instead of minting one
                (a service joining the requester's operation; ``BaseService`` does
                this automatically from the propagated ``operation_group`` field).
            kind: Optional. What kind of operation this is (see above).
            ref: Optional. What the operation refers to (see above).
            keys: Optional. A seed from ``key_seed()`` (see above).
            minted: Optional. The ids this operation mints for what it creates:
                a create refused 409 id-taken for one of them was made by an
                earlier send of the operation, and answers as made.

        Returns:
            The operation's group id.

        Raises:
            ValueError: ``kind`` is not one of the kinds listed above.
        """
        _check_operation_kind(kind)
        frame = {'keys': keys or None, 'count': 0, 'minted': set(minted) if minted else None,
                 'depth': 1, 'owned': False}
        open_group = self._operation_group
        self._opened_frame = None
        if open_group is not None:
            # A nested operation that brings its own key seed or ids numbers
            # the keys in a frame of its own until it ends, then the frame
            # under it numbers again.
            open_group['depth'] += 1
            if keys or minted:
                frame['depth'] = open_group['depth']
                open_group['frames'].append(frame)
                self._opened_frame = frame
            return open_group['id']
        self._operation_group = {
            'id': str(group_id) if group_id else str(uuid.uuid4()),
            'message': None if message is None else str(message),
            'kind': None if kind is None else str(kind),
            'ref': None if ref is None else str(ref),
            'depth': 1,
            'written': False,
            'refined': _UNSET_MESSAGE,
            'frames': [frame],
        }
        self._opened_frame = frame
        return self._operation_group['id']

    def key_seed(self) -> dict:
        """A seed for the Idempotency-Keys of a logical operation that may be
        run again from the top (see ``begin_operation``'s ``keys``). Keep it
        with the work it belongs to and pass it to every run.

        Returns:
            ``{'seed': <UUIDv7>, 'stamps': {}}``, where ``stamps`` comes to
            map each request's number to the version it claimed (None for
            none).
        """
        return {'seed': uuid7(), 'stamps': {}}

    def end_operation(self, message: str | None | object = _UNSET_MESSAGE) -> None:
        """End the current logical operation. With no argument this is purely
        local (no request). Pass a refined ``message`` to relabel the group now
        that the outcome is known (``end_operation('Merged 3 morphemes')``) —
        that sends one PATCH, skipped if the operation never wrote anything. A
        refine from a nested (flattened) ``end_operation`` is ignored; the
        outer label wins.

        Args:
            message: Optional. A refined label for the finished operation.
        """
        group = self._operation_group
        if group is None:
            return
        if group['depth'] > 1:
            # A frame begun at this depth by hand (begin_operation) ends here.
            # One begun by operation() is ended by that block itself.
            frames = group['frames']
            top = frames[-1]
            if len(frames) > 1 and not top['owned'] and top['depth'] == group['depth']:
                frames.pop()
            group['depth'] -= 1
            return
        self._operation_group = None
        refined = message if message is not _UNSET_MESSAGE else group['refined']
        if refined is not _UNSET_MESSAGE and group['written']:
            try:
                self.operation_groups.update(group['id'], refined)
            except PlaidAPIError as e:
                # 404: the group never materialized server-side (every tagged
                # write failed or a batch was aborted). Nothing to relabel.
                if e.status != 404:
                    raise

    @contextmanager
    def operation(self, message: str, *, kind: str | None = None, ref: str | None = None,
                  group_id: str | None = None, keys: dict | None = None, minted=None):
        """Run the block as one logical operation (see ``begin_operation``),
        ending it when the block exits — including on exception. The yielded
        object's ``set_message(msg)`` refines the label once the outcome is
        known::

            with client.operation('Merge morphemes') as op:
                with client.batched() as b:
                    ...
                op.set_message(f'Merged {n} morphemes')

        Not atomic (see ``begin_operation``): use ``batched()`` inside for any
        step that must be all-or-nothing. A service request made inside the
        block carries the operation to the service, whose writes then fold
        under this entry.

        ``kind`` and ``ref`` say what kind of operation this is and what it
        refers to (see ``begin_operation``)::

            with client.operation('Import ELAN corpus', kind='import', ref='format:elan'):
                ...

        Args:
            message: Human label for the operation (shown as the audit-log entry).
            kind: Optional. What kind of operation this is: one of
                ``assistant-plan``, ``service-run``, ``import``, ``bulk-edit``,
                ``guess-adoption``, ``repair`` or ``review``. Any other raises
                ``ValueError`` before the block runs.
            ref: Optional. What the operation refers to.
            group_id: Optional. Adopt an existing group id (see ``begin_operation``).
            keys: Optional. A seed from ``key_seed()`` (see ``begin_operation``).
            minted: Optional. The ids the block mints for what it creates: a
                create refused 409 id-taken for one of them answers as made.
        """
        self.begin_operation(message, group_id=group_id, kind=kind, ref=ref, keys=keys,
                             minted=minted)
        group = self._operation_group
        # The key frame this block opened is ended by this block, whatever
        # else began or ended meanwhile.
        frame = self._opened_frame
        if frame is not None:
            frame['owned'] = True
        ctx = _OperationContext(group)
        try:
            yield ctx
        except BaseException:
            self._drop_frame(group, frame)
            # A relabel the server refuses (a token scoped to projects may not
            # relabel a group, which names none) must not take the place of
            # the error the block raised: the caller answers for that one.
            try:
                self.end_operation()
            except PlaidAPIError as e:
                logging.getLogger(__name__).warning('The operation was not relabelled: %s', e)
            raise
        self._drop_frame(group, frame)
        self.end_operation()

    @staticmethod
    def _drop_frame(group, frame):
        """End the key frame ``frame`` of ``group``, wherever it is among the
        frames open."""
        if group is None or frame is None or group['frames'][0] is frame:
            return
        group['frames'] = [f for f in group['frames'] if f is not frame]

    def batch(self) -> 'PlaidBatch':
        """Open a batch: a view of this client with the same resources, on
        which every write of project data queues instead of going out.
        ``submit()`` sends the queued operations as ONE atomic request (larger
        than the server's cap, as consecutive requests with the results
        concatenated in queue order, each atomic on its own, so a failure in a
        later one leaves the earlier ones committed, and the error it raises
        carries ``committed``, the count saved, and ``committed_results``,
        their results) and returns one result
        per operation;
        ``abort()`` drops them. A call made on the client itself is never
        touched by an open batch, and a read or an out-of-band signal made on
        the batch goes over the wire now (see the note at the top of
        ``http.py``)::

            b = client.batch()
            b.tokens.bulk_create(sentence_ops)
            b.tokens.bulk_create(word_ops)
            sentence_results, word_results = b.submit()

        Server-side a batch runs sequentially in one transaction: a child op
        sees parents created earlier in the same batch, and any op's failure
        rolls the whole batch back. A batch is not nestable. Prefer
        :meth:`batched`, which submits or aborts for you.
        """
        return PlaidBatch(self)

    def _post_batch(self, ops: list[dict], stamped_documents: list | None = None,
                    stamped_groups: list | None = None) -> list[Any]:
        """POST queued operations (see PlaidBatch.submit) and return one
        ``{'status', 'headers', 'body'}`` per operation, in order, with only
        the body recased: the headers keep the server's spelling.

        ``stamped_documents`` names, index for index, the document each op's
        strict-mode stamp is for (None for none), and ``stamped_groups`` the
        logical operation each joined (None for none), marked written once
        the request holding it is taken.

        Each request goes with an Idempotency-Key of its own, minted as the
        request is formed. A request whose answer is lost (no response, 502,
        504) is sent again under it, and answered from the first send if that
        landed. Inside an operation opened with ``keys``, a request whose ops
        joined it takes the operation's next key and claims the version its
        first run claimed."""
        url = f'{self.base_url}/api/v1/batch'
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
            headers = {
                'Authorization': f'Bearer {self.token}',
                'Content-Type': 'application/json',
            }

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
                group = self._operation_group
                joins = group is not None and any(
                    g is group for g in groups[start:start + MAX_BATCH_OPS])
                key, pin, record = next_idempotency_key(self, joins)

                def claim(doc_id, pin=pin):
                    return pin if pin is not NO_PIN else self.document_versions.get(doc_id)

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
                request_headers = {**headers, IDEMPOTENCY_HEADER: key}

                # Retry a 503: the batch is atomic, so a refused one wrote
                # nothing and repeating it is safe. The batch timeout is its
                # own, longer budget — giving up here does not stop the
                # server's transaction.
                # Retry a 503: the batch is atomic, so a refused one wrote
                # nothing. And send it again under its key when the answer
                # was lost (no response, 502, 504): a resend of one that
                # landed is answered from its first send.
                # Encoded once, before anything goes: a body that cannot be
                # sent is the caller's mistake, never an unknown outcome.
                data = json.dumps(body, default=_unsendable)

                def attempt(data=data, request_headers=request_headers):
                    try:
                        resp = self.session.post(url, headers=request_headers, data=data,
                                                 timeout=wire_timeout(self.batch_timeout))
                    except PlaidAPIError:
                        raise
                    except Exception as e:
                        if type(e).__name__ in ('Timeout', 'ConnectTimeout', 'ReadTimeout'):
                            raise PlaidAPIError(f'Request timed out at {url}', url=url,
                                                method='POST', original_error=e) from e
                        raise PlaidAPIError(f'Network error: {e} at {url}', url=url,
                                            method='POST', original_error=e) from e
                    if not resp.ok:
                        raise build_api_error(resp, url, 'POST')
                    return resp

                try:
                    response = retry_unknown(
                        lambda: retry_while_busy(attempt, on_retry=self._note_retry),
                        self.retry_delays, on_retry=self._note_retry)
                except PlaidAPIError as e:
                    e.idempotency_key = key
                    raise
                results = response.json()
                # A replayed batch carries the versions right after its first send.
                replayed = is_replayed(getattr(response, 'headers', None))
                # The server took the request, so each operation it joined exists.
                for group in (stamped_groups or [])[start:start + MAX_BATCH_OPS]:
                    if group is not None:
                        group['written'] = True

                for result in results:
                    if isinstance(result, dict) and 'headers' in result:
                        dv_header = result['headers'].get('X-Document-Versions')
                        if dv_header:
                            try:
                                versions_map = json.loads(dv_header)
                                if isinstance(versions_map, dict):
                                    self.document_versions.update(merge_versions(
                                        self.document_versions, versions_map, replayed))
                            except (json.JSONDecodeError, TypeError):
                                pass
                # The batch's own header holds each document's version after
                # the whole batch, the layer rules' remedies at its end
                # included, which no single operation's answer does: a split
                # that deletes a relation crossing the new boundary moves the
                # version once more.
                outer_header = (getattr(response, 'headers', None) or {}).get('X-Document-Versions')
                if outer_header:
                    try:
                        versions_map = json.loads(outer_header)
                        if isinstance(versions_map, dict):
                            self.document_versions.update(merge_versions(
                                self.document_versions, versions_map, replayed))
                    except (json.JSONDecodeError, TypeError):
                        pass

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
            error = PlaidAPIError(f'Network error: {e} at {self.base_url}/api/v1/batch',
                                  url=f'{self.base_url}/api/v1/batch', method='POST',
                                  original_error=e)
            error.committed = len(results_out)
            error.committed_results = results_out
            raise error

    @contextmanager
    def batched(self):
        """Run the block with a batch, then submit all queued ops as
        :meth:`PlaidBatch.submit` does (ONE atomic request up to MAX_BATCH_OPS
        operations, consecutive requests past it), or abort the batch if the
        block raises. The block makes its
        writes on the yielded batch; the results land on its ``.results`` (a
        context manager can't return a value)::

            with client.batched() as b:
                b.tokens.bulk_create(sentence_ops)
                b.tokens.bulk_create(word_ops)
            sentence_results, word_results = b.results

        An empty block submits nothing and leaves ``.results == []``. A write
        made on ``client`` inside the block is not part of the batch: it goes
        over the wire at once, as it would anywhere else. See :meth:`batch`.
        """
        batch = self.batch()
        try:
            yield batch
        except BaseException:
            # The block failed (or was cancelled): drop the queued ops.
            batch.abort()
            raise
        else:
            batch.submit()

    def close(self) -> None:
        """Close the underlying HTTP session."""
        self.session.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    @staticmethod
    def invite_url(app_url: str, code: str) -> str:
        """Build the link to hand someone for an invite code.

        The server never sees an app URL, so the app that minted the invite is
        the one that names it. Both SPAs use hash routing, so the code rides in
        the fragment — which also keeps it out of server access logs.

        Args:
            app_url: Where the SPA lives, e.g. "https://plaid.example.org/igt/"
            code: The code returned by ``invites.create()``
        """
        base = re.sub(r'#.*$', '', app_url).rstrip('/')
        return f'{base}/#/invite/{quote(code, safe="")}'

    @classmethod
    def health(cls, base_url: str, timeout: float | None = DEFAULT_TIMEOUT_S) -> Any:
        """Liveness, version and database size, with NO authentication and no
        client instance: for a launcher or status page checking whether a
        server is up before anyone logs in. ``client.server.health()`` is the
        same read from a client."""
        return cls._anonymous_get(base_url, '/health', timeout=timeout)

    @classmethod
    def info(cls, base_url: str, timeout: float | None = DEFAULT_TIMEOUT_S) -> Any:
        """The version and the limits this server enforces, with NO
        authentication and no client instance. ``client.server.info()`` is the
        same read from a client, cached."""
        return cls._anonymous_get(base_url, '/api/v1/info', timeout=timeout)

    @classmethod
    def _anonymous_get(cls, base_url: str, path: str,
                       timeout: float | None = DEFAULT_TIMEOUT_S) -> Any:
        """GET a path that takes no Authorization header."""
        url = f'{base_url.rstrip("/")}{path}'
        try:
            response = req_lib.get(url, timeout=wire_timeout(timeout))
        except Exception as e:
            if type(e).__name__ in ('Timeout', 'ConnectTimeout', 'ReadTimeout'):
                raise PlaidAPIError(f'Request timed out at {url}', url=url, method='GET',
                                    original_error=e)
            raise PlaidAPIError(f'Network error: {e} at {url}', url=url, method='GET',
                                original_error=e)
        if not response.ok:
            raise build_api_error(response, url, 'GET')
        return transform_response(response.json())

    @classmethod
    def _anonymous_post(cls, base_url: str, path: str, body: dict,
                        timeout: float | None = DEFAULT_TIMEOUT_S) -> Any:
        """POST to an endpoint that takes no Authorization header.

        Used by login, invite lookup and invite redemption — all of which are
        called before any client exists, which is why they cannot go through
        the instance request path.
        """
        base_url = base_url.rstrip('/')
        url = f'{base_url}{path}'
        try:
            response = req_lib.post(url,
                                    headers={'Content-Type': 'application/json'},
                                    data=json.dumps(body),
                                    timeout=wire_timeout(timeout))
        except Exception as e:
            if type(e).__name__ in ('Timeout', 'ConnectTimeout', 'ReadTimeout'):
                raise PlaidAPIError(f'Request timed out at {url}', url=url, method='POST',
                                    original_error=e)
            raise PlaidAPIError(f'Network error: {e} at {url}', url=url, method='POST',
                                original_error=e)

        if not response.ok:
            raise build_api_error(response, url, 'POST')
        return transform_response(response.json())

    @classmethod
    def lookup_invite(cls, base_url: str, code: str,
                      timeout: float | None = DEFAULT_TIMEOUT_S) -> Any:
        """Describe an invite code, with NO authentication.

        This is what a signup page calls before the redeemer has an account.
        Returns the kind of link (``"signup"`` or ``"password-reset"``), its
        ``status`` (``"active"``, ``"used"``, ``"expired"``, ``"revoked"``,
        or ``"inactive"`` when its creator can no longer grant what it
        grants), and the project it grants access to, if any.

        Raises ``PlaidAPIError`` with status 404 if the code is unknown. A
        known-but-dead code returns normally with a non-active ``status``, so
        the page can explain why rather than just saying "invalid".

        Args:
            base_url: The base URL for the API
            code: The invite code
            timeout: Per-request timeout in seconds
        """
        return cls._anonymous_post(base_url, '/api/v1/invites/lookup',
                                   {'code': code}, timeout=timeout)

    @classmethod
    def redeem_invite(cls, base_url: str, code: str, password: str,
                      email: str | None = None, display_name: str | None = None,
                      timeout: float | None = DEFAULT_TIMEOUT_S, *,
                      batch_timeout: float | None = _UNSET,
                      retry_delays: list[float] | None = None) -> tuple[PlaidClient, Any]:
        """Redeem an invite code, with NO authentication.

        For a signup invite, pass ``email`` and ``password`` to create the
        account (and optionally ``display_name``); the invite's grants are
        applied in the same transaction. For a password reset link, pass
        ``password`` only.

        Returns an authenticated client alongside the response, exactly like
        :meth:`login` — the redeemer just chose these credentials, so there is
        no reason to send them to a login form to retype them.

        Args:
            base_url: The base URL for the API
            code: The invite code
            password: Desired password (at least 8 characters)
            email: The new account's email address, which becomes its id and
                login (signup invites only)
            display_name: How the new user is shown in the UI; defaults to the
                local part of the email (signup invites only)
            timeout: Per-request timeout in seconds, forwarded to the new client.
            batch_timeout: Forwarded to the new client (see :class:`PlaidClient`).
            retry_delays: Forwarded to the new client (see :class:`PlaidClient`).

        Returns:
            ``(client, result)`` where ``result`` carries ``user_id`` and ``kind``.
        """
        body = {'code': code, 'password': password}
        if email is not None:
            body['email'] = normalize_user_id(email)
        if display_name is not None:
            body['display-name'] = display_name
        data = cls._anonymous_post(base_url, '/api/v1/invites/redeem', body,
                                   timeout=timeout)
        client = cls(base_url.rstrip('/'), data.get('token', ''), timeout=timeout,
                     batch_timeout=batch_timeout, retry_delays=retry_delays)
        return client, data

    @classmethod
    def login(cls, base_url: str, user_id: str, password: str,
              timeout: float | None = DEFAULT_TIMEOUT_S, *,
              batch_timeout: float | None = _UNSET,
              retry_delays: list[float] | None = None) -> PlaidClient:
        """Authenticate and return a new client instance with token.

        This is the single auth entry point — there is no ``client.login`` resource.

        Args:
            base_url: The base URL for the API
            user_id: User ID for authentication
            password: Password for authentication
            timeout: Per-request timeout in seconds, forwarded to the new client.
            batch_timeout: Forwarded to the new client (see :class:`PlaidClient`).
            retry_delays: Forwarded to the new client (see :class:`PlaidClient`).

        Returns:
            Authenticated client instance
        """
        base_url = base_url.rstrip('/')
        url = f'{base_url}/api/v1/login'
        try:
            response = req_lib.post(url,
                                    headers={'Content-Type': 'application/json'},
                                    data=json.dumps({'user-id': normalize_user_id(user_id),
                                                     'password': password}),
                                    timeout=wire_timeout(timeout))
        except Exception as e:
            if type(e).__name__ in ('Timeout', 'ConnectTimeout', 'ReadTimeout'):
                raise PlaidAPIError(f'Request timed out at {url}', url=url, method='POST',
                                    original_error=e)
            raise PlaidAPIError(f'Network error: {e} at {url}', url=url, method='POST',
                                original_error=e)

        if not response.ok:
            raise build_api_error(response, url, 'POST')

        data = response.json()
        token = data.get('token', '')
        return cls(base_url, token, timeout=timeout, batch_timeout=batch_timeout,
                   retry_delays=retry_delays)


class PlaidBatch:
    """One batch of writes, opened by :meth:`PlaidClient.batch`.

    The same resources as the client (``documents``, ``tokens``, ...), built
    on this object, so a write made through them queues instead of going out.
    Everything else (the token and base URL, strict mode and the document
    versions it tracks, the open logical operation, ``query``) is the client's
    and resolves to it.
    """

    def __init__(self, client: PlaidClient):
        self.client = client
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
        self.results = self.client._post_batch(ops, stamps, groups) if ops else []
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
