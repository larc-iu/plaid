/**
 * The layer bundles: text, token, span and relation layers, each a factory
 * of the client (client.js installs them).
 */

import { bodyOf, configMethods, constraintMethods, layerMethods, valueSetMethods } from "./families.js";
import { queryTimeout } from "./http.js";

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
export function textLayersApi(client) {
  return {
    /**
     * Create a new text layer for a project.
     * @param {string} projectId - The project ID
     * @param {string} name - The name
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (projectId, name, auditMessage, { id } = {}) =>
      client._request("POST", "/api/v1/text-layers", {
        auditMessage,
        body: bodyOf({ id, "project-id": projectId, name }),
      }),
    ...configMethods(client, "text-layers"),
    ...layerMethods(client, "text-layers"),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function tokenLayersApi(client) {
  return {
    /**
     * Create a new token layer.
     * @param {string} textLayerId - The text layer ID
     * @param {string} name - The name
     * @param {string} [overlapMode] - Per-layer, immutable token invariant: "any" (default), "non-overlapping", or "partitioning". On partitioning layers, single token create/update/delete are rejected; use bulkCreate plus split/merge/shift.
     * @param {string} [parentTokenLayerId] - Optional immutable parent token layer. Tokens in this layer must nest within a parent-layer token; the parent layer must be in the same text layer and be "non-overlapping" or "partitioning" (an "any" parent is rejected). A nested layer may be "any" or "non-overlapping" but not "partitioning" (partitioning is only for root layers), e.g. words (non-overlapping, parent=sentences) within sentences (partitioning).
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (
      textLayerId,
      name,
      overlapMode,
      parentTokenLayerId,
      auditMessage,
      { id } = {},
    ) =>
      client._request("POST", "/api/v1/token-layers", {
        auditMessage,
        body: bodyOf({
          id,
          "text-layer-id": textLayerId,
          name,
          "overlap-mode": overlapMode,
          "parent-token-layer-id": parentTokenLayerId,
        }),
      }),
    /**
     * Count, per document, the tokens of each layer whose surface matches a
     * regex, as a query's `value: {regex}` on a token decides. Each text is
     * read once, so it stays fast on a long document. Layers you cannot read
     * are left out.
     * @param {string[]} layerIds - The token layer ids
     * @param {{regex: string, flags?: string}} value - The regex spec
     * @returns {Promise<{results: Array<[string, string, number]>}>} [layerId,
     *   documentId, count] rows, a document with tokens of the layer and no
     *   match counting 0.
     */
    countMatching: (layerIds, value) =>
      client._request("POST", "/api/v1/query/token-counts", {
        body: { layers: layerIds, value },
        outOfBand: true,
        timeout: queryTimeout(client),
        noBusyRetry: true,
      }),
    ...layerMethods(client, "token-layers"),
    ...configMethods(client, "token-layers"),
    ...constraintMethods(client, "token-layers"),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function spanLayersApi(client) {
  return {
    /**
     * Create a new span layer.
     * @param {string} tokenLayerId - The token layer ID
     * @param {string} name - The name
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (tokenLayerId, name, auditMessage, { id } = {}) =>
      client._request("POST", "/api/v1/span-layers", {
        auditMessage,
        body: bodyOf({ id, "token-layer-id": tokenLayerId, name }),
      }),
    ...configMethods(client, "span-layers"),
    ...constraintMethods(client, "span-layers"),
    ...valueSetMethods(client, "span-layers"),
    ...layerMethods(client, "span-layers"),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function relationLayersApi(client) {
  return {
    /**
     * Create a new relation layer.
     * @param {string} spanLayerId - The span layer ID
     * @param {string} name - The name
     * @param {string} [auditMessage] - Audit message for this write
     * @param {object} [opts]
     * @param {string} [opts.id] - The new entity's id, minted by the caller (see uuidv7)
     * @returns {Promise<Created>}
     */
    create: (spanLayerId, name, auditMessage, { id } = {}) =>
      client._request("POST", "/api/v1/relation-layers", {
        auditMessage,
        body: bodyOf({ id, "span-layer-id": spanLayerId, name }),
      }),
    ...layerMethods(client, "relation-layers"),
    ...configMethods(client, "relation-layers"),
    ...constraintMethods(client, "relation-layers"),
    ...valueSetMethods(client, "relation-layers"),
  };
}
