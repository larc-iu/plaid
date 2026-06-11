import { transformRequest, transformResponse } from './transforms.js';

// Default per-request timeout (ms). Applied to every request unless the client
// is constructed with a different `timeout` (0 / null disables it). Note: this
// also bounds media up/downloads — bump it (or disable) for very large files.
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Extract and update document versions from response headers and body.
 */
export function extractDocumentVersions(client, responseHeaders, responseBody = null) {
  const docVersionsHeader = responseHeaders.get('X-Document-Versions');
  if (docVersionsHeader) {
    try {
      const versionsMap = JSON.parse(docVersionsHeader);
      if (typeof versionsMap === 'object' && versionsMap !== null) {
        // Clone once, then assign — cloning inside the loop is O(n²) and pointless.
        client.documentVersions = { ...client.documentVersions, ...versionsMap };
      }
    } catch (e) {
      console.warn('Failed to parse document versions header:', e);
    }
  }

  if (responseBody && typeof responseBody === 'object') {
    if (responseBody['document/id'] && responseBody['document/version']) {
      client.documentVersions = { ...client.documentVersions };
      client.documentVersions[responseBody['document/id']] = responseBody['document/version'];
    }
  }
}

/**
 * Read a failed response's body as parsed JSON, falling back to text.
 */
export async function parseErrorBody(response) {
  try {
    return await response.json();
  } catch (_) {
    return { message: await response.text().catch(() => 'Unable to read error response') };
  }
}

/**
 * Create an enriched error from a failed HTTP response.
 */
export function makeHttpError(response, errorData, url, method) {
  const serverMessage = errorData?.error || errorData?.message || response.statusText || 'Unknown error';
  const error = new Error(`HTTP ${response.status} ${serverMessage} at ${url}`);
  error.status = response.status;
  error.statusText = response.statusText;
  error.url = url;
  error.method = method;
  error.responseData = errorData;
  return error;
}

/**
 * Create a network error (status 0). Timeout aborts get a clearer message.
 */
export function makeNetworkError(originalError, url, method) {
  const timedOut = originalError?.name === 'TimeoutError' || originalError?.name === 'AbortError';
  const message = timedOut
    ? `Request timed out at ${url}`
    : `Network error: ${originalError.message} at ${url}`;
  const error = new Error(message);
  error.status = 0;
  error.url = url;
  error.method = method;
  error.originalError = originalError;
  return error;
}

/**
 * Build a fetch AbortSignal that fires after `timeout` ms, or undefined when
 * timeouts are disabled / unsupported.
 */
export function timeoutSignal(timeout) {
  if (timeout && timeout > 0 && typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
    return AbortSignal.timeout(timeout);
  }
  return undefined;
}

/**
 * Generic request method handling all fetch logic.
 *
 * Options:
 *   body            - Object body, run through transformRequest
 *   rawBody         - Body value passed directly (no transform). Mutually exclusive with body.
 *   formData        - If true, body is FormData; skip Content-Type header
 *   queryParams     - Object of query param key/values to append
 *   noBatch         - If true, throw when in batch mode
 *   skipResponseTransform - Return raw parsed JSON (no transformResponse)
 *   noAuth          - Skip Authorization header
 *   binaryResponse  - Return arrayBuffer instead of JSON/text
 */
export async function makeRequest(client, method, path, options = {}) {
  const {
    body,
    rawBody,
    formData,
    queryParams,
    noBatch,
    skipResponseTransform,
    noAuth,
    binaryResponse,
  } = options;

  // Build URL
  let url = `${client.baseUrl}${path}`;

  // Append query params
  if (queryParams) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined && value !== null) {
        // URLSearchParams stringifies booleans to lowercase 'true'/'false',
        // which the server's malli coercion requires (the Python client does
        // this conversion explicitly).
        params.append(key, value);
      }
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  // Prepare request body
  let requestBody;
  if (formData) {
    requestBody = body; // FormData passed directly
  } else if (rawBody !== undefined) {
    requestBody = rawBody;
  } else if (body !== undefined) {
    requestBody = transformRequest(body);
  }

  // Strict mode: append document-version for non-GET requests.
  // Inside a batch, stamp ONLY the first write: batches run atomically
  // server-side, so a version check on the first op gives whole-batch OCC
  // semantics, while stamping every op would 409 the second op against the
  // version bump the first op itself caused (every queued op captures the
  // same pre-batch version).
  if (client.strictModeDocumentId && method !== 'GET'
      && !(client.isBatching && client.batchVersionStamped)) {
    const docId = client.strictModeDocumentId;
    if (client.documentVersions[docId]) {
      const docVersion = client.documentVersions[docId];
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      if (client.isBatching) client.batchVersionStamped = true;
    }
  }

  // Batch mode
  if (client.isBatching) {
    if (noBatch) {
      throw new Error(`This endpoint cannot be used in batch mode: ${path}`);
    }
    const operation = {
      path: url.replace(client.baseUrl, ''),
      method: method.toUpperCase(),
    };
    if (requestBody !== undefined) {
      operation.body = requestBody;
    }
    client.batchOperations.push(operation);
    return { batched: true };
  }

  // Build fetch options
  const headers = {};
  if (!noAuth) {
    headers['Authorization'] = `Bearer ${client.token}`;
  }
  if (!formData) {
    headers['Content-Type'] = 'application/json';
  }

  const fetchOptions = { method, headers };
  if (requestBody !== undefined) {
    fetchOptions.body = formData ? requestBody : JSON.stringify(requestBody);
  }
  const signal = timeoutSignal(client.timeout);
  if (signal) fetchOptions.signal = signal;

  try {
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw makeHttpError(response, await parseErrorBody(response), url, method);
    }

    // Binary response (getMedia)
    if (binaryResponse) {
      extractDocumentVersions(client, response.headers);
      return await response.arrayBuffer();
    }

    // JSON or text response
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      extractDocumentVersions(client, response.headers, data);
      if (skipResponseTransform) {
        return data;
      }
      return transformResponse(data);
    } else {
      extractDocumentVersions(client, response.headers);
      return await response.text();
    }
  } catch (error) {
    if (error.status !== undefined) {
      throw error;
    }
    throw makeNetworkError(error, url, method);
  }
}
