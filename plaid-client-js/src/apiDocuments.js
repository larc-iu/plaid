/**
 * The document bundles: documents (with their locks, media and history) and
 * texts, each a factory of the client (client.js installs them).
 */

import { withDocumentLock } from "./documentLock.js";
import { auditMethods, bodyOf, csvParam, metadataMethods } from "./families.js";

/**
 * @typedef {import("./types.js").TextEditOp} TextEditOp
 * @typedef {import("./types.js").TextGap} TextGap
 * @typedef {import("./types.js").MetadataOp} MetadataOp
 * @typedef {import("./types.js").LayerConstraint} LayerConstraint
 * @typedef {import("./types.js").ConstraintWriteOptions} ConstraintWriteOptions
 * @typedef {import("./types.js").ConstraintViolation} ConstraintViolation
 * @typedef {import("./types.js").Requester} Requester
 * @typedef {import("./types.js").BatchRef} BatchRef
 * @typedef {import("./types.js").ServiceParam} ServiceParam
 * @typedef {import("./types.js").ServiceInfo} ServiceInfo
 * @typedef {import("./types.js").DiscoveredService} DiscoveredService
 * @typedef {import("./types.js").ResponseHelper} ResponseHelper
 * @typedef {import("./types.js").ServiceRegistration} ServiceRegistration
 * @typedef {import("./types.js").ServiceStatusEvent} ServiceStatusEvent
 * @typedef {import("./types.js").OperationGroupsBundle} OperationGroupsBundle
 * @typedef {import("./types.js").PlaidClientOptions} PlaidClientOptions
 * @typedef {import("./types.js").OperationKind} OperationKind
 * @typedef {import("./types.js").KeySeed} KeySeed
 * @typedef {import("./types.js").PlaidBatch} PlaidBatch
 * @typedef {import("./types.js").AuditPageOptions} AuditPageOptions
 * @typedef {import("./types.js").VocabItemRestoreSummary} VocabItemRestoreSummary
 * @typedef {import("./types.js").UserDataEntry} UserDataEntry
 * @typedef {import("./types.js").AdminUserDataEntry} AdminUserDataEntry
 * @typedef {import("./types.js").ActivityTallyRow} ActivityTallyRow
 * @typedef {import("./types.js").ConstraintRepair} ConstraintRepair
 * @typedef {import("./types.js").ValueSetRule} ValueSetRule
 * @typedef {import("./types.js").RefusedValues} RefusedValues
 * @typedef {import("./types.js").CommentableType} CommentableType
 * @typedef {import("./types.js").Comment} Comment
 * @typedef {import("./types.js").Guideline} Guideline
 * @typedef {import("./types.js").ClientEventType} ClientEventType
 * @typedef {import("./types.js").ClientEvent} ClientEvent
 * @typedef {import("./types.js").Invite} Invite
 * @typedef {import("./types.js").ServerLimits} ServerLimits
 * @typedef {import("./types.js").ServerHealth} ServerHealth
 * @typedef {import("./types.js").RateLimitBucket} RateLimitBucket
 * @typedef {import("./types.js").RateLimitSnapshot} RateLimitSnapshot
 * @typedef {import("./types.js").BackupStatus} BackupStatus
 * @typedef {import("./types.js").ServerReport} ServerReport
 * @typedef {import("./types.js").LiveLog} LiveLog
 * @typedef {import("./types.js").SSEConnection} SSEConnection
 * @typedef {import("./types.js").SSEStats} SSEStats
 * @typedef {import("./types.js").AtomicValue} AtomicValue
 * @typedef {import("./types.js").Created} Created
 * @typedef {import("./types.js").Project} Project
 * @typedef {import("./types.js").ProjectTextLayer} ProjectTextLayer
 * @typedef {import("./types.js").ProjectTokenLayer} ProjectTokenLayer
 * @typedef {import("./types.js").ProjectSpanLayer} ProjectSpanLayer
 * @typedef {import("./types.js").ProjectRelationLayer} ProjectRelationLayer
 * @typedef {import("./types.js").ProjectVocab} ProjectVocab
 * @typedef {import("./types.js").PlaidDocument} PlaidDocument
 * @typedef {import("./types.js").DocumentTextLayer} DocumentTextLayer
 * @typedef {import("./types.js").DocumentTokenLayer} DocumentTokenLayer
 * @typedef {import("./types.js").DocumentSpanLayer} DocumentSpanLayer
 * @typedef {import("./types.js").PlaidText} PlaidText
 * @typedef {import("./types.js").TextReshape} TextReshape
 * @typedef {import("./types.js").Token} Token
 * @typedef {import("./types.js").Span} Span
 * @typedef {import("./types.js").Relation} Relation
 * @typedef {import("./types.js").VocabItem} VocabItem
 * @typedef {import("./types.js").VocabLink} VocabLink
 * @typedef {import("./types.js").VocabLayer} VocabLayer
 * @typedef {import("./types.js").TextLayer} TextLayer
 * @typedef {import("./types.js").TokenLayer} TokenLayer
 * @typedef {import("./types.js").SpanLayer} SpanLayer
 * @typedef {import("./types.js").RelationLayer} RelationLayer
 * @typedef {import("./types.js").MetadataRecords} MetadataRecords
 * @typedef {import("./types.js").LayerRecords} LayerRecords
 * @typedef {import("./types.js").User} User
 * @typedef {import("./types.js").ProjectListEntry} ProjectListEntry
 * @typedef {import("./types.js").DocumentListEntry} DocumentListEntry
 * @typedef {import("./types.js").ApiToken} ApiToken
 * @typedef {import("./types.js").AuditUser} AuditUser
 * @typedef {import("./types.js").AuditTarget} AuditTarget
 * @typedef {import("./types.js").AuditOp} AuditOp
 * @typedef {import("./types.js").AuditEntry} AuditEntry
 * @typedef {import("./types.js").LockGrant} LockGrant
 * @typedef {import("./types.js").DocumentRestoreSummary} DocumentRestoreSummary
 * @typedef {import("./types.js").RestoreCounts} RestoreCounts
 * @typedef {import("./types.js").OperationGroup} OperationGroup
 * @typedef {import("./types.js").QueryResult} QueryResult
 */

/**
 * @template [T=any]
 * @typedef {import("./types.js").Page<T>} Page
 */

/** @param {import("./client.js").PlaidClient} client */
export function documentsApi(client) {
  return {
    /**
     * Get a document. Set `includeBody` to true to include all data.
     *
     * A document with a recording has `mediaUrl`, and `mediaDuration`, the
     * recording's length in seconds, when the server could read it from the
     * file at upload (WAV, MP4, M4A, MOV, FLAC, MP3).
     *
     * `layers` narrows a body read to the layers you name (ids of any kind:
     * text, token, span, or relation). A layer comes back when it is named
     * or is an ancestor of a named layer, and carries its own
     * texts/tokens/spans/relations/vocabs only when it is itself named — so
     * name the text layer too if you also want the text body. An id that is
     * not a layer of this document's project is an error, not a quietly
     * smaller response. Requires `includeBody`.
     * @param {string} documentId - The document ID
     * @param {boolean} [includeBody] - Include document body data
     * @param {string} [asOf] - Temporal query timestamp
     * @param {string[]|string} [layers] - Layer ids to restrict a body read to
     * @returns {Promise<PlaidDocument>}
     */
    get: (documentId, includeBody, asOf, layers) =>
      client._request("GET", `/api/v1/documents/${documentId}`, {
        queryParams: {
          "include-body": includeBody,
          "as-of": asOf,
          layers: csvParam(layers),
        },
      }),
    /**
     * Get the media file for a document, as a Blob whose `type` is the
     * served media type. Media is not versioned, so there is no as-of form:
     * the route refuses the parameter. A busy core (503) is asked again, as
     * for any read. To play a recording, stream it from `mediaLink` instead.
     * @param {string} documentId - The document ID
     * @param {object} [options]
     * @param {number | null} [options.timeout] - This read's timeout in ms, in place of the client's. A
     *   recording can take longer than the default 30 s to come down: null or 0 waits as long as it takes.
     * @param {(progress: {loaded: number, total: number | null}) => void} [options.onProgress] - Called with
     *   `{ loaded, total }` (bytes, total null when unknown) as the file comes down.
     * @returns {Promise<Blob>}
     */
    getMedia: (documentId, { timeout, onProgress } = {}) =>
      client._request("GET", `/api/v1/documents/${documentId}/media`, {
        blobResponse: true,
        onDownloadProgress: onProgress,
        timeout,
      }),
    /**
     * Create a new document in a project.
     * @param {string} projectId - The project ID
     * @param {string} name - The name
     * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @param {boolean} [opts.freeName] - A name another document of the project holds, ignoring case, becomes
     *   the first free "name (2)", "name (3)" and on. Without it such a name is refused with 422
     *   and `name-taken`.
     * @returns {Promise<{id: string, name: string}>} The new id and the name stored
     */
    create: (projectId, name, metadata, auditMessage, { id, freeName } = {}) =>
      client._request("POST", "/api/v1/documents", {
        auditMessage,
        body: bodyOf({
          id,
          "project-id": projectId,
          name,
          metadata,
          "free-name": freeName || undefined,
        }),
      }),
    /**
     * Update a document's name. A name another document of the project holds,
     * ignoring case,
     * is refused with 422 and `name-taken`.
     * @param {string} documentId - The document ID
     * @param {string} name - The name
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<PlaidDocument>}
     */
    update: (documentId, name, auditMessage) =>
      client._request("PATCH", `/api/v1/documents/${documentId}`, {
        auditMessage,
        body: bodyOf({ name }),
      }),
    /**
     * Delete a document and all data contained.
     * @param {string} documentId - The document ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (documentId, auditMessage) =>
      client._request("DELETE", `/api/v1/documents/${documentId}`, {
        auditMessage,
      }),
    /**
     * Check the lock status of a document.
     * @param {string} documentId - The document ID
     * @returns {Promise<{userId: string, expiresAt: number} | void>}
     */
    checkLock: (documentId) =>
      client._request("GET", `/api/v1/documents/${documentId}/lock`),
    /**
     * Acquire a document lock as a new holder.
     *
     * The answer's `lockId` names the holder: `renewLock` and `releaseLock`
     * take it. While the lock is held, a second acquire is refused with
     * HTTP 423, whoever makes it, this user included.
     *
     * `newLockId` names the holder from the client's side (a fresh UUID). An
     * acquire whose answer never arrived can then be sent again, which
     * answers 200 while that holder has the lock, or released. Without it
     * the server mints the id, and a lost answer leaves a lock nobody can
     * release until it expires.
     *
     * outOfBand: the lock is a signal, not project data (see the note at
     * the top of http.js). Queued on a batch it would be taken only at
     * submit, after every write it was meant to guard, and until then answer
     * success to a caller that does not hold it and cannot see the 423
     * saying somebody else does.
     * @param {string} documentId - The document ID
     * @param {string} [auditMessage]
     * @param {string} [newLockId] - A holder id this client minted
     * @returns {Promise<LockGrant>}
     */
    acquireLock: (documentId, auditMessage, newLockId) =>
      client._request("POST", `/api/v1/documents/${documentId}/lock`, {
        ...(newLockId !== undefined && newLockId !== null
          ? { queryParams: { "new-lock-id": newLockId } }
          : {}),
        auditMessage,
        outOfBand: true,
      }),
    /**
     * Renew the lock `lockId` holds while it is live. HTTP 423 if another
     * holder has it, and also once it has expired or been dropped, even when
     * nobody holds the document now: a renewal never takes a free document.
     * outOfBand, for the same reason as acquireLock.
     * @param {string} documentId - The document ID
     * @param {string} lockId - The `lockId` acquireLock answered with
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<LockGrant>}
     */
    renewLock: (documentId, lockId, auditMessage) =>
      client._request("POST", `/api/v1/documents/${documentId}/lock`, {
        queryParams: { "lock-id": lockId },
        auditMessage,
        outOfBand: true,
      }),
    /**
     * Release the lock `lockId` holds. Idempotent: a lock that holder no
     * longer has is left alone. outOfBand, for the same reason as
     * acquireLock: queued, the lock would be held until the batch submits,
     * and not released at all if it aborts.
     * @param {string} documentId - The document ID
     * @param {string} lockId - The `lockId` acquireLock answered with
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    releaseLock: (documentId, lockId, auditMessage) =>
      client._request("DELETE", `/api/v1/documents/${documentId}/lock`, {
        queryParams: { "lock-id": lockId },
        auditMessage,
        outOfBand: true,
      }),
    /**
     * Hold this document's server-enforced lock for the length of `fn`,
     * releasing it on the way out (including on error). Resolves to what
     * `fn` returned.
     *
     *   await client.documents.locked(docId, async () => {
     *     // delete + recreate tokens
     *   });
     *
     * Wrap any multi-step, server-side mutation of a document that must not
     * interleave with a human editor or another service, e.g. a parser or
     * tokenizer that deletes and recreates a document's tokens, spans and
     * relations. A single atomic call does not need it. While the lock is
     * held, writes to the document by ANOTHER user are refused with HTTP
     * 423; the holder's own writes pass and renew it. If anyone already
     * holds it, another block of this same user included, this rejects with
     * a readable 423 and `fn` does not run.
     *
     * The lock is renewed for as long as `fn` runs, so work that computes
     * for minutes before it writes holds the lock the whole time rather than
     * only for its first minute. If a renewal fails the lock is gone: every
     * later write from this client throws `DocumentLockLost`, and a block
     * that got to the end anyway ends with that error rather than reporting
     * success. `fn` receives a lock handle and may read `lock.lost` (or call
     * `lock.raiseIfLost()`) to give up sooner.
     *
     * The lock is per HOLDER: each block is its own, named by
     * `lock.lockId`, and only that id renews or releases it. NOT
     * re-entrant: a nested `locked()` block on one document is a second
     * holder and gets the 423. Lock at exactly one level per call path.
     * The block mints its holder id and sends it with the acquire, so an
     * acquire whose answer was lost is sent again (up to three tries) and,
     * if none is answered, released rather than left to expire. A
     * lost lock is recorded on the CLIENT, like strict mode, so it stops
     * every write the client makes (on any batch of it too) and not only the
     * ones this block makes.
     *
     * A core restart drops every lock, and until the next renewal finds it
     * gone (up to half the lock window) this block's writes still pass, since
     * writes carry no lock id. When a write must not land past that point,
     * hold the document in strict mode too (`enterStrictMode`), so such a
     * write is refused with a 409.
     * @template T
     * @param {string} documentId - The document ID
     * @param {(lock: import("./documentLock.js").DocumentLock) => T | Promise<T>} fn - The work to run while holding it
     * @param {{keepAlive?: boolean}} [options] - `{ keepAlive }`: renew on a timer (default true)
     * @returns {Promise<T>}
     */
    locked: (documentId, fn, options) =>
      withDocumentLock(client, documentId, fn, options),
    /**
     * Get a link that plays the document's recording without an
     * Authorization header, for an audio or video element's `src`, which
     * cannot send one. `url` is the document's media URL with a
     * `media-token` added, resolved against the client's base URL. The token
     * opens only this recording, for this user, and the server refuses it on
     * every other route. It expires at `expiresAt` (an ISO-8601 instant, six
     * hours on by default), and sooner when the user signs out, changes
     * password or loses access to the project: ask for a new link then. A
     * document with no recording is a 404. Writes nothing, so it takes no
     * Idempotency-Key and goes over the wire when made on a batch.
     * @param {string} documentId - The document ID
     * @returns {Promise<{url: string, expiresAt: string}>}
     */
    mediaLink: async (documentId) => {
      const link = await client._request(
        "POST",
        `/api/v1/documents/${documentId}/media/link`,
        { outOfBand: true },
      );
      return { ...link, url: `${client.baseUrl}${link.url}` };
    },
    /**
     * Upload a media file for a document. Uses Apache Tika for content validation.
     * A document that already has a recording refuses it with a 409
     * (`media-exists`, and the current `media-url`): delete that one first.
     * A WAV whose samples are not PCM, 32-bit float, A-law or mu-law (IMA or
     * MS ADPCM, GSM, 64-bit float and the rest), which browsers cannot play,
     * is refused with a 415 whose `error` names its coding.
     * @param {string} documentId - The document ID
     * @param {File} file - The file to upload
     * @param {string} [auditMessage] - Custom audit-log message for this write
     * @param {{onProgress?: (progress: {loaded: number, total: number | null}) => void}} [options] - `{ onProgress }`: called with `{ loaded, total }` (bytes) as the file goes up. In a browser the upload then travels by XMLHttpRequest, and the request timeout only fires when the upload stalls, not on total time.
     * @returns {Promise<{message: string, extension: string, contentType: string}>}
     */
    uploadMedia: (documentId, file, auditMessage, { onProgress } = {}) => {
      const fd = new FormData();
      fd.append("file", file);
      return client._request("PUT", `/api/v1/documents/${documentId}/media`, {
        auditMessage,
        body: fd,
        formData: true,
        noBatch: true,
        onUploadProgress: onProgress,
      });
    },
    /**
     * Delete media file for a document
     * @param {string} documentId - The document ID
     * @param {string} [auditMessage] - Audit message for this write
     * @param {{mediaVersion?: string}} [options] - `mediaVersion`: the
     *   recording meant, the `?v=` of the document's `mediaUrl`. The delete
     *   is refused with a 409 (`media-changed`, and the current `media-url`)
     *   when the stored recording is another one.
     * @returns {Promise<void>}
     */
    // The upload above is multipart and cannot be batched, but a DELETE
    // carries no blob, so the batch transport takes it. It is a write
    // of the document's own data and queues like any other. The server
    // removes the file only after the write commits, so a batch that aborts
    // after this op leaves the recording in place.
    deleteMedia: (documentId, auditMessage, { mediaVersion } = {}) =>
      client._request("DELETE", `/api/v1/documents/${documentId}/media`, {
        auditMessage,
        queryParams: { "media-version": mediaVersion },
      }),
    /**
     * Restore a document to its state at an earlier time, as one
     * operation: what was deleted since then comes back under its original
     * id, what was added since is removed, and what changed is set back,
     * across every layer. A layer deleted since then, or a vocabulary entry
     * that no longer exists, is skipped and reported under `skipped`. A name
     * another document holds now stays with it, and the document keeps its
     * current name, reported under `nameKept` (`{name, taken}`).
     * Resolves to a summary of the changes. Maintainers only.
     * @param {string} documentId - The document ID
     * @param {string} asOf - The moment to go back to (ISO-8601 instant),
     *   typically a history entry's `endTime`
     * @param {{dryRun?: boolean}} [options] - `{ dryRun }`: with `dryRun` true nothing
     *   is written and the summary says what would change
     * @param {string} [auditMessage] - Custom audit message for this operation
     * @returns {Promise<DocumentRestoreSummary>}
     */
    restore: (documentId, asOf, { dryRun } = {}, auditMessage) =>
      client._request("POST", `/api/v1/documents/${documentId}/restore`, {
        queryParams: {
          "as-of": asOf,
          "dry-run": dryRun ? "true" : undefined,
        },
        auditMessage,
      }),
    /**
     * Copy a document and everything in it into a new document of the same
     * project, as one operation. The copy shares the source's layers and
     * the vocabulary entries its links name, and holds the source's texts,
     * tokens, spans, relations and vocab links under fresh ids, with their
     * metadata. Comments do not travel. The media file does, unless
     * `includeMedia` is false. Resolves to `{ id, name }`, plus `mediaError` when
     * the source had media the copy could not take with it. A name another
     * document of the project holds, ignoring case, is refused with 422 and `name-taken`,
     * unless `freeName`, which takes the first free "name (2)", "name (3)"
     * and on.
     * @param {string} documentId - The document to copy
     * @param {string} name - The new document's name
     * @param {{includeMedia?: boolean, id?: string, freeName?: boolean}} [options] - `{ includeMedia }`: false leaves the media
     *   file behind
     * @param {string} [auditMessage] - Custom audit message for this operation
     * @returns {Promise<{id: string, name: string, mediaError?: string}>}
     */
    copy: (documentId, name, { includeMedia, id, freeName } = {}, auditMessage) =>
      client._request("POST", `/api/v1/documents/${documentId}/copy`, {
        auditMessage,
        body: bodyOf({
          id,
          name,
          "include-media": includeMedia,
          "free-name": freeName || undefined,
        }),
      }),
    ...metadataMethods(client, "documents"),
    ...auditMethods(client, "documents"),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function textsApi(client) {
  return {
    /**
     * Get a text.
     * @param {string} textId - The text ID
     * @returns {Promise<PlaidText>}
     */
    get: (textId) =>
      client._request("GET", `/api/v1/texts/${textId}`),
    /**
     * Create a new text in a document's text layer. A text is a container for
     * one long string in `body` for a given layer.
     * @param {string} textLayerId - The text layer ID
     * @param {string} documentId - The document ID
     * @param {string} body - The text
     * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
     * @param {string} [auditMessage]
     * @param {{id?: string, tokenEdges?: number[], tokenizeLayer?: string}} [options] - `id`: the
     *   new text's id, a UUIDv7 this client minted. `tokenEdges`: the code-point offsets where
     *   the tokens made next on this text begin and end. The body is stored composed, except a
     *   character one of them falls inside, which stays as sent (see composeText).
     *   `tokenizeLayer`: a word layer of the text, which gets the body's words, cut by the
     *   server ("Tokenize new text").
     * @returns {Promise<Created>}
     */
    create: (
      textLayerId,
      documentId,
      body,
      metadata,
      auditMessage,
      { id, tokenEdges, tokenizeLayer } = {},
    ) =>
      client._request("POST", "/api/v1/texts", {
        auditMessage,
        body: bodyOf({
          id,
          "text-layer-id": textLayerId,
          "document-id": documentId,
          body,
          "token-edges": tokenEdges,
          "tokenize-layer": tokenizeLayer,
          metadata,
        }),
      }),
    /**
     * Update a text's body. A diff is computed and token indices are updated
     * so that tokens remain intact. Alternatively, `body` can be a list of
     * edit directives (code-point indices, applied in order):
     *   {type: 'delete', index, value: count}
     *   {type: 'insert', index, value: string}
     *   {type: 'replace', index, length, value: string} — unlike
     *     delete+insert, a token covering the whole range is resized to keep
     *     it (respell a word in place without losing its annotations).
     * A list is applied exactly as sent. With `base` (the `digest` of the
     * body the update was made on, as every read of a text gives it) the
     * update applies only to that body, and is refused with 409 and
     * `text-changed` otherwise. Strict mode then does not stamp it, unless
     * `versioned` is true (a batch whose later writes are stamped needs its
     * first write stamped too).
     * @param {string} textId - The text ID
     * @param {any} body - The new text
     * @param {string} [auditMessage]
     * `tokenizeLayer`: a word layer of the text, whose words the server makes for the text the
     * update types, after it places the old tokens ("Tokenize new text"). They come in the
     * answer's `reshape`.
     * @param {{base?: string, versioned?: boolean, tokenizeLayer?: string}} [options]
     * @returns {Promise<PlaidText & {reshape: TextReshape}>}
     */
    update: (textId, body, auditMessage, { base, versioned, tokenizeLayer } = {}) =>
      client._request("PATCH", `/api/v1/texts/${textId}`, {
        auditMessage,
        body: bodyOf({ body, base, "tokenize-layer": tokenizeLayer }),
        versioned: versioned ?? (base === undefined || base === null),
      }),
    /**
     * Delete a text and all dependent data.
     * @param {string} textId - The text ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (textId, auditMessage) =>
      client._request("DELETE", `/api/v1/texts/${textId}`, { auditMessage }),
    /**
     * Change a text's body by the edits made at the caret: a list of edit
     * directives as `update` takes them (code-point indices, applied in
     * order, each index in the body the ones before it left). Only their
     * net change counts. An insert or a delete stays where it was made, and
     * a stretch deleted and typed over is read as a whole new body is. The
     * answer is the text with its new `digest` and `reshape` (the tokens
     * moved, the spans and vocab links trimmed, the rows deleted). With
     * `base`, the digest of the body the edits were made on, the edit
     * applies only to that body and is refused with 409 and `text-changed`
     * otherwise, and strict mode does not stamp it unless `versioned` is
     * true. `tokenizeLayer` is as `update` takes it. See composeTextEdits and gapsToOps.
     * @param {string} textId - The text ID
     * @param {Array<object>} edits - The edit directives
     * @param {string} [auditMessage]
     * @param {{base?: string, versioned?: boolean, tokenizeLayer?: string}} [options]
     * @returns {Promise<PlaidText & {reshape: TextReshape}>}
     */
    edit: (textId, edits, auditMessage, { base, versioned, tokenizeLayer } = {}) =>
      client._request("PATCH", `/api/v1/texts/${textId}`, {
        auditMessage,
        body: bodyOf({ edits, base, "tokenize-layer": tokenizeLayer }),
        versioned: versioned ?? (base === undefined || base === null),
      }),
    ...metadataMethods(client, "texts"),
  };
}
