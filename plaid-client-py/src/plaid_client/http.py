import itertools
import json
import logging
import random
import time
from urllib.parse import urlencode, quote

from plaid_client.transforms import transform_request, transform_response

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Batches: which calls a batch carries, and which go over the wire anyway.
#
# A batch is an OBJECT (``client.batch()``, or what ``with client.batched()``
# yields), a view of the client with the same resources. A write made on the
# batch queues; a call made on the client itself always goes over the wire,
# whatever batches happen to be open. So an editor, an importer and a keep-alive
# can share one client, and a write by code that knows nothing about a batch
# can never land inside it. Every call reaching this layer is one of three
# things, and the third column is what a new endpoint has to pick.
#
# 1. A WRITE of project data: an entity, its metadata, a layer, a membership,
#    a comment. This is what a batch is for, so on a batch it QUEUES. It is
#    the default and needs no flag.
#
# 2. A READ. Every GET is answered from the wire even when made on a batch:
#    the caller gets data rather than ``{'batched': True}``, it takes no slot
#    in the batch's results, and server-side it runs against the pool rather
#    than the batch's transaction connection. A read that travels as a POST
#    (``query``) says so with ``out_of_band``.
#
# 3. An OUT-OF-BAND SIGNAL: stopping a service request, reporting a service's
#    progress or result, taking or dropping a document lock, forgetting a
#    service, an admin action on the server itself. It is shaped like a write
#    but carries no project data, and its whole value is that it happens NOW.
#    Pass ``out_of_band``: made on a batch it still goes over the wire, and it
#    never joins an open logical operation. The audit group is a label for the
#    writes, and a signal that is never audited would mark the group written
#    and leave the relabel PATCH 404ing on a group nothing ever created.
#
# Strict mode stamps the batch's one expected document-version onto the first
# write queued on it (whole-batch OCC: stamping every op would 409 the second
# against the bump the first caused). A call that went over the wire on its
# own carries its own stamp and spends nothing of any batch's.
#
# ``no_batch`` is not part of that judgment. It marks the five calls the batch
# transport cannot carry at all (the multipart media and
# avatar uploads, the user-data store's put and delete) and raises so the caller
# finds out. Never put it on a read: it turns a swallowed read into a thrown
# one, which is what the chrome hit when an unrelated import was running. A
# blobless DELETE beside an upload is not one of them: it carries nothing the
# transport cannot express, so it takes its class from the three above like
# anything else.
# ---------------------------------------------------------------------------

# Default per-request timeout (seconds). Applied to every request unless the
# client is constructed with a different ``timeout`` (None disables it). Note:
# this also bounds media up/downloads — raise it (or disable) for large files.
DEFAULT_TIMEOUT_S = 30.0

# Batch submissions get their own, longer budget. A batch runs as ONE server
# transaction holding the single SQLite write lock for its whole duration, and
# giving up on the HTTP request does not cancel it — so a short timeout buys
# nothing and costs a retry stacked on a write that is still running.
DEFAULT_BATCH_TIMEOUT_S = 180.0

# Retry budget for 503 "Database busy" responses. Plaid serializes writers on a
# single SQLite write lock; a writer that cannot get it within the server's
# busy_timeout is refused with 503. That refusal is definitive — the
# transaction never opened, or was rolled back whole — so repeating the request
# is safe, including for a batch (which is all-or-nothing by construction).
BUSY_RETRIES = 4
BUSY_BACKOFF_S = 0.25

# Sentinel distinguishing "no per-call timeout override" from an explicit
# ``timeout=None`` (which disables the timeout for that call).
_UNSET = object()


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


def retry_while_busy(attempt, retries=BUSY_RETRIES, base_delay=BUSY_BACKOFF_S):
    """Run ``attempt``, retrying while it raises a 503.

    Exponential backoff with full jitter, so two clients that collide do not
    march in lockstep and collide again on every retry. ``attempt`` must
    perform the whole request: a response body is consumed once.
    """
    for i in itertools.count():
        try:
            return attempt()
        except PlaidAPIError as e:
            if getattr(e, 'status', None) != 503 or i >= retries:
                raise
            time.sleep(base_delay * 2 ** i * (0.5 + random.random()))


def short_error(error):
    """One readable line for an operator.

    An HTTP failure names its status. A connection failure is unwrapped down to
    its root cause: ``requests`` reports one through urllib3's retry chain, so
    the raw string is three nested exceptions of noise around "Connection
    refused", which is the only part worth showing on a line whose job is to say
    "the server is not up yet".

    Unwrapping stops as soon as a layer says something its parent did not.
    Every wrapper in a connection chain quotes the cause it wraps, so a cause
    whose message is contained in its parent's is pure detail and worth
    descending into; one that is NOT (a chunked-stream drop bottoming out in
    ``invalid literal for int()``) is a different, less useful fact than the
    "Response ended prematurely" above it, so we keep the parent.
    """
    if error is None:
        return 'the server closed the stream'
    status = (getattr(error, 'status', 0)
              or getattr(getattr(error, 'response', None), 'status_code', None))
    if status:
        return f'HTTP {status}'
    root = error
    for _ in range(8):
        inner = (getattr(root, 'original_error', None)
                 or root.__cause__ or root.__context__)
        if inner is None or inner is root or not str(inner):
            break
        if str(inner) not in str(root):
            break
        root = inner
    return f'{type(root).__name__}: {root}'


def parse_error_body(response):
    """Read a failed response's body as parsed JSON, falling back to text."""
    try:
        return response.json()
    except Exception:
        try:
            return {'message': response.text}
        except Exception:
            return {'message': 'Unable to read error response'}


def build_api_error(response, url, method):
    """Build a PlaidAPIError from a failed HTTP response (shared by every code path)."""
    error_data = parse_error_body(response)
    server_message = (error_data.get('error') or error_data.get('message')
                      or response.reason or 'Unknown error')
    return PlaidAPIError(
        f'HTTP {response.status_code} {server_message} at {url}',
        status=response.status_code, url=url, method=method,
        response_data=error_data, status_text=response.reason or '',
    )


def extract_document_versions(client, response_headers, response_body=None, historical=False):
    """Extract and update document versions from response headers and body.

    ``historical`` marks a read made with ``as-of``: its body carries the
    version the document HAD then, which is not what a strict-mode write must
    claim next, so the body is ignored and only the header (always the live
    version) is learned from.
    """
    header = response_headers.get('X-Document-Versions')
    if header:
        try:
            versions_map = json.loads(header)
            if isinstance(versions_map, dict):
                client.document_versions.update(versions_map)
        except (json.JSONDecodeError, TypeError):
            logger.warning('Failed to parse document versions header')

    if not historical and isinstance(response_body, dict):
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


def _entries_of(page, path):
    """The page's ``entries``, or a ValueError naming the endpoint.

    Every collection endpoint answers with the envelope. A bare list or any
    other shape is a broken endpoint, so name it and stop rather than return a
    silently truncated result.
    """
    if not isinstance(page, dict) or not isinstance(page.get('entries'), list):
        raise ValueError(
            f"GET {path} did not return a paginated envelope (no 'entries' list)"
        )
    return page['entries']


def list_page(client, path, *, limit=None, cursor=None, query=None):
    """Fetch a single page from a paginated collection endpoint.

    Returns the transformed envelope dict ``{"entries": [...],
    "next_cursor": <opaque-string-or-None>}`` exactly as the server returns it
    (after the client's response transform, which snake_cases ``next-cursor``
    to ``next_cursor``).

    A page is a read, so it goes over the wire even while a batch is open on
    the client (see the three classes at the top of this file).

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

    Every page is a read, so this works while a batch is open on the client:
    each page goes over the wire, in order, against the state the batch has not
    committed yet.

    Args:
        client: PlaidClient instance.
        path: Collection path, e.g. ``/api/v1/projects``.
        page_size: Page size requested as ``limit`` (1..1000).
        query: Extra query params (e.g. ``{"as-of": ...}``).
    """
    cursor = None
    while True:
        page = list_page(client, path, limit=page_size, cursor=cursor, query=query)
        entries = _entries_of(page, path)
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

    Every page is a read, so this works while a batch is open on the client:
    each page goes over the wire, in order, against the state the batch has not
    committed yet.

    Args:
        client: PlaidClient instance.
        path: Collection path, e.g. ``/api/v1/projects``.
        page_size: Page size requested as ``limit`` (1..1000).
        query: Extra query params (e.g. ``{"as-of": ...}``).
    """
    results = []
    cursor = None
    prev_cursor = None
    while True:
        page = list_page(client, path, limit=page_size, cursor=cursor, query=query)
        results.extend(_entries_of(page, path))
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


class _ProgressBody:
    """An encoded request body that reports how much of it has been read.

    ``http.client`` sends a file-like body by reading it in blocks, so what
    has been read is what has gone up the socket, give or take one block. Has
    a length so ``requests`` sends a Content-Length rather than chunking.
    """

    def __init__(self, data, callback):
        self._data = data
        self._pos = 0
        self._callback = callback

    def __len__(self):
        return len(self._data)

    def read(self, size=-1):
        if size is None or size < 0:
            size = len(self._data) - self._pos
        chunk = self._data[self._pos:self._pos + size]
        self._pos += len(chunk)
        if chunk:
            self._callback({'loaded': self._pos, 'total': len(self._data)})
        return chunk


def prepare_request(client, method, path, *, body=None, raw_body=None, form_data=False,
                    query_params=None, out_of_band=False, audit_message=None, batch=None):
    """Everything a request is before it goes anywhere: the URL with its query
    params and the stamps strict mode, a per-call audit message and an open
    logical operation add, plus the transformed body. Shared by the wire path
    (``make_request``) and the batch path (``queue_request``), so a queued op
    is exactly the request that would have gone out. ``batch`` is the batch the
    call is being queued on, if any: strict mode stamps its document-version
    onto the first write queued there and no other.

    Returns ``(url, request_body)``.
    """
    url = f'{client.base_url}{path}'

    # A write must not go out on a lock that lapsed. ``documents.locked()``
    # records the loss here when its keep-alive cannot renew, and from that
    # moment the block is holding nothing. Reads pass, and so do the lock
    # routes themselves, which is how the block still releases on its way out.
    lock_lost = getattr(client, 'document_lock_lost', None)
    if lock_lost is not None and method != 'GET' and not path.endswith('/lock'):
        raise lock_lost

    if query_params:
        filtered = {}
        for k, v in query_params.items():
            if v is None:
                continue
            if isinstance(v, bool):
                filtered[k] = 'true' if v else 'false'
            else:
                filtered[k] = v
        if filtered:
            url += '?' + urlencode(filtered)

    request_body = None
    if form_data:
        request_body = body
    elif raw_body is not None:
        request_body = raw_body
    elif body is not None:
        request_body = transform_request(body)

    # Strict mode: stamp the expected document-version on a write, on EVERY
    # queued write of a batch. The server validates the first write it can
    # (one whose route resolves a document) and skips the rest of that
    # document's, so the version bump a sub-op causes does not 409 the next
    # one. Stamping only the first write was silently no check at all
    # whenever that write was one the route ignores, such as a vocabulary
    # entry's metadata.
    if client.strict_mode_document_id and method != 'GET':
        doc_id = client.strict_mode_document_id
        doc_version = client.document_versions.get(doc_id)
        if doc_version:
            separator = '&' if '?' in url else '?'
            url += f'{separator}document-version={quote(str(doc_version), safe="")}'

    # Per-call custom audit-log message. Unlike document-version this has no
    # OCC self-conflict, so it is stamped on every queued op, not just the
    # first.
    if audit_message and method != 'GET':
        separator = '&' if '?' in url else '?'
        url += f'{separator}audit-message={quote(str(audit_message), safe="")}'

    # Logical-operation group (see client.begin_operation): stamp every write
    # with the group id; the message rides along so the server can label the
    # group lazily on whichever tagged write lands first. An out-of-band
    # signal is not one of those writes (see the note at the top of this
    # file): never audited, so a stamp does nothing server-side while
    # ``written`` promises a group that will never exist.
    group = getattr(client, '_operation_group', None)
    if group is not None and method != 'GET' and not out_of_band:
        separator = '&' if '?' in url else '?'
        url += f'{separator}group-id={quote(group["id"], safe="")}'
        if group.get('message'):
            url += f'&group-message={quote(str(group["message"]), safe="")}'
        group['written'] = True

    return url, request_body


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
            if k in ('body', 'raw_body', 'form_data', 'query_params', 'audit_message')}
    url, request_body = prepare_request(batch.client, method, path, batch=batch, **prep)
    operation = {
        'path': url.replace(batch.client.base_url, ''),
        'method': method.upper(),
    }
    if request_body is not None:
        operation['body'] = request_body
    batch.operations.append(operation)
    return {'batched': True}


def make_request(client, method, path, *, body=None, raw_body=None, form_data=False,
                 query_params=None, no_batch=False, out_of_band=False,
                 skip_response_transform=False,
                 no_auth=False, binary_response=False, audit_message=None,
                 timeout=_UNSET, on_upload_progress=None):
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
        no_batch: If True, raise when made on a batch. Only for calls the
            batch transport cannot carry at all (see the note at the top of
            this file); never for a read. Nothing here: a call that reached
            this function is going over the wire.
        out_of_band: If True, the call is a signal rather than a write of
            project data: made on a batch it still goes over the wire, and it
            never joins an open logical operation (see the note at the top of
            this file).
        skip_response_transform: Return raw parsed JSON (no transform_response).
        no_auth: Skip Authorization header.
        binary_response: Return raw bytes instead of JSON/text.
        on_upload_progress: For a multipart upload, called with
            ``{'loaded': bytes_sent, 'total': body_bytes}`` as the body goes
            up (the JS client's ``on_upload_progress``). The body is then
            encoded up front and streamed from memory, which is what
            ``requests`` does for ``files=`` anyway.
    """
    url, request_body = prepare_request(
        client, method, path, body=body, raw_body=raw_body, form_data=form_data,
        query_params=query_params, out_of_band=out_of_band, audit_message=audit_message)

    headers = {}
    if not no_auth:
        headers['Authorization'] = f'Bearer {client.token}'
    if not form_data:
        headers['Content-Type'] = 'application/json'

    kwargs = {'method': method, 'url': url, 'headers': headers,
              'timeout': (timeout if timeout is not _UNSET
                          else getattr(client, 'timeout', DEFAULT_TIMEOUT_S))}

    encoded_upload = None
    if request_body is not None:
        if form_data:
            # request_body is a dict of {field: file_tuple} for multipart
            kwargs.pop('headers', None)
            kwargs['headers'] = {k: v for k, v in headers.items() if k != 'Content-Type'}
            if on_upload_progress is not None:
                # requests' own encoder for ``files=``, so the body is byte
                # for byte what the plain path would have sent; only the
                # transport differs (a file-like body read in blocks).
                from requests.models import RequestEncodingMixin
                encoded_upload, content_type = RequestEncodingMixin._encode_files(
                    request_body, None)
                kwargs['headers']['Content-Type'] = content_type
            else:
                kwargs['files'] = request_body
        else:
            kwargs['data'] = json.dumps(request_body)

    def attempt():
        if encoded_upload is not None:
            # A fresh body per attempt: a retried upload must start over.
            kwargs['data'] = _ProgressBody(encoded_upload, on_upload_progress)
        try:
            resp = client.session.request(**kwargs)
        except Exception as e:
            if type(e).__name__ in ('Timeout', 'ConnectTimeout', 'ReadTimeout'):
                raise PlaidAPIError(f'Request timed out at {url}', url=url, method=method,
                                    original_error=e)
            raise PlaidAPIError(f'Network error: {e} at {url}', url=url, method=method,
                                original_error=e)
        # Raise a 503 from inside so retry_while_busy can see it; every other
        # failure is raised here too and simply propagates.
        if not resp.ok:
            raise build_api_error(resp, url, method)
        return resp

    response = retry_while_busy(attempt)

    # Binary response
    if binary_response:
        extract_document_versions(client, response.headers)
        return response.content

    # JSON or text response
    content_type = response.headers.get('content-type', '')
    if 'application/json' in content_type:
        data = response.json()
        extract_document_versions(client, response.headers, data,
                                  historical=bool(query_params and query_params.get('as-of')))
        if skip_response_transform:
            return data
        return transform_response(data)
    else:
        extract_document_versions(client, response.headers)
        return response.text
