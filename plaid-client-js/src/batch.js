/**
 * Batches: the batch a client opens (a view of the client whose writes
 * queue), how its queued operations go out in requests of at most
 * MAX_BATCH_OPS, and the batch POST itself, on the same send, retries and
 * version learning as every other request. Which calls a batch carries is
 * said at the top of http.js, and the refs a later write uses for an id an
 * earlier one creates are in batchRef.js. The twin of plaid-client-py's
 * batch.py.
 */

import { makeBatchRef, rebaseRefs, takeRefs } from "./batchRef.js";
import {
  IDEMPOTENCY_HEADER,
  REPLAYED_HEADER,
  extractDocumentVersions,
  fetchWithTimeout,
  makeHttpError,
  makeNetworkError,
  noteAuthError,
  noteServerClock,
  parseErrorBody,
  prepareRequest,
  restampDocumentVersion,
  withRetries,
  writesLanded,
  writesStarted,
} from "./http.js";
import { uuidv7 } from "./ids.js";
import { nextIdempotencyKey } from "./operations.js";
import { markReplayed, wasReplayed } from "./replayed.js";
import { transformResponse } from "./transforms.js";

/**
 * The server's cap on operations per batch request (plaid.rest-api.v1.batch).
 * A batch queued past it is submitted as consecutive requests.
 */
export const MAX_BATCH_OPS = 1000;

/**
 * A batch is the client with a different `_request` (see `queueRequest`) and
 * its own copy of the bundles. Everything else resolves to the client through
 * the prototype: the token and base URL, strict mode and the document versions
 * it tracks, the open logical operation.
 * @param {any} client - PlaidClient instance
 * @param {{timeout?: number | null}} [options]
 */
export function openBatch(client, { timeout } = {}) {
  const batch = Object.create(client);
  batch.client = client;
  // This batch's own timeout per request, in place of the client's
  // `batchTimeout` (undefined: the client's).
  batch.submitTimeout = timeout;
  batch.operations = [];
  // The document each queued op's strict-mode stamp is for (null for none),
  // and the logical operation it joined (null for none), index for index with
  // `operations`.
  batch.stampedDocuments = [];
  batch.stampedGroups = [];
  batch.open = true;
  batch._request = (method, path, options = {}) =>
    queueRequest(batch, method, path, options);
  batch.batch = () => {
    throw new Error("A batch is not nestable: queue on the batch you have");
  };
  batch.batched = batch.batch;
  // A stand-in for the id op n will create, for a later op's body (see
  // batchRef.js). The server fills it in inside the batch's transaction.
  batch.ref = (opIndex = -1, index) => makeBatchRef(batch, opIndex, index);
  batch.submit = () => submitBatch(batch);
  batch.abort = () => {
    batch.operations = [];
    batch.stampedDocuments = [];
    batch.stampedGroups = [];
    batch.open = false;
  };
  batch._installResources();
  return batch;
}

export async function submitBatch(batch) {
  if (!batch.open) {
    throw new Error("This batch was already submitted or aborted");
  }
  batch.open = false;
  const ops = batch.operations;
  const stamps = batch.stampedDocuments;
  const groups = batch.stampedGroups;
  batch.operations = [];
  batch.stampedDocuments = [];
  batch.stampedGroups = [];
  if (ops.length === 0) return [];
  const client = batch.client;
  const url = `${client.baseUrl}/api/v1/batch`;
  // The server caps a batch at MAX_BATCH_OPS so one transaction cannot hold
  // the write lock without bound. A larger batch goes as consecutive
  // requests, results concatenated in queue order: it could not have been one
  // transaction anyway, and a repair or bulk edit over a big document must
  // not fail on its size alone. Past the first request, a strict-mode stamp
  // claims the version the requests before it left (learned from their
  // results), not the one the document had when the op was queued, which the
  // first request has already moved on.
  //
  // Each request is atomic, the whole is not: a failure leaves the requests
  // before it saved. The error says so, as `committed` (how many operations
  // were saved) and `committedResults` (their results, in queue order), so a
  // caller can tell a partial write from a batch that saved nothing. The
  // failed request itself counts as unsaved, even when its answer was lost.
  //
  // Each request's results are marked replayed when that request was (see
  // replayed.js), and the combined results when any request was: then some of
  // the batch stored nothing new, which is what a caller reading the mark
  // needs to know. The same holds for `committedResults`.
  const results = [];
  try {
    await sendChunks(
      client,
      url,
      ops,
      stamps,
      results,
      groups,
      batch.submitTimeout,
    );
  } catch (error) {
    if (error && typeof error === "object") {
      error.committed = results.length;
      error.committedResults = results;
    }
    throw error;
  }
  return results;
}

/** The document-version an op's path claims, as a number, or null. */
export function claimedVersion(path) {
  const v = new URLSearchParams(path.split("?")[1] ?? "").get("document-version");
  return v == null ? null : Number(v);
}

export async function sendChunks(
  client,
  url,
  ops,
  stamps,
  results,
  groups = [],
  timeout = undefined,
) {
  // Every chunk's refs are checked before the first request goes, so a batch
  // whose refs cannot resolve writes nothing.
  const chunks = [];
  for (let i = 0; i < ops.length; i += MAX_BATCH_OPS) {
    chunks.push(
      ops
        .slice(i, i + MAX_BATCH_OPS)
        .map((op) =>
          i > 0 && op.refs ? { ...op, refs: rebaseRefs(op.refs, i) } : op,
        ),
    );
  }
  for (let c = 0; c < chunks.length; c++) {
    const i = c * MAX_BATCH_OPS;
    let chunk = chunks[c];
    // One Idempotency-Key per request, minted as the request is formed, so a
    // resend of this chunk is answered from its first send when that landed.
    // Inside an operation opened with keys, a chunk whose ops joined it takes
    // the operation's next key and claims the version its first run claimed.
    const joins = groups
      .slice(i, i + chunk.length)
      .some((g) => g && g === client.operationGroup);
    const { key, pin, record } = nextIdempotencyKey(client, joins);
    const claim = (docId) =>
      pin !== undefined ? pin : client.documentVersions[docId];
    if (i > 0 || pin !== undefined) {
      chunk = chunk.map((op, j) => {
        const docId = stamps[i + j];
        if (!docId) return op;
        const path = restampDocumentVersion(op.path, claim(docId));
        return { ...op, path };
      });
    }
    // Pin what the chunk actually claims: the first stamped op's version as
    // its path now carries it.
    const j = stamps.slice(i, i + chunk.length).findIndex(Boolean);
    record(j < 0 ? null : claimedVersion(chunk[j].path));
    const answered = await client._postBatch(url, chunk, { key, timeout });
    results.push(...answered);
    if (wasReplayed(answered)) markReplayed(results);
    // The server took the chunk, so each operation it joined exists.
    for (let j = i; j < i + chunk.length; j++) {
      if (groups[j]) groups[j].written = true;
    }
  }
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
  const { url, requestBody, stampedDocument, stampedGroup } = prepareRequest(
    batch.client,
    method,
    path,
    options,
  );
  const operation = {
    path: url.replace(batch.client.baseUrl, ""),
    method: method.toUpperCase(),
  };
  if (requestBody !== undefined) {
    // Each b.ref() in the body goes beside it, as the path to a null the
    // server fills with the id (batchRef.js).
    const { body, refs } = takeRefs(batch, requestBody);
    operation.body = body;
    if (refs) operation.refs = refs;
  }
  batch.operations.push(operation);
  batch.stampedDocuments.push(stampedDocument);
  batch.stampedGroups.push(stampedGroup);
  return { batched: true };
}

/**
 * POST one batch request (at most MAX_BATCH_OPS operations) through the same
 * send, retries and version learning as every other request. Resolves to one
 * `{ status, headers, body }` per operation, with only the body recased: the
 * headers keep the server's spelling. `key` is the request's Idempotency-Key:
 * a batch whose answer is lost (no response, 502, 504) is sent again under
 * it, and answered from the first send if that landed. A refused batch wrote
 * nothing (it is atomic), so a 503 is retried too. `timeout` is this
 * request's, in place of `batchTimeout` when given.
 *
 * Each sub-response's `X-Document-Versions` is learned, and the batch's own,
 * which holds each document's version after the whole batch, the layer
 * rules' remedies at its end included (a split that deletes a relation
 * crossing the new boundary moves the version once more). The batch's own
 * `X-Document-Versions-Omitted` is not taken up: each sub-response keeps its
 * own list. Every answer notes the server's clock, as a single request's
 * does.
 * @param {object} client - PlaidClient instance
 * @param {string} url
 * @param {object[]} body - The operations
 * @param {{key?: string, timeout?: number | null}} [options]
 */
export async function postBatch(client, url, body, { key = uuidv7(), timeout } = {}) {
  const fetchOptions = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${client.token}`,
      "Content-Type": "application/json",
      [IDEMPOTENCY_HEADER]: key,
    },
    body: JSON.stringify(body),
  };

  const started = writesStarted(client);
  try {
    const attempt = async () => {
      let res;
      try {
        res = await fetchWithTimeout(
          url,
          fetchOptions,
          timeout !== undefined ? timeout : client.batchTimeout,
        );
      } catch (e) {
        throw makeNetworkError(e, url, "POST");
      }
      noteServerClock(client, res.headers);
      if (!res.ok) {
        throw makeHttpError(res, await parseErrorBody(res), url, "POST");
      }
      return res;
    };
    const response = await withRetries(client, attempt, { keyed: true }).catch((error) => {
      error.idempotencyKey = key;
      noteAuthError(client, error);
      throw error;
    });

    const results = await response.json();
    // A replayed batch carries the versions right after its first send.
    const replayed = response.headers?.get?.(REPLAYED_HEADER) === "true";
    const replayedHeader = replayed ? "true" : null;
    for (const result of results) {
      const versions = result.headers?.["X-Document-Versions"] ?? null;
      extractDocumentVersions(client, {
        get: (name) =>
          name === "X-Document-Versions" ? versions : name === REPLAYED_HEADER ? replayedHeader : null,
      });
    }
    extractDocumentVersions(client, {
      get: (name) =>
        name === "X-Document-Versions-Omitted" ? null : (response.headers?.get?.(name) ?? null),
    });

    writesLanded(client, started, replayed);

    const out = results.map((result) => ({
      ...result,
      body: transformResponse(result.body),
    }));
    return replayed ? markReplayed(out) : out;
  } catch (error) {
    if (error.status !== undefined) throw error;
    throw Object.assign(makeNetworkError(error, url, "POST"), {
      idempotencyKey: key,
    });
  }
}
