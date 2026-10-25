/**
 * PlaidClient: a client's state (token, versions, strict mode, the open
 * operation, the server's facts), its bundles, its batches and logical
 * operations, and the static entry points that make one (login, invites,
 * health, info). The package root (index.js) re-exports it with the rest of
 * the package.
 */

import { transformResponse } from "./transforms.js";
import {
  makeRequest,
  parseErrorBody,
  makeHttpError,
  makeNetworkError,
  timeoutSignal,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BATCH_TIMEOUT_MS,
  queryTimeout,
} from "./http.js";
import { normalizeUserId } from "./ids.js";
import { openBatch, postBatch } from "./batch.js";
import { apiTokensApi, authApi, invitesApi, userDataApi, usersApi } from "./apiPeople.js";
import { documentsApi, textsApi } from "./apiDocuments.js";
import { vocabItemsApi, vocabLayersApi } from "./apiVocab.js";
import { relationLayersApi, spanLayersApi, textLayersApi, tokenLayersApi } from "./apiLayers.js";
import { relationsApi, spansApi, tokensApi, vocabLinksApi } from "./apiAnnotations.js";
import {
  beginOperation,
  endOperation,
  keySeed,
  withOperation,
} from "./operations.js";
import { bodyOf, auditQuery, auditMethods, configMethods } from "./families.js";
import { listAll, listPage, iterPages } from "./pagination.js";
import { recorderFor } from "./events.js";
import { createSSEConnection } from "./sse.js";
import {
  discoverServices,
  discardService,
  releaseService,
  serve,
  requestService,
  attachServiceRequest,
  cancelServiceRequest,
} from "./services.js";

// ---- Types --------------------------------------------------------------
// The shapes the API answers with and takes are in types.js, named here so
// this module's JSDoc can use them.

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

// A request with no Authorization header: login, invite lookup and redemption
// (POST, with a body), /health and /api/v1/info (GET). Deliberately does not
// go through PlaidClient._request: these are called before any client exists,
// which is the whole point.
async function anonymousRequest(method, baseUrl, path, body, options = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const url = `${base}${path}`;
  try {
    const fetchOptions =
      method === "GET"
        ? { method }
        : {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          };
    const signal = timeoutSignal(
      options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS,
    );
    if (signal) fetchOptions.signal = signal;

    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw makeHttpError(response, await parseErrorBody(response), url, method);
    }
    return transformResponse(await response.json());
  } catch (error) {
    if (error.status) throw error;
    throw makeNetworkError(error, url, method);
  }
}

/**
 * How long `admin.backup()` waits for the server to finish writing a backup:
 * minutes on a large database, past the usual per-request timeout.
 */
export const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;

/** The query of an events read: `types` as the wire's comma-separated list. */
function eventQuery(types, startTime, endTime) {
  return {
    types: Array.isArray(types) ? types.join(",") || undefined : types,
    "start-time": startTime,
    "end-time": endTime,
  };
}

class PlaidClient {
  /**
   * Create a new PlaidClient instance
   * @param {string} baseUrl - The base URL for the API
   * @param {string} token - The authentication token
   * @param {PlaidClientOptions} [options] - Client options
   */
  constructor(baseUrl, token, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    /** @type {number | null} */
    this.timeout =
      options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS;
    // Batch submissions get a longer budget than a single request. Aborting a
    // batch does NOT stop the server: it keeps running the transaction and
    // holding the single SQLite write lock, so a client that gives up early
    // just adds a retry on top of a write that is still in progress. Falls
    // back to an explicit `timeout` when one was given.
    /** @type {number | null} */
    this.batchTimeout =
      options.batchTimeout !== undefined
        ? options.batchTimeout
        : options.timeout !== undefined
          ? options.timeout
          : DEFAULT_BATCH_TIMEOUT_MS;
    // Delays (ms) before sending a keyed write again when its answer was lost
    // (no response, 502, 504). See the Idempotency-Key note in http.js.
    /** @type {number[] | undefined} */
    this.retryDelaysMs = options.retryDelaysMs;
    /**
     * The latest version seen for each document written through this client,
     * keyed by document id.
     * @type {Record<string, number>}
     */
    this.documentVersions = {};
    /**
     * True once a response left its version list out
     * (X-Document-Versions-Omitted, past fifty documents). Every version held
     * was then forgotten, and the strict-mode document's is read again before
     * the next write.
     * @type {boolean | undefined}
     */
    this.documentVersionsOmitted = undefined;
    // The server's clock minus this machine's, in ms, from the last response
    // with a Date header (null before one). See serverNow().
    /** @type {number | null} */
    this.serverClockOffsetMs = null;
    /**
     * The document strict mode is entered for, or null.
     * @type {string | null}
     */
    this.strictModeDocumentId = null;
    // Set to a DocumentLockLost while a `documents.locked()` block's keep-alive
    // has failed. Every write throws it until the block exits; see
    // documentLock.js.
    /** @type {import("./documentLock.js").DocumentLockLost | null} */
    this.documentLockLost = null;
    // The keeper of each `documents.locked()` block that renews on a beat, by
    // document id: a write that lands on a held document renewed its lock,
    // and the request layer tells that keeper.
    this.lockKeepers = new Map();
    // The open logical operation (audit-log group), or null. While set, every
    // write is stamped with `?group-id=` (+ `group-message`) so the audit log
    // folds them into ONE expandable entry. See beginOperation / withOperation.
    // Shape: { id, message, depth, written, refined, frames }, where each of
    // `frames` is { keys, count, minted, depth, owned } and the last numbers.
    /**
     * @type {{id: string, message: string | null, kind: OperationKind | null,
     *   ref: string | null, depth: number, written: boolean, refined: any,
     *   frames: object[]} | null}
     */
    this.operationGroup = null;
    // Optional callback fired once (per client) when any request returns HTTP
    // 401 — i.e. the token is missing/expired/invalid. Apps use it to discard
    // the stored token and route back to login. See makeRequest in http.js.
    /** @type {((error: Error) => void) | null} */
    this.onAuthError = options.onAuthError || null;
    /** @private */
    this._authErrorFired = false;
    // Who hears that a request is being sent again (onRetry).
    /** @private */
    this._retryListeners = new Set();
    // GET /info as last read (`server.info()`), and whether a stream of this
    // client dropped since.
    /** @private */
    this._serverFacts = { info: null, stale: false };
    // The key frame the last beginOperation opened, or null (withOperation).
    /** @private @type {object | null} */
    this._openedFrame = null;

    this._installResources();
  }

  /**
   * A stream of this client ended without being closed here: the server may
   * have restarted, with other limits.
   * @private
   */
  _noteStreamDropped() {
    this._serverFacts.stale = true;
  }

  /**
   * A stream of this client is open. After a drop the limits are read again,
   * once however many streams reopen.
   * @private
   */
  _noteStreamOpened() {
    if (!this._serverFacts.stale) return;
    this.server.refresh().catch(() => {
      // The figures known before stand, and the next open asks again.
      this._serverFacts.stale = true;
    });
  }

  /**
   * Hear every time a request is sent again: after a 503 (the database was
   * busy), or for a keyed write after its answer was lost (no response, 502,
   * 504). The listener gets `{ attempt, retries, delay, error }` before the
   * wait. A screen that writes through the client directly can say it is
   * retrying while the server does not answer, though the browser is online.
   * @param {(info: {attempt: number, retries: number, delay: number, error: Error}) => void} listener
   * @returns {() => void} the unsubscribe
   */
  onRetry(listener) {
    this._retryListeners.add(listener);
    return () => this._retryListeners.delete(listener);
  }

  /**
   * Tell every `onRetry` listener. A listener that throws is passed over.
   * @private
   */
  _noteRetry(info) {
    for (const listener of this._retryListeners) {
      try {
        listener(info);
      } catch (_) {
        /* a listener must not stop the retry */
      }
    }
  }

  /**
   * The server's time now, as its last response's Date header put it (to the
   * second), else this machine's. Judge a time the server stamped, such as an
   * audit entry's `ts`, against this rather than `Date.now()`: a browser
   * clock can be minutes off.
   * @returns {Date}
   */
  serverNow() {
    return new Date(Date.now() + (this.serverClockOffsetMs ?? 0));
  }

  /**
   * The API bundles (`client.documents`, `client.tokens`, ...). Installed on
   * the client, and again on every batch it opens (see `batch()`): a batch is
   * a view of the client with its own `_request`, so the same bundles built
   * on it queue instead of sending.
   * @private
   */
  _installResources() {
    this.vocabLinks = vocabLinksApi(this);

    this.vocabLayers = vocabLayersApi(this);

    this.relations = relationsApi(this);

    this.spanLayers = spanLayersApi(this);

    this.spans = spansApi(this);

    // Server-level facts. Read once, and again only when they may have
    // changed: after this client's connection to the server was lost and came
    // back (a restart, the only way the limits change, always drops it), or
    // after the server refused a private data write as too large. A caller
    // asking "will this file be accepted" does not pay a round trip to find
    // out. The facts live on the client (`_serverFacts`), so a batch opened
    // on it reads the same.
    this.server = {
      /**
       * This server's version and the limits it enforces, e.g.
       * `{ limits: { mediaFileBytes, jsonBodyBytes, batchOperations, … } }`.
       * Sizes are in bytes. Unauthenticated.
       * @returns {Promise<{limits: ServerLimits}>}
       */
      info: () => {
        const facts = this._serverFacts;
        if (!facts.info) {
          const asked = this._request("GET", "/api/v1/info").catch((err) => {
            // A failure must not be kept: a client that starts before the
            // server is up would never see the limits at all.
            if (facts.info === asked) facts.info = null;
            throw err;
          });
          facts.info = asked;
        }
        return facts.info;
      },
      /**
       * Read `GET /info` again and resolve to it. Until it answers, a reader
       * waits for it. The facts known before are kept when the server does
       * not answer, and the error is thrown.
       * @returns {Promise<{limits: ServerLimits}>}
       */
      refresh: () => {
        const facts = this._serverFacts;
        const before = facts.info;
        facts.stale = false;
        const fresh = this._request("GET", "/api/v1/info");
        const held = fresh.catch((err) => {
          if (facts.info === held) facts.info = before;
          if (before) return before;
          throw err;
        });
        held.catch(() => {});
        facts.info = held;
        return fresh;
      },
      /**
       * Just the limits, which is what a caller almost always wants.
       * @returns {Promise<ServerLimits>}
       */
      limits: async () => {
        // Through `self`: tsc types a bundle that names itself as
        // `this.server` in its own methods `any` in the declarations.
        const self = this;
        return (await self.server.info()).limits;
      },
      /**
       * Liveness, version and database size. Unauthenticated, and served
       * outside the REST router at /health, so it answers even while the API
       * is refusing requests. Never cached — the point is that it is current.
       * @returns {Promise<ServerHealth>}
       */
      health: () => PlaidClient.health(this.baseUrl, { timeout: this.timeout }),
    };

    this.auth = authApi(this);

    this.texts = textsApi(this);

    this.users = usersApi(this);

    this.userData = userDataApi(this);

    this.apiTokens = apiTokensApi(this);

    this.invites = invitesApi(this);

    this.admin = {
      /**
       * Everything about the server in one read: version and JVM uptime,
       * database size and per-table row counts, media directory usage, backup
       * configuration and the backups on disk, and the settings an operator
       * gets asked to confirm. Carries no secrets. Runs a count per table and
       * walks the media directory, so open it, do not poll it. Admin only.
       * @returns {Promise<ServerReport>}
       */
      server: () => this._request("GET", "/api/v1/admin/server"),
      /**
       * Take a database backup right now, outside the nightly schedule.
       * Resolves to the backup block with `ok` reporting whether the snapshot
       * succeeded. Uses VACUUM INTO, which only reads, so it is safe while
       * people are working. Admin only.
       *
       * The server answers once the backup is written, which takes minutes on
       * a large database, so this waits up to `BACKUP_TIMEOUT_MS` (30 minutes)
       * rather than the client's usual timeout. A proxy in front of the server
       * may still give up first (a 504): the backup goes on, and its file
       * shows in `server().backup.backups` once it is written.
       * @returns {Promise<BackupStatus>}
       *
       * outOfBand, as every admin action on the server itself is: none of them
       * writes project data (see the note at the top of http.js).
       */
      backup: () =>
        this._request("POST", "/api/v1/admin/backup", {
          outOfBand: true,
          timeout: BACKUP_TIMEOUT_MS,
        }),
      /**
       * Documents currently held by an editing lock, with who holds each and
       * when it expires on its own. Admin only.
       * @returns {Promise<{entries: Array<{documentId: string, userId: string, expiresAt: number}>}>}
       */
      locks: () => this._request("GET", "/api/v1/admin/locks"),
      /**
       * Drop the lock on a document whoever holds it. Idempotent. For a client
       * that went away without releasing one. Admin only.
       * @param {string} documentId - The document ID
       * @returns {Promise<{result: string}>}
       */
      releaseLock: (documentId) =>
        this._request("DELETE", `/api/v1/admin/locks/${documentId}`, {
          outOfBand: true,
        }),
      /**
       * Live login and invite rate-limit buckets: the address, the account
       * where there is one, failures inside the window, the limit, and whether
       * it is currently blocking. Admin only.
       * @returns {Promise<RateLimitSnapshot>}
       */
      rateLimits: () => this._request("GET", "/api/v1/admin/rate-limits"),
      /**
       * Forget recorded rate-limit failures. With `ip`, clears that address,
       * narrowed to one account with `userId`. With neither, clears every
       * bucket. Only ever unblocks. Admin only.
       * @param {object} [opts]
       * @param {string} [opts.ip] - Clear only this address
       * @param {string} [opts.userId] - Narrow to one account on that address
       * @returns {Promise<{result: string}>}
       */
      clearRateLimits: ({ ip, userId } = {}) =>
        this._request("DELETE", "/api/v1/admin/rate-limits", {
          outOfBand: true,
          queryParams: { ip, "user-id": userId },
        }),
      /**
       * What the server has logged, structured and filtered, from an in-memory
       * buffer kept whether or not a log file is configured. `requests` is one
       * entry per HTTP request (method, path, status, duration, and who made
       * it), `events` is everything else, with a stack trace where there was
       * one. They are buffered separately so a burst of requests cannot evict
       * an error. Both come newest first, `matched` counts what passed the
       * filters, and request `stats` describe the filtered set. Covers Plaid's
       * own log stream since the last restart: for library messages and older
       * history, see `logFile`. Admin only.
       * @param {object} [opts]
       * @param {number} [opts.limit] - Max entries per kind (default 200, max 2000)
       * @param {string} [opts.q] - Substring of any field, case-insensitive
       * @param {string} [opts.level] - Minimum level for events, e.g. "warn"
       * @param {string} [opts.status] - "2xx".."5xx", an exact code, or "failures"
       * @param {string} [opts.user] - Only requests made by this account
       * @param {string} [opts.method] - Only requests with this HTTP method
       * @returns {Promise<LiveLog>}
       */
      logs: ({ limit, q, level, status, user, method } = {}) =>
        this._request("GET", "/api/v1/admin/logs", {
          queryParams: { limit, q, level, status, user, method },
        }),
      /**
       * The tail of the configured log file, as text lines. The only place
       * third-party library messages and anything from before the last restart
       * can be read. Resolves with an `error` string instead of lines when no
       * log file is configured or it does not exist yet. Admin only.
       * @param {object} [opts]
       * @param {number} [opts.lines] - How many lines (default 200, max 2000)
       * @returns {Promise<{file: (string|null), lines: string[], error?: string}>}
       */
      logFile: ({ lines } = {}) =>
        this._request("GET", "/api/v1/admin/logs/file", {
          queryParams: { lines },
        }),
      /**
       * Private user-data entries across every account, each carrying its
       * `userId`. `/users/:userId/data` has always been owner-or-admin; this
       * is the same reach across accounts at once. Transparently follows
       * pagination cursors and returns the full flat array. Admin only.
       *
       * Narrow with `prefix` (the literal head of a key) and/or `pattern`, a
       * GLOB over the whole key (`*` any run, `?` one character) — the way to
       * ask for a key convention identified by a segment in the middle, e.g.
       * `igt:assistant:*:meta:*`. Values come only with `includeValues`, and
       * are recased like any other body (see `userData.put`).
       * @param {object} [opts]
       * @param {string} [opts.prefix] - Only keys starting with this
       * @param {string} [opts.pattern] - Only keys matching this GLOB
       * @param {boolean} [opts.includeValues] - Also return each entry's value
       * @returns {Promise<AdminUserDataEntry[]>}
       */
      userData: ({ prefix, pattern, includeValues } = {}) =>
        listAll(this, "/api/v1/admin/user-data", {
          query: {
            prefix,
            pattern,
            "include-values": includeValues,
          },
        }),
      /**
       * One page of private user-data entries across accounts, ordered by
       * (user, key). Admin only.
       * @param {object} [opts]
       * @param {string} [opts.prefix] - Only keys starting with this
       * @param {string} [opts.pattern] - Only keys matching this GLOB
       * @param {boolean} [opts.includeValues] - Also return each entry's value
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @returns {Promise<Page<AdminUserDataEntry>>}
       */
      userDataPage: ({ prefix, pattern, includeValues, limit, cursor } = {}) =>
        listPage(this, "/api/v1/admin/user-data", {
          limit,
          cursor,
          query: {
            prefix,
            pattern,
            "include-values": includeValues,
          },
        }),
    };

    this.audit = {
      /**
       * The audit log across every project, oldest first. Same fold, window
       * and op-type filter as the per-project read, with the entity scope
       * dropped. Admin only. Transparently follows pagination cursors and
       * returns the full flat array.
       * @param {object} [opts]
       * @param {string} [opts.startTime] - Only operations at or after this instant
       * @param {string} [opts.endTime] - Only operations at or before this instant
       * @param {string[]|string} [opts.opTypes] - Only these op types (e.g.
       *   `['span-layer/create']`). An entry appears when one of its operations
       *   matches, carrying only the ones that did.
       * @param {string[]|string} [opts.kinds] - Only the entries of operations
       *   of these kinds (e.g. `['review']`), each whole
       * @returns {Promise<AuditEntry[]>}
       */
      list: ({ startTime, endTime, opTypes, kinds } = {}) =>
        listAll(this, "/api/v1/audit", {
          query: auditQuery({ startTime, endTime, opTypes, kinds }),
        }),
      /**
       * Fetch a single page of the instance-wide audit log. Admin only.
       * @param {object} [opts]
       * @param {string} [opts.startTime] - Only entries at or after this instant
       * @param {string} [opts.endTime] - Only entries at or before this instant
       * @param {string[]|string} [opts.opTypes] - Only these op types
       * @param {OperationKind[]|string} [opts.kinds] - Only the entries of operations of these kinds, each whole
       * @param {"asc"|"desc"} [opts.order] - "desc" pages newest-first, which
       *   is what a feed wants. A cursor belongs to the direction that made it.
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {number} [opts.opsLimit] - Keep only each entry's oldest N
       *   operations in `ops` (1..1000). `opCount` on every entry says how
       *   many it has
       * @param {string} [opts.entryId] - Read only this entry, not a page
       * @returns {Promise<Page<AuditEntry>>}
       */
      listPage: ({ startTime, endTime, opTypes, kinds, order, limit, cursor, opsLimit, entryId } = {}) =>
        listPage(this, "/api/v1/audit", {
          limit,
          cursor,
          query: auditQuery({ startTime, endTime, opTypes, kinds, order, opsLimit, entryId }),
        }),
      /**
       * Async-iterate the instance-wide audit log page by page. Admin only.
       * @param {object} [opts]
       * @param {string} [opts.startTime] - Only entries at or after this instant
       * @param {string} [opts.endTime] - Only entries at or before this instant
       * @param {string[]|string} [opts.opTypes] - Only these op types
       * @param {OperationKind[]|string} [opts.kinds] - Only the entries of operations of these kinds, each whole
       * @param {number} [opts.pageSize] - Per-request page size
       * @returns {AsyncGenerator<AuditEntry[]>}
       */
      iterPages: ({ startTime, endTime, opTypes, kinds, pageSize } = {}) =>
        iterPages(this, "/api/v1/audit", {
          pageSize,
          query: auditQuery({ startTime, endTime, opTypes, kinds }),
        }),
      /**
       * Per-user activity counts. `changes` is the number of logical actions,
       * folded the way the audit feed folds them, so one "Confirm word
       * analysis" counts once however many rows it wrote; `operations` is the
       * unfolded row count. Only users who did something appear — subtract
       * from the roster you already hold to find the ones who did not.
       *
       * With `projectId`, scoped to that project and open to its maintainers.
       * Without one, instance-wide and admin only.
       * @param {object} [opts]
       * @param {string} [opts.projectId] - Scope to one project
       * @param {string} [opts.startTime] - Only count at or after this instant
       * @param {string} [opts.endTime] - Only count at or before this instant
       * @param {boolean} [opts.daily] - Also return `byDay`, a list of
       *   `{date, changes}` per user, oldest first, at the cost of a second
       *   grouped scan
       * @returns {Promise<ActivityTallyRow[]>}
       */
      tally: async ({ projectId, startTime, endTime, daily } = {}) => {
        const path = projectId
          ? `/api/v1/projects/${projectId}/audit/tally`
          : "/api/v1/audit/tally";
        const result = await this._request("GET", path, {
          queryParams: {
            "start-time": startTime,
            "end-time": endTime,
            daily,
          },
        });
        return result.entries;
      },
    };

    this.tokenLayers = tokenLayersApi(this);

    this.documents = documentsApi(this);

    this.projects = {
      /**
       * Set a user's access level to read and write for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      addWriter: (id, userId, auditMessage) =>
        this._request("POST", `/api/v1/projects/${id}/writers/${userId}`, {
          auditMessage,
        }),
      /**
       * Remove a user's writer privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      removeWriter: (id, userId, auditMessage) =>
        this._request("DELETE", `/api/v1/projects/${id}/writers/${userId}`, {
          auditMessage,
        }),
      /**
       * Set a user's access level to read-only for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      addReader: (id, userId, auditMessage) =>
        this._request("POST", `/api/v1/projects/${id}/readers/${userId}`, {
          auditMessage,
        }),
      /**
       * Remove a user's reader privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      removeReader: (id, userId, auditMessage) =>
        this._request("DELETE", `/api/v1/projects/${id}/readers/${userId}`, {
          auditMessage,
        }),
      ...configMethods(this, "projects"),
      /**
       * Assign a user as a maintainer for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      addMaintainer: (id, userId, auditMessage) =>
        this._request("POST", `/api/v1/projects/${id}/maintainers/${userId}`, {
          auditMessage,
        }),
      /**
       * Remove a user's maintainer privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      removeMaintainer: (id, userId, auditMessage) =>
        this._request(
          "DELETE",
          `/api/v1/projects/${id}/maintainers/${userId}`,
          { auditMessage },
        ),
      ...auditMethods(this, "projects"),
      /**
       * When the calling user last wrote to each document in a project, as a
       * `{documentId: timestamp}` map. Documents they have never written to
       * are absent. One request covers a whole document list.
       *
       * The response is NOT key-transformed: its keys are document ids, and
       * camelCasing would mangle the hyphens in a UUID.
       * @param {string} projectId - The project ID
       * @returns {Promise<Object<string, string>>}
       */
      myLastEdits: (projectId) =>
        this._request("GET", `/api/v1/projects/${projectId}/audit/last-edits`, {
          skipResponseTransform: true,
        }),
      /**
       * Link a vocabulary to a project.
       * @param {string} id - The resource ID
       * @param {string} vocabId - The vocab layer ID
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      linkVocab: (id, vocabId, auditMessage) =>
        this._request("POST", `/api/v1/projects/${id}/vocabs/${vocabId}`, {
          auditMessage,
        }),
      /**
       * Unlink a vocabulary from a project.
       * @param {string} id - The resource ID
       * @param {string} vocabId - The vocab layer ID
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      unlinkVocab: (id, vocabId, auditMessage) =>
        this._request("DELETE", `/api/v1/projects/${id}/vocabs/${vocabId}`, {
          auditMessage,
        }),
      /**
       * Get a project by ID. To fetch the project's documents, use
       * listDocuments(id) — the include-documents flag has been removed.
       * @param {string} id - The resource ID
       * @returns {Promise<Project>}
       */
      get: (id) =>
        this._request("GET", `/api/v1/projects/${id}`),
      /**
       * List all documents in a project. Transparently follows pagination
       * cursors and returns the full flat array.
       *
       * Note: this endpoint does not support temporal (`as-of`) queries; the
       * server rejects `?as-of=` on the documents-list route with a 400.
       * @param {string} id - The project ID
       * @returns {Promise<DocumentListEntry[]>}
       */
      listDocuments: (id) => listAll(this, `/api/v1/projects/${id}/documents`),
      /**
       * Fetch a single page of a project's documents.
       *
       * Note: this endpoint does not support temporal (`as-of`) queries; the
       * server rejects `?as-of=` on the documents-list route with a 400.
       * @param {string} id - The project ID
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @returns {Promise<Page<DocumentListEntry>>}
       */
      listDocumentsPage: (id, { limit, cursor } = {}) =>
        listPage(this, `/api/v1/projects/${id}/documents`, { limit, cursor }),
      /**
       * Async-iterate a project's documents page by page; yields each page's
       * entries array.
       *
       * Note: this endpoint does not support temporal (`as-of`) queries; the
       * server rejects `?as-of=` on the documents-list route with a 400.
       * @param {string} id - The project ID
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * @returns {AsyncGenerator<DocumentListEntry[]>}
       */
      iterDocuments: (id, { pageSize } = {}) =>
        iterPages(this, `/api/v1/projects/${id}/documents`, { pageSize }),
      /**
       * Delete a project and everything in it. This is irrecoverable. The
       * project is gone when this returns, and what it holds is removed on
       * the server afterwards.
       * @param {string} id - The resource ID
       * @param {string} [auditMessage] - Custom audit-log message
       * @param {object} [options]
       * @param {number} [options.timeout] - Per-request timeout in ms, the client's own by default (0/null disables)
       * @returns {Promise<void>}
       */
      delete: (id, auditMessage, { timeout } = {}) =>
        this._request("DELETE", `/api/v1/projects/${id}`, {
          auditMessage,
          timeout,
        }),
      /**
       * Update a project's name.
       * @param {string} id - The resource ID
       * @param {string} name - The name
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<Project>}
       */
      update: (id, name, auditMessage) =>
        this._request("PATCH", `/api/v1/projects/${id}`, {
          auditMessage,
          body: bodyOf({ name }),
        }),
      /**
       * List all projects accessible to user. Transparently follows pagination
       * cursors and returns the full flat array.
       * @returns {Promise<ProjectListEntry[]>}
       */
      list: () => listAll(this, "/api/v1/projects"),
      /**
       * Fetch a single page of projects.
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @returns {Promise<Page<ProjectListEntry>>}
       */
      listPage: ({ limit, cursor } = {}) =>
        listPage(this, "/api/v1/projects", {
          limit,
          cursor,
        }),
      /**
       * Async-iterate projects page by page; yields each page's entries array.
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * @returns {AsyncGenerator<ProjectListEntry[]>}
       */
      iterPages: ({ pageSize } = {}) =>
        iterPages(this, "/api/v1/projects", {
          pageSize,
        }),
      /**
       * Create a new project. Note: this also registers the user as a maintainer.
       * @param {string} name - The name
       * @param {string} [auditMessage] - Audit message for this write
       * @param {object} [opts]
       * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
       * @returns {Promise<Created>}
       */
      create: (name, auditMessage, { id } = {}) =>
        this._request("POST", "/api/v1/projects", {
          auditMessage,
          body: bodyOf({ id, name }),
        }),
    };

    this.textLayers = textLayersApi(this);

    this.vocabItems = vocabItemsApi(this);

    this.relationLayers = relationLayersApi(this);

    this.tokens = tokensApi(this);

    this.messages = {
      /**
       * Open a Server-Sent Events stream for a project.
       * @param {string} projectId - The UUID of the project to listen to
       * @param {(eventType: string, data: any) => void | boolean} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop.
       * @param {string} [path] - Stream path under baseUrl (defaults to the project /listen bus; service channels pass their own).
       * @returns {SSEConnection} SSE connection object with .close() and .getStats() methods
       */
      listen: (projectId, onEvent, path) =>
        createSSEConnection(this, projectId, onEvent, path),

      /**
       * Send a message to project listeners.
       *
       * `data` may be any JSON value and is sent VERBATIM (`rawBody`): a
       * message payload is opaque application data, like `metadata` and
       * `config`, so its keys must not be re-cased on the way out. Without
       * this a key such as `case-marker` would reach listeners as
       * `caseMarker` in JS and `case_marker` in Python. `listen` restores it
       * verbatim on the way in.
       *
       * A message is not saved and writes nothing to History, so it never
       * joins an open operation (`withOperation`). Made on a batch it still
       * queues, so a message queued after the writes goes out after them.
       * @param {string} projectId - The UUID of the project to send to
       * @param {any} data - The message data to send
       * @returns {Promise<{success: boolean, message: string}>}
       */
      sendMessage: (projectId, data) =>
        this._request("POST", `/api/v1/projects/${projectId}/message`, {
          noOperation: true,
          rawBody: { body: data },
        }),

      /**
       * Discover the services seen on a project (synchronous GET). Currently
       * connected services carry `online: true`; previously-seen offline ones
       * carry `online: false` plus a `lastSeenAt` stamp.
       * @param {string} projectId - The UUID of the project to query
       * @returns {Promise<DiscoveredService[]>} Array of discovered service information
       */
      discoverServices: (projectId) => discoverServices(this, projectId),

      /**
       * Forget a previously-seen (offline) service. Maintainer-only; 409 if
       * the service is currently connected.
       * @param {string} projectId - The UUID of the project
       * @param {string} serviceId - The ID of the service to forget
       * @returns {Promise<void>}
       */
      discardService: (projectId, serviceId) =>
        discardService(this, projectId, serviceId),

      /**
       * Release a service id from the account that first registered it on
       * the project, so the next account to register it claims it.
       * Admin-only; 409 while the service is connected, 404 when no account
       * holds it.
       * @param {string} projectId - The UUID of the project
       * @param {string} serviceId - The ID of the service to release
       * @returns {Promise<void>}
       */
      releaseService: (projectId, serviceId) =>
        releaseService(this, projectId, serviceId),

      /**
       * Register as a service and handle incoming work requests.
       *
       * The registration reopens its channel whenever it drops, so a server
       * restart needs no service restart.
       * @param {string} projectId - The UUID of the project to serve
       * @param {ServiceInfo} serviceInfo - Service information {serviceId, serviceName, description}
       * @param {(data: any, responseHelper: ResponseHelper) => void} onServiceRequest - Callback (data, responseHelper)
       * @param {Object} [extras] - Optional additional service metadata
       * @param {(event: ServiceStatusEvent, projectId: string, detail?: string) => void} [onStatus] - Optional callback (event, projectId, detail) for
       *   connection transitions: 'registered', 'reconnected', 'disconnected',
       *   and 'stopped' when the server refuses the channel for good, which
       *   ends the registration
       * @returns {ServiceRegistration} Service registration with .stop(), .isRunning(), .isConnected()
       */
      serve: (projectId, serviceInfo, onServiceRequest, extras, onStatus) =>
        serve(this, projectId, serviceInfo, onServiceRequest, extras, onStatus),

      /**
       * Request a service to perform work and await its result.
       *
       * The request outlives this call: after a timeout, an abort, or a
       * dropped connection the service goes on, and `attachServiceRequest`
       * collects the result given the request id, which `opts.onAccepted`
       * receives as soon as the server has taken the request. Pass
       * `opts.requestId` (a UUID you mint) to know the id before submitting;
       * submitting an id that names a request you already made rejoins it
       * instead of starting another.
       * @param {string} projectId - The UUID of the project
       * @param {string} serviceId - The ID of the service to request
       * @param {any} data - The request data
       * @param {number} [timeout=10000] - Timeout in ms
       * @param {function} [onProgress] - Called with each progress payload {percent, message}
       * @param {AbortSignal} [signal] - Abort to stop waiting; rejects with an AbortError
       * @param {{requestId?: string, onAccepted?: (requestId: string) => void, projectIds?: string[], noOperation?: boolean}} [opts] - {requestId, onAccepted, projectIds, noOperation}
       * @returns {Promise<any>} The service's result
       */
      requestService: (
        projectId,
        serviceId,
        data,
        timeout,
        onProgress,
        signal,
        opts,
      ) =>
        requestService(
          this,
          projectId,
          serviceId,
          data,
          timeout,
          onProgress,
          signal,
          opts,
        ),

      /**
       * Rejoin a service request made earlier and await its result: the
       * latest progress is replayed, then the result comes, or at once if the
       * request already finished. Only the user who submitted it (or an
       * admin). Rejects with an error whose `status` is 404 when the request
       * is unknown or expired (a finished request's result is kept for a
       * while, not forever).
       * @param {string} projectId - The UUID of the project
       * @param {string} requestId - The request id
       * @param {number} [timeout=10000] - Timeout in ms
       * @param {function} [onProgress] - Called with each progress payload
       * @param {AbortSignal} [signal] - Abort to stop waiting
       * @returns {Promise<any>} The service's result
       */
      attachServiceRequest: (
        projectId,
        requestId,
        timeout,
        onProgress,
        signal,
      ) =>
        attachServiceRequest(
          this,
          projectId,
          requestId,
          timeout,
          onProgress,
          signal,
        ),

      /**
       * Ask the service to stop a request made earlier. The request still
       * ends with whatever the service then reports, on the stream of whoever
       * is awaiting it. Rejects with 404 if unknown or expired, 409 once
       * finished.
       * @param {string} projectId - The UUID of the project
       * @param {string} requestId - The request id
       * @returns {Promise<void>}
       */
      cancelServiceRequest: (projectId, requestId) =>
        cancelServiceRequest(this, projectId, requestId),
    };

    // outOfBand: a query is a read that travels as a POST (see the note at
    // the top of http.js). Made on a batch it goes over the wire like any
    // read, and it never joins a logical operation. It waits past core's own
    // query limit, so a query too broad answers with core's 408, and a 503
    // from core's full queue of large queries is not retried.
    /**
     * Run a query over every project you can read.
     *
     * `body` is the query AST. Its keys follow the usual client convention
     * (camelCase, e.g. `scope.projectIds`) and are converted to the wire
     * format automatically; clause heads and variables are plain strings you
     * write literally (e.g. `'span'`, `'?s1'`, `'vocab-link'`). Example:
     *
     *   await client.query({
     *     find: ['?s1', '?s2'],
     *     where: [
     *       ['span', '?s1', { layer: posLayerId, value: 'NOUN' }],
     *       ['span', '?s2', { layer: posLayerId, value: 'VERB' }],
     *       ['covers', '?s1', '?t1'], ['covers', '?s2', '?t2'],
     *       ['precedes', '?t1', '?t2'],
     *     ],
     *     return: 'entities',   // 'ids' (default) | 'entities' | 'count'
     *     limit: 100,
     *   });
     *
     * A `layer` is referenced by its id (its UUID) only — not by name or
     * path. To match a layer by name, bind it with a `*-layer` clause (e.g.
     * `['span-layer', '?sl', { name: 'pos' }]`) and use the variable.
     *
     * A vocab link's provenance is on the link itself: bind it as a `link`
     * entity to filter or group by it, e.g. the machine-made links nobody
     * confirmed, with the tokens they sit on:
     *
     *   ['link', '?l', { metadata: { prov: 'inferred' } }],
     *   ['not', ['link', '?l', { metadata: { provConfirmed: true } }]],
     *   ['link-token', '?l', '?t'], ['link-item', '?l', '?v']
     *
     * Optional keys: `scope` (restrict to projects by id, `{projectIds}`), `orderBy`
     * (sort rows), and `bindings` (substitute `?name` placeholders with literals).
     * `return` may also be an aggregate spec `{group, aggregates}`. See the query
     * language reference.
     *
     * @param {Object} body - The query AST ({find, where, scope?, limit?, orderBy?,
     *   return?, bindings?}).
     * @returns {Promise<QueryResult>} For 'ids'/'entities': {columns, results, count, truncated}.
     *   For 'count': {return: 'count', count, truncated}, where `truncated` says
     *   the count stopped at the server's cap. Entity cells are full entity
     *   objects (same shape as the GET endpoints).
     */
    this.query = (body) =>
      this._request("POST", "/api/v1/query", {
        body,
        outOfBand: true,
        timeout: queryTimeout(this),
        noBusyRetry: true,
      });

    // Logical-operation groups (audit-log grouping). There is no create: a
    // group row is made lazily by the first write carrying `?group-id=`
    // (see beginOperation). Not an audited write, so no auditMessage arg.
    this.operationGroups = {
      /**
       * Get a logical-operation group (its label + creator).
       * @param {string} id - The group id
       * @returns {Promise<OperationGroup>}
       */
      get: (id) => this._request("GET", `/api/v1/operation-groups/${id}`),
      /**
       * Relabel a logical-operation group after the fact. Owner or admin only.
       * @param {string} id - The group id
       * @param {string|null} message - The new label
       * @returns {Promise<OperationGroup>}
       */
      update: (id, message) =>
        this._request("PATCH", `/api/v1/operation-groups/${id}`, {
          body: { message },
        }),
    };

    this.comments = {
      /**
       * Post a comment on an entity. Requires write access to the entity's
       * project, or to the vocabulary for a vocab-item; the author is the
       * authenticated caller. Comments are not audited and do not bump the
       * document version.
       *
       * A comment outlives its anchor: deleting the entity does not delete
       * the comment. `anchorLabel` is the caption shown once that happens
       * ("Gloss of ktab, sentence 4"), so pass what the comment is about.
       * @param {CommentableType} entityType - What kind of thing is being commented on
       * @param {string} entityId - The commented entity's id
       * @param {string} body - The comment text (1..10000 characters)
       * @param {object} [opts]
       * @param {string} [opts.anchorLabel] - What the comment is about, in words (at most 200 characters)
       * @param {string} [opts.id] - The new comment's id, minted by the caller (see uuidv7)
       * @returns {Promise<Comment>}
       */
      create: (entityType, entityId, body, { anchorLabel, id } = {}) =>
        this._request("POST", "/api/v1/comments", {
          // A comment is not audited, so it never joins an open operation,
          // and never takes a number from an edit's Idempotency-Key seed.
          noOperation: true,
          body: bodyOf({
            id,
            "entity-type": entityType,
            "entity-id": entityId,
            body,
            "anchor-label": anchorLabel,
          }),
        }),
      /**
       * Read one comment.
       * @param {string} id - The comment id
       * @returns {Promise<Comment>}
       */
      get: (id) => this._request("GET", `/api/v1/comments/${id}`),
      /**
       * Edit a comment's body. Only the comment's AUTHOR may do this - not
       * maintainers, not admins. Sets `edited` on the comment.
       * @param {string} id - The comment id
       * @param {string} body - The replacement text
       * @returns {Promise<Comment>}
       */
      update: (id, body) =>
        this._request("PATCH", `/api/v1/comments/${id}`, {
          body: { body },
          noOperation: true,
        }),
      /**
       * Delete a comment. The author may delete their own; a project
       * maintainer (or admin) may delete any.
       * @param {string} id - The comment id
       * @returns {Promise<void>}
       */
      delete: (id) =>
        this._request("DELETE", `/api/v1/comments/${id}`, { noOperation: true }),
      /**
       * List comments in a project, oldest first. Transparently follows
       * pagination cursors and returns the full flat array.
       * @param {string} projectId - The project to read
       * @param {object} [filters] - Narrow the scope
       * @param {string} [filters.documentId] - Every comment anywhere in one document
       * @param {string} [filters.entityType] - With entityId, one entity's thread
       * @param {string} [filters.entityId] - With entityType, one entity's thread
       * @returns {Promise<Comment[]>}
       */
      list: (projectId, { documentId, entityType, entityId } = {}) =>
        listAll(this, `/api/v1/projects/${projectId}/comments`, {
          query: {
            "document-id": documentId,
            "entity-type": entityType,
            "entity-id": entityId,
          },
        }),
      /**
       * Fetch a single page of a project's comments.
       * @param {string} projectId - The project to read
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {string} [opts.documentId] - Every comment anywhere in one document
       * @param {string} [opts.entityType] - With entityId, one entity's thread
       * @param {string} [opts.entityId] - With entityType, one entity's thread
       * @returns {Promise<Page<Comment>>}
       */
      listPage: (
        projectId,
        { limit, cursor, documentId, entityType, entityId } = {},
      ) =>
        listPage(this, `/api/v1/projects/${projectId}/comments`, {
          limit,
          cursor,
          query: {
            "document-id": documentId,
            "entity-type": entityType,
            "entity-id": entityId,
          },
        }),
      /**
       * Async-iterate a project's comments page by page; yields each page's entries array.
       * @param {string} projectId - The project to read
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * @param {string} [opts.documentId] - Every comment anywhere in one document
       * @param {string} [opts.entityType] - With entityId, one entity's thread
       * @param {string} [opts.entityId] - With entityType, one entity's thread
       * @returns {AsyncGenerator<Comment[]>}
       */
      iterPages: (
        projectId,
        { pageSize, documentId, entityType, entityId } = {},
      ) =>
        iterPages(this, `/api/v1/projects/${projectId}/comments`, {
          pageSize,
          query: {
            "document-id": documentId,
            "entity-type": entityType,
            "entity-id": entityId,
          },
        }),
      /**
       * Comment counts per entity, as an `{entityId: n}` map, over the same
       * scope and filters as `list`. One cheap request paints a comment
       * indicator on every annotated item in a document without paging
       * through the bodies.
       *
       * The response is NOT key-transformed: its keys are entity ids, and
       * camelCasing would mangle the hyphens in a UUID.
       * @param {string} projectId - The project to read
       * @param {{documentId?: string, entityType?: CommentableType, entityId?: string}} [filters] - Same filters as list()
       * @returns {Promise<Object<string, number>>}
       */
      counts: (projectId, { documentId, entityType, entityId } = {}) =>
        this._request("GET", `/api/v1/projects/${projectId}/comments/counts`, {
          queryParams: {
            "document-id": documentId,
            "entity-type": entityType,
            "entity-id": entityId,
          },
          skipResponseTransform: true,
        }),
      /**
       * List the comments on a vocabulary's entries, oldest first. Requires
       * read access to the vocabulary. Transparently follows pagination
       * cursors and returns the full flat array.
       * @param {string} vocabId - The vocab layer to read
       * @param {object} [filters]
       * @param {string} [filters.entityId] - One entry's thread
       * @returns {Promise<Comment[]>}
       */
      listInVocab: (vocabId, { entityId } = {}) =>
        listAll(this, `/api/v1/vocab-layers/${vocabId}/comments`, {
          query: { "entity-id": entityId },
        }),
      /**
       * Fetch a single page of a vocabulary's comments.
       * @param {string} vocabId - The vocab layer to read
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {string} [opts.entityId] - One entry's thread
       * @returns {Promise<Page<Comment>>}
       */
      listInVocabPage: (vocabId, { limit, cursor, entityId } = {}) =>
        listPage(this, `/api/v1/vocab-layers/${vocabId}/comments`, {
          limit,
          cursor,
          query: { "entity-id": entityId },
        }),
      /**
       * Async-iterate a vocabulary's comments page by page, oldest first;
       * yields each page's entries array.
       * @param {string} vocabId - The vocab layer to read
       * @param {object} [opts]
       * @param {string} [opts.entityId] - One entry's thread
       * @param {number} [opts.pageSize] - Per-request page size
       * @returns {AsyncGenerator<Comment[]>}
       */
      iterInVocabPages: (vocabId, { entityId, pageSize } = {}) =>
        iterPages(this, `/api/v1/vocab-layers/${vocabId}/comments`, {
          pageSize,
          query: { "entity-id": entityId },
        }),
      /**
       * Comment counts per entry of a vocabulary, as an `{entityId: n}` map.
       * The response is NOT key-transformed: its keys are entry ids.
       * @param {string} vocabId - The vocab layer to read
       * @param {object} [filters]
       * @param {string} [filters.entityId] - One entry only
       * @returns {Promise<Object<string, number>>}
       */
      countsInVocab: (vocabId, { entityId } = {}) =>
        this._request(
          "GET",
          `/api/v1/vocab-layers/${vocabId}/comments/counts`,
          {
            queryParams: { "entity-id": entityId },
            skipResponseTransform: true,
          },
        ),
    };

    this.events = {
      /**
       * Record one research-telemetry event (plaid-core sql/client_event.clj).
       * Fire and forget: the event is buffered and sent with
       * others every ten seconds, at fifty events, and when the page is
       * hidden. A batch that fails is dropped, nothing is retried, and
       * nothing is ever thrown. Sends nothing for a project whose switch
       * (`config.plaid.research.telemetry`) is off, which it reads from the
       * project itself. `suggestion.shown` is recorded once per target,
       * field and value in a page session.
       * @param {ClientEventType} type - The event type
       * @param {object} fields
       * @param {string} fields.projectId - The project it happened in
       * @param {string} [fields.documentId] - The document it happened in
       * @param {string} [fields.targetId] - What it is about: a token, a plan
       * @param {object} [fields.data] - Its details, keyed by single lowercase words (`value`, `source`, `field`, `written`, `conversation`)
       * @returns {boolean} Whether the event was buffered
       */
      record: (type, fields) => recorderFor(this).record(this, type, fields),
      /**
       * Send what the recorder holds now, rather than at its next interval.
       * @returns {void}
       */
      flush: () => recorderFor(this).flush(),
      /**
       * Tell the recorder a project's switch at once, e.g. right after a
       * maintainer changed it. Turning it off drops what is buffered.
       * @param {string} projectId - The project
       * @param {boolean} on - Whether telemetry is on
       * @returns {void}
       */
      setEnabled: (projectId, on) => recorderFor(this).setEnabled(projectId, on),
      /**
       * Record events directly, with no buffering. Requires write access, and
       * the server refuses with a 403 while the project's switch is off. All
       * or nothing: one bad event refuses the request with a 400 naming it.
       * @param {string} projectId - The project the events happened in
       * @param {Array<{type: string, documentId?: string, targetId?: string, data?: object, clientTs?: string}>} events - At most 500 events
       * @returns {Promise<{count: number}>}
       */
      create: (projectId, events) =>
        this._request("POST", `/api/v1/projects/${projectId}/events`, {
          body: events,
          outOfBand: true,
        }),
      /**
       * A project's events in arrival order. Maintainer or admin only.
       * Transparently follows pagination cursors and returns the full flat
       * array.
       * @param {string} projectId - The project to read
       * @param {object} [filters]
       * @param {string|string[]} [filters.types] - Only these types
       * @param {string} [filters.startTime] - Only events the server stamped at or after this instant
       * @param {string} [filters.endTime] - Only events the server stamped at or before this instant
       * @returns {Promise<ClientEvent[]>}
       */
      list: (projectId, { types, startTime, endTime } = {}) =>
        listAll(this, `/api/v1/projects/${projectId}/events`, {
          query: eventQuery(types, startTime, endTime),
        }),
      /**
       * One page of a project's events. Maintainer or admin only.
       * @param {string} projectId - The project to read
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {string|string[]} [opts.types] - Only these types
       * @param {string} [opts.startTime] - Only events at or after this instant
       * @param {string} [opts.endTime] - Only events at or before this instant
       * @returns {Promise<Page<ClientEvent>>}
       */
      listPage: (
        projectId,
        { limit, cursor, types, startTime, endTime } = {},
      ) =>
        listPage(this, `/api/v1/projects/${projectId}/events`, {
          limit,
          cursor,
          query: eventQuery(types, startTime, endTime),
        }),
      /**
       * Async-iterate a project's events page by page; yields each page's entries array.
       * @param {string} projectId - The project to read
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * @param {string|string[]} [opts.types] - Only these types
       * @param {string} [opts.startTime] - Only events at or after this instant
       * @param {string} [opts.endTime] - Only events at or before this instant
       * @returns {AsyncGenerator<ClientEvent[]>}
       */
      iterPages: (projectId, { pageSize, types, startTime, endTime } = {}) =>
        iterPages(this, `/api/v1/projects/${projectId}/events`, {
          pageSize,
          query: eventQuery(types, startTime, endTime),
        }),
    };

    this.guidelines = {
      /**
       * Create a guideline in a project. `title` is the handle an assistant
       * asks for one by, and the only thing a person has to keep current. It is
       * NOT required to be unique, so a title already in use is written like
       * any other: warn about it, do not refuse it. A `pinned` guideline is one
       * the assistant is given in full on every turn.
       * @param {string} projectId - The project the guideline belongs to
       * @param {string} title - The handle an assistant asks for one by (1..100 characters)
       * @param {object} [opts]
       * @param {string} [opts.body] - The Markdown text (up to 20000 characters; may be empty)
       * @param {boolean} [opts.pinned] - Send this one to the assistant in full on every turn
       * @param {string} [opts.id] - The new guideline's id, minted by the caller (see uuidv7)
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<{id: string}>}
       */
      create: (projectId, title, { body, pinned, id } = {}, auditMessage) =>
        this._request("POST", `/api/v1/projects/${projectId}/guidelines`, {
          auditMessage,
          body: bodyOf({ id, title, body, pinned }),
        }),
      /**
       * Read one guideline, Markdown body included.
       * @param {string} id - The guideline id
       * @returns {Promise<Guideline>}
       */
      get: (id) => this._request("GET", `/api/v1/guidelines/${id}`),
      /**
       * Update a guideline. Every field is optional and an omitted one is
       * left alone, so an edit to the body need not restate the title.
       *
       * Pass `expectedUpdatedAt` (the `updatedAt` you last read) when a person
       * has been editing prose: the write then fails with 409 rather than
       * overwriting somebody who saved in between. Leave it off for a pin
       * toggle or a script, which have nothing of anyone's to lose.
       * @param {string} id - The guideline id
       * @param {object} [changes]
       * @param {string} [changes.title] - The new handle
       * @param {string} [changes.body] - The new Markdown text
       * @param {boolean} [changes.pinned] - Whether the assistant always gets it in full
       * @param {string} [changes.expectedUpdatedAt] - Write only if this is still the stored updatedAt
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<Guideline>}
       */
      update: (
        id,
        { title, body, pinned, expectedUpdatedAt } = {},
        auditMessage,
      ) =>
        this._request("PATCH", `/api/v1/guidelines/${id}`, {
          auditMessage,
          queryParams: { "updated-at": expectedUpdatedAt },
          body: bodyOf({ title, body, pinned }),
        }),
      /**
       * Delete a guideline.
       * @param {string} id - The guideline id
       * @param {string} [auditMessage] - Audit message for this write
       * @returns {Promise<void>}
       */
      delete: (id, auditMessage) =>
        this._request("DELETE", `/api/v1/guidelines/${id}`, { auditMessage }),
      /**
       * List a project's guidelines, by title. Transparently follows
       * pagination cursors and returns the full flat array.
       *
       * Without `includeBodies` each entry carries `bodyChars`, the length of
       * its body, so a caller can budget before fetching any. Pinned
       * guidelines are NOT sorted first: `pinned` is on every entry and
       * grouping is the caller's.
       * @param {string} projectId - The project to read
       * @param {object} [opts]
       * @param {boolean} [opts.includeBodies] - Return each body instead of its length
       * @returns {Promise<Guideline[]>}
       */
      list: (projectId, { includeBodies } = {}) =>
        listAll(this, `/api/v1/projects/${projectId}/guidelines`, {
          query: { "include-bodies": includeBodies },
        }),
      /**
       * Fetch a single page of a project's guidelines.
       * @param {string} projectId - The project to read
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {boolean} [opts.includeBodies] - Return each body instead of its length
       * @returns {Promise<Page<Guideline>>}
       */
      listPage: (projectId, { limit, cursor, includeBodies } = {}) =>
        listPage(this, `/api/v1/projects/${projectId}/guidelines`, {
          limit,
          cursor,
          query: { "include-bodies": includeBodies },
        }),
      /**
       * Async-iterate a project's guidelines page by page; yields each page's entries array.
       * @param {string} projectId - The project to read
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * @param {boolean} [opts.includeBodies] - Return each body instead of its length
       * @returns {AsyncGenerator<Guideline[]>}
       */
      iterPages: (projectId, { pageSize, includeBodies } = {}) =>
        iterPages(this, `/api/v1/projects/${projectId}/guidelines`, {
          pageSize,
          query: { "include-bodies": includeBodies },
        }),
    };
  }

  // --- Core methods ---

  /** @private */
  async _request(method, path, options = {}) {
    return makeRequest(this, method, path, options);
  }

  /**
   * Enter strict mode for a specific document, requiring document version
   * headers so that conflicting concurrent writes are rejected.
   * @param {string} documentId - The ID of the document to track versions for
   */
  enterStrictMode(documentId) {
    this.strictModeDocumentId = documentId;
  }

  /** Exit strict mode and stop tracking document versions for writes. */
  exitStrictMode() {
    this.strictModeDocumentId = null;
  }

  /**
   * Begin a LOGICAL OPERATION: a user-meaningful action ("Merge morphemes",
   * "Re-transcribe") implemented as many low-level writes, possibly across
   * several batches and even a service round-trip. Until `endOperation()`,
   * every write is stamped with a client-minted `?group-id=` (and the message)
   * so the audit log shows the whole run as ONE expandable entry labeled
   * `message`, with each write's own description underneath.
   *
   * Grouping is orthogonal to batches: a batch is a transaction boundary, an
   * operation is an intent boundary. An operation is NOT atomic — if write 3
   * of 5 fails, writes 1–2 stay committed (and logged under the group). Use a
   * batch inside the operation for any step that must be all-or-nothing.
   *
   * Nesting flattens: a `beginOperation` while one is open is a no-op that
   * joins the outer operation (the outer label wins), and the matching
   * `endOperation` is likewise a no-op. The label is recorded on the FIRST
   * write, so an operation that is never ended (crash, closed tab) is still
   * labeled in the log.
   *
   * "Every write" is the writes of project data. Reads never join, and neither
   * do the out-of-band signals shaped like a write (a document lock taken or
   * renewed, a stopped service request, a service reporting itself, an admin
   * control), and neither does a broadcast message (`messages.sendMessage`):
   * none of them is audited, so there would be nothing under the label.
   *
   * `kind` says what kind of operation this is, for a program reading the
   * log: one of `assistant-plan`, `service-run`, `import`, `bulk-edit`,
   * `guess-adoption`, `repair` or `review` (the server refuses any other).
   * Any other kind throws here, before anything is written.
   * `ref` is a short string naming what the operation came from, in the
   * shape its kind documents (the core manual, "Kinds of operation"). Both
   * are recorded from the first write like the label, and a nested operation
   * keeps the outer one's.
   *
   * `keys` (from `keySeed()`) makes a run of the operation send the same
   * requests as an earlier run with the same keys: the nth keyed request that
   * joins it takes the Idempotency-Key `<seed>.<n>` and the document-version
   * its first run claimed, so a request that landed is answered from its
   * first send and writes nothing again. The count starts at 0 at each
   * outermost begin. A nested operation joins the outer one's keys, unless it
   * brings its own: then it numbers from 0 under its own seed until its
   * matching end, and the outer numbering resumes after it.
   *
   * @param {string} message - Human label for the operation.
   * @param {{groupId?: string, kind?: OperationKind, ref?: string, keys?: KeySeed, minted?: Iterable<string>}} [opts] - Optional `{ groupId, kind, ref, keys, minted }`. `groupId` adopts an existing group id instead of minting one (a service joining the requester's operation; `requestService` propagates an open operation to the service automatically). Python's is `group_id`. `kind`, `ref` and `keys` are described above. `minted` is the ids the operation mints for what it creates: a create refused 409 id-taken for one of them was made by an earlier send of the operation, and answers as made.
   * @returns {string} The operation's group id.
   */
  beginOperation(message, { groupId, kind, ref, keys, minted } = {}) {
    return beginOperation(this, message, { groupId, kind, ref, keys, minted });
  }

  /**
   * A seed for the Idempotency-Keys of a logical operation that may be run
   * again from the top (see beginOperation's `keys`). Keep it with the work
   * it belongs to and pass it to every run.
   * @returns {KeySeed}
   */
  keySeed() {
    return keySeed();
  }

  /**
   * End the current logical operation. With no argument this is purely local
   * (no request). Pass a refined `message` to relabel the group now that the
   * outcome is known (e.g. `endOperation('Merged 3 morphemes')`) — that sends
   * one PATCH, skipped if the operation never wrote anything. A refine from a
   * nested (flattened) `endOperation` is ignored; the outer label wins.
   * @param {string} [message] - Optional refined label.
   * @returns {Promise<void>}
   */
  async endOperation(message) {
    return endOperation(this, message);
  }

  /**
   * Run `fn` as one logical operation (see beginOperation), ending it when
   * `fn` settles — including on throw. `fn` receives a `setMessage(msg)`
   * callback to refine the label once the outcome is known.
   *
   *   await client.withOperation('Merge morphemes', async (setMessage) => {
   *     await client.batched(async (b) => { ... });
   *     setMessage(`Merged ${n} morphemes`);
   *   });
   *
   * The kind and reference (see beginOperation) come after `fn`:
   *
   *   await client.withOperation('Import ELAN corpus', run, { kind: 'import', ref: 'format:elan' });
   *
   * @template T
   * @param {string} message - Human label for the operation.
   * @param {(setMessage: (msg: string) => void) => T | Promise<T>} fn - The work to run; receives `setMessage(msg)` to refine the label once the outcome is known.
   * @param {{kind?: OperationKind, ref?: string, groupId?: string, keys?: KeySeed, minted?: Iterable<string>}} [opts] - Optional `{ kind, ref, groupId, keys, minted }`, as for beginOperation. `kind` is one of `assistant-plan`, `service-run`, `import`, `bulk-edit`, `guess-adoption`, `repair` or `review`, and any other throws before `fn` runs.
   * @returns {Promise<T>} Whatever `fn` resolves to.
   */
  async withOperation(message, fn, { kind, ref, groupId, keys, minted } = {}) {
    return withOperation(this, message, fn, { kind, ref, groupId, keys, minted });
  }


  /**
   * Open a batch: a view of this client with the same bundles, on which every
   * write of project data queues instead of going out. `submit()` sends the
   * queued operations as ONE atomic request (larger than the server's cap,
   * as consecutive requests with the results concatenated in queue order,
   * each atomic on its own, so a failure in a later one leaves the earlier
   * ones committed, and the error it throws carries `committed`, the count
   * saved, and `committedResults`, their results) and
   * resolves to one result per operation; `abort()` drops them. A call made
   * on the client itself is never touched by an open batch, and a read or an
   * out-of-band signal made on the batch goes over the wire now (see the note
   * at the top of `http.js`).
   *
   *   const b = client.batch();
   *   b.tokens.bulkCreate(sentenceOps);
   *   b.tokens.bulkCreate(wordOps);
   *   const [sentRes, wordRes] = await b.submit();
   *
   * Server-side a batch runs sequentially in one transaction: a child op sees
   * parents created earlier in the same batch, and any op's failure rolls the
   * whole batch back. A batch is not nestable. Prefer `batched()`, which
   * submits or aborts for you.
   *
   * `timeout` (ms, or null for none) is how long each of this batch's
   * requests may wait for its answer, in place of the client's
   * `batchTimeout`, for this batch alone.
   * @param {{timeout?: number | null}} [options]
   * @returns {PlaidBatch} the batch view
   */
  batch({ timeout } = {}) {
    return openBatch(this, { timeout });
  }

  /**
   * POST one batch request (at most MAX_BATCH_OPS operations). Resolves to
   * one `{ status, headers, body }` per operation, with only the body
   * recased: the headers keep the server's spelling. `key` is the request's
   * Idempotency-Key: a batch whose answer is lost (no response, 502, 504) is
   * sent again under it, and answered from the first send if that landed.
   * `timeout` is this request's, in place of `batchTimeout` when given.
   * See postBatch in http.js.
   * @param {string} url
   * @param {object[]} body
   * @param {{key?: string, timeout?: number | null}} [options]
   * @private
   */
  async _postBatch(url, body, options) {
    return postBatch(this, url, body, options);
  }


  /**
   * Run `fn` with a batch, then submit all queued ops as `submit()` does (ONE
   * atomic request up to MAX_BATCH_OPS operations, consecutive requests past
   * it), or abort the batch if `fn` throws. `fn` receives the batch and makes its
   * writes on it; it must NOT call `submit()` itself. Resolves to the batch
   * results array (`[]` if `fn` queued nothing).
   *
   *   const [sentRes, wordRes] = await client.batched(async (b) => {
   *     b.tokens.bulkCreate(sentenceOps);
   *     b.tokens.bulkCreate(wordOps);
   *   });
   *
   * A write made on `client` inside `fn` is not part of the batch: it goes
   * over the wire at once, as it would anywhere else. See `batch()`, which
   * also says what `timeout` does.
   * @param {(batch: PlaidBatch) => (void | Promise<void>)} fn
   * @param {{timeout?: number | null}} [options]
   * @returns {Promise<any[]>}
   */
  async batched(fn, { timeout } = {}) {
    const batch = this.batch({ timeout });
    try {
      await fn(batch);
    } catch (e) {
      batch.abort();
      throw e;
    }
    return batch.submit();
  }

  /**
   * Liveness, version and database size, with NO authentication and no client
   * instance — for a launcher or status page checking whether a server is up
   * before anyone logs in.
   * @param {string} baseUrl - The API base URL
   * @param {{timeout?: number | null}} [options]
   * @returns {Promise<ServerHealth>}
   */
  static async health(baseUrl, options = {}) {
    return anonymousRequest("GET", baseUrl, "/health", undefined, options);
  }

  /**
   * The limits this server enforces, with NO authentication and no client
   * instance. See the instance method for the shape.
   * @param {string} baseUrl - The API base URL
   * @param {{timeout?: number | null}} [options]
   * @returns {Promise<{limits: ServerLimits}>}
   */
  static async info(baseUrl, options = {}) {
    return anonymousRequest("GET", baseUrl, "/api/v1/info", undefined, options);
  }

  /**
   * Build the link to hand someone for an invite code. The server never sees
   * an app URL, so the app that minted the invite is the one that names it.
   * Both SPAs use HashRouter, so the code rides in the fragment — which also
   * keeps it out of server access logs.
   * @param {string} appUrl - Where the SPA lives, e.g. "https://plaid.example.org/igt/"
   * @param {string} code - The code returned by invites.create()
   * @returns {string}
   */
  static inviteUrl(appUrl, code) {
    return `${appUrl.replace(/#.*$/, "").replace(/\/$/, "")}/#/invite/${encodeURIComponent(code)}`;
  }

  /**
   * Describe an invite code, with NO authentication — this is what a signup
   * page calls before the redeemer has an account. Returns the kind of link
   * ("signup" or "password-reset"), its status ("active", "used", "expired",
   * "revoked", or "inactive" when its creator can no longer grant what it
   * grants), and the project it grants access to, if any.
   *
   * Throws a 404-shaped error if the code is unknown. A known-but-dead code
   * resolves normally with a non-"active" status, so the page can say why.
   * @param {string} baseUrl - The API base URL
   * @param {string} code - The invite code
   * @param {object} [options]
   * @returns {Promise<{kind: string, status: string, expiresAt: string, projectName?: string, projectRole?: string, email?: string, grantAdmin: boolean}>}
   */
  static async lookupInvite(baseUrl, code, options = {}) {
    return anonymousRequest("POST", baseUrl, "/api/v1/invites/lookup", { code }, options);
  }

  /**
   * Redeem an invite code, with NO authentication.
   *
   * For a signup invite, pass `email` and `password` to create the account
   * (and optionally `displayName`); the invite's grants are applied in the
   * same transaction. For a password reset link, pass `password` only.
   * Resolves to a logged-in client, exactly like login() — the redeemer just
   * chose these credentials, so there is no reason to send them to a login
   * form to retype them.
   * @param {string} baseUrl - The API base URL
   * @param {string} code - The invite code
   * @param {object} credentials
   * @param {string} [credentials.email] - The new account's email address,
   *   which becomes its id and login (signup only)
   * @param {string} [credentials.displayName] - How the new user is shown in
   *   the UI; defaults to the local part of the email (signup only)
   * @param {string} credentials.password - Desired password (min 8 characters)
   * @param {object} [options]
   * @returns {Promise<{client: PlaidClient, userId: string, kind: string}>}
   */
  static async redeemInvite(
    baseUrl,
    code,
    { email, password, displayName } = {},
    options = {},
  ) {
    const data = await anonymousRequest(
      "POST",
      baseUrl,
      "/api/v1/invites/redeem",
      bodyOf({
        code,
        email: normalizeUserId(email),
        password,
        "display-name": displayName,
      }),
      options,
    );
    return {
      client: new PlaidClient(
        baseUrl.replace(/\/$/, ""),
        data.token || "",
        options,
      ),
      userId: data.userId,
      kind: data.kind,
    };
  }

  /**
   * Authenticate and return a new client instance with token. This is the
   * single auth entry point — there is no `client.login` resource.
   * @param {string} baseUrl - The base URL for the API
   * @param {string} userId - User ID for authentication
   * @param {string} password - Password for authentication
   * @param {object} [options] - Client options forwarded to the constructor (e.g. { timeout })
   * @returns {Promise<PlaidClient>} - Authenticated client instance
   */
  static async login(baseUrl, userId, password, options = {}) {
    baseUrl = baseUrl.replace(/\/$/, "");
    const data = await anonymousRequest(
      "POST",
      baseUrl,
      "/api/v1/login",
      { "user-id": normalizeUserId(userId), password },
      options,
    );
    return new PlaidClient(baseUrl, data.token || "", options);
  }
}

export { PlaidClient };
