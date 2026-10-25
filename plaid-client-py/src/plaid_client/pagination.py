"""Cursor-pagination helpers for collection endpoints, the twin of
plaid-client-js's pagination.js.

The server's collection endpoints answer with a paginated envelope
``{"entries": [...], "next-cursor": "<opaque-string>" | null}`` (recased to
``next_cursor``). These helpers paper over the cursoring so a caller can get
the full flat list, ask for one page, or iterate page by page. Each goes
through the request layer (``http.make_request``), so auth headers, the base
URL and the response transform apply as for any other request.
"""

from plaid_client import http


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
    the client (see the three classes at the top of http.py).

    Args:
        client: PlaidClient instance.
        path: Collection path, e.g. ``/api/v1/projects``.
        limit: Page size (1..1000). ``None`` lets the server use its default.
        cursor: Opaque cursor from a previous page's ``next_cursor``.
        query: Extra query params (e.g. ``{"as-of": ...}``).
    """
    qp = _merge_query(query, limit=limit, cursor=cursor)
    return http.make_request(client, 'GET', path, query_params=qp or None)


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
    every page's ``entries``. An empty first page yields ``[]``.

    Every page is a read, so this works while a batch is open on the client:
    each page goes over the wire, in order, against the state the batch has not
    committed yet.

    Args:
        client: PlaidClient instance.
        path: Collection path, e.g. ``/api/v1/projects``.
        page_size: Page size requested as ``limit`` (1..1000).
        query: Extra query params (e.g. ``{"as-of": ...}``).
    """
    return [entry for page in iter_pages(client, path, page_size=page_size, query=query)
            for entry in page]
