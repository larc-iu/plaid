import { transformRequest, transformResponse } from "./transforms.js";

// ---------------------------------------------------------------------------
// Batches: which calls a batch carries, and which go over the wire anyway.
//
// A batch is an OBJECT (`client.batch()`, or the argument `client.batched(fn)`
// hands `fn`), a view of the client with the same bundles. A write made on the
// batch queues; a call made on the client itself always goes over the wire,
// whatever batches happen to be open. So the editor, the importer and the
// app's chrome can share one client, and a write by code that knows nothing
// about a batch can never land inside it. Every call reaching this layer is
// one of three things, and the third column is what a new endpoint has to
// pick.
//
// 1. A WRITE of project data: an entity, its metadata, a layer, a membership,
//    a comment. This is what a batch is for, so on a batch it QUEUES. It is
//    the default and needs no flag.
//
// 2. A READ. Every GET is answered from the wire even when made on a batch:
//    the caller gets data rather than `{ batched: true }`, it takes no slot in
//    the batch's results, and server-side it runs against the pool rather than
//    the batch's transaction connection. A read that travels as a POST
//    (`query`) says so with `outOfBand`.
//
// 3. An OUT-OF-BAND SIGNAL: stopping a service request, reporting a service's
//    progress or result, taking or dropping a document lock, forgetting a
//    service, an admin action on the server itself. It is shaped like a write
//    but carries no project data, and its whole value is that it happens NOW.
//    Pass `outOfBand`: made on a batch it still goes over the wire, and it
//    never joins an open logical operation. The audit group is a label for
//    the writes, and a signal that is never audited would mark the group
//    written and leave the relabel PATCH 404ing on a group nothing ever
//    created.
//
// Strict mode stamps the batch's one expected document-version onto the first
// write queued on it (whole-batch OCC: stamping every op would 409 the second
// against the bump the first caused). A call that went over the wire on its
// own carries its own stamp and spends nothing of any batch's.
//
// `noBatch` is not part of that judgment. It marks the five calls the batch
// transport cannot carry at all (a batch inside a batch, the multipart media
// and avatar uploads, the user-data store's put and delete) and raises so the
// caller finds out. Never put it on a read: it turns a swallowed read into a
// thrown one, which is what the chrome hit when an unrelated import was
// running. A blobless DELETE beside an upload is not one of them: it carries
// nothing the transport cannot express, so it takes its class from the three
// above like anything else.
// ---------------------------------------------------------------------------

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
 *   noBatch         - If true, throw when made on a batch. Only for calls the
 *                     batch transport cannot carry at all (see the note at the
 *                     top of this file); never for a read.
 *   outOfBand       - If true, the call is a signal rather than a write of
 *                     project data: made on a batch it still goes over the
 *                     wire, and it never joins an open logical operation (see
 *                     the note at the top of this file).
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
/**
 * Everything a request is before it goes anywhere: the URL with its query
 * params and the stamps strict mode, a per-call audit message and an open
 * logical operation add, plus the transformed body. Shared by the wire path
 * (`makeRequest`) and the batch path (`queueRequest`), so a queued op is
 * exactly the request that would have gone out. `batch` is the batch the call
 * is being queued on, if any: strict mode stamps its document-version onto the
 * first write queued there and no other.
 */
export function prepareRequest(
  client,
  method,
  path,
  options = {},
  batch = null,
) {
  const { body, rawBody, formData, queryParams, outOfBand, auditMessage } =
    options;

  // A write must not go out on a lock that lapsed. `documents.locked()`
  // records the loss here when its keep-alive cannot renew, and from that
  // moment the block is holding nothing: an edit by somebody else can already
  // have landed between the read the work was planned from and the write about
  // to go out. Reads pass, and so do the lock routes themselves, which is how
  // the block still releases on its way out.
  if (client.documentLockLost && method !== "GET" && !path.endsWith("/lock")) {
    throw client.documentLockLost;
  }

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

  // Strict mode: append document-version for non-GET requests, on EVERY
  // queued write of a batch. The server validates the first write it can
  // (one whose route resolves a document) and skips the rest of that
  // document's, so the version bump a sub-op causes does not 409 the next
  // one. Stamping only the first write was silently no check at all
  // whenever that write was one the route ignores, such as a vocabulary
  // entry's metadata, which is exactly what the igt editor queues first.
  if (client.strictModeDocumentId && method !== "GET") {
    const docId = client.strictModeDocumentId;
    if (client.documentVersions[docId]) {
      const docVersion = client.documentVersions[docId];
      const separator = url.includes("?") ? "&" : "?";
      url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
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
  //
  // An out-of-band signal is not one of those writes (see the note at the top
  // of this file): it never lands in the audit log, so a stamp does nothing
  // server-side while `written` promises a group that will never exist, and
  // the relabel PATCH then 404s.
  if (client.operationGroup && method !== "GET" && !outOfBand) {
    const group = client.operationGroup;
    const separator = url.includes("?") ? "&" : "?";
    url += `${separator}group-id=${encodeURIComponent(group.id)}`;
    if (group.message)
      url += `&group-message=${encodeURIComponent(group.message)}`;
    group.written = true;
  }

  return { url, requestBody };
}

/**
 * A call made on a batch (see `PlaidClient#batch`). A write of project data is
 * queued as one operation of the batch and answers `{ batched: true }`; its
 * result is the matching entry of what `submit()` resolves to. A read, and a
 * signal marked `outOfBand`, is the client's to make and goes over the wire
 * now, exactly as if it had been made on the client.
 */
export async function queueRequest(batch, method, path, options = {}) {
  if (method === "GET" || options.outOfBand) {
    return batch.client._request(method, path, options);
  }
  if (!batch.open) {
    throw new Error(`This batch was already submitted or aborted: ${path}`);
  }
  if (options.noBatch) {
    throw new Error(`This endpoint cannot be used in a batch: ${path}`);
  }
  const { url, requestBody } = prepareRequest(
    batch.client,
    method,
    path,
    options,
    batch,
  );
  const operation = {
    path: url.replace(batch.client.baseUrl, ""),
    method: method.toUpperCase(),
  };
  if (requestBody !== undefined) {
    operation.body = requestBody;
  }
  batch.operations.push(operation);
  return { batched: true };
}

export async function makeRequest(client, method, path, options = {}) {
  const {
    formData,
    skipResponseTransform,
    noAuth,
    binaryResponse,
    timeout,
    onUploadProgress,
  } = options;
  const { url, requestBody } = prepareRequest(client, method, path, options);

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
