/**
 * The server bundles: the server's facts and health, the instance admin
 * controls and the instance-wide audit log, each a factory of the client
 * (client.js installs them).
 */

import { auditQuery } from "./families.js";
import { iterPages, listAll, listPage } from "./pagination.js";
import { PlaidClient } from "./client.js";

/**
 * How long `admin.backup()` waits for the server to finish writing a backup:
 * minutes on a large database, past the usual per-request timeout.
 */
export const BACKUP_TIMEOUT_MS = 30 * 60 * 1000;

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

// Server-level facts. Read once, and again only when they may have
// changed: after this client's connection to the server was lost and came
// back (a restart, the only way the limits change, always drops it), or
// after the server refused a private data write as too large. A caller
// asking "will this file be accepted" does not pay a round trip to find
// out. The facts live on the client (`_serverFacts`), so a batch opened
// on it reads the same.
/** @param {import("./client.js").PlaidClient} client */
export function serverApi(client) {
  return {
    /**
     * This server's version and the limits it enforces, e.g.
     * `{ limits: { mediaFileBytes, jsonBodyBytes, batchOperations, … } }`.
     * Sizes are in bytes. Unauthenticated.
     * @returns {Promise<{limits: ServerLimits}>}
     */
    info: () => {
      const facts = client._serverFacts;
      if (!facts.info) {
        const asked = client._request("GET", "/api/v1/info").catch((err) => {
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
      const facts = client._serverFacts;
      const before = facts.info;
      facts.stale = false;
      const fresh = client._request("GET", "/api/v1/info");
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
      const self = client;
      return (await self.server.info()).limits;
    },
    /**
     * Liveness, version and database size. Unauthenticated, and served
     * outside the REST router at /health, so it answers even while the API
     * is refusing requests. Never cached — the point is that it is current.
     * @returns {Promise<ServerHealth>}
     */
    health: () => PlaidClient.health(client.baseUrl, { timeout: client.timeout }),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function adminApi(client) {
  return {
    /**
     * Everything about the server in one read: version and JVM uptime,
     * database size and per-table row counts, media directory usage, backup
     * configuration and the backups on disk, and the settings an operator
     * gets asked to confirm. Carries no secrets. Runs a count per table and
     * walks the media directory, so open it, do not poll it. Admin only.
     * @returns {Promise<ServerReport>}
     */
    server: () => client._request("GET", "/api/v1/admin/server"),
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
      client._request("POST", "/api/v1/admin/backup", {
        outOfBand: true,
        timeout: BACKUP_TIMEOUT_MS,
      }),
    /**
     * Documents currently held by an editing lock, with who holds each and
     * when it expires on its own. Admin only.
     * @returns {Promise<{entries: Array<{documentId: string, userId: string, expiresAt: number}>}>}
     */
    locks: () => client._request("GET", "/api/v1/admin/locks"),
    /**
     * Drop the lock on a document whoever holds it. Idempotent. For a client
     * that went away without releasing one. Admin only.
     * @param {string} documentId - The document ID
     * @returns {Promise<{result: string}>}
     */
    releaseLock: (documentId) =>
      client._request("DELETE", `/api/v1/admin/locks/${documentId}`, {
        outOfBand: true,
      }),
    /**
     * Live login and invite rate-limit buckets: the address, the account
     * where there is one, failures inside the window, the limit, and whether
     * it is currently blocking. Admin only.
     * @returns {Promise<RateLimitSnapshot>}
     */
    rateLimits: () => client._request("GET", "/api/v1/admin/rate-limits"),
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
      client._request("DELETE", "/api/v1/admin/rate-limits", {
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
      client._request("GET", "/api/v1/admin/logs", {
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
      client._request("GET", "/api/v1/admin/logs/file", {
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
      listAll(client, "/api/v1/admin/user-data", {
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
      listPage(client, "/api/v1/admin/user-data", {
        limit,
        cursor,
        query: {
          prefix,
          pattern,
          "include-values": includeValues,
        },
      }),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function auditApi(client) {
  return {
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
      listAll(client, "/api/v1/audit", {
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
      listPage(client, "/api/v1/audit", {
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
      iterPages(client, "/api/v1/audit", {
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
      const result = await client._request("GET", path, {
        queryParams: {
          "start-time": startTime,
          "end-time": endTime,
          daily,
        },
      });
      return result.entries;
    },
  };
}
