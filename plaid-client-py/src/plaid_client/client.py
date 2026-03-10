from __future__ import annotations

import json
from typing import Any

import requests as req_lib

from plaid_client.http import PlaidAPIError, make_request, extract_document_versions
from plaid_client.transforms import transform_response
from plaid_client.sse import SSEConnection
from plaid_client import services as svc


def _body_of(**kwargs):
    return {k: v for k, v in kwargs.items() if v is not None}


class _Resource:
    def __init__(self, client: PlaidClient):
        self._client = client

    def _request(self, method, path, **kwargs):
        return make_request(self._client, method, path, **kwargs)


class VocabLinksResource(_Resource):
    def create(self, vocab_item: str, tokens: list, metadata: Any = None) -> Any:
        """Create a new vocab link between tokens and a vocab item."""
        return self._request('POST', '/api/v1/vocab-links',
                             body=_body_of(vocab_item=vocab_item, tokens=tokens, metadata=metadata))

    def set_metadata(self, id: str, body: Any) -> Any:
        """Replace all metadata for a vocab link."""
        return self._request('PUT', f'/api/v1/vocab-links/{id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, id: str) -> Any:
        """Remove all metadata from a vocab link."""
        return self._request('DELETE', f'/api/v1/vocab-links/{id}/metadata',
                             skip_response_transform=True)

    def get(self, id: str, *, as_of: str | None = None) -> Any:
        """Get a vocab link by ID."""
        return self._request('GET', f'/api/v1/vocab-links/{id}',
                             query_params={'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a vocab link."""
        return self._request('DELETE', f'/api/v1/vocab-links/{id}')


class VocabLayersResource(_Resource):
    def get(self, id: str, *, include_items: bool | None = None, as_of: str | None = None) -> Any:
        """Get a vocab layer by ID."""
        return self._request('GET', f'/api/v1/vocab-layers/{id}',
                             query_params={'include-items': include_items, 'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a vocab layer."""
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}')

    def update(self, id: str, name: str) -> Any:
        """Update a vocab layer's name."""
        return self._request('PATCH', f'/api/v1/vocab-layers/{id}',
                             body=_body_of(name=name))

    def set_config(self, id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a vocab layer in an editor namespace."""
        return self._request('PUT', f'/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a vocab layer."""
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def list(self, *, as_of: str | None = None) -> Any:
        """List all vocab layers accessible to the current user."""
        return self._request('GET', '/api/v1/vocab-layers',
                             query_params={'as-of': as_of})

    def create(self, name: str) -> Any:
        """Create a new vocab layer.

        Also registers the current user as a maintainer.
        """
        return self._request('POST', '/api/v1/vocab-layers',
                             body=_body_of(name=name))

    def add_maintainer(self, id: str, user_id: str) -> Any:
        """Assign a user as a maintainer for this vocab layer."""
        return self._request('POST', f'/api/v1/vocab-layers/{id}/maintainers/{user_id}')

    def remove_maintainer(self, id: str, user_id: str) -> Any:
        """Remove a user's maintainer privileges for this vocab layer."""
        return self._request('DELETE', f'/api/v1/vocab-layers/{id}/maintainers/{user_id}')


class RelationsResource(_Resource):
    def set_metadata(self, relation_id: str, body: Any) -> Any:
        """Replace all metadata for a relation."""
        return self._request('PUT', f'/api/v1/relations/{relation_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, relation_id: str) -> Any:
        """Remove all metadata from a relation."""
        return self._request('DELETE', f'/api/v1/relations/{relation_id}/metadata',
                             skip_response_transform=True)

    def set_target(self, relation_id: str, span_id: str) -> Any:
        """Update the target span of a relation."""
        return self._request('PUT', f'/api/v1/relations/{relation_id}/target',
                             body=_body_of(span_id=span_id))

    def set_source(self, relation_id: str, span_id: str) -> Any:
        """Update the source span of a relation."""
        return self._request('PUT', f'/api/v1/relations/{relation_id}/source',
                             body=_body_of(span_id=span_id))

    def get(self, relation_id: str, *, as_of: str | None = None) -> Any:
        """Get a relation by ID."""
        return self._request('GET', f'/api/v1/relations/{relation_id}',
                             query_params={'as-of': as_of})

    def delete(self, relation_id: str) -> Any:
        """Delete a relation."""
        return self._request('DELETE', f'/api/v1/relations/{relation_id}')

    def update(self, relation_id: str, value: Any) -> Any:
        """Update a relation's value."""
        return self._request('PATCH', f'/api/v1/relations/{relation_id}',
                             body=_body_of(value=value))

    def create(self, layer_id: str, source_id: str, target_id: str, value: Any,
               metadata: Any = None) -> Any:
        """Create a new relation.

        A relation is a directed edge between two spans with a value, useful
        for expressing phenomena such as syntactic or semantic relations.
        """
        return self._request('POST', '/api/v1/relations',
                             body=_body_of(layer_id=layer_id, source_id=source_id,
                                           target_id=target_id, value=value, metadata=metadata))

    def bulk_create(self, body: list) -> Any:
        """Create multiple relations in a single operation."""
        return self._request('POST', '/api/v1/relations/bulk', body=body)

    def bulk_delete(self, body: list) -> Any:
        """Delete multiple relations in a single operation."""
        return self._request('DELETE', '/api/v1/relations/bulk', body=body)


class SpanLayersResource(_Resource):
    def get(self, span_layer_id: str, *, as_of: str | None = None) -> Any:
        """Get a span layer by ID."""
        return self._request('GET', f'/api/v1/span-layers/{span_layer_id}',
                             query_params={'as-of': as_of})

    def delete(self, span_layer_id: str) -> Any:
        """Delete a span layer."""
        return self._request('DELETE', f'/api/v1/span-layers/{span_layer_id}')

    def update(self, span_layer_id: str, name: str) -> Any:
        """Update a span layer's name."""
        return self._request('PATCH', f'/api/v1/span-layers/{span_layer_id}',
                             body=_body_of(name=name))

    def set_config(self, span_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a span layer in an editor namespace."""
        return self._request('PUT', f'/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, span_layer_id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a span layer."""
        return self._request('DELETE', f'/api/v1/span-layers/{span_layer_id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def shift(self, span_layer_id: str, direction: str) -> Any:
        """Shift a span layer's display order."""
        return self._request('POST', f'/api/v1/span-layers/{span_layer_id}/shift',
                             body=_body_of(direction=direction))

    def create(self, token_layer_id: str, name: str) -> Any:
        """Create a new span layer."""
        return self._request('POST', '/api/v1/span-layers',
                             body=_body_of(token_layer_id=token_layer_id, name=name))


class SpansResource(_Resource):
    def set_metadata(self, span_id: str, body: Any) -> Any:
        """Replace all metadata for a span."""
        return self._request('PUT', f'/api/v1/spans/{span_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, span_id: str) -> Any:
        """Remove all metadata from a span."""
        return self._request('DELETE', f'/api/v1/spans/{span_id}/metadata',
                             skip_response_transform=True)

    def set_tokens(self, span_id: str, tokens: list) -> Any:
        """Replace the tokens associated with a span."""
        return self._request('PUT', f'/api/v1/spans/{span_id}/tokens',
                             body=_body_of(tokens=tokens))

    def get(self, span_id: str, *, as_of: str | None = None) -> Any:
        """Get a span by ID."""
        return self._request('GET', f'/api/v1/spans/{span_id}',
                             query_params={'as-of': as_of})

    def delete(self, span_id: str) -> Any:
        """Delete a span."""
        return self._request('DELETE', f'/api/v1/spans/{span_id}')

    def update(self, span_id: str, value: Any) -> Any:
        """Update a span's value."""
        return self._request('PATCH', f'/api/v1/spans/{span_id}',
                             body=_body_of(value=value))

    def create(self, span_layer_id: str, tokens: list, value: Any, metadata: Any = None) -> Any:
        """Create a new span.

        A span holds a primary atomic value and optional metadata, and must
        at all times be associated with one or more tokens.
        """
        return self._request('POST', '/api/v1/spans',
                             body=_body_of(span_layer_id=span_layer_id, tokens=tokens,
                                           value=value, metadata=metadata))

    def bulk_create(self, body: list) -> Any:
        """Create multiple spans in a single operation."""
        return self._request('POST', '/api/v1/spans/bulk', body=body)

    def bulk_delete(self, body: list) -> Any:
        """Delete multiple spans in a single operation."""
        return self._request('DELETE', '/api/v1/spans/bulk', body=body)


class TextsResource(_Resource):
    def create(self, text_layer_id: str, document_id: str, body: str,
               metadata: Any = None) -> Any:
        """Create a new text in a document's text layer.

        A text is a container for one long string in ``body`` for a given layer.
        """
        return self._request('POST', '/api/v1/texts',
                             body=_body_of(text_layer_id=text_layer_id, document_id=document_id,
                                           body=body, metadata=metadata))

    def get(self, text_id: str, *, as_of: str | None = None) -> Any:
        """Get a text."""
        return self._request('GET', f'/api/v1/texts/{text_id}',
                             query_params={'as-of': as_of})

    def delete(self, text_id: str) -> Any:
        """Delete a text and all dependent data."""
        return self._request('DELETE', f'/api/v1/texts/{text_id}')

    def update(self, text_id: str, body: Any) -> Any:
        """Update a text's ``body``.

        A diff is computed and token indices are updated so that tokens
        remain intact. Alternatively, ``body`` can be a list of edit
        directives.
        """
        return self._request('PATCH', f'/api/v1/texts/{text_id}',
                             body=_body_of(body=body))

    def set_metadata(self, text_id: str, body: Any) -> Any:
        """Replace all metadata for a text."""
        return self._request('PUT', f'/api/v1/texts/{text_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, text_id: str) -> Any:
        """Remove all metadata from a text."""
        return self._request('DELETE', f'/api/v1/texts/{text_id}/metadata',
                             skip_response_transform=True)


class UsersResource(_Resource):
    def list(self, *, as_of: str | None = None) -> Any:
        """List all users."""
        return self._request('GET', '/api/v1/users',
                             query_params={'as-of': as_of})

    def create(self, username: str, password: str, is_admin: bool) -> Any:
        """Create a new user."""
        return self._request('POST', '/api/v1/users',
                             body=_body_of(username=username, password=password, is_admin=is_admin))

    def get(self, id: str, *, as_of: str | None = None) -> Any:
        """Get a user by ID."""
        return self._request('GET', f'/api/v1/users/{id}',
                             query_params={'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a user."""
        return self._request('DELETE', f'/api/v1/users/{id}')

    def update(self, id: str, *, password: str | None = None, username: str | None = None,
               is_admin: bool | None = None) -> Any:
        """Modify a user.

        Admins may change the username, password, and admin status of any
        user. All other users may only modify their own username or password.
        """
        return self._request('PATCH', f'/api/v1/users/{id}',
                             body=_body_of(password=password, username=username, is_admin=is_admin))

    def audit(self, user_id: str, *, start_time: str | None = None, end_time: str | None = None,
              as_of: str | None = None) -> Any:
        """Get audit log for a user's actions."""
        return self._request('GET', f'/api/v1/users/{user_id}/audit',
                             query_params={'start-time': start_time, 'end-time': end_time, 'as-of': as_of})


class TokenLayersResource(_Resource):
    def get(self, token_layer_id: str, *, as_of: str | None = None) -> Any:
        """Get a token layer by ID."""
        return self._request('GET', f'/api/v1/token-layers/{token_layer_id}',
                             query_params={'as-of': as_of})

    def delete(self, token_layer_id: str) -> Any:
        """Delete a token layer."""
        return self._request('DELETE', f'/api/v1/token-layers/{token_layer_id}')

    def update(self, token_layer_id: str, name: str) -> Any:
        """Update a token layer's name."""
        return self._request('PATCH', f'/api/v1/token-layers/{token_layer_id}',
                             body=_body_of(name=name))

    def set_config(self, token_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a token layer in an editor namespace."""
        return self._request('PUT', f'/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, token_layer_id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a token layer."""
        return self._request('DELETE', f'/api/v1/token-layers/{token_layer_id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def shift(self, token_layer_id: str, direction: str) -> Any:
        """Shift a token layer's display order."""
        return self._request('POST', f'/api/v1/token-layers/{token_layer_id}/shift',
                             body=_body_of(direction=direction))

    def create(self, text_layer_id: str, name: str) -> Any:
        """Create a new token layer."""
        return self._request('POST', '/api/v1/token-layers',
                             body=_body_of(text_layer_id=text_layer_id, name=name))


class DocumentsResource(_Resource):
    def check_lock(self, document_id: str, *, as_of: str | None = None) -> Any:
        """Check the lock status of a document."""
        return self._request('GET', f'/api/v1/documents/{document_id}/lock',
                             query_params={'as-of': as_of})

    def acquire_lock(self, document_id: str) -> Any:
        """Acquire or refresh a document lock."""
        return self._request('POST', f'/api/v1/documents/{document_id}/lock')

    def release_lock(self, document_id: str) -> Any:
        """Release a document lock."""
        return self._request('DELETE', f'/api/v1/documents/{document_id}/lock')

    def get_media(self, document_id: str, *, as_of: str | None = None) -> bytes:
        """Get media file for a document."""
        return self._request('GET', f'/api/v1/documents/{document_id}/media',
                             query_params={'as-of': as_of}, no_batch=True, binary_response=True)

    def upload_media(self, document_id: str, file) -> Any:
        """Upload a media file for a document."""
        return self._request('PUT', f'/api/v1/documents/{document_id}/media',
                             body={'file': file}, form_data=True, no_batch=True)

    def delete_media(self, document_id: str) -> Any:
        """Delete media file for a document."""
        return self._request('DELETE', f'/api/v1/documents/{document_id}/media',
                             no_batch=True)

    def get(self, document_id: str, *, include_body: bool | None = None,
            as_of: str | None = None) -> Any:
        """Get a document.

        Set ``include_body`` to true to include all data contained in the
        document.
        """
        return self._request('GET', f'/api/v1/documents/{document_id}',
                             query_params={'include-body': include_body, 'as-of': as_of})

    def delete(self, document_id: str) -> Any:
        """Delete a document and all data contained."""
        return self._request('DELETE', f'/api/v1/documents/{document_id}')

    def update(self, document_id: str, name: str) -> Any:
        """Update a document's name."""
        return self._request('PATCH', f'/api/v1/documents/{document_id}',
                             body=_body_of(name=name))

    def create(self, project_id: str, name: str, metadata: Any = None) -> Any:
        """Create a new document in a project."""
        return self._request('POST', '/api/v1/documents',
                             body=_body_of(project_id=project_id, name=name, metadata=metadata))

    def set_metadata(self, document_id: str, body: Any) -> Any:
        """Replace all metadata for a document."""
        return self._request('PUT', f'/api/v1/documents/{document_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, document_id: str) -> Any:
        """Remove all metadata from a document."""
        return self._request('DELETE', f'/api/v1/documents/{document_id}/metadata',
                             skip_response_transform=True)

    def audit(self, document_id: str, *, start_time: str | None = None,
              end_time: str | None = None, as_of: str | None = None) -> Any:
        """Get audit log for a document."""
        return self._request('GET', f'/api/v1/documents/{document_id}/audit',
                             query_params={'start-time': start_time, 'end-time': end_time, 'as-of': as_of})


class MessagesResource(_Resource):
    def listen(self, project_id: str, on_event) -> SSEConnection:
        """Listen to project events via Server-Sent Events."""
        return SSEConnection(self._client, project_id, on_event)

    def send_message(self, project_id: str, data: Any) -> Any:
        """Send a message to all clients listening to a project."""
        return self._request('POST', f'/api/v1/projects/{project_id}/message',
                             body={'body': data})

    def discover_services(self, project_id: str, timeout: float = 3.0) -> list:
        """Discover available services in a project."""
        return svc.discover_services(
            self._client, self.listen, self.send_message, project_id, timeout)

    def serve(self, project_id: str, service_info: dict, on_service_request,
              extras: dict | None = None) -> svc.ServiceRegistration:
        """Register a service for a project."""
        return svc.serve(
            self._client, self.listen, self.send_message, project_id,
            service_info, on_service_request, extras)

    def request_service(self, project_id: str, service_id: str, data: Any,
                        timeout: float = 10.0) -> Any:
        """Send a request to a service in a project."""
        return svc.request_service(
            self._client, self.listen, self.send_message, project_id,
            service_id, data, timeout)


class ProjectsResource(_Resource):
    def create(self, name: str) -> Any:
        """Create a new project.

        Also registers the current user as a maintainer.
        """
        return self._request('POST', '/api/v1/projects',
                             body=_body_of(name=name))

    def list(self, *, as_of: str | None = None) -> Any:
        """List all projects accessible to the current user."""
        return self._request('GET', '/api/v1/projects',
                             query_params={'as-of': as_of})

    def get(self, id: str, *, include_documents: bool | None = None,
            as_of: str | None = None) -> Any:
        """Get a project by ID.

        Set ``include_documents`` to true to also include document IDs and
        names.
        """
        return self._request('GET', f'/api/v1/projects/{id}',
                             query_params={'include-documents': include_documents, 'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a project."""
        return self._request('DELETE', f'/api/v1/projects/{id}')

    def update(self, id: str, name: str) -> Any:
        """Update a project's name."""
        return self._request('PATCH', f'/api/v1/projects/{id}',
                             body=_body_of(name=name))

    def add_writer(self, id: str, user_id: str) -> Any:
        """Grant write access to a user for this project."""
        return self._request('POST', f'/api/v1/projects/{id}/writers/{user_id}')

    def remove_writer(self, id: str, user_id: str) -> Any:
        """Remove a user's write access for this project."""
        return self._request('DELETE', f'/api/v1/projects/{id}/writers/{user_id}')

    def add_reader(self, id: str, user_id: str) -> Any:
        """Grant read-only access to a user for this project."""
        return self._request('POST', f'/api/v1/projects/{id}/readers/{user_id}')

    def remove_reader(self, id: str, user_id: str) -> Any:
        """Remove a user's read access for this project."""
        return self._request('DELETE', f'/api/v1/projects/{id}/readers/{user_id}')

    def add_maintainer(self, id: str, user_id: str) -> Any:
        """Assign a user as a maintainer for this project."""
        return self._request('POST', f'/api/v1/projects/{id}/maintainers/{user_id}')

    def remove_maintainer(self, id: str, user_id: str) -> Any:
        """Remove a user's maintainer privileges for this project."""
        return self._request('DELETE', f'/api/v1/projects/{id}/maintainers/{user_id}')

    def set_config(self, id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a project in an editor namespace."""
        return self._request('PUT', f'/api/v1/projects/{id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a project."""
        return self._request('DELETE', f'/api/v1/projects/{id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def audit(self, project_id: str, *, start_time: str | None = None,
              end_time: str | None = None, as_of: str | None = None) -> Any:
        """Get audit log for a project."""
        return self._request('GET', f'/api/v1/projects/{project_id}/audit',
                             query_params={'start-time': start_time, 'end-time': end_time, 'as-of': as_of})

    def link_vocab(self, id: str, vocab_id: str) -> Any:
        """Link a vocabulary layer to a project."""
        return self._request('POST', f'/api/v1/projects/{id}/vocabs/{vocab_id}')

    def unlink_vocab(self, id: str, vocab_id: str) -> Any:
        """Unlink a vocabulary layer from a project."""
        return self._request('DELETE', f'/api/v1/projects/{id}/vocabs/{vocab_id}')


class TextLayersResource(_Resource):
    def get(self, text_layer_id: str, *, as_of: str | None = None) -> Any:
        """Get a text layer by ID."""
        return self._request('GET', f'/api/v1/text-layers/{text_layer_id}',
                             query_params={'as-of': as_of})

    def delete(self, text_layer_id: str) -> Any:
        """Delete a text layer."""
        return self._request('DELETE', f'/api/v1/text-layers/{text_layer_id}')

    def update(self, text_layer_id: str, name: str) -> Any:
        """Update a text layer's name."""
        return self._request('PATCH', f'/api/v1/text-layers/{text_layer_id}',
                             body=_body_of(name=name))

    def set_config(self, text_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a text layer in an editor namespace."""
        return self._request('PUT', f'/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, text_layer_id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a text layer."""
        return self._request('DELETE', f'/api/v1/text-layers/{text_layer_id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def shift(self, text_layer_id: str, direction: str) -> Any:
        """Shift a text layer's display order."""
        return self._request('POST', f'/api/v1/text-layers/{text_layer_id}/shift',
                             body=_body_of(direction=direction))

    def create(self, project_id: str, name: str) -> Any:
        """Create a new text layer for a project."""
        return self._request('POST', '/api/v1/text-layers',
                             body=_body_of(project_id=project_id, name=name))


class VocabItemsResource(_Resource):
    def create(self, vocab_layer_id: str, form: str, metadata: Any = None) -> Any:
        """Create a new vocab item."""
        return self._request('POST', '/api/v1/vocab-items',
                             body=_body_of(vocab_layer_id=vocab_layer_id, form=form, metadata=metadata))

    def get(self, id: str, *, as_of: str | None = None) -> Any:
        """Get a vocab item by ID."""
        return self._request('GET', f'/api/v1/vocab-items/{id}',
                             query_params={'as-of': as_of})

    def delete(self, id: str) -> Any:
        """Delete a vocab item."""
        return self._request('DELETE', f'/api/v1/vocab-items/{id}')

    def update(self, id: str, form: str) -> Any:
        """Update a vocab item's form."""
        return self._request('PATCH', f'/api/v1/vocab-items/{id}',
                             body=_body_of(form=form))

    def set_metadata(self, id: str, body: Any) -> Any:
        """Replace all metadata for a vocab item."""
        return self._request('PUT', f'/api/v1/vocab-items/{id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, id: str) -> Any:
        """Remove all metadata from a vocab item."""
        return self._request('DELETE', f'/api/v1/vocab-items/{id}/metadata',
                             skip_response_transform=True)


class RelationLayersResource(_Resource):
    def get(self, relation_layer_id: str, *, as_of: str | None = None) -> Any:
        """Get a relation layer by ID."""
        return self._request('GET', f'/api/v1/relation-layers/{relation_layer_id}',
                             query_params={'as-of': as_of})

    def delete(self, relation_layer_id: str) -> Any:
        """Delete a relation layer."""
        return self._request('DELETE', f'/api/v1/relation-layers/{relation_layer_id}')

    def update(self, relation_layer_id: str, name: str) -> Any:
        """Update a relation layer's name."""
        return self._request('PATCH', f'/api/v1/relation-layers/{relation_layer_id}',
                             body=_body_of(name=name))

    def set_config(self, relation_layer_id: str, namespace: str, config_key: str, config_value: Any) -> Any:
        """Set a configuration value for a relation layer in an editor namespace."""
        return self._request('PUT', f'/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}',
                             raw_body=config_value, skip_response_transform=True)

    def delete_config(self, relation_layer_id: str, namespace: str, config_key: str) -> Any:
        """Remove a configuration value for a relation layer."""
        return self._request('DELETE', f'/api/v1/relation-layers/{relation_layer_id}/config/{namespace}/{config_key}',
                             skip_response_transform=True)

    def shift(self, relation_layer_id: str, direction: str) -> Any:
        """Shift a relation layer's display order."""
        return self._request('POST', f'/api/v1/relation-layers/{relation_layer_id}/shift',
                             body=_body_of(direction=direction))

    def create(self, span_layer_id: str, name: str) -> Any:
        """Create a new relation layer."""
        return self._request('POST', '/api/v1/relation-layers',
                             body=_body_of(span_layer_id=span_layer_id, name=name))


class TokensResource(_Resource):
    def set_metadata(self, token_id: str, body: Any) -> Any:
        """Replace all metadata for a token."""
        return self._request('PUT', f'/api/v1/tokens/{token_id}/metadata',
                             raw_body=body, skip_response_transform=True)

    def delete_metadata(self, token_id: str) -> Any:
        """Remove all metadata from a token."""
        return self._request('DELETE', f'/api/v1/tokens/{token_id}/metadata',
                             skip_response_transform=True)

    def get(self, token_id: str, *, as_of: str | None = None) -> Any:
        """Get a token."""
        return self._request('GET', f'/api/v1/tokens/{token_id}',
                             query_params={'as-of': as_of})

    def delete(self, token_id: str) -> Any:
        """Delete a token and remove it from any spans.

        If this causes a span to have no remaining tokens, the span will
        also be deleted.
        """
        return self._request('DELETE', f'/api/v1/tokens/{token_id}')

    def update(self, token_id: str, *, begin: int | None = None, end: int | None = None,
               precedence: int | None = None) -> Any:
        """Update a token's ``begin``, ``end``, or ``precedence``."""
        return self._request('PATCH', f'/api/v1/tokens/{token_id}',
                             body=_body_of(begin=begin, end=end, precedence=precedence))

    def create(self, token_layer_id: str, text: str, begin: int, end: int, *,
               precedence: int | None = None, metadata: Any = None) -> Any:
        """Create a new token in a token layer.

        Tokens define text substrings using ``begin`` and ``end`` offsets.
        Tokens may be zero-width and may overlap. For tokens sharing the
        same ``begin``, ``precedence`` controls the linear ordering.
        """
        return self._request('POST', '/api/v1/tokens',
                             body=_body_of(token_layer_id=token_layer_id, text=text,
                                           begin=begin, end=end, precedence=precedence,
                                           metadata=metadata))

    def bulk_create(self, body: list) -> Any:
        """Create multiple tokens in a single operation."""
        return self._request('POST', '/api/v1/tokens/bulk', body=body)

    def bulk_delete(self, body: list) -> Any:
        """Delete multiple tokens in a single operation."""
        return self._request('DELETE', '/api/v1/tokens/bulk', body=body)


class BatchResource(_Resource):
    def submit(self, body: list) -> Any:
        """Execute multiple API operations atomically.

        If any operation fails, all changes are rolled back.
        """
        return self._request('POST', '/api/v1/batch', body=body, no_batch=True)


class PlaidClient:
    def __init__(self, base_url: str, token: str):
        """Create a new PlaidClient instance."""
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.agent_name = None
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
        self.token_layers = TokenLayersResource(self)
        self.documents = DocumentsResource(self)
        self.messages = MessagesResource(self)
        self.projects = ProjectsResource(self)
        self.text_layers = TextLayersResource(self)
        self.vocab_items = VocabItemsResource(self)
        self.relation_layers = RelationLayersResource(self)
        self.tokens = TokensResource(self)
        self.batch = BatchResource(self)

    def enter_strict_mode(self, document_id: str) -> None:
        """Enable strict mode for a document, requiring document version headers."""
        self.strict_mode_document_id = document_id

    def exit_strict_mode(self) -> None:
        """Disable strict mode."""
        self.strict_mode_document_id = None

    def set_agent_name(self, agent_name: str) -> None:
        """Set the agent name sent in request headers."""
        self.agent_name = agent_name

    def begin_batch(self) -> None:
        """Start collecting operations for a batch submission."""
        self.is_batching = True
        self.batch_operations = []

    def submit_batch(self) -> list[Any]:
        """Submit all collected batch operations atomically.

        If any operation fails, all changes are rolled back.
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
            if self.agent_name:
                headers['X-Agent-Name'] = self.agent_name

            response = self.session.post(url, headers=headers, data=json.dumps(body))

            if not response.ok:
                try:
                    error_data = response.json()
                except Exception:
                    error_data = {'message': response.text}
                server_message = (error_data.get('error') or error_data.get('message')
                                  or response.reason or 'Unknown error')
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    status=response.status_code, url=url, method='POST',
                    response_data=error_data,
                )

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
                                url=f'{self.base_url}/api/v1/batch', method='POST')
        finally:
            self.is_batching = False
            self.batch_operations = []

    def abort_batch(self) -> None:
        """Discard all collected batch operations without submitting."""
        self.is_batching = False
        self.batch_operations = []

    def is_batch_mode(self) -> bool:
        """Return whether the client is currently collecting batch operations."""
        return self.is_batching

    def close(self) -> None:
        self.session.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    @classmethod
    def login(cls, base_url: str, user_id: str, password: str) -> PlaidClient:
        """Authenticate and return a new PlaidClient instance."""
        base_url = base_url.rstrip('/')
        url = f'{base_url}/api/v1/login'
        try:
            response = req_lib.post(url,
                                    headers={'Content-Type': 'application/json'},
                                    data=json.dumps({'user-id': user_id, 'password': password}))
        except Exception as e:
            raise PlaidAPIError(f'Network error: {e} at {url}', url=url, method='POST')

        if not response.ok:
            try:
                error_data = response.json()
            except Exception:
                error_data = {'message': response.text}
            server_message = (error_data.get('error') or error_data.get('message')
                              or response.reason or 'Unknown error')
            raise PlaidAPIError(
                f'HTTP {response.status_code} {server_message} at {url}',
                status=response.status_code, url=url, method='POST',
                response_data=error_data,
            )

        data = response.json()
        token = data.get('token', '')
        return cls(base_url, token)
