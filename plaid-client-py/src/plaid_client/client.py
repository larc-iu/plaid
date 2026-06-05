from __future__ import annotations

import json
from typing import Any

import requests as req_lib

from plaid_client.http import (
    PlaidAPIError, make_request, extract_document_versions,
    list_all, list_page, iter_pages, build_api_error, DEFAULT_TIMEOUT_S,
)
from plaid_client.transforms import transform_response
from plaid_client.sse import SSEConnection
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


class _Resource:
    def __init__(self, client: PlaidClient):
        self._client = client

    def _request(self, method, path, **kwargs):
        return make_request(self._client, method, path, **kwargs)


class VocabLinksResource(_Resource):
    def create(self, vocab_item: str, tokens: list, metadata: Any = _UNSET) -> Any:
        """Create a new vocab link between tokens and a vocab item.

        Args:
            vocab_item: The vocab item to link
            tokens: The tokens to link
            metadata: Metadata for the link. Omit to leave unset; pass ``None``
                to send JSON null.
        """
        return self._request('POST', '/api/v1/vocab-links',
                             body=_body_of(vocab_item=vocab_item, tokens=tokens, metadata=metadata))

    def set_metadata(self, id: str, body: Any) -> Any:
        """Replace all metadata for a vocab link.

        The entire metadata map is replaced - existing metadata keys not
        included in the request will be removed.

        Args:
            id: The resource ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/vocab-links/{id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, id: str) -> Any:
        """Remove all metadata from a vocab link.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-links/{id}/metadata',
                             skip_response_transform=True)

    def patch_metadata(self, id: str, body: Any) -> Any:
        """Patch (shallow-merge) metadata for a vocab link.

        Keys present in the body are set or overwritten; keys not present are
        left untouched; a key whose value is None (JSON null) is deleted.
        Merging is top-level only (nested objects are replaced wholesale, not
        deep-merged), so a literal null cannot be stored as a value. An empty
        body changes no metadata.

        Args:
            id: The resource ID
            body: The metadata patch
        """
        return self._request('PATCH', f'/api/v1/vocab-links/{id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def get(self, id: str, *, as_of: str | None = None) -> Any:
        """Get a vocab link by ID.

        Args:
            id: The resource ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/vocab-links/{id}',
                             query_params={'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a vocab link.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-links/{id}')


class VocabLayersResource(_Resource):
    def get(self, id: str, *, include_items: bool | None = None, as_of: str | None = None) -> Any:
        """Get a vocab layer by ID.

        Args:
            id: The resource ID
            include_items: Include vocab items
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/vocab-layers/{id}',
                             query_params={'include-items': include_items, 'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a vocab layer.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}')

    def update(self, id: str, name: str) -> Any:
        """Update a vocab layer's name.

        Args:
            id: The resource ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/vocab-layers/{id}',
                             body=_body_of(name=name))

    def set_config(self, id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a vocab layer in an editor namespace.

        Args:
            id: The resource ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
        """
        return self._request('PUT', f'/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a vocab layer.

        Args:
            id: The resource ID
            namespace: The config namespace
            config_key: The config key
        """
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def list(self, *, as_of: str | None = None) -> Any:
        """List all vocab layers accessible to the current user.

        Transparently follows server-side pagination cursors and returns the
        full flat list.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError if called while batching — use list_page() for a single page in a batch.

        Args:
            as_of: Temporal query timestamp
        """
        return list_all(self._client, '/api/v1/vocab-layers',
                        query={'as-of': as_of})

    def list_page(self, *, limit: int | None = None, cursor: str | None = None,
                  as_of: str | None = None) -> Any:
        """List one page of vocab layers.

        Args:
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            as_of: Temporal query timestamp
        """
        return list_page(self._client, '/api/v1/vocab-layers',
                         limit=limit, cursor=cursor, query={'as-of': as_of})

    def iter_pages(self, *, page_size: int = 1000, as_of: str | None = None):
        """Iterate over pages of vocab layers, yielding each page's entries list.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError on first iteration if called while batching — use list_page() for a single page in a batch.

        Args:
            page_size: Page size (1..1000)
            as_of: Temporal query timestamp
        """
        return iter_pages(self._client, '/api/v1/vocab-layers',
                          page_size=page_size, query={'as-of': as_of})

    def create(self, name: str) -> Any:
        """Create a new vocab layer.

        Also registers the current user as a maintainer.

        Args:
            name: The name
        """
        return self._request('POST', '/api/v1/vocab-layers',
                             body=_body_of(name=name))

    def add_maintainer(self, id: str, user_id: str) -> Any:
        """Assign a user as a maintainer for this vocab layer.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('POST', f'/api/v1/vocab-layers/{id}/maintainers/{user_id}')

    def remove_maintainer(self, id: str, user_id: str) -> Any:
        """Remove a user's maintainer privileges for this vocab layer.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}/maintainers/{user_id}')


class RelationsResource(_Resource):
    def set_metadata(self, relation_id: str, body: Any) -> Any:
        """Replace all metadata for a relation.

        Args:
            relation_id: The relation ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/relations/{relation_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, relation_id: str) -> Any:
        """Remove all metadata from a relation.

        Args:
            relation_id: The relation ID
        """
        return self._request('DELETE', f'/api/v1/relations/{relation_id}/metadata',
                             skip_response_transform=True)

    def patch_metadata(self, relation_id: str, body: Any) -> Any:
        """Patch (shallow-merge) metadata for a relation.

        Keys present in the body are set or overwritten; keys not present are
        left untouched; a key whose value is None (JSON null) is deleted.
        Merging is top-level only (nested objects are replaced wholesale, not
        deep-merged), so a literal null cannot be stored as a value. An empty
        body changes no metadata.

        Args:
            relation_id: The relation ID
            body: The metadata patch
        """
        return self._request('PATCH', f'/api/v1/relations/{relation_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def set_target(self, relation_id: str, span_id: str) -> Any:
        """Update the target span of a relation.

        Args:
            relation_id: The relation ID
            span_id: The span ID
        """
        return self._request('PUT', f'/api/v1/relations/{relation_id}/target',
                             body=_body_of(span_id=span_id))

    def set_source(self, relation_id: str, span_id: str) -> Any:
        """Update the source span of a relation.

        Args:
            relation_id: The relation ID
            span_id: The span ID
        """
        return self._request('PUT', f'/api/v1/relations/{relation_id}/source',
                             body=_body_of(span_id=span_id))

    def get(self, relation_id: str, *, as_of: str | None = None) -> Any:
        """Get a relation by ID.

        Args:
            relation_id: The relation ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/relations/{relation_id}',
                             query_params={'as-of': as_of})

    def delete(self, relation_id: str) -> Any:
        """Delete a relation.

        Args:
            relation_id: The relation ID
        """
        return self._request('DELETE', f'/api/v1/relations/{relation_id}')

    def update(self, relation_id: str, value: Any) -> Any:
        """Update a relation's value.

        Args:
            relation_id: The relation ID
            value: The value
        """
        return self._request('PATCH', f'/api/v1/relations/{relation_id}',
                             body=_body_of(value=value))

    def create(self, layer_id: str, source_id: str, target_id: str, value: Any,
               metadata: Any = _UNSET) -> Any:
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
        """
        return self._request('POST', '/api/v1/relations',
                             body=_body_of(layer_id=layer_id, source_id=source_id,
                                           target_id=target_id, value=value, metadata=metadata))

    def bulk_create(self, body: list) -> Any:
        """Create multiple relations in a single operation.

        Args:
            body: The request body
        """
        return self._request('POST', '/api/v1/relations/bulk', body=body)

    def bulk_delete(self, body: list) -> Any:
        """Delete multiple relations in a single operation. Provide a list of IDs.

        Args:
            body: The request body
        """
        return self._request('DELETE', '/api/v1/relations/bulk', body=body)


class SpanLayersResource(_Resource):
    def get(self, span_layer_id: str, *, as_of: str | None = None) -> Any:
        """Get a span layer by ID.

        Args:
            span_layer_id: The span layer ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/span-layers/{span_layer_id}',
                             query_params={'as-of': as_of})

    def delete(self, span_layer_id: str) -> Any:
        """Delete a span layer.

        Args:
            span_layer_id: The span layer ID
        """
        return self._request('DELETE', f'/api/v1/span-layers/{span_layer_id}')

    def update(self, span_layer_id: str, name: str) -> Any:
        """Update a span layer's name.

        Args:
            span_layer_id: The span layer ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/span-layers/{span_layer_id}',
                             body=_body_of(name=name))

    def set_config(self, span_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a span layer in an editor namespace.

        Args:
            span_layer_id: The span layer ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
        """
        return self._request('PUT', f'/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, span_layer_id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a span layer.

        Args:
            span_layer_id: The span layer ID
            namespace: The config namespace
            config_key: The config key
        """
        return self._request('DELETE', f'/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def shift(self, span_layer_id: str, direction: str) -> Any:
        """Shift a span layer's display order.

        Args:
            span_layer_id: The span layer ID
            direction: The direction ("up" or "down")
        """
        return self._request('POST', f'/api/v1/span-layers/{span_layer_id}/shift',
                             body=_body_of(direction=direction))

    def create(self, token_layer_id: str, name: str) -> Any:
        """Create a new span layer.

        Args:
            token_layer_id: The token layer ID
            name: The name
        """
        return self._request('POST', '/api/v1/span-layers',
                             body=_body_of(token_layer_id=token_layer_id, name=name))


class SpansResource(_Resource):
    def set_metadata(self, span_id: str, body: Any) -> Any:
        """Replace all metadata for a span.

        Args:
            span_id: The span ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/spans/{span_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, span_id: str) -> Any:
        """Remove all metadata from a span.

        Args:
            span_id: The span ID
        """
        return self._request('DELETE', f'/api/v1/spans/{span_id}/metadata',
                             skip_response_transform=True)

    def patch_metadata(self, span_id: str, body: Any) -> Any:
        """Patch (shallow-merge) metadata for a span.

        Keys present in the body are set or overwritten; keys not present are
        left untouched; a key whose value is None (JSON null) is deleted.
        Merging is top-level only (nested objects are replaced wholesale, not
        deep-merged), so a literal null cannot be stored as a value. An empty
        body changes no metadata.

        Args:
            span_id: The span ID
            body: The metadata patch
        """
        return self._request('PATCH', f'/api/v1/spans/{span_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def set_tokens(self, span_id: str, tokens: list) -> Any:
        """Replace the tokens associated with a span.

        Args:
            span_id: The span ID
            tokens: The tokens
        """
        return self._request('PUT', f'/api/v1/spans/{span_id}/tokens',
                             body=_body_of(tokens=tokens))

    def get(self, span_id: str, *, as_of: str | None = None) -> Any:
        """Get a span by ID.

        Args:
            span_id: The span ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/spans/{span_id}',
                             query_params={'as-of': as_of})

    def delete(self, span_id: str) -> Any:
        """Delete a span.

        Args:
            span_id: The span ID
        """
        return self._request('DELETE', f'/api/v1/spans/{span_id}')

    def update(self, span_id: str, value: Any) -> Any:
        """Update a span's value.

        Args:
            span_id: The span ID
            value: The value
        """
        return self._request('PATCH', f'/api/v1/spans/{span_id}',
                             body=_body_of(value=value))

    def create(self, span_layer_id: str, tokens: list, value: Any, metadata: Any = _UNSET) -> Any:
        """Create a new span.

        A span holds a primary atomic value and optional metadata, and must
        at all times be associated with one or more tokens.

        Args:
            span_layer_id: The span layer ID
            tokens: The tokens
            value: The value
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
        """
        return self._request('POST', '/api/v1/spans',
                             body=_body_of(span_layer_id=span_layer_id, tokens=tokens,
                                           value=value, metadata=metadata))

    def bulk_create(self, body: list) -> Any:
        """Create multiple spans in a single operation.

        Args:
            body: The request body
        """
        return self._request('POST', '/api/v1/spans/bulk', body=body)

    def bulk_delete(self, body: list) -> Any:
        """Delete multiple spans in a single operation. Provide a list of IDs.

        Args:
            body: The request body
        """
        return self._request('DELETE', '/api/v1/spans/bulk', body=body)


class TextsResource(_Resource):
    def create(self, text_layer_id: str, document_id: str, body: str,
               metadata: Any = _UNSET) -> Any:
        """Create a new text in a document's text layer.

        A text is a container for one long string in ``body`` for a given layer.

        Args:
            text_layer_id: The text layer ID
            document_id: The document ID
            body: The request body
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
        """
        return self._request('POST', '/api/v1/texts',
                             body=_body_of(text_layer_id=text_layer_id, document_id=document_id,
                                           body=body, metadata=metadata))

    def get(self, text_id: str, *, as_of: str | None = None) -> Any:
        """Get a text.

        Args:
            text_id: The text ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/texts/{text_id}',
                             query_params={'as-of': as_of})

    def delete(self, text_id: str) -> Any:
        """Delete a text and all dependent data.

        Args:
            text_id: The text ID
        """
        return self._request('DELETE', f'/api/v1/texts/{text_id}')

    def update(self, text_id: str, body: Any) -> Any:
        """Update a text's ``body``.

        A diff is computed and token indices are updated so that tokens
        remain intact. Alternatively, ``body`` can be a list of edit
        directives.

        Args:
            text_id: The text ID
            body: The request body
        """
        return self._request('PATCH', f'/api/v1/texts/{text_id}',
                             body=_body_of(body=body))

    def set_metadata(self, text_id: str, body: Any) -> Any:
        """Replace all metadata for a text.

        Args:
            text_id: The text ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/texts/{text_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, text_id: str) -> Any:
        """Remove all metadata from a text.

        Args:
            text_id: The text ID
        """
        return self._request('DELETE', f'/api/v1/texts/{text_id}/metadata',
                             skip_response_transform=True)

    def patch_metadata(self, text_id: str, body: Any) -> Any:
        """Patch (shallow-merge) metadata for a text.

        Keys present in the body are set or overwritten; keys not present are
        left untouched; a key whose value is None (JSON null) is deleted.
        Merging is top-level only (nested objects are replaced wholesale, not
        deep-merged), so a literal null cannot be stored as a value. An empty
        body changes no metadata.

        Args:
            text_id: The text ID
            body: The metadata patch
        """
        return self._request('PATCH', f'/api/v1/texts/{text_id}/metadata',
                             raw_body=body, skip_response_transform=True)


class UsersResource(_Resource):
    def list(self, *, as_of: str | None = None) -> Any:
        """List all users.

        Transparently follows server-side pagination cursors and returns the
        full flat list.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError if called while batching — use list_page() for a single page in a batch.

        Args:
            as_of: Temporal query timestamp
        """
        return list_all(self._client, '/api/v1/users',
                        query={'as-of': as_of})

    def list_page(self, *, limit: int | None = None, cursor: str | None = None,
                  as_of: str | None = None) -> Any:
        """List one page of users.

        Args:
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            as_of: Temporal query timestamp
        """
        return list_page(self._client, '/api/v1/users',
                         limit=limit, cursor=cursor, query={'as-of': as_of})

    def iter_pages(self, *, page_size: int = 1000, as_of: str | None = None):
        """Iterate over pages of users, yielding each page's entries list.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError on first iteration if called while batching — use list_page() for a single page in a batch.

        Args:
            page_size: Page size (1..1000)
            as_of: Temporal query timestamp
        """
        return iter_pages(self._client, '/api/v1/users',
                          page_size=page_size, query={'as-of': as_of})

    def create(self, username: str, password: str, is_admin: bool) -> Any:
        """Create a new user.

        Args:
            username: The username
            password: The password
            is_admin: Whether the user is an admin
        """
        return self._request('POST', '/api/v1/users',
                             body=_body_of(username=username, password=password, is_admin=is_admin))

    def get(self, id: str, *, as_of: str | None = None) -> Any:
        """Get a user by ID.

        Args:
            id: The resource ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/users/{id}',
                             query_params={'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a user.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/users/{id}')

    def update(self, id: str, *, password: Any = _UNSET, username: Any = _UNSET,
               is_admin: Any = _UNSET) -> Any:
        """Modify a user.

        Admins may change the username, password, and admin status of any
        user. All other users may only modify their own username or password.

        Args:
            id: The resource ID
            password: New password. Omit to leave unchanged; pass ``None`` to
                send JSON null.
            username: New username. Omit to leave unchanged; pass ``None`` to
                send JSON null.
            is_admin: New admin status. Omit to leave unchanged; pass ``None``
                to send JSON null.
        """
        return self._request('PATCH', f'/api/v1/users/{id}',
                             body=_body_of(password=password, username=username, is_admin=is_admin))

    def audit(self, user_id: str, *, start_time: str | None = None, end_time: str | None = None,
              as_of: str | None = None) -> Any:
        """Get audit log for a user's actions.

        Transparently follows server-side pagination cursors and returns the
        full flat list of audit entries.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError if called while batching — use list_page() for a single page in a batch.

        Args:
            user_id: The user ID
            start_time: Start of time range
            end_time: End of time range
            as_of: Temporal query timestamp
        """
        return list_all(self._client, f'/api/v1/users/{user_id}/audit',
                        query={'start-time': start_time, 'end-time': end_time, 'as-of': as_of})


class ApiTokensResource(_Resource):
    def list(self, user_id: str) -> Any:
        """List a user's named API tokens.

        Never includes the signed token string itself — that is only returned
        once, by create(). Transparently follows server-side pagination cursors
        and returns the full flat list.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError if called while batching — use list_page() for a single page in a batch.

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

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError on first iteration if called while batching — use list_page() for a single page in a batch.

        Args:
            user_id: The user ID who owns the tokens
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, f'/api/v1/users/{user_id}/tokens',
                          page_size=page_size)

    def create(self, user_id: str, name: str) -> Any:
        """Mint a named API token for a user.

        The returned ``token`` is the signed credential and is shown ONLY
        here — store it immediately. API tokens do not expire and survive
        password changes / logout; revoke to kill. Returns a dict with
        ``id``, ``name`` and ``token``.

        Args:
            user_id: The user ID who will own the token
            name: A human label, e.g. "Stanza Parser"

        Returns:
            A dict with ``id``, ``name`` and ``token``.
        """
        return self._request('POST', f'/api/v1/users/{user_id}/tokens',
                             body=_body_of(name=name))

    def revoke(self, user_id: str, token_id: str) -> Any:
        """Revoke a named API token (soft-revoke; idempotent).

        Args:
            user_id: The user ID who owns the token
            token_id: The token ID to revoke
        """
        return self._request('DELETE', f'/api/v1/users/{user_id}/tokens/{token_id}')


class TokenLayersResource(_Resource):
    def get(self, token_layer_id: str, *, as_of: str | None = None) -> Any:
        """Get a token layer by ID.

        Args:
            token_layer_id: The token layer ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/token-layers/{token_layer_id}',
                             query_params={'as-of': as_of})

    def delete(self, token_layer_id: str) -> Any:
        """Delete a token layer.

        Args:
            token_layer_id: The token layer ID
        """
        return self._request('DELETE', f'/api/v1/token-layers/{token_layer_id}')

    def update(self, token_layer_id: str, name: str) -> Any:
        """Update a token layer's name.

        Args:
            token_layer_id: The token layer ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/token-layers/{token_layer_id}',
                             body=_body_of(name=name))

    def set_config(self, token_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a token layer in an editor namespace.

        Args:
            token_layer_id: The token layer ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
        """
        return self._request('PUT', f'/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, token_layer_id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a token layer.

        Args:
            token_layer_id: The token layer ID
            namespace: The config namespace
            config_key: The config key
        """
        return self._request('DELETE', f'/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def shift(self, token_layer_id: str, direction: str) -> Any:
        """Shift a token layer's display order.

        Args:
            token_layer_id: The token layer ID
            direction: The direction ("up" or "down")
        """
        return self._request('POST', f'/api/v1/token-layers/{token_layer_id}/shift',
                             body=_body_of(direction=direction))

    def create(self, text_layer_id: str, name: str, *, overlap_mode: Any = _UNSET,
               parent_token_layer_id: Any = _UNSET) -> Any:
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
        """
        return self._request('POST', '/api/v1/token-layers',
                             body=_body_of(text_layer_id=text_layer_id, name=name,
                                           overlap_mode=overlap_mode,
                                           parent_token_layer_id=parent_token_layer_id))


class DocumentsResource(_Resource):
    def check_lock(self, document_id: str, *, as_of: str | None = None) -> Any:
        """Get information about a document lock.

        Args:
            document_id: The document ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/documents/{document_id}/lock',
                             query_params={'as-of': as_of})

    def acquire_lock(self, document_id: str) -> Any:
        """Acquire or refresh a document lock.

        Args:
            document_id: The document ID
        """
        return self._request('POST', f'/api/v1/documents/{document_id}/lock')

    def release_lock(self, document_id: str) -> Any:
        """Release a document lock.

        Args:
            document_id: The document ID
        """
        return self._request('DELETE', f'/api/v1/documents/{document_id}/lock')

    def get_media(self, document_id: str, *, as_of: str | None = None) -> bytes:
        """Get media file for a document.

        Args:
            document_id: The document ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/documents/{document_id}/media',
                             query_params={'as-of': as_of}, no_batch=True, binary_response=True)

    def upload_media(self, document_id: str, file) -> Any:
        """Upload a media file for a document. Uses Apache Tika for content validation.

        Args:
            document_id: The document ID
            file: The file to upload
        """
        return self._request('PUT', f'/api/v1/documents/{document_id}/media',
                             body={'file': file}, form_data=True, no_batch=True)

    def delete_media(self, document_id: str) -> Any:
        """Delete media file for a document.

        Args:
            document_id: The document ID
        """
        return self._request('DELETE', f'/api/v1/documents/{document_id}/media',
                             no_batch=True)

    def get(self, document_id: str, *, include_body: bool | None = None,
            as_of: str | None = None) -> Any:
        """Get a document.

        Set ``include_body`` to true to include all data contained in the
        document.

        Args:
            document_id: The document ID
            include_body: Include document body data
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/documents/{document_id}',
                             query_params={'include-body': include_body, 'as-of': as_of})

    def delete(self, document_id: str) -> Any:
        """Delete a document and all data contained.

        Args:
            document_id: The document ID
        """
        return self._request('DELETE', f'/api/v1/documents/{document_id}')

    def update(self, document_id: str, name: str) -> Any:
        """Update a document's name.

        Args:
            document_id: The document ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/documents/{document_id}',
                             body=_body_of(name=name))

    def create(self, project_id: str, name: str, metadata: Any = _UNSET) -> Any:
        """Create a new document in a project.

        Args:
            project_id: The project ID
            name: The name
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
        """
        return self._request('POST', '/api/v1/documents',
                             body=_body_of(project_id=project_id, name=name, metadata=metadata))

    def set_metadata(self, document_id: str, body: Any) -> Any:
        """Replace all metadata for a document.

        Args:
            document_id: The document ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/documents/{document_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, document_id: str) -> Any:
        """Remove all metadata from a document.

        Args:
            document_id: The document ID
        """
        return self._request('DELETE', f'/api/v1/documents/{document_id}/metadata',
                             skip_response_transform=True)

    def patch_metadata(self, document_id: str, body: Any) -> Any:
        """Patch (shallow-merge) metadata for a document.

        Keys present in the body are set or overwritten; keys not present are
        left untouched; a key whose value is None (JSON null) is deleted.
        Merging is top-level only (nested objects are replaced wholesale, not
        deep-merged), so a literal null cannot be stored as a value. An empty
        body changes no metadata.

        Args:
            document_id: The document ID
            body: The metadata patch
        """
        return self._request('PATCH', f'/api/v1/documents/{document_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def audit(self, document_id: str, *, start_time: str | None = None,
              end_time: str | None = None, as_of: str | None = None) -> Any:
        """Get audit log for a document.

        Transparently follows server-side pagination cursors and returns the
        full flat list of audit entries.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError if called while batching — use list_page() for a single page in a batch.

        Args:
            document_id: The document ID
            start_time: Start of time range
            end_time: End of time range
            as_of: Temporal query timestamp
        """
        return list_all(self._client, f'/api/v1/documents/{document_id}/audit',
                        query={'start-time': start_time, 'end-time': end_time, 'as-of': as_of})


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

        Args:
            project_id: The UUID of the project to send to
            data: The message data to send

        Returns:
            Response from the send operation
        """
        return self._request('POST', f'/api/v1/projects/{project_id}/message',
                             body={'body': data})

    def discover_services(self, project_id: str, timeout: float = 3.0) -> list:
        """Discover available services in a project.

        Reads the server-side service registry synchronously — no broadcast
        handshake, no waiting.

        Args:
            project_id: The UUID of the project to query
            timeout: Unused; kept for signature back-compat

        Returns:
            List of discovered service information
        """
        return svc.discover_services(self._client, project_id, timeout)

    def serve(self, project_id: str, service_info: dict, on_service_request,
              extras: dict | None = None) -> svc.ServiceRegistration:
        """Register as a service and handle incoming work requests.

        Requests are delivered over the service's own addressed channel (not the
        broadcast bus); replies stream back to the one requester.

        Args:
            project_id: The UUID of the project to serve
            service_info: Service information {service_id, service_name, description}
            on_service_request: Callback (data, response_helper)
            extras: Optional additional service metadata

        Returns:
            Service registration object with .stop() method
        """
        return svc.serve(
            self._client, project_id, service_info, on_service_request, extras)

    def request_service(self, project_id: str, service_id: str, data: Any,
                        timeout: float = 10.0, on_progress=None) -> Any:
        """Request a service to perform work and await its result.

        Streams the service's progress + result back over a single
        server-mediated response. Raises if no service is connected.

        Args:
            project_id: The UUID of the project
            service_id: The ID of the service to request
            data: The request data
            timeout: Timeout in seconds (default: 10.0)
            on_progress: Optional callback invoked with each progress payload

        Returns:
            Service response
        """
        return svc.request_service(
            self._client, project_id, service_id, data, timeout, on_progress)


class ProjectsResource(_Resource):
    def create(self, name: str) -> Any:
        """Create a new project.

        Also registers the current user as a maintainer.

        Args:
            name: The name
        """
        return self._request('POST', '/api/v1/projects',
                             body=_body_of(name=name))

    def list(self, *, as_of: str | None = None) -> Any:
        """List all projects accessible to the current user.

        Transparently follows server-side pagination cursors and returns the
        full flat list.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError if called while batching — use list_page() for a single page in a batch.

        Args:
            as_of: Temporal query timestamp
        """
        return list_all(self._client, '/api/v1/projects',
                        query={'as-of': as_of})

    def list_page(self, *, limit: int | None = None, cursor: str | None = None,
                  as_of: str | None = None) -> Any:
        """List one page of projects.

        Args:
            limit: Page size (1..1000)
            cursor: Opaque cursor from a previous page's ``next_cursor``
            as_of: Temporal query timestamp
        """
        return list_page(self._client, '/api/v1/projects',
                         limit=limit, cursor=cursor, query={'as-of': as_of})

    def iter_pages(self, *, page_size: int = 1000, as_of: str | None = None):
        """Iterate over pages of projects, yielding each page's entries list.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError on first iteration if called while batching — use list_page() for a single page in a batch.

        Args:
            page_size: Page size (1..1000)
            as_of: Temporal query timestamp
        """
        return iter_pages(self._client, '/api/v1/projects',
                          page_size=page_size, query={'as-of': as_of})

    def list_documents(self, id: str) -> Any:
        """List all documents (IDs and names) in a project.

        Transparently follows server-side pagination cursors and returns the
        full flat list. Replaces the removed ``include_documents`` param on
        ``get``.

        Note: this endpoint does not support temporal (``as-of``) queries; the
        server rejects ``?as-of=`` on the documents-list route with a 400.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError if called while batching — use list_page() for a single page in a batch.

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

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError on first iteration if called while batching — use list_page() for a single page in a batch.

        Args:
            id: The project ID
            page_size: Page size (1..1000)
        """
        return iter_pages(self._client, f'/api/v1/projects/{id}/documents',
                          page_size=page_size)

    def get(self, id: str, *, as_of: str | None = None) -> Any:
        """Get a project by ID.

        To fetch the project's document IDs and names, use ``list_documents``
        (the former ``include_documents`` param has been removed server-side).

        Args:
            id: The resource ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/projects/{id}',
                             query_params={'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a project.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}')

    def update(self, id: str, name: str) -> Any:
        """Update a project's name.

        Args:
            id: The resource ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/projects/{id}',
                             body=_body_of(name=name))

    def add_writer(self, id: str, user_id: str) -> Any:
        """Set a user's access level to read and write for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('POST', f'/api/v1/projects/{id}/writers/{user_id}')

    def remove_writer(self, id: str, user_id: str) -> Any:
        """Remove a user's writer privileges for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/writers/{user_id}')

    def add_reader(self, id: str, user_id: str) -> Any:
        """Set a user's access level to read-only for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('POST', f'/api/v1/projects/{id}/readers/{user_id}')

    def remove_reader(self, id: str, user_id: str) -> Any:
        """Remove a user's reader privileges for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/readers/{user_id}')

    def add_maintainer(self, id: str, user_id: str) -> Any:
        """Assign a user as a maintainer for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('POST', f'/api/v1/projects/{id}/maintainers/{user_id}')

    def remove_maintainer(self, id: str, user_id: str) -> Any:
        """Remove a user's maintainer privileges for this project.

        Args:
            id: The resource ID
            user_id: The user ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/maintainers/{user_id}')

    def set_config(self, id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a project in an editor namespace.

        Args:
            id: The resource ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
        """
        return self._request('PUT', f'/api/v1/projects/{id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a project.

        Args:
            id: The resource ID
            namespace: The config namespace
            config_key: The config key
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def audit(self, project_id: str, *, start_time: str | None = None,
              end_time: str | None = None, as_of: str | None = None) -> Any:
        """Get audit log for a project.

        Transparently follows server-side pagination cursors and returns the
        full flat list of audit entries.

        Cannot be used inside a batch (it auto-paginates across requests); raises RuntimeError if called while batching — use list_page() for a single page in a batch.

        Args:
            project_id: The project ID
            start_time: Start of time range
            end_time: End of time range
            as_of: Temporal query timestamp
        """
        return list_all(self._client, f'/api/v1/projects/{project_id}/audit',
                        query={'start-time': start_time, 'end-time': end_time, 'as-of': as_of})

    def link_vocab(self, id: str, vocab_id: str) -> Any:
        """Link a vocabulary to a project.

        Args:
            id: The resource ID
            vocab_id: The vocab layer ID
        """
        return self._request('POST', f'/api/v1/projects/{id}/vocabs/{vocab_id}')

    def unlink_vocab(self, id: str, vocab_id: str) -> Any:
        """Unlink a vocabulary from a project.

        Args:
            id: The resource ID
            vocab_id: The vocab layer ID
        """
        return self._request('DELETE', f'/api/v1/projects/{id}/vocabs/{vocab_id}')


class TextLayersResource(_Resource):
    def get(self, text_layer_id: str, *, as_of: str | None = None) -> Any:
        """Get a text layer by ID.

        Args:
            text_layer_id: The text layer ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/text-layers/{text_layer_id}',
                             query_params={'as-of': as_of})

    def delete(self, text_layer_id: str) -> Any:
        """Delete a text layer.

        Args:
            text_layer_id: The text layer ID
        """
        return self._request('DELETE', f'/api/v1/text-layers/{text_layer_id}')

    def update(self, text_layer_id: str, name: str) -> Any:
        """Update a text layer's name.

        Args:
            text_layer_id: The text layer ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/text-layers/{text_layer_id}',
                             body=_body_of(name=name))

    def set_config(self, text_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a text layer in an editor namespace.

        Args:
            text_layer_id: The text layer ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
        """
        return self._request('PUT', f'/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, text_layer_id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a text layer.

        Args:
            text_layer_id: The text layer ID
            namespace: The config namespace
            config_key: The config key
        """
        return self._request('DELETE', f'/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def shift(self, text_layer_id: str, direction: str) -> Any:
        """Shift a text layer's order within the project.

        Args:
            text_layer_id: The text layer ID
            direction: The direction ("up" or "down")
        """
        return self._request('POST', f'/api/v1/text-layers/{text_layer_id}/shift',
                             body=_body_of(direction=direction))

    def create(self, project_id: str, name: str) -> Any:
        """Create a new text layer for a project.

        Args:
            project_id: The project ID
            name: The name
        """
        return self._request('POST', '/api/v1/text-layers',
                             body=_body_of(project_id=project_id, name=name))


class VocabItemsResource(_Resource):
    def create(self, vocab_layer_id: str, form: str, metadata: Any = _UNSET) -> Any:
        """Create a new vocab item.

        Args:
            vocab_layer_id: The vocab layer ID
            form: The vocab item form
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
        """
        return self._request('POST', '/api/v1/vocab-items',
                             body=_body_of(vocab_layer_id=vocab_layer_id, form=form, metadata=metadata))

    def get(self, id: str, *, as_of: str | None = None) -> Any:
        """Get a vocab item by ID.

        Args:
            id: The resource ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/vocab-items/{id}',
                             query_params={'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a vocab item.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-items/{id}')

    def update(self, id: str, form: str) -> Any:
        """Update a vocab item's form.

        Args:
            id: The resource ID
            form: The vocab item form
        """
        return self._request('PATCH', f'/api/v1/vocab-items/{id}',
                             body=_body_of(form=form))

    def set_metadata(self, id: str, body: Any) -> Any:
        """Replace all metadata for a vocab item.

        Args:
            id: The resource ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/vocab-items/{id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, id: str) -> Any:
        """Remove all metadata from a vocab item.

        Args:
            id: The resource ID
        """
        return self._request('DELETE', f'/api/v1/vocab-items/{id}/metadata',
                             skip_response_transform=True)

    def patch_metadata(self, id: str, body: Any) -> Any:
        """Patch (shallow-merge) metadata for a vocab item.

        Keys present in the body are set or overwritten; keys not present are
        left untouched; a key whose value is None (JSON null) is deleted.
        Merging is top-level only (nested objects are replaced wholesale, not
        deep-merged), so a literal null cannot be stored as a value. An empty
        body changes no metadata.

        Args:
            id: The resource ID
            body: The metadata patch
        """
        return self._request('PATCH', f'/api/v1/vocab-items/{id}/metadata',
                             raw_body=body, skip_response_transform=True)


class RelationLayersResource(_Resource):
    def get(self, relation_layer_id: str, *, as_of: str | None = None) -> Any:
        """Get a relation layer by ID.

        Args:
            relation_layer_id: The relation layer ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/relation-layers/{relation_layer_id}',
                             query_params={'as-of': as_of})

    def delete(self, relation_layer_id: str) -> Any:
        """Delete a relation layer.

        Args:
            relation_layer_id: The relation layer ID
        """
        return self._request('DELETE', f'/api/v1/relation-layers/{relation_layer_id}')

    def update(self, relation_layer_id: str, name: str) -> Any:
        """Update a relation layer's name.

        Args:
            relation_layer_id: The relation layer ID
            name: The name
        """
        return self._request('PATCH', f'/api/v1/relation-layers/{relation_layer_id}',
                             body=_body_of(name=name))

    def set_config(self, relation_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a relation layer in an editor namespace.

        Args:
            relation_layer_id: The relation layer ID
            namespace: The config namespace
            config_key: The config key
            config_value: Configuration value to set
        """
        return self._request('PUT', f'/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, relation_layer_id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a relation layer.

        Args:
            relation_layer_id: The relation layer ID
            namespace: The config namespace
            config_key: The config key
        """
        return self._request('DELETE', f'/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def shift(self, relation_layer_id: str, direction: str) -> Any:
        """Shift a relation layer's display order.

        Args:
            relation_layer_id: The relation layer ID
            direction: The direction ("up" or "down")
        """
        return self._request('POST', f'/api/v1/relation-layers/{relation_layer_id}/shift',
                             body=_body_of(direction=direction))

    def create(self, span_layer_id: str, name: str) -> Any:
        """Create a new relation layer.

        Args:
            span_layer_id: The span layer ID
            name: The name
        """
        return self._request('POST', '/api/v1/relation-layers',
                             body=_body_of(span_layer_id=span_layer_id, name=name))


class TokensResource(_Resource):
    def set_metadata(self, token_id: str, body: Any) -> Any:
        """Replace all metadata for a token.

        Args:
            token_id: The token ID
            body: The request body
        """
        return self._request('PUT', f'/api/v1/tokens/{token_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, token_id: str) -> Any:
        """Remove all metadata from a token.

        Args:
            token_id: The token ID
        """
        return self._request('DELETE', f'/api/v1/tokens/{token_id}/metadata',
                             skip_response_transform=True)

    def patch_metadata(self, token_id: str, body: Any) -> Any:
        """Patch (shallow-merge) metadata for a token.

        Keys present in the body are set or overwritten; keys not present are
        left untouched; a key whose value is None (JSON null) is deleted.
        Merging is top-level only (nested objects are replaced wholesale, not
        deep-merged), so a literal null cannot be stored as a value. An empty
        body changes no metadata.

        Args:
            token_id: The token ID
            body: The metadata patch
        """
        return self._request('PATCH', f'/api/v1/tokens/{token_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def get(self, token_id: str, *, as_of: str | None = None) -> Any:
        """Get a token.

        Args:
            token_id: The token ID
            as_of: Temporal query timestamp
        """
        return self._request('GET', f'/api/v1/tokens/{token_id}',
                             query_params={'as-of': as_of})

    def delete(self, token_id: str) -> Any:
        """Delete a token and remove it from any spans.

        If this causes a span to have no remaining tokens, the span will
        also be deleted.

        Args:
            token_id: The token ID
        """
        return self._request('DELETE', f'/api/v1/tokens/{token_id}')

    def update(self, token_id: str, *, begin: Any = _UNSET, end: Any = _UNSET,
               precedence: Any = _UNSET) -> Any:
        """Update a token's ``begin``, ``end``, or ``precedence``.

        ``precedence`` distinguishes three cases: omit it to leave the value
        unchanged; pass an int to set it; pass ``None`` explicitly to CLEAR it
        (revert to no explicit ordering) -- the server reads key-presence, not
        non-nil-ness, so a sent JSON ``null`` is an explicit clear.
        ``begin``/``end`` are left unchanged when omitted.

        Args:
            token_id: The token ID
            begin: New start offset. Omit to leave unchanged.
            end: New end offset. Omit to leave unchanged.
            precedence: Ordering precedence. Omit to leave unchanged; pass an
                int to set; pass ``None`` explicitly to CLEAR it (revert to no
                explicit ordering).
        """
        return self._request('PATCH', f'/api/v1/tokens/{token_id}',
                             body=_body_of(begin=begin, end=end, precedence=precedence))

    def create(self, token_layer_id: str, text: str, begin: int, end: int, *,
               precedence: Any = _UNSET, metadata: Any = _UNSET) -> Any:
        """Create a new token in a token layer.

        Tokens define text substrings using ``begin`` and ``end`` offsets.
        Tokens may be zero-width and may overlap. For tokens sharing the
        same ``begin``, ``precedence`` controls the linear ordering.

        Args:
            token_layer_id: The token layer ID
            text: The text ID
            begin: Start offset (inclusive)
            end: End offset (exclusive)
            precedence: Ordering precedence. Omit to leave unset; pass ``None``
                to send JSON null.
            metadata: Metadata map. Omit to leave unset; pass ``None`` to send
                JSON null.
        """
        return self._request('POST', '/api/v1/tokens',
                             body=_body_of(token_layer_id=token_layer_id, text=text,
                                           begin=begin, end=end, precedence=precedence,
                                           metadata=metadata))

    def bulk_create(self, body: list) -> Any:
        """Create multiple tokens in a single operation.

        Args:
            body: The request body
        """
        return self._request('POST', '/api/v1/tokens/bulk', body=body)

    def bulk_delete(self, body: list) -> Any:
        """Delete multiple tokens in a single operation. Provide a list of IDs.

        Args:
            body: The request body
        """
        return self._request('DELETE', '/api/v1/tokens/bulk', body=body)

    def split(self, token_id: str, position: int) -> Any:
        """Split a token at a character offset.

        The original token becomes the left half (keeping its ID, spans, and
        vocab-links); a new token is created for the right half and its ID is
        returned. ``position`` must be strictly between the token's begin and end.

        Args:
            token_id: The token ID
            position: Offset to split at (strictly between begin and end)
        """
        return self._request('POST', f'/api/v1/tokens/{token_id}/split',
                             body=_body_of(position=position))

    def merge(self, token_id: str, other_token_id: str) -> Any:
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
                             body=_body_of(other_token_id=other_token_id))

    def shift(self, token_id: str, *, begin: Any = _UNSET, end: Any = _UNSET) -> Any:
        """Shift a token's boundary.

        On partitioning layers the adjacent token is auto-adjusted to preserve
        the partition; on non-overlapping layers the shift is rejected if it
        would create an overlap.

        Args:
            token_id: The token ID
            begin: New start offset. Omit to leave unchanged.
            end: New end offset. Omit to leave unchanged.
        """
        return self._request('POST', f'/api/v1/tokens/{token_id}/shift',
                             body=_body_of(begin=begin, end=end))


class BatchResource(_Resource):
    def submit(self, body: list) -> Any:
        """Execute multiple API operations atomically.

        If any operation fails, all changes are rolled back.

        Args:
            body: The request body
        """
        return self._request('POST', '/api/v1/batch', body=body, no_batch=True)


class PlaidClient:
    def __init__(self, base_url: str, token: str, timeout: float | None = DEFAULT_TIMEOUT_S):
        """Create a new PlaidClient instance.

        Args:
            base_url: The base URL for the API
            token: The authentication token
            timeout: Per-request timeout in seconds (default 30; ``None`` disables
                it). Also bounds media up/downloads — raise it for large files.
        """
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.timeout = timeout
        self.is_batching = False
        self.batch_operations: list[dict] = []
        self.document_versions: dict[str, str] = {}
        self.strict_mode_document_id: str | None = None
        self.session = req_lib.Session()

        self.vocab_links = VocabLinksResource(self)
        self.vocab_layers = VocabLayersResource(self)
        self.relations = RelationsResource(self)
        self.span_layers = SpanLayersResource(self)
        self.spans = SpansResource(self)
        self.texts = TextsResource(self)
        self.users = UsersResource(self)
        self.api_tokens = ApiTokensResource(self)
        self.token_layers = TokenLayersResource(self)
        self.documents = DocumentsResource(self)
        self.messages = MessagesResource(self)
        self.projects = ProjectsResource(self)
        self.text_layers = TextLayersResource(self)
        self.vocab_items = VocabItemsResource(self)
        self.relation_layers = RelationLayersResource(self)
        self.tokens = TokensResource(self)
        self.batch = BatchResource(self)

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
                    ['span', '?s1', {'layer': 'pos', 'value': 'NOUN'}],
                    ['span', '?s2', {'layer': 'pos', 'value': 'VERB'}],
                    ['covers', '?s1', '?t1'], ['covers', '?s2', '?t2'],
                    ['precedes', '?t1', '?t2'],
                ],
                'return': 'entities',   # 'ids' (default) | 'entities' | 'count'
                'limit': 100,
            })

        Args:
            body: The query AST ({find, where, scope?, limit?, return?}).

        Returns:
            For 'ids'/'entities': {columns, results, count, truncated}. For
            'count': {return: 'count', count}. Entity cells are full entity
            dicts (same shape as the GET endpoints).
        """
        return make_request(self, 'POST', '/api/v1/query', body=body)

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

    def begin_batch(self) -> None:
        """Begin a batch of operations. Subsequent API calls will be queued."""
        self.is_batching = True
        self.batch_operations = []

    def submit_batch(self) -> list[Any]:
        """Submit all queued batch operations as a single batch request.

        If any operation fails, all changes are rolled back.

        Returns:
            List of results corresponding to each operation
        """
        if not self.is_batching:
            raise PlaidAPIError('No active batch. Call begin_batch() first.')

        if not self.batch_operations:
            self.is_batching = False
            return []

        try:
            url = f'{self.base_url}/api/v1/batch'
            body = []
            for op in self.batch_operations:
                entry = {'path': op['path'], 'method': op['method'].upper()}
                if 'body' in op:
                    entry['body'] = op['body']
                body.append(entry)

            headers = {
                'Authorization': f'Bearer {self.token}',
                'Content-Type': 'application/json',
            }

            response = self.session.post(url, headers=headers, data=json.dumps(body),
                                         timeout=self.timeout)

            if not response.ok:
                raise build_api_error(response, url, 'POST')

            results = response.json()

            for result in results:
                if isinstance(result, dict) and 'headers' in result:
                    dv_header = result['headers'].get('X-Document-Versions')
                    if dv_header:
                        try:
                            versions_map = json.loads(dv_header)
                            if isinstance(versions_map, dict):
                                self.document_versions.update(versions_map)
                        except (json.JSONDecodeError, TypeError):
                            pass

            return [transform_response(r) for r in results]
        except PlaidAPIError:
            raise
        except Exception as e:
            raise PlaidAPIError(f'Network error: {e} at {self.base_url}/api/v1/batch',
                                url=f'{self.base_url}/api/v1/batch', method='POST',
                                original_error=e)
        finally:
            self.is_batching = False
            self.batch_operations = []

    def abort_batch(self) -> None:
        """Abort the current batch without executing any operations."""
        self.is_batching = False
        self.batch_operations = []

    def is_batch_mode(self) -> bool:
        """Check if currently in batch mode.

        Returns:
            Whether the client is currently collecting batch operations.
        """
        return self.is_batching

    def close(self) -> None:
        """Close the underlying HTTP session."""
        self.session.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    @classmethod
    def login(cls, base_url: str, user_id: str, password: str,
              timeout: float | None = DEFAULT_TIMEOUT_S) -> PlaidClient:
        """Authenticate and return a new client instance with token.

        This is the single auth entry point — there is no ``client.login`` resource.

        Args:
            base_url: The base URL for the API
            user_id: User ID for authentication
            password: Password for authentication
            timeout: Per-request timeout in seconds, forwarded to the new client.

        Returns:
            Authenticated client instance
        """
        base_url = base_url.rstrip('/')
        url = f'{base_url}/api/v1/login'
        try:
            response = req_lib.post(url,
                                    headers={'Content-Type': 'application/json'},
                                    data=json.dumps({'user-id': user_id, 'password': password}),
                                    timeout=timeout)
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
        return cls(base_url, token, timeout=timeout)
