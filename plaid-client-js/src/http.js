import { transformRequest, transformResponse } from "./transforms.js";

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
 *
 * `historical` marks a read made with `as-of`: its body carries the version
 * the document HAD then, which is not what a strict-mode write must claim
 * next, so the body is ignored and only the header (always the live
 * version) is learned from. Without this, viewing an old state and then
 * writing 409s on a version that stopped being current long ago.
 */
export function extractDocumentVersions(
  client,
  responseHeaders,
  responseBody = null,
  { historical = false } = {},
) {
  const docVersionsHeader = responseHeaders.get("X-Document-Versions");
  if (docVersionsHeader) {
    try {
      const versionsMap = JSON.parse(docVersionsHeader);
      if (typeof versionsMap === "object" && versionsMap !== null) {
        // Clone once, then assign — cloning inside the loop is O(n²) and pointless.
        client.documentVersions = {
          ...client.documentVersions,
          ...versionsMap,
        };
      }
    } catch (e) {
      console.warn("Failed to parse document versions header:", e);
    }
  }

  if (!historical && responseBody && typeof responseBody === "object") {
    if (responseBody["document/id"] && responseBody["document/version"]) {
      client.documentVersions = { ...client.documentVersions };
      client.documentVersions[responseBody["document/id"]] =
        responseBody["document/version"];
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
    return {
      message: await response
        .text()
        .catch(() => "Unable to read error response"),
    };
  }
}

/**
 * Create an enriched error from a failed HTTP response.
 */
export function makeHttpError(response, errorData, url, method) {
  const serverMessage =
    errorData?.error ||
    errorData?.message ||
    response.statusText ||
    "Unknown error";
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
  const timedOut =
    originalError?.name === "TimeoutError" ||
    originalError?.name === "AbortError";
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
export async function retryWhileBusy(
  attempt,
  { retries = BUSY_RETRIES, baseDelayMs = BUSY_BACKOFF_MS, onRetry } = {},
) {
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
  if (
    timeout &&
    timeout > 0 &&
    typeof AbortSignal !== "undefined" &&
    AbortSignal.timeout
  ) {
    return AbortSignal.timeout(timeout);
  }
  return undefined;
}

/**
 * Send a request through XMLHttpRequest so the caller can watch the bytes go
 * up: fetch cannot report upload progress. Resolves to a Response, so the rest
 * of the pipeline is the same either way. The timeout is a STALL timeout,
 * re-armed by every progress event, so a large file on a slow link is never
 * cut off while it is still moving, only once nothing has moved for `timeout`
 * ms. Rejects the way fetch does: a TypeError for a network failure, an error
 * named TimeoutError for a stall.
 */
export function xhrSend(
  url,
  { method, headers, body },
  { onUploadProgress, timeout } = {},
) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.responseType = "arraybuffer";
    for (const [name, value] of Object.entries(headers || {}))
      xhr.setRequestHeader(name, value);

    let timer = null;
    const disarm = () => clearTimeout(timer);
    const arm = () => {
      if (!timeout || timeout <= 0) return;
      disarm();
      timer = setTimeout(() => {
        xhr.abort();
        reject(
          Object.assign(new Error(`Request timed out at ${url}`), {
            name: "TimeoutError",
          }),
        );
      }, timeout);
    };

    xhr.upload.onprogress = (e) => {
      arm();
      if (onUploadProgress) {
        onUploadProgress({
          loaded: e.loaded,
          total: e.lengthComputable ? e.total : null,
        });
      }
    };
    xhr.onprogress = arm;
    xhr.onload = () => {
      disarm();
      if (xhr.status === 0) {
        reject(new TypeError(`Failed to fetch ${url}`));
        return;
      }
      const responseHeaders = new Headers();
      for (const line of (xhr.getAllResponseHeaders() || "")
        .trim()
        .split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i > 0)
          responseHeaders.append(
            line.slice(0, i).trim(),
            line.slice(i + 1).trim(),
          );
      }
      // A Response refuses a body for these statuses.
      const responseBody = [204, 205, 304].includes(xhr.status)
        ? null
        : xhr.response;
      resolve(
        new Response(responseBody, {
          status: xhr.status,
          statusText: xhr.statusText,
          headers: responseHeaders,
        }),
      );
    };
    xhr.onerror = () => {
      disarm();
      reject(new TypeError(`Failed to fetch ${url}`));
    };
    xhr.onabort = () => {
      disarm();
      reject(
        Object.assign(new Error(`Request aborted at ${url}`), {
          name: "AbortError",
        }),
      );
    };

    arm();
    xhr.send(body);
  });
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
 *   bypassBatch     - If true, go over the wire even while a batch is open.
 *                     For READS only: a batch is a write transaction, its
 *                     ops return no value to their caller until submit, and
 *                     the sub-request runs against the tx Connection rather
 *                     than the pool. A read swallowed by an ambient batch is
 *                     therefore useless to the caller AND can fail the whole
 *                     batch (see `query`).
 *   skipResponseTransform - Return raw parsed JSON (no transformResponse)
 *   noAuth          - Skip Authorization header
 *   binaryResponse  - Return arrayBuffer instead of JSON/text
 *   timeout         - Per-request timeout in ms overriding client.timeout
 *                     for this call (0/null disables). Used for known-long
 *                     ops like project delete.
 *   onUploadProgress - Called with `{ loaded, total }` (bytes; total null when
 *                     unknown) as the request body goes up. In a browser the
 *                     request then travels by XMLHttpRequest (see xhrSend),
 *                     where the timeout only fires when the upload stalls;
 *                     elsewhere the callback is ignored and fetch is used.
 */
export async function makeRequest(client, method, path, options = {}) {
  const {
    body,
    rawBody,
    formData,
    queryParams,
    noBatch,
    bypassBatch,
    skipResponseTransform,
    noAuth,
    binaryResponse,
    auditMessage,
    timeout,
    onUploadProgress,
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
  if (
    client.strictModeDocumentId &&
    method !== "GET" &&
    !(client.isBatching && client.batchVersionStamped)
  ) {
    const docId = client.strictModeDocumentId;
    if (client.documentVersions[docId]) {
      const docVersion = client.documentVersions[docId];
      const separator = url.includes("?") ? "&" : "?";
      url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      if (client.isBatching) client.batchVersionStamped = true;
    }
  }

  // Per-call custom audit-log message (overrides the auto-generated
  // description of THIS write). Unlike document-version this has no OCC
  // self-conflict, so it is stamped on every queued batch op, not just the
  // first. The server templates `{param}` placeholders against the endpoint's
  // own path/query/body params.
  if (auditMessage && method !== "GET") {
    const separator = url.includes("?") ? "&" : "?";
    url += `${separator}audit-message=${encodeURIComponent(auditMessage)}`;
  }

  // Logical-operation group (see client.beginOperation): stamp every write
  // with the group id; the message rides along too so the server can label
  // the group lazily on whichever tagged write lands first.
  if (client.operationGroup && method !== "GET") {
    const group = client.operationGroup;
    const separator = url.includes("?") ? "&" : "?";
    url += `${separator}group-id=${encodeURIComponent(group.id)}`;
    if (group.message)
      url += `&group-message=${encodeURIComponent(group.message)}`;
    group.written = true;
  }

  // Batch mode. A `bypassBatch` read is deliberately NOT queued: it belongs to
  // whoever called it, not to whatever batch happens to be open on this shared
  // client (a document reconcile, an import), and it reads the pre-batch state
  // exactly as it would have if the batch were not running.
  if (client.isBatching && !bypassBatch) {
    if (noBatch) {
      throw new Error(`This endpoint cannot be used in batch mode: ${path}`);
    }
    const operation = {
      path: url.replace(client.baseUrl, ""),
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
    headers["Authorization"] = `Bearer ${client.token}`;
  }
  if (!formData) {
    headers["Content-Type"] = "application/json";
  }

  const fetchOptions = { method, headers };
  if (requestBody !== undefined) {
    fetchOptions.body = formData ? requestBody : JSON.stringify(requestBody);
  }

  // A fresh AbortSignal.timeout per attempt: the signal fires once and stays
  // aborted, so reusing it would make every retry fail instantly.
  const timeoutMs = timeout !== undefined ? timeout : client.timeout;
  const send = () => {
    if (onUploadProgress && typeof XMLHttpRequest !== "undefined") {
      return xhrSend(url, fetchOptions, {
        onUploadProgress,
        timeout: timeoutMs,
      });
    }
    const signal = timeoutSignal(timeoutMs);
    return fetch(url, signal ? { ...fetchOptions, signal } : fetchOptions);
  };

  try {
    const response = await retryWhileBusy(async () => {
      const res = await send();
      // Surface a 503 as a throw so retryWhileBusy can see it; other failures
      // are re-thrown from here and handled by the caller below.
      if (res.status === 503) {
        throw makeHttpError(res, await parseErrorBody(res), url, method);
      }
      return res;
    });

    if (!response.ok) {
      const error = makeHttpError(
        response,
        await parseErrorBody(response),
        url,
        method,
      );
      // 401 means the token is missing/expired/invalid. Fire the app's auth-error
      // handler once (it discards the token and routes back to login). 403
      // (forbidden — authenticated but not permitted) deliberately does NOT.
      if (
        response.status === 401 &&
        typeof client.onAuthError === "function" &&
        !client._authErrorFired
      ) {
        client._authErrorFired = true;
        try {
          client.onAuthError(error);
        } catch (_) {
          /* handler must not mask the original error */
        }
      }
      throw error;
    }

    // Binary response (getMedia)
    if (binaryResponse) {
      extractDocumentVersions(client, response.headers);
      return await response.arrayBuffer();
    }

    // JSON or text response
    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const data = await response.json();
      extractDocumentVersions(client, response.headers, data, {
        historical: /[?&]as-of=/.test(url),
      });
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
