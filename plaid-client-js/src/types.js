/**
 * The shapes the Plaid API answers with and takes, as JSDoc typedefs, for
 * editors and for the declarations `npm run types` generates (types.d.ts).
 * The package root re-exports every one of them. No runtime code.
 */

/**
 * @typedef {import("./textEdits.js").TextEditOp} TextEditOp
 * @typedef {import("./textEdits.js").TextGap} TextGap
 * @typedef {import("./metadataOps.js").MetadataOp} MetadataOp
 * @typedef {import("./constraints.js").LayerConstraint} LayerConstraint
 * @typedef {import("./constraints.js").ConstraintWriteOptions} ConstraintWriteOptions
 * @typedef {import("./constraints.js").ConstraintViolation} ConstraintViolation
 * @typedef {import("./requester.js").Requester} Requester
 * @typedef {import("./batchRef.js").BatchRef} BatchRef
 * @typedef {import("./serviceSchema.js").ServiceParam} ServiceParam
 * @typedef {import("./serviceSchema.js").ServiceInfo} ServiceInfo
 * @typedef {import("./serviceSchema.js").DiscoveredService} DiscoveredService
 * @typedef {import("./services.js").ResponseHelper} ResponseHelper
 * @typedef {import("./services.js").ServiceRegistration} ServiceRegistration
 * @typedef {import("./services.js").ServiceStatusEvent} ServiceStatusEvent
 * @typedef {import("./index.js").PlaidClient["operationGroups"]} OperationGroupsBundle
 */

/**
 * A single page of a cursor-paginated collection.
 * @template [T=any]
 * @typedef {{entries: T[], nextCursor: string | null}} Page
 */

/**
 * Client options.
 * @typedef {object} PlaidClientOptions
 * @property {number | null} [timeout] Per-request timeout in ms (default
 *   30000, 0 or null disables it).
 * @property {number | null} [batchTimeout] Timeout for batch submissions in
 *   ms (default 180000, 0 or null disables it). Aborting a batch does NOT
 *   stop the server, which keeps running the transaction and holding the
 *   write lock. Defaults to `timeout` when that is given and this is not.
 * @property {number[]} [retryDelaysMs] Delays in ms before sending a keyed
 *   write again when its answer was lost (no response, 502 or 504). Default
 *   [1000, 3000, 9000].
 * @property {((error: Error) => void) | null} [onAuthError] Fired once when
 *   a request returns HTTP 401 (missing, expired or invalid token). 403 does
 *   NOT trigger it.
 */

/**
 * What kind of operation a logical-operation group is (`?group-kind=`).
 * @typedef {"assistant-plan" | "service-run" | "import" | "bulk-edit"
 *   | "guess-adoption" | "repair" | "review"} OperationKind
 */

/**
 * Idempotency-Key seed for an operation run more than once (`client.keySeed()`).
 * @typedef {{seed: string, stamps: Map<number, number | null>}} KeySeed
 */

/**
 * A batch: the client's bundles, on which every write of project data queues
 * until `submit()`. See `PlaidClient.batch()`. `submit()` resolves to one
 * result per operation, in order. `ref(opIndex, index)` stands for the id a
 * queued operation will create, in the body of a later write on this batch.
 * @typedef {import("./index.js").PlaidClient & {
 *   readonly client: import("./index.js").PlaidClient,
 *   readonly operations: Array<{path: string, method: string, body?: any}>,
 *   submit(): Promise<any[]>,
 *   abort(): void,
 *   ref(opIndex?: number, index?: number): BatchRef,
 * }} PlaidBatch
 */

/**
 * Options for a single page of any audit log. `kinds` keeps only the entries
 * of operations of these kinds, each whole. `order: "desc"` pages newest
 * first, and a cursor belongs to the direction that made it. `opsLimit` keeps
 * only each entry's oldest N operations in `ops` (1..1000), and every entry
 * has `opCount`. `entryId` reads only that entry rather than a page.
 * @typedef {object} AuditPageOptions
 * @property {string} [startTime]
 * @property {string} [endTime]
 * @property {string[] | string} [opTypes]
 * @property {OperationKind[] | string} [kinds]
 * @property {"asc" | "desc"} [order]
 * @property {number} [limit]
 * @property {string} [cursor]
 * @property {number} [opsLimit]
 * @property {string} [entryId]
 */

/**
 * What `vocabLayers.restoreItem` did, or with `dryRun` would do.
 * @typedef {object} VocabItemRestoreSummary
 * @property {boolean} inserted The entry was gone and came back under its old id.
 * @property {boolean} form A living entry's form was set back.
 * @property {boolean} metadata A living entry's fields were set back.
 * @property {number} total 0 when nothing changes.
 */

/**
 * One private data entry. `version` is raised by one on every write of the
 * entry, and a new entry is 1.
 * @typedef {{key: string, updatedAt: string, version: number, value?: any}} UserDataEntry
 */

/** @typedef {UserDataEntry & {userId: string}} AdminUserDataEntry */

/**
 * One user's activity over a scope and window (`audit.tally`).
 * @typedef {object} ActivityTallyRow
 * @property {{id: string, displayName?: string}} user
 * @property {number} operations
 * @property {number} changes
 * @property {number} documents
 * @property {string} firstTs
 * @property {string} lastTs
 * @property {Array<{date: string, changes: number}>} [byDay]
 */

/**
 * What a constraint repair did in one document.
 * @typedef {{document: string, constraint: string, deleted: number, joined: number}} ConstraintRepair
 */

/**
 * A value-set rule as `refusedValues` takes it: the list, the characters a
 * value is split on, and whether every part (`"all"`, the default) or only
 * the first must be listed.
 * @typedef {{values: string[], delimiters?: string, parts?: "all" | "first"}} ValueSetRule
 */

/**
 * What a value-set rule would refuse in a layer's stored values: how many,
 * how many distinct, and the most frequent with the parts not listed.
 * @typedef {object} RefusedValues
 * @property {number} count
 * @property {number} valueCount
 * @property {Array<{value: any, parts: string[], count: number}>} values
 */

/**
 * Entities that can carry a comment.
 * @typedef {"document" | "text" | "token" | "span" | "relation" | "vocab-item"} CommentableType
 */

/**
 * One comment. `projectId` and `documentId` are null for a comment on a
 * vocabulary entry, and `vocabLayerId` is set only for one. `anchorLabel` is
 * what the comment is about, in words, captured when it was posted: a
 * comment outlives its anchor. `edited` is true once the body has been
 * rewritten since it was posted.
 * @typedef {object} Comment
 * @property {string} id
 * @property {string | null} projectId
 * @property {string | null} documentId
 * @property {string | null} vocabLayerId
 * @property {CommentableType} entityType
 * @property {string} entityId
 * @property {string | null} anchorLabel
 * @property {string} authorId
 * @property {string} body
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {boolean} edited
 */

/**
 * One entry in a project's annotation manual. `body` is present on a single
 * read and on a list made with `includeBodies`, `bodyChars` on a list made
 * without. `pinned`: the assistant is given this one in full on every turn.
 * @typedef {object} Guideline
 * @property {string} id
 * @property {string} projectId
 * @property {string} title
 * @property {string} [body]
 * @property {number} [bodyChars]
 * @property {boolean} pinned
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * A research-telemetry event type.
 * @typedef {"suggestion.shown" | "suggestion.adopted" | "suggestion.dismissed" | "plan.opened"} ClientEventType
 */

/**
 * One research-telemetry event as the server stores it.
 * @typedef {object} ClientEvent
 * @property {number} id
 * @property {string} projectId
 * @property {string | null} documentId
 * @property {string} userId
 * @property {ClientEventType} type
 * @property {string | null} targetId
 * @property {Record<string, any> | null} data
 * @property {string | null} clientTs
 * @property {string} ts
 */

/**
 * An invite. `kind` is "signup" or "password-reset", `status` "active",
 * "used", "expired", "revoked" or "inactive".
 * @typedef {object} Invite
 * @property {string} id
 * @property {string} kind
 * @property {string} status
 * @property {string} createdBy
 * @property {string} createdAt
 * @property {string} expiresAt
 * @property {number} maxUses
 * @property {number} uses
 * @property {string | null} revokedAt
 * @property {string | null} note
 * @property {string | null} targetUserId
 * @property {boolean} grantAdmin
 * @property {string | null} projectId
 * @property {string | null} projectRole
 */

/**
 * Server limits, as reported by /api/v1/info. An unset limit is absent.
 * `passwordMinLength` is the shortest password the server accepts on any
 * path, `lockExpirationMs` how long a document lock is held before it lapses.
 * `queryBranches` is the most branches a query's `or` and `seq` may expand
 * to, `queryClauseDepth` the deepest its clauses may nest.
 * @typedef {object} ServerLimits
 * @property {number} [mediaFileBytes]
 * @property {number} [jsonBodyBytes]
 * @property {number} [batchOperations]
 * @property {number} [metadataDepth]
 * @property {number} [metadataKeyCount]
 * @property {number} [metadataStringLength]
 * @property {number} [metadataTotalBytes]
 * @property {number} [userDataValueBytes]
 * @property {number} [guidelineTitleLength]
 * @property {number} [guidelineBodyLength]
 * @property {number} [commentBodyLength]
 * @property {number} [passwordMinLength]
 * @property {number} [lockExpirationMs]
 * @property {number} [queryBranches]
 * @property {number} [queryClauseDepth]
 */

/**
 * @typedef {object} ServerHealth
 * @property {boolean} ok
 * @property {string} version
 * @property {number} uptimeMs
 * @property {{dbSizeMb?: number, auditRows?: number, error?: string}} audit
 */

/**
 * @typedef {{ip: string, userId?: string, failures: number, limit: number, blocked: boolean}} RateLimitBucket
 */

/**
 * @typedef {object} RateLimitSnapshot
 * @property {number} windowMs
 * @property {RateLimitBucket[]} logins
 * @property {RateLimitBucket[]} ips
 * @property {RateLimitBucket[]} invites
 */

/**
 * @typedef {object} BackupStatus
 * @property {boolean} enabled
 * @property {string} directory
 * @property {number} retention
 * @property {string} time
 * @property {Array<{name: string, bytes: number, modified: string}>} backups
 * @property {boolean} [ok]
 */

/**
 * @typedef {object} ServerReport
 * @property {string} version
 * @property {{uptimeMs: number, startedAt: string, java: string, heapUsed: number, heapMax: number}} jvm
 * @property {{path: string | null, bytes: number | null, walBytes: number | null,
 *   slowQueryThresholdMs?: number, journalMode?: string, maxPoolSize?: number,
 *   tables: Record<string, number | null>}} database
 * @property {{directory: string, files: number, bytes: number, orphans: number, orphanBytes: number}} media
 * @property {BackupStatus} backup
 * @property {Record<string, any>} settings
 */

/**
 * The live log. Requests and events are buffered separately, so a burst of
 * requests cannot evict an error. In each, `matched` is how many passed the
 * filters (which may exceed what `entries` holds) and `held` how many are
 * buffered in total. `file` is the configured log file's absolute path, or
 * null when logging to stdout.
 * @typedef {object} LiveLog
 * @property {{entries: object[], matched: number, held: number, capacity: number,
 *   stats: Record<string, number | null>}} requests
 * @property {{entries: object[], matched: number, held: number, capacity: number,
 *   byLevel: Record<string, number>}} events
 * @property {string | null} file
 */

/**
 * An open server-sent-events stream. Once CLOSED, `error` says why: null when
 * this side closed it. A refused stream's error carries the HTTP `status`,
 * and one the server ended is named "StreamClosed".
 * @typedef {object} SSEConnection
 * @property {() => void} close
 * @property {() => SSEStats} getStats
 * @property {number} readyState
 * @property {(Error & {status?: number}) | null} error
 */

/**
 * How an SSE connection has fared so far. `events` counts what arrived by
 * event type ("audit-log", "message", "heartbeat", "connected", "other").
 * @typedef {object} SSEStats
 * @property {number} durationSeconds
 * @property {boolean} isConnected
 * @property {boolean} isClosed
 * @property {string | null} clientId
 * @property {Record<string, number>} events
 * @property {number} readyState
 */

/**
 * A value a span or relation holds: a JSON scalar.
 * @typedef {string | number | boolean | null} AtomicValue
 */

/**
 * What a create answers: the new record's id.
 * @typedef {{id: string}} Created
 */

/**
 * A project. `textLayers` nests its layers in their display order, each
 * with the layers built on it, and `vocabs` lists the vocabularies linked to
 * it.
 * @typedef {object} Project
 * @property {string} id
 * @property {string} name
 * @property {Record<string, any>} config
 * @property {string[]} readers
 * @property {string[]} writers
 * @property {string[]} maintainers
 * @property {ProjectTextLayer[]} textLayers
 * @property {ProjectVocab[]} vocabs
 */

/**
 * @typedef {{id: string, name: string, config: Record<string, any>, tokenLayers: ProjectTokenLayer[]}} ProjectTextLayer
 * @typedef {{id: string, name: string, config: Record<string, any>,
 *   constraints: Record<string, LayerConstraint[]>, spanLayers: ProjectSpanLayer[]}} ProjectTokenLayer
 * @typedef {{id: string, name: string, config: Record<string, any>,
 *   constraints: Record<string, LayerConstraint[]>, relationLayers: ProjectRelationLayer[]}} ProjectSpanLayer
 * @typedef {{id: string, name: string, config: Record<string, any>,
 *   constraints: Record<string, LayerConstraint[]>}} ProjectRelationLayer
 * @typedef {{id: string, name: string, maintainers: string[], config: Record<string, any>}} ProjectVocab
 */

/**
 * A document. `version` rises by one on every write to it or its layers.
 * A read with `includeBody` also carries `textLayers`, the document's
 * annotation nested under each layer.
 * @typedef {object} PlaidDocument
 * @property {string} id
 * @property {string} name
 * @property {string} project
 * @property {number} version
 * @property {string} timeCreated
 * @property {string} timeModified
 * @property {Record<string, any>} [metadata]
 * @property {DocumentTextLayer[]} [textLayers]
 */

/**
 * A text layer as a document read nests it: `text` is null where the
 * document has no text in this layer.
 * @typedef {object} DocumentTextLayer
 * @property {string} id
 * @property {string} name
 * @property {Record<string, any>} config
 * @property {{id: string, document: string, body: string, digest: string,
 *   metadata?: Record<string, any>} | null} text
 * @property {DocumentTokenLayer[]} tokenLayers
 */

/**
 * @typedef {object} DocumentTokenLayer
 * @property {string} id
 * @property {string} name
 * @property {Record<string, any>} config
 * @property {Record<string, LayerConstraint[]>} constraints
 * @property {string} overlapMode
 * @property {string | null} parentTokenLayer
 * @property {Array<{id: string, begin: number, end: number, precedence: number | null,
 *   metadata?: Record<string, any>}>} tokens
 * @property {DocumentSpanLayer[]} spanLayers
 * @property {Array<ProjectVocab & {vocabLinks: Array<{id: string, vocabItem: VocabItem,
 *   tokens: string[], metadata?: Record<string, any>}>}>} vocabs
 */

/**
 * @typedef {object} DocumentSpanLayer
 * @property {string} id
 * @property {string} name
 * @property {Record<string, any>} config
 * @property {Record<string, LayerConstraint[]>} constraints
 * @property {Array<{id: string, value: AtomicValue, tokens: string[],
 *   metadata?: Record<string, any>}>} spans
 * @property {Array<ProjectRelationLayer & {relations: Array<{id: string, source: string,
 *   target: string, value: AtomicValue, metadata?: Record<string, any>}>}>} relationLayers
 */

/**
 * A text: one document's body in one text layer. `digest` names the body,
 * as an edit's `base`.
 * @typedef {object} PlaidText
 * @property {string} id
 * @property {string} body
 * @property {string} document
 * @property {string} layer
 * @property {string} digest
 * @property {Record<string, any>} [metadata]
 */

/**
 * What a text write changed besides the body: the tokens whose extent
 * moved (with `layer` and `text` on one the write made), the spans and
 * vocabulary links whose tokens or value changed, and the ids of what it
 * deleted.
 * @typedef {object} TextReshape
 * @property {Array<{id: string, begin: number, end: number, layer?: string, text?: string}>} tokens
 * @property {Array<{id: string, tokens?: string[], value?: AtomicValue}>} spans
 * @property {Array<{id: string, tokens: string[]}>} vocabLinks
 * @property {{tokens: string[], spans: string[], relations: string[], vocabLinks: string[]}} deleted
 */

/**
 * A token. `value` is the text it covers.
 * @typedef {object} Token
 * @property {string} id
 * @property {string} text
 * @property {number} begin
 * @property {number} end
 * @property {string} layer
 * @property {string} document
 * @property {number | null} precedence
 * @property {string} value
 * @property {Record<string, any>} [metadata]
 */

/**
 * @typedef {object} Span
 * @property {string} id
 * @property {string} layer
 * @property {string} document
 * @property {AtomicValue} value
 * @property {string[]} tokens
 * @property {Record<string, any>} [metadata]
 */

/**
 * A relation, from the span `source` to the span `target`.
 * @typedef {object} Relation
 * @property {string} id
 * @property {string} layer
 * @property {string} document
 * @property {string} source
 * @property {string} target
 * @property {AtomicValue} value
 * @property {Record<string, any>} [metadata]
 */

/**
 * @typedef {object} VocabItem
 * @property {string} id
 * @property {string} layer
 * @property {string} form
 * @property {Record<string, any>} [metadata]
 */

/**
 * A link from a vocabulary entry to the tokens of one occurrence.
 * @typedef {object} VocabLink
 * @property {string} id
 * @property {string} vocabItem
 * @property {string} document
 * @property {string[]} tokens
 * @property {Record<string, any>} [metadata]
 */

/**
 * A vocabulary. `items` is there on a read made with `includeItems`.
 * @typedef {object} VocabLayer
 * @property {string} id
 * @property {string} name
 * @property {string} timeCreated
 * @property {string} timeModified
 * @property {Record<string, any>} config
 * @property {string[]} maintainers
 * @property {VocabItem[]} [items]
 */

/**
 * @typedef {{id: string, name: string, project: string, config: Record<string, any>}} TextLayer
 * @typedef {{id: string, name: string, textLayer: string, project: string, overlapMode: string,
 *   parentTokenLayer: string | null, config: Record<string, any>,
 *   constraints: Record<string, LayerConstraint[]>}} TokenLayer
 * @typedef {{id: string, name: string, tokenLayer: string, project: string, config: Record<string, any>,
 *   constraints: Record<string, LayerConstraint[]>}} SpanLayer
 * @typedef {{id: string, name: string, spanLayer: string, project: string, config: Record<string, any>,
 *   constraints: Record<string, LayerConstraint[]>}} RelationLayer
 */

/**
 * The records with metadata, by the path segment of their routes.
 * @typedef {{documents: PlaidDocument, texts: PlaidText, tokens: Token, spans: Span,
 *   relations: Relation, "vocab-items": VocabItem, "vocab-links": VocabLink}} MetadataRecords
 */

/**
 * The four layer kinds, by the path segment of their routes.
 * @typedef {{"text-layers": TextLayer, "token-layers": TokenLayer, "span-layers": SpanLayer,
 *   "relation-layers": RelationLayer}} LayerRecords
 */

/**
 * @typedef {object} User
 * @property {string} id
 * @property {string} displayName
 * @property {boolean} isAdmin
 * @property {string | null} deactivatedAt
 * @property {string | null} avatarHash
 */

/**
 * A project as the project list gives it: the project, with how many
 * documents it has and when the newest of them last changed.
 * @typedef {Project & {documentCount: number, lastModified: string | null}} ProjectListEntry
 */

/**
 * A document as a project's document list gives it.
 * @typedef {object} DocumentListEntry
 * @property {string} id
 * @property {string} name
 * @property {number} version
 * @property {string} timeCreated
 * @property {string} timeModified
 */

/**
 * A named API token, without the signed token itself, which only `create`
 * returns.
 * @typedef {object} ApiToken
 * @property {string} id
 * @property {string} userId
 * @property {string} name
 * @property {string} createdAt
 * @property {string | null} lastUsedAt
 * @property {string | null} revokedAt
 */

/**
 * Who made an operation, as the audit log names them.
 * @typedef {{id: string, displayName: string, avatarHash: string | null}} AuditUser
 */

/**
 * A project or a document an audit entry names, while it exists.
 * @typedef {{id: string, name: string}} AuditTarget
 */

/**
 * One operation of an audit entry.
 * @typedef {object} AuditOp
 * @property {string} id
 * @property {string} type The kind of write, such as "document/update".
 * @property {string} description
 * @property {string} time
 * @property {string} endTime The time to read at to see the operation done.
 * @property {AuditUser | null} user
 * @property {string} [credential]
 * @property {AuditTarget} [project]
 * @property {AuditTarget} [document]
 * @property {string} [batchId]
 */

/**
 * One entry of an audit log: a logical operation, an atomic batch or a lone
 * write, with its operations oldest first (`ops`, cut to `opsLimit` when one
 * was asked for, while `opCount` counts them all).
 * @typedef {object} AuditEntry
 * @property {string} id
 * @property {string} time
 * @property {string} endTime
 * @property {AuditUser | null} user
 * @property {AuditTarget[]} projects
 * @property {AuditTarget[]} documents
 * @property {AuditOp[]} ops
 * @property {number} opCount
 * @property {string} [groupId]
 * @property {string} [message]
 * @property {OperationKind} [kind]
 * @property {string} [ref]
 * @property {string} [batchId]
 * @property {{id: string, name: string}} [apiToken]
 * @property {string} [credential]
 */

/**
 * A document lock as its holder sees it. `expiresAt` is in epoch
 * milliseconds.
 * @typedef {{lockId: string, userId: string, expiresAt: number}} LockGrant
 */

/**
 * What `documents.restore` did, or with `dryRun` would do: per kind of
 * record, how many come back, are set back and are removed (per layer for
 * the layered kinds), and what could not come back, with why.
 * @typedef {object} DocumentRestoreSummary
 * @property {boolean} name
 * @property {boolean} documentMetadata
 * @property {RestoreCounts} texts
 * @property {RestoreCounts & {byLayer: Array<RestoreCounts & {layerId: string}>}} tokens
 * @property {RestoreCounts & {byLayer: Array<RestoreCounts & {layerId: string}>}} spans
 * @property {RestoreCounts & {byLayer: Array<RestoreCounts & {layerId: string}>}} relations
 * @property {RestoreCounts} vocabLinks
 * @property {Array<{kind: string, count: number, reason: string}>} skipped
 * @property {{name: string, taken: string}} [nameKept] When the name the
 *   document had then belongs to another document now: the name it keeps,
 *   and that other document's name.
 * @property {number} total 0 when nothing changes.
 */

/** @typedef {{inserted: number, updated: number, deleted: number}} RestoreCounts */

/**
 * A logical-operation group: its label, who made it and when, and the kind
 * and reference of the operation when it has them.
 * @typedef {object} OperationGroup
 * @property {string} id
 * @property {string | null} message
 * @property {string} user
 * @property {string} createdAt
 * @property {string} [kind]
 * @property {string} [ref]
 */

/**
 * A query's answer. For "ids" and "entities", one row of `results` per
 * match, a cell per `columns` entry: an id, or the entity as its GET
 * answers it. For "count", only the count. `truncated`: the rows or the
 * count stopped at the server's cap.
 * @typedef {object} QueryResult
 * @property {string} return
 * @property {number} count
 * @property {boolean} truncated
 * @property {string[]} [columns]
 * @property {any[][]} [results]
 */

export {};
