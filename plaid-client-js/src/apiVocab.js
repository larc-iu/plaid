/**
 * The vocabulary bundles: vocabulary layers and their items, each a factory
 * of the client (client.js installs them).
 */

import { auditQuery, bodyOf, configMethods, metadataMethods } from "./families.js";
import { iterPages, listAll, listPage } from "./pagination.js";

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
export function vocabLayersApi(client) {
  return {
    /**
     * Get a vocab layer by ID. With `asOf`, the vocabulary as it was at that
     * instant, read from its history: the same shape as the live read, its
     * entries with `includeItems`. A vocabulary that did not exist then is a
     * 404, a malformed or pruned time a 400.
     * @param {string} id - The resource ID
     * @param {boolean} [includeItems] - Include vocab items
     * @param {string} [asOf] - The moment to read at (ISO-8601 instant)
     * @returns {Promise<VocabLayer>}
     */
    get: (id, includeItems, asOf) =>
      client._request("GET", `/api/v1/vocab-layers/${id}`, {
        queryParams: { "include-items": includeItems, "as-of": asOf },
      }),
    /**
     * One entry of the vocabulary as it was at `asOf`, also when it has
     * been deleted since. The same shape as `vocabItems.get`. A 404 when
     * the entry was not in this vocabulary at that time.
     * @param {string} id - The vocabulary ID
     * @param {string} itemId - The entry ID
     * @param {string} asOf - The moment to read at (ISO-8601 instant)
     * @returns {Promise<VocabItem>}
     */
    getItemAt: (id, itemId, asOf) =>
      client._request("GET", `/api/v1/vocab-layers/${id}/items/${itemId}`, {
        queryParams: { "as-of": asOf },
      }),
    /**
     * Get the audit log of a vocabulary: every change to it or to its
     * entries, folded into entries as the document log is. Links are not
     * listed, they belong to the document they annotate. Transparently
     * follows pagination cursors and returns the full flat array.
     * @param {string} id - The vocabulary ID
     * @param {string} [startTime] - Start of time range
     * @param {string} [endTime] - End of time range
     * @param {string[]|string} [opTypes] - Only return operations of these
     *   types, spelled as in an entry's `op/type` (e.g.
     *   `['vocab-item/delete', 'vocab-item/restore']`)
     * @param {string} [itemId] - Only the changes that wrote this one entry,
     *   each with only its operations that did
     * @param {string[]|string} [kinds] - Only the entries of operations of
     *   these kinds (e.g. `['review', 'guess-adoption']`), each whole
     * @returns {Promise<AuditEntry[]>}
     */
    audit: (id, startTime, endTime, opTypes, itemId, kinds) =>
      listAll(client, `/api/v1/vocab-layers/${id}/audit`, {
        query: auditQuery({ startTime, endTime, opTypes, itemId, kinds }),
      }),
    /**
     * One page of the same log, newest-first with `order: "desc"`. Use this
     * rather than audit() wherever the caller wants the recent end of a log
     * that may be long: audit() walks every page before it resolves.
     * @param {string} id - The vocabulary ID
     * @param {object} [opts]
     * @param {string} [opts.startTime] - Only entries at or after this instant
     * @param {string} [opts.endTime] - Only entries at or before this instant
     * @param {string[]|string} [opts.opTypes] - Only these op types
     * @param {OperationKind[]|string} [opts.kinds] - Only the entries of operations of these kinds, each whole
     * @param {"asc"|"desc"} [opts.order] - "desc" pages newest-first
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @param {number} [opts.opsLimit] - Keep only each entry's oldest N
     *   operations in `ops` (1..1000). `opCount` on every entry says how
     *   many it has
     * @param {string} [opts.entryId] - Read only this entry, not a page
     * @param {string} [opts.itemId] - Only the changes that wrote this one
     *   entry, each with only its operations that did
     * @returns {Promise<Page<AuditEntry>>}
     */
    auditPage: (
      id,
      { startTime, endTime, opTypes, kinds, order, limit, cursor, opsLimit, entryId, itemId } = {},
    ) =>
      listPage(client, `/api/v1/vocab-layers/${id}/audit`, {
        limit,
        cursor,
        query: auditQuery({ startTime, endTime, opTypes, kinds, order, opsLimit, entryId, itemId }),
      }),
    /**
     * Put one entry of the vocabulary back as it was at `asOf`, as one
     * operation. A deleted entry comes back under its original id with its
     * form and fields, and a living one has its form and fields set back.
     * Links are not part of an entry: a deleted entry's links come back
     * through each document's own `documents.restore`. Resolves to
     * `{inserted, form, metadata, total}`, `total` 0 when nothing changes.
     * A form set back bumps every linking document, and the new versions
     * come back in X-Document-Versions (or, past fifty documents,
     * X-Document-Versions-Omitted), which the client takes up as on any
     * write. A time when the entry did not exist is a 400. Maintainers of
     * the vocabulary only.
     * @param {string} id - The vocabulary ID
     * @param {string} itemId - The entry ID
     * @param {string} asOf - The moment to go back to (ISO-8601 instant),
     *   typically a history entry's `endTime`
     * @param {{dryRun?: boolean}} [options] - `{ dryRun }`: with `dryRun` true nothing
     *   is written and the summary says what would change
     * @param {string} [auditMessage] - Custom audit message for this operation
     * @returns {Promise<VocabItemRestoreSummary>}
     */
    restoreItem: (id, itemId, asOf, { dryRun } = {}, auditMessage) =>
      client._request(
        "POST",
        `/api/v1/vocab-layers/${id}/items/${itemId}/restore`,
        {
          queryParams: {
            "as-of": asOf,
            "dry-run": dryRun ? "true" : undefined,
          },
          auditMessage,
        },
      ),
    /**
     * Delete a vocab layer.
     * @param {string} id - The resource ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (id, auditMessage) =>
      client._request("DELETE", `/api/v1/vocab-layers/${id}`, { auditMessage }),
    /**
     * Update a vocab layer's name. A new name restates every document
     * linking the vocabulary: their versions are bumped and taken up from
     * X-Document-Versions.
     * @param {string} id - The resource ID
     * @param {string} name - The name
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<VocabLayer>}
     */
    update: (id, name, auditMessage) =>
      client._request("PATCH", `/api/v1/vocab-layers/${id}`, {
        auditMessage,
        body: bodyOf({ name }),
      }),
    ...configMethods(client, "vocab-layers"),
    /**
     * List all vocab layers accessible to user. Transparently follows
     * pagination cursors and returns the full flat array.
     * @returns {Promise<VocabLayer[]>}
     */
    list: () => listAll(client, "/api/v1/vocab-layers"),
    /**
     * Fetch a single page of vocab layers.
     * @param {object} [opts]
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @returns {Promise<Page<VocabLayer>>}
     */
    listPage: ({ limit, cursor } = {}) =>
      listPage(client, "/api/v1/vocab-layers", {
        limit,
        cursor,
      }),
    /**
     * Async-iterate vocab layers page by page; yields each page's entries array.
     * @param {object} [opts]
     * @param {number} [opts.pageSize] - Per-request page size
     * @returns {AsyncGenerator<VocabLayer[]>}
     */
    iterPages: ({ pageSize } = {}) =>
      iterPages(client, "/api/v1/vocab-layers", {
        pageSize,
      }),
    /**
     * Create a new vocab layer. Note: this also registers the user as a maintainer.
     * @param {string} name - The name
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (name, auditMessage, { id } = {}) =>
      client._request("POST", "/api/v1/vocab-layers", {
        auditMessage,
        body: bodyOf({ id, name }),
      }),
    /**
     * Assign a user as a maintainer for this vocab layer.
     * @param {string} id - The resource ID
     * @param {string} userId - The user ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    addMaintainer: (id, userId, auditMessage) =>
      client._request(
        "POST",
        `/api/v1/vocab-layers/${id}/maintainers/${userId}`,
        { auditMessage },
      ),
    /**
     * Remove a user's maintainer privileges for this vocab layer.
     * @param {string} id - The resource ID
     * @param {string} userId - The user ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    removeMaintainer: (id, userId, auditMessage) =>
      client._request(
        "DELETE",
        `/api/v1/vocab-layers/${id}/maintainers/${userId}`,
        { auditMessage },
      ),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function vocabItemsApi(client) {
  return {
    ...metadataMethods(client, "vocab-items"),
    /**
     * Create a new vocab item
     * @param {string} vocabLayerId - The vocab layer ID
     * @param {string} form - The vocab item form
     * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (vocabLayerId, form, metadata, auditMessage, { id } = {}) =>
      client._request("POST", "/api/v1/vocab-items", {
        auditMessage,
        body: bodyOf({ id, "vocab-layer-id": vocabLayerId, form, metadata }),
      }),
    /**
     * Create multiple vocab items in a single operation. Entries may target
     * different vocab layers; the user must have write access to each.
     * @param {Array<{vocabLayerId: string, form: string, metadata?: any}>} body - The vocab items to create
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{ids: string[]}>}
     */
    bulkCreate: (body, auditMessage) =>
      client._request("POST", "/api/v1/vocab-items/bulk", {
        auditMessage,
        body,
      }),
    /**
     * Update many vocab items in a single operation: set forms and/or patch
     * metadata.
     * @param {Array<{id: string, form?: string, metadata?: Array<object>}>} body - `form` is set only when the key is present; `metadata` is a list of metadata ops, as for patchMetadata. The entries may lie in several vocab layers; the user must have write access to each. An unknown id refuses the whole update, and an id may appear only once. Only an entry whose form really changes restates the documents linking it, and a strict-mode client picks up their new versions from the response.
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{count: number}>} How many vocab items were updated.
     */
    bulkUpdate: (body, auditMessage) =>
      client._request("PATCH", "/api/v1/vocab-items/bulk", {
        auditMessage,
        body,
      }),
    /**
     * Delete multiple vocab items in a single operation. Each item's
     * descendant vocab links are deleted too. Provide an array of IDs.
     *
     * Every document holding one of those links has its version bumped, and
     * a strict-mode client picks up their new versions from the response.
     * @param {string[]} body - The vocab item IDs to delete
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    bulkDelete: (body, auditMessage) =>
      client._request("DELETE", "/api/v1/vocab-items/bulk", {
        auditMessage,
        body,
      }),
    /**
     * Get a vocab item by ID
     * @param {string} id - The resource ID
     * @returns {Promise<VocabItem>}
     */
    get: (id) =>
      client._request("GET", `/api/v1/vocab-items/${id}`),
    /**
     * Delete a vocab item, and every link to it. Every document holding one
     * of those links has its version bumped, and a strict-mode client picks
     * up their new versions from the response.
     * @param {string} id - The resource ID
     * @param {string} [auditMessage] - Audit message for this write
     * @param {{expectedLinkCount?: number}} [options] - `expectedLinkCount`: the
     *   number of links the caller showed. The delete is refused with a 409 when
     *   the entry has any other number of links by then.
     * @returns {Promise<void>}
     */
    delete: (id, auditMessage, { expectedLinkCount } = {}) =>
      client._request("DELETE", `/api/v1/vocab-items/${id}`, {
        auditMessage,
        queryParams: { "expected-link-count": expectedLinkCount },
      }),
    /**
     * Merge entries into this one, in one operation. Every link to a loser
     * moves to the survivor (keeping its id and metadata), except a link on
     * words the survivor is already linked to, which is deleted, and then the
     * losers are deleted. Links are read when the merge runs, so one made
     * after the caller looked moves too. Every loser must be in the
     * survivor's vocabulary, and a loser that is already gone is skipped, so
     * a repeated merge changes nothing. Metadata naming a loser by its id,
     * in the vocabulary's other entries and in the documents of every
     * project it is linked to, is rewritten to name the survivor. A
     * reference to a loser in the survivor's own metadata is the caller's to
     * rewrite, in the same batch.
     * Needs maintainer rights on the vocabulary.
     * @param {string} survivorId - The entry that stays
     * @param {string[]} loserIds - The entries merged into it
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{moved: number, duplicates: number, removed: string[]}>}
     */
    merge: (survivorId, loserIds, auditMessage) =>
      client._request("POST", `/api/v1/vocab-items/${survivorId}/merge`, {
        auditMessage,
        body: { losers: loserIds },
      }),
    /**
     * Update a vocab item's form. A document read carries the entry's form on
     * every link to it, so a rename restates those documents: each has its
     * version bumped, and a strict-mode client picks up their new versions
     * from the response.
     * @param {string} id - The resource ID
     * @param {string} form - The vocab item form
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<VocabItem>}
     */
    update: (id, form, auditMessage) =>
      client._request("PATCH", `/api/v1/vocab-items/${id}`, {
        auditMessage,
        body: bodyOf({ form }),
      }),
  };
}
