/**
 * The annotation bundles: tokens, spans, relations and vocabulary links,
 * each a factory of the client (client.js installs them).
 */

import { bodyOf, metadataMethods } from "./families.js";

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
export function tokensApi(client) {
  return {
    /**
     * Create a new token in a token layer. Tokens define text substrings
     * using begin and end offsets. Tokens may be zero-width and may overlap.
     * For tokens sharing the same begin, precedence controls the linear
     * ordering.
     *
     * Offsets are 0-based indices in Unicode CODE POINTS (not UTF-16 code
     * units): a supplementary-plane character (emoji, SMP script) is one
     * position. JS strings are UTF-16, so do NOT use `str.length` /
     * `str.substring` to compute offsets — count code points instead
     * (e.g. `[...str].length`, or iterate with `codePointAt`).
     * @param {string} tokenLayerId - The token layer ID
     * @param {string} text - The text ID
     * @param {number} begin - Start offset, inclusive (Unicode code points)
     * @param {number} end - End offset, exclusive (Unicode code points)
     * @param {number} [precedence] - Ordering precedence
     * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (
      tokenLayerId,
      text,
      begin,
      end,
      precedence,
      metadata,
      auditMessage,
      { id } = {},
    ) =>
      client._request("POST", "/api/v1/tokens", {
        auditMessage,
        body: bodyOf({
          id,
          "token-layer-id": tokenLayerId,
          text,
          begin,
          end,
          precedence,
          metadata,
        }),
      }),
    /**
     * Get a token.
     * @param {string} tokenId - The token ID
     * @returns {Promise<Token>}
     */
    get: (tokenId) =>
      client._request("GET", `/api/v1/tokens/${tokenId}`),
    /**
     * Delete a token and remove it from any spans. If this causes a span to
     * have no remaining tokens, the span will also be deleted.
     * @param {string} tokenId - The token ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (tokenId, auditMessage) =>
      client._request("DELETE", `/api/v1/tokens/${tokenId}`, { auditMessage }),
    /**
     * Update a token.
     * @param {string} tokenId - The token ID
     * @param {number} [begin] - New start offset, inclusive (Unicode code points)
     * @param {number} [end] - New end offset, exclusive (Unicode code points)
     * @param {?number} [precedence] - Ordering precedence. Omit (undefined)
     *   to leave unchanged; pass a number to set; pass null explicitly to
     *   CLEAR it (revert to no explicit ordering). bodyOf keeps null but
     *   drops undefined, so the three cases map correctly to the server.
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Token>}
     */
    update: (tokenId, begin, end, precedence, auditMessage) =>
      client._request("PATCH", `/api/v1/tokens/${tokenId}`, {
        auditMessage,
        body: bodyOf({ begin, end, precedence }),
      }),
    /**
     * Create multiple tokens in a single operation.
     * @param {Array} body - The request body
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{ids: string[]}>} The created entity IDs, in input order. (bulkDelete resolves to no value.)
     */
    bulkCreate: (body, auditMessage) =>
      client._request("POST", "/api/v1/tokens/bulk", { auditMessage, body }),
    /**
     * Delete multiple tokens in a single operation. Provide an array of IDs.
     * @param {Array} body - The request body
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    bulkDelete: (body, auditMessage) =>
      client._request("DELETE", "/api/v1/tokens/bulk", { auditMessage, body }),
    /**
     * Update many tokens in a single operation: patch metadata.
     * @param {Array} body - Objects of the shape `{id, metadata}`. `metadata` is a list of metadata ops, as for patchMetadata. The tokens may lie in several documents of one project; every document touched has its version bumped and every new version comes back in `X-Document-Versions` (past fifty documents, only their number, in `X-Document-Versions-Omitted`). A `document-version` precondition is accepted only when every entry lies in one document. An unknown id refuses the whole update.
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{count: number}>} How many tokens were updated.
     */
    bulkUpdate: (body, auditMessage) =>
      client._request("PATCH", "/api/v1/tokens/bulk", {
        auditMessage,
        body,
      }),
    /**
     * Split a token at a Unicode code-point offset. A new token is made for one
     * half and its ID is returned. The original token keeps its ID, spans and
     * vocab-links on the left half, or on the right half with `keep: "right"`.
     * @param {string} tokenId - The token ID
     * @param {number} position - Code-point offset to split at (strictly between begin and end)
     * @param {string} [auditMessage] - Audit message for this write
     * @param {{id?: string, keep?: "left"|"right"}} [options] - `id`: the new
     *   token's id, a UUIDv7 this client minted. `keep`: the half the original token
     *   (its id, spans, vocab-links, comments and metadata) stays on, `"left"` by
     *   default. With `"right"` the new token, whose id is answered, is the left
     *   half. A relation layer whose relations must stay inside one token
     *   of this layer declares a same-ancestor constraint, and the server deletes
     *   the relations the split leaves crossing in the same transaction.
     * @returns {Promise<Created>}
     */
    split: (
      tokenId,
      position,
      auditMessage,
      { id, keep } = {},
    ) =>
      client._request("POST", `/api/v1/tokens/${tokenId}/split`, {
        auditMessage,
        body: bodyOf({ id, keep, position }),
      }),
    /**
     * Merge two tokens. The left token (smaller begin) survives with the combined
     * extent; the right is deleted and its spans/vocab-links are reparented to the left.
     * On partitioning layers the tokens must be adjacent; on non-overlapping layers the
     * merged extent must not engulf a third token.
     * @param {string} tokenId - The anchor token ID
     * @param {string} otherTokenId - The other token to merge in
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Token>}
     */
    merge: (tokenId, otherTokenId, auditMessage) =>
      client._request("POST", `/api/v1/tokens/${tokenId}/merge`, {
        auditMessage,
        body: bodyOf({ "other-token-id": otherTokenId }),
      }),
    /**
     * Shift a token's boundary. On partitioning layers the adjacent token is
     * auto-adjusted to preserve the partition; on non-overlapping layers a shift that
     * would create an overlap is rejected.
     * @param {string} tokenId - The token ID
     * @param {number} [begin] - New start offset, inclusive (Unicode code points)
     * @param {number} [end] - New end offset, exclusive (Unicode code points)
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Token>}
     */
    shift: (tokenId, begin, end, auditMessage) =>
      client._request("POST", `/api/v1/tokens/${tokenId}/shift`, {
        auditMessage,
        body: bodyOf({ begin, end }),
      }),
    ...metadataMethods(client, "tokens"),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function spansApi(client) {
  return {
    /**
     * Replace tokens for a span.
     * @param {string} spanId - The span ID
     * @param {Array} tokens - The tokens
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Span>}
     */
    setTokens: (spanId, tokens, auditMessage) =>
      client._request("PUT", `/api/v1/spans/${spanId}/tokens`, {
        auditMessage,
        body: bodyOf({ tokens }),
      }),
    /**
     * Create a new span. A span holds a primary atomic value and optional
     * metadata, and must at all times be associated with one or more tokens.
     * @param {string} spanLayerId - The span layer ID
     * @param {Array} tokens - The tokens
     * @param {any} value - The value
     * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (spanLayerId, tokens, value, metadata, auditMessage, { id } = {}) =>
      client._request("POST", "/api/v1/spans", {
        auditMessage,
        body: bodyOf({
          id,
          "span-layer-id": spanLayerId,
          tokens,
          value,
          metadata,
        }),
      }),
    /**
     * Get a span by ID.
     * @param {string} spanId - The span ID
     * @returns {Promise<Span>}
     */
    get: (spanId) =>
      client._request("GET", `/api/v1/spans/${spanId}`),
    /**
     * Delete a span.
     * @param {string} spanId - The span ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (spanId, auditMessage) =>
      client._request("DELETE", `/api/v1/spans/${spanId}`, { auditMessage }),
    /**
     * Update a span's value.
     * @param {string} spanId - The span ID
     * @param {any} value - The value
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Span>}
     */
    update: (spanId, value, auditMessage) =>
      client._request("PATCH", `/api/v1/spans/${spanId}`, {
        auditMessage,
        body: bodyOf({ value }),
      }),
    /**
     * Create multiple spans in a single operation.
     * @param {Array} body - The request body
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{ids: string[]}>} The created entity IDs, in input order. (bulkDelete resolves to no value.)
     */
    bulkCreate: (body, auditMessage) =>
      client._request("POST", "/api/v1/spans/bulk", { auditMessage, body }),
    /**
     * Delete multiple spans in a single operation. Provide an array of IDs.
     * @param {Array} body - The request body
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    bulkDelete: (body, auditMessage) =>
      client._request("DELETE", "/api/v1/spans/bulk", { auditMessage, body }),
    /**
     * Update many spans in a single operation: set values and/or patch metadata.
     * @param {Array} body - Objects of the shape `{id, value?, metadata?}`. `value` is set only when the key is present (null sends JSON null); `metadata` is a list of metadata ops, as for patchMetadata. The spans may lie in several documents of one project; every document touched has its version bumped and every new version comes back in `X-Document-Versions` (past fifty documents, only their number, in `X-Document-Versions-Omitted`). A `document-version` precondition is accepted only when every entry lies in one document. An unknown id refuses the whole update.
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{count: number}>} How many spans were updated.
     */
    bulkUpdate: (body, auditMessage) =>
      client._request("PATCH", "/api/v1/spans/bulk", {
        auditMessage,
        body,
      }),
    ...metadataMethods(client, "spans"),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function relationsApi(client) {
  return {
    ...metadataMethods(client, "relations"),
    /**
     * Update the target span of a relation.
     * @param {string} relationId - The relation ID
     * @param {string} spanId - The span ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Relation>}
     */
    setTarget: (relationId, spanId, auditMessage) =>
      client._request("PUT", `/api/v1/relations/${relationId}/target`, {
        auditMessage,
        body: bodyOf({ "span-id": spanId }),
      }),
    /**
     * Get a relation by ID.
     * @param {string} relationId - The relation ID
     * @returns {Promise<Relation>}
     */
    get: (relationId) =>
      client._request("GET", `/api/v1/relations/${relationId}`),
    /**
     * Delete a relation.
     * @param {string} relationId - The relation ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (relationId, auditMessage) =>
      client._request("DELETE", `/api/v1/relations/${relationId}`, {
        auditMessage,
      }),
    /**
     * Update a relation's value.
     * @param {string} relationId - The relation ID
     * @param {any} value - The value
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Relation>}
     */
    update: (relationId, value, auditMessage) =>
      client._request("PATCH", `/api/v1/relations/${relationId}`, {
        auditMessage,
        body: bodyOf({ value }),
      }),
    /**
     * Update the source span of a relation.
     * @param {string} relationId - The relation ID
     * @param {string} spanId - The span ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<Relation>}
     */
    setSource: (relationId, spanId, auditMessage) =>
      client._request("PUT", `/api/v1/relations/${relationId}/source`, {
        auditMessage,
        body: bodyOf({ "span-id": spanId }),
      }),
    /**
     * Create a new relation. A relation is a directed edge between two spans
     * with a value, useful for expressing phenomena such as syntactic or
     * semantic relations.
     * @param {string} relationLayerId - The relation layer ID
     * @param {string} source - The source span ID
     * @param {string} target - The target span ID
     * @param {any} value - The value
     * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (
      relationLayerId,
      source,
      target,
      value,
      metadata,
      auditMessage,
      { id } = {},
    ) =>
      client._request("POST", "/api/v1/relations", {
        auditMessage,
        body: bodyOf({
          id,
          "relation-layer-id": relationLayerId,
          source,
          target,
          value,
          metadata,
        }),
      }),
    /**
     * Create multiple relations in a single operation.
     * @param {Array} body - The request body
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{ids: string[]}>} The created entity IDs, in input order. (bulkDelete resolves to no value.)
     */
    bulkCreate: (body, auditMessage) =>
      client._request("POST", "/api/v1/relations/bulk", { auditMessage, body }),
    /**
     * Delete multiple relations in a single operation. Provide an array of IDs.
     * @param {Array} body - The request body
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    bulkDelete: (body, auditMessage) =>
      client._request("DELETE", "/api/v1/relations/bulk", {
        auditMessage,
        body,
      }),
    /**
     * Update many relations in a single operation: set values and/or patch metadata.
     * @param {Array} body - Objects of the shape `{id, value?, metadata?}`. `value` is set only when the key is present (null sends JSON null); `metadata` is a list of metadata ops, as for patchMetadata. The relations may lie in several documents of one project; every document touched has its version bumped and every new version comes back in `X-Document-Versions` (past fifty documents, only their number, in `X-Document-Versions-Omitted`). A `document-version` precondition is accepted only when every entry lies in one document. An unknown id refuses the whole update.
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{count: number}>} How many relations were updated.
     */
    bulkUpdate: (body, auditMessage) =>
      client._request("PATCH", "/api/v1/relations/bulk", {
        auditMessage,
        body,
      }),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function vocabLinksApi(client) {
  return {
    /**
     * Create a new vocab link between tokens and a vocab item.
     * @param {string} vocabItem - The vocab item to link
     * @param {Array} tokens - The tokens to link
     * @param {any} [metadata] - Metadata for the link. Omit to leave unset; pass null to send JSON null.
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (vocabItem, tokens, metadata, auditMessage, { id } = {}) =>
      client._request("POST", "/api/v1/vocab-links", {
        auditMessage,
        body: bodyOf({ id, "vocab-item": vocabItem, tokens, metadata }),
      }),
    /**
     * Create multiple vocab links in a single operation. Entries may
     * reference different vocab items, but all tokens across the call must
     * belong to one document.
     * @param {Array<{vocabItem: string, tokens: string[], metadata?: any}>} body - The vocab links to create
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<{ids: string[]}>} The created entity IDs, in input order. (bulkDelete resolves to no value.)
     */
    bulkCreate: (body, auditMessage) =>
      client._request("POST", "/api/v1/vocab-links/bulk", {
        auditMessage,
        body,
      }),
    /**
     * Delete multiple vocab links in a single operation. Provide an array of IDs.
     * @param {string[]} body - The vocab link IDs to delete
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    bulkDelete: (body, auditMessage) =>
      client._request("DELETE", "/api/v1/vocab-links/bulk", {
        auditMessage,
        body,
      }),
    ...metadataMethods(client, "vocab-links"),
    /**
     * Get a vocab link by ID
     * @param {string} id - The resource ID
     * @returns {Promise<VocabLink>}
     */
    get: (id) =>
      client._request("GET", `/api/v1/vocab-links/${id}`),
    /**
     * Delete a vocab link
     * @param {string} id - The resource ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    delete: (id, auditMessage) =>
      client._request("DELETE", `/api/v1/vocab-links/${id}`, { auditMessage }),
  };
}
