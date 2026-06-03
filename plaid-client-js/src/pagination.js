/**
 * Cursor-pagination helpers for collection endpoints.
 *
 * The server's collection endpoints return a paginated envelope shaped like
 * `{ entries: [...], nextCursor: "<opaque-string>" | null }` (the wire key
 * `next-cursor` is camelCased to `nextCursor` by transformResponse). These
 * helpers paper over the cursoring so callers can either get the full flat
 * array transparently, request a single page, or iterate page-by-page.
 *
 * Each helper threads the client through to `client._request`, so auth
 * headers, base URL, and response transforms all apply exactly as for any
 * other request.
 */

// Merge caller query params with paging params, dropping undefined/null so we
// don't emit empty query string values.
function buildQueryParams(query, limit, cursor) {
  const params = { ...query };
  if (limit !== undefined && limit !== null) params.limit = limit;
  if (cursor !== undefined && cursor !== null) params.cursor = cursor;
  return params;
}

/**
 * Fetch every page and return the full flat array of entries, transparently
 * following `nextCursor` until it is null. This is what `.list()` calls so it
 * stays backward compatible with the pre-pagination (bare-array) contract.
 *
 * NOTE: This auto-paginates and therefore CANNOT be used inside a batch — each
 * page's request needs the previous page's `nextCursor`, which doesn't exist
 * until the batch executes. It throws immediately when `client.isBatching` is
 * true. Use `listPage` for a single page inside a batch.
 *
 * @param {object} client - PlaidClient instance
 * @param {string} path - API path, e.g. '/api/v1/projects'
 * @param {object} [opts]
 * @param {number} [opts.pageSize=1000] - Per-request page size (limit)
 * @param {object} [opts.query={}] - Extra query params (e.g. { 'as-of': asOf })
 * @returns {Promise<Array>} The concatenated entries across all pages
 */
export async function listAll(client, path, { pageSize = 1000, query = {} } = {}) {
  if (client.isBatching) {
    throw new Error(
      `Cannot auto-paginate ${path} inside a batch: list methods follow cursors across multiple requests, which a batch cannot do. Use listPage() for a single page inside a batch, or call list() outside the batch.`,
    );
  }
  const all = [];
  let cursor = null;
  let prevCursor;
  do {
    const response = await client._request('GET', path, {
      queryParams: buildQueryParams(query, pageSize, cursor),
    });
    // Compatibility shim: a non-paginated server (or proxy) may return a bare
    // array. Treat it as a terminal full result with no further paging.
    if (Array.isArray(response)) {
      all.push(...response);
      break;
    }
    if (response && Array.isArray(response.entries)) {
      all.push(...response.entries);
    } else {
      throw new Error(
        "Unexpected list response shape (no 'entries'); server may be incompatible.",
      );
    }
    prevCursor = cursor;
    cursor = response.nextCursor;
    // Guard against a buggy server/proxy that returns a constant non-null
    // cursor, which would otherwise loop forever.
    if (cursor !== null && cursor !== undefined && cursor === prevCursor) {
      throw new Error(
        'Pagination cursor did not advance; aborting to avoid an infinite loop.',
      );
    }
  } while (cursor !== null && cursor !== undefined);
  return all;
}

/**
 * Fetch a single page and return the raw envelope.
 *
 * @param {object} client - PlaidClient instance
 * @param {string} path - API path
 * @param {object} [opts]
 * @param {number} [opts.limit] - Page size (1..1000; server default 100)
 * @param {string} [opts.cursor] - Opaque cursor from a previous page
 * @param {object} [opts.query={}] - Extra query params
 * @returns {Promise<{entries: Array, nextCursor: (string|null)}>}
 */
export async function listPage(client, path, { limit, cursor, query = {} } = {}) {
  return client._request('GET', path, {
    queryParams: buildQueryParams(query, limit, cursor),
  });
}

/**
 * Async generator yielding each page's entries array in turn, following
 * `nextCursor` until it is null.
 *
 * NOTE: This auto-paginates and therefore CANNOT be used inside a batch — each
 * page's request needs the previous page's `nextCursor`, which doesn't exist
 * until the batch executes. It throws on first iteration when
 * `client.isBatching` is true. Use `listPage` for a single page inside a batch.
 *
 * @param {object} client - PlaidClient instance
 * @param {string} path - API path
 * @param {object} [opts]
 * @param {number} [opts.pageSize=1000] - Per-request page size (limit)
 * @param {object} [opts.query={}] - Extra query params
 * @yields {Array} The entries array for each page
 */
export async function* iterPages(client, path, { pageSize = 1000, query = {} } = {}) {
  if (client.isBatching) {
    throw new Error(
      `Cannot auto-paginate ${path} inside a batch: list methods follow cursors across multiple requests, which a batch cannot do. Use listPage() for a single page inside a batch, or call list() outside the batch.`,
    );
  }
  let cursor = null;
  let prevCursor;
  do {
    const response = await client._request('GET', path, {
      queryParams: buildQueryParams(query, pageSize, cursor),
    });
    const entries = (response && Array.isArray(response.entries)) ? response.entries : [];
    // Suppress the trailing empty page that the server emits when a collection's
    // size is an exact multiple of the page size (a final full page with a
    // non-null cursor, then an empty page). Still follow the cursor below.
    if (entries.length > 0) {
      yield entries;
    }
    prevCursor = cursor;
    cursor = response ? response.nextCursor : null;
    // Guard against a buggy server/proxy that returns a constant non-null
    // cursor, which would otherwise loop forever.
    if (cursor !== null && cursor !== undefined && cursor === prevCursor) {
      throw new Error(
        'Pagination cursor did not advance; aborting to avoid an infinite loop.',
      );
    }
  } while (cursor !== null && cursor !== undefined);
}
