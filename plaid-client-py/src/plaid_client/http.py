import json
import logging
from urllib.parse import urlencode, quote

from plaid_client.transforms import transform_request, transform_response

logger = logging.getLogger(__name__)


class PlaidAPIError(Exception):
    """Enriched API error raised for failed HTTP responses and network errors.

    Attributes:
        status: HTTP status code (0 for network errors).
        status_text: HTTP status reason phrase.
        url: The request URL.
        method: The HTTP method used.
        response_data: Parsed error body returned by the server, if any.
        original_error: The underlying exception for network errors, if any.
    """

    def __init__(self, message, status=0, url='', method='', response_data=None,
                 status_text='', original_error=None):
        super().__init__(message)
        self.status = status
        self.status_text = status_text
        self.url = url
        self.method = method
        self.response_data = response_data
        self.original_error = original_error


def extract_document_versions(client, response_headers, response_body=None):
    """Extract and update document versions from response headers and body."""
    header = response_headers.get('X-Document-Versions')
    if header:
        try:
            versions_map = json.loads(header)
            if isinstance(versions_map, dict):
                client.document_versions.update(versions_map)
        except (json.JSONDecodeError, TypeError):
            logger.warning('Failed to parse document versions header')

    if isinstance(response_body, dict):
        doc_id = response_body.get('document/id')
        doc_version = response_body.get('document/version')
        if doc_id and doc_version:
            client.document_versions[doc_id] = doc_version


def _merge_query(query, **extra):
    """Merge a base query dict with extra paging params, dropping None values."""
    merged = dict(query) if query else {}
    for k, v in extra.items():
        if v is not None:
            merged[k] = v
    return merged


def list_page(client, path, *, limit=None, cursor=None, query=None):
    """Fetch a single page from a paginated collection endpoint.

    Returns the transformed envelope dict ``{"entries": [...],
    "next_cursor": <opaque-string-or-None>}`` exactly as the server returns it
    (after the client's response transform, which snake_cases ``next-cursor``
    to ``next_cursor``).

    Args:
        client: PlaidClient instance.
        path: Collection path, e.g. ``/api/v1/projects``.
        limit: Page size (1..1000). ``None`` lets the server use its default.
        cursor: Opaque cursor from a previous page's ``next_cursor``.
        query: Extra query params (e.g. ``{"as-of": ...}``).
    """
    qp = _merge_query(query, limit=limit, cursor=cursor)
    return make_request(client, 'GET', path, query_params=qp or None)


def iter_pages(client, path, *, page_size=1000, query=None):
    """Generator yielding each page's ``entries`` list, following cursors.

    Each yielded value is the list of entries for one page. Iteration stops
    when the server reports ``next_cursor`` of ``None``.

    NOTE: This auto-paginates and therefore CANNOT be used inside a batch — each
    page's request needs the previous page's ``next_cursor``, which doesn't
    exist until the batch executes. It raises ``RuntimeError`` immediately when
    the client is in batch mode. Use ``list_page`` for a single page inside a
    batch.

    Args:
        client: PlaidClient instance.
        path: Collection path, e.g. ``/api/v1/projects``.
        page_size: Page size requested as ``limit`` (1..1000).
        query: Extra query params (e.g. ``{"as-of": ...}``).
    """
    if client.is_batching:
        raise RuntimeError(
            f'Cannot auto-paginate {path} inside a batch: list methods follow '
            'cursors across multiple requests, which a batch cannot do. Use '
            'list_page() for a single page inside a batch, or call the list '
            'method outside the batch.'
        )
    cursor = None
    while True:
        page = list_page(client, path, limit=page_size, cursor=cursor, query=query)
        entries = page.get('entries', []) or []
        # Suppress the trailing empty page that the server emits when a
        # collection's size is an exact multiple of the page size (a final full
        # page with a non-null cursor, then an empty page). Still follow the
        # cursor below.
        if entries:
            yield entries
        prev_cursor = cursor
        cursor = page.get('next_cursor')
        if cursor is None:
            break
        # Guard against a buggy server/proxy that returns a constant non-null
        # cursor, which would otherwise loop forever.
        if cursor == prev_cursor:
            raise RuntimeError(
                'Pagination cursor did not advance; aborting to avoid an '
                'infinite loop.'
            )


def list_all(client, path, *, page_size=1000, query=None):
    """Fetch the full flat list from a paginated collection endpoint.

    Transparently follows ``next_cursor`` until exhausted and concatenates
    every page's ``entries``. An empty first page yields ``[]``. This is the
    backward-compatible shape the old ``.list()`` methods returned before the
    server moved to a paginated envelope.

    NOTE: This auto-paginates and therefore CANNOT be used inside a batch — each
    page's request needs the previous page's ``next_cursor``, which doesn't
    exist until the batch executes. It raises ``RuntimeError`` immediately when
    the client is in batch mode. Use ``list_page`` for a single page inside a
    batch.

    Args:
        client: PlaidClient instance.
        path: Collection path, e.g. ``/api/v1/projects``.
        page_size: Page size requested as ``limit`` (1..1000).
        query: Extra query params (e.g. ``{"as-of": ...}``).
    """
    if client.is_batching:
        raise RuntimeError(
            f'Cannot auto-paginate {path} inside a batch: list methods follow '
            'cursors across multiple requests, which a batch cannot do. Use '
            'list_page() for a single page inside a batch, or call the list '
            'method outside the batch.'
        )
    results = []
    cursor = None
    prev_cursor = None
    while True:
        page = list_page(client, path, limit=page_size, cursor=cursor, query=query)
        # Compatibility shim: a non-paginated server (or proxy) may return a
        # bare list. Treat it as a terminal full result with no further paging.
        if isinstance(page, list):
            results.extend(page)
            break
        if isinstance(page, dict) and 'entries' in page:
            results.extend(page.get('entries') or [])
        else:
            raise ValueError(
                "Unexpected list response shape (no 'entries'); server may be "
                "incompatible."
            )
        prev_cursor = cursor
        cursor = page.get('next_cursor')
        if cursor is None:
            break
        # Guard against a buggy server/proxy that returns a constant non-null
        # cursor, which would otherwise loop forever.
        if cursor == prev_cursor:
            raise RuntimeError(
                'Pagination cursor did not advance; aborting to avoid an '
                'infinite loop.'
            )
    return results


def make_request(client, method, path, *, body=None, raw_body=None, form_data=False,
                 query_params=None, no_batch=False, skip_response_transform=False,
                 no_auth=False, binary_response=False):
    """Generic request method handling all HTTP logic.

    Args:
        client: PlaidClient instance.
        method: HTTP method.
        path: Request path appended to the client base URL.
        body: Object body, run through transform_request.
        raw_body: Body value passed directly (no transform). Mutually
            exclusive with body.
        form_data: If True, body is multipart form data; skip Content-Type
            header.
        query_params: Dict of query param key/values to append.
        no_batch: If True, raise when in batch mode.
        skip_response_transform: Return raw parsed JSON (no transform_response).
        no_auth: Skip Authorization header.
        binary_response: Return raw bytes instead of JSON/text.
    """
    url = f'{client.base_url}{path}'

    # Append query params
    if query_params:
        filtered = {}
        for k, v in query_params.items():
            if v is None:
                continue
            # Booleans must be lowercase for the server's malli coercion
            if isinstance(v, bool):
                filtered[k] = 'true' if v else 'false'
            else:
                filtered[k] = v
        if filtered:
            url += '?' + urlencode(filtered)

    # Prepare request body
    request_body = None
    if form_data:
        request_body = body
    elif raw_body is not None:
        request_body = raw_body
    elif body is not None:
        request_body = transform_request(body)

    # Strict mode: append document-version for non-GET requests
    if client.strict_mode_document_id and method != 'GET':
        doc_id = client.strict_mode_document_id
        doc_version = client.document_versions.get(doc_id)
        if doc_version:
            separator = '&' if '?' in url else '?'
            url += f'{separator}document-version={quote(str(doc_version), safe="")}'

    # Batch mode
    if client.is_batching:
        if no_batch:
            raise PlaidAPIError(f'This endpoint cannot be used in batch mode: {path}')
        operation = {
            'path': url.replace(client.base_url, ''),
            'method': method.upper(),
        }
        if request_body is not None:
            operation['body'] = request_body
        client.batch_operations.append(operation)
        return {'batched': True}

    # Build request kwargs
    headers = {}
    if not no_auth:
        headers['Authorization'] = f'Bearer {client.token}'
    if not form_data:
        headers['Content-Type'] = 'application/json'

    kwargs = {'method': method, 'url': url, 'headers': headers}

    if request_body is not None:
        if form_data:
            # request_body is a dict of {field: file_tuple} for multipart
            kwargs.pop('headers', None)
            kwargs['headers'] = {k: v for k, v in headers.items() if k != 'Content-Type'}
            kwargs['files'] = request_body
        else:
            kwargs['data'] = json.dumps(request_body)

    try:
        response = client.session.request(**kwargs)
    except Exception as e:
        raise PlaidAPIError(f'Network error: {e} at {url}', url=url, method=method,
                            original_error=e)

    if not response.ok:
        try:
            error_data = response.json()
        except Exception:
            try:
                error_data = {'message': response.text}
            except Exception:
                error_data = {'message': 'Unable to read error response'}
        server_message = (error_data.get('error') or error_data.get('message')
                          or response.reason or 'Unknown error')
        raise PlaidAPIError(
            f'HTTP {response.status_code} {server_message} at {url}',
            status=response.status_code, url=url, method=method,
            response_data=error_data, status_text=response.reason or '',
        )

    # Binary response
    if binary_response:
        extract_document_versions(client, response.headers)
        return response.content

    # JSON or text response
    content_type = response.headers.get('content-type', '')
    if 'application/json' in content_type:
        data = response.json()
        extract_document_versions(client, response.headers, data)
        if skip_response_transform:
            return data
        return transform_response(data)
    else:
        extract_document_versions(client, response.headers)
        return response.text
