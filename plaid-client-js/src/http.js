import { transformRequest, transformResponse } from './transforms.js';

// Default per-request timeout (ms). Applied to every request unless the client
// is constructed with a different `timeout` (0 / null disables it). Note: this
// also bounds media up/downloads — bump it (or disable) for very large files.
export const DEFAULT_TIMEOUT_MS = 30000;

// Batch submissions get their own, longer budget. A batch runs as ONE server
// transaction holding the single SQLite write lock for its whole duration, and
// aborting the HTTP request does not cancel it — so a short timeout buys
// nothing and costs a retry stacked on a write that is still running.
export const DEFAULT_BATCH_TIMEOUT_MS = 180000;

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

// Retry budget for 503 "Database busy" responses. Plaid serializes writers on
// a single SQLite write lock; a writer that can't get it within the server's
// busy_timeout is refused with 503. That refusal is definitive — the
// transaction never opened, or was rolled back whole — so repeating the
// request is safe, including for a batch (which is all-or-nothing by
// construction). Retrying here is what lets a long import ride out someone
// else's slow write instead of dying partway through.
export const BUSY_RETRIES = 4;
export const BUSY_BACKOFF_MS = 250;

/**
 * Run `attempt`, retrying while it rejects with a 503. Exponential backoff
 * with full jitter, so two clients that collide don't march in lockstep and
 * collide again on every retry.
 *
 * `attempt` must perform the whole request, not just await a prepared one:
 * a fetch body and an AbortSignal.timeout are both single-use.
 */
export async function retryWhileBusy(attempt, {
  retries = BUSY_RETRIES,
  baseDelayMs = BUSY_BACKOFF_MS,
  onRetry,
} = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (error?.status !== 503 || i >= retries) throw error;
      const delay = Math.round(baseDelayMs * 2 ** i * (0.5 + Math.random()));
      onRetry?.({ attempt: i + 1, retries, delay, error });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
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
 *   timeout         - Per-request timeout in ms overriding client.timeout
 *                     for this call (0/null disables). Used for known-long
 *                     ops like project delete.
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
    auditMessage,
    timeout,
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

  // Per-call custom audit-log message (overrides the auto-generated
  // description of THIS write). Unlike document-version this has no OCC
  // self-conflict, so it is stamped on every queued batch op, not just the
  // first. The server templates `{param}` placeholders against the endpoint's
  // own path/query/body params.
  if (auditMessage && method !== 'GET') {
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}audit-message=${encodeURIComponent(auditMessage)}`;
  }

  // Logical-operation group (see client.beginOperation): stamp every write
  // with the group id; the message rides along too so the server can label
  // the group lazily on whichever tagged write lands first.
  if (client.operationGroup && method !== 'GET') {
    const group = client.operationGroup;
    const separator = url.includes('?') ? '&' : '?';
    url += `${separator}group-id=${encodeURIComponent(group.id)}`;
    if (group.message) url += `&group-message=${encodeURIComponent(group.message)}`;
    group.written = true;
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

  // A fresh AbortSignal.timeout per attempt: the signal fires once and stays
  // aborted, so reusing it would make every retry fail instantly.
  const attemptOptions = () => {
    const signal = timeoutSignal(timeout !== undefined ? timeout : client.timeout);
    return signal ? { ...fetchOptions, signal } : fetchOptions;
  };

  try {
    const response = await retryWhileBusy(async () => {
      const res = await fetch(url, attemptOptions());
      // Surface a 503 as a throw so retryWhileBusy can see it; other failures
      // are re-thrown from here and handled by the caller below.
      if (res.status === 503) {
        throw makeHttpError(res, await parseErrorBody(res), url, method);
      }
      return res;
    });

    if (!response.ok) {
      const error = makeHttpError(response, await parseErrorBody(response), url, method);
      // 401 means the token is missing/expired/invalid. Fire the app's auth-error
      // handler once (it discards the token and routes back to login). 403
      // (forbidden — authenticated but not permitted) deliberately does NOT.
      if (response.status === 401 && typeof client.onAuthError === 'function' && !client._authErrorFired) {
        client._authErrorFired = true;
        try { client.onAuthError(error); } catch (_) { /* handler must not mask the original error */ }
      }
      throw error;
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
