/**
 * plaid-client - JavaScript client for the Plaid annotation API
 */

// ---- Types --------------------------------------------------------------
// The shapes the API answers with and takes are in types.js, named here so
// this module's JSDoc can use them and the package root exports them.

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

import { PlaidClient } from "./client.js";

export default PlaidClient;
export { PlaidClient };
export { BACKUP_TIMEOUT_MS } from "./apiServer.js";
export { valueSetAllows, violationCountOf, violationsOf } from "./constraints.js";

// Unicode code-point helpers for text offsets (token begin/end are code-point
// indices). See ./codepoint.js.
export {
  cpLength,
  cpSlice,
  cpSlicer,
  utf16ToCp,
  cpIndexOf,
  composeText,
} from "./codepoint.js";
export { composeTextEdits, gapsToOps, applyTextOps } from "./textEdits.js";
export {
  PLAID_NAMESPACE,
  ROLE_KEY,
  PRESERVE_ON_SPLIT_KEY,
  SPLIT_ON_SPACE_KEY,
  IGNORED_TOKENS_KEY,
  ROLES,
  readRole,
  readIgnoredTokens,
  findByRole,
} from "./roles.js";
// Service self-description helpers: filter discovered services by task, read a
// service's parameter schema/summary, and build/coerce form values. See
// ./serviceSchema.js.
export {
  TASKS,
  servesTask,
  filterServicesByTask,
  getParamSchema,
  getServiceSummary,
  buildDefaultValues,
  coerceParamValues,
} from "./serviceSchema.js";
// Cooperative cancellation for a service AUTHORED in JS: `progress()` is a
// checkpoint that throws ServiceCancelled once the requester stops the
// request, and `critical()` holds that off around writes. See ./services.js
// and the manual, "Stopping a request".
export { ServiceCancelled, createCancelScope } from "./services.js";
// The two messages a write that got no answer is reported with: one the
// server may have saved, one never sent. See ./services.js.
export { UNKNOWN_OUTCOME, UNREACHABLE } from "./services.js";
// Who asked for a service run, named in its History label and in what it
// stores. See ./requester.js.
export { REQUESTED_BY, makeRequester, requesterOf } from "./requester.js";
// Document locks: `client.documents.locked()` holds one for a block of work and
// renews it while the block runs. DocumentLockLost is what a write throws once
// a renewal has failed. See ./documentLock.js.
export { DocumentLock, DocumentLockLost } from "./documentLock.js";
// Provenance: the cross-app convention for who made an annotation (flat
// prov/provSource/provConfirmed metadata; absence = a verifier; 'inferred' =
// a machine; 'contributed' = a person whose work is reviewed), plus the
// machine-writer contract. See ./provenance.js and the manual, "Provenance".
export {
  PROV,
  PROV_STATES,
  PROVENANCE_KEYS,
  stampInferred,
  confirmedInferred,
  stampContributed,
  provState,
  provOrigin,
  isMachine,
  isProtected,
  needsReview,
  contributeOnEdit,
  serviceSource,
  REVIEW_KEY,
  readReview,
  projectRole,
  isReviewed,
  withReviewedUser,
  CONFIDENCE_KEY,
  DEFAULT_CONFIDENCE_THRESHOLD,
  readConfidenceThreshold,
  machineProb,
  isDoubtful,
  VALUE_PROBS_KEY,
  FORM_PROBS_KEY,
  readValueProbs,
  writerPolicy,
} from "./provenance.js";
// Lexicon entry forms are stored without affix or clitic markers, the marker
// drawn from the entry's morph type. Every entry-form writer stores what
// entryForm returns. See ./entryForms.js.
export {
  MORPH_TYPES,
  entryForm,
  readAffixMarkers,
  decorateWithAffixMarkers,
} from "./entryForms.js";
// Metadata ops: the body of a metadata PATCH and of a bulk update entry's
// `metadata`. See ./metadataOps.js.
export {
  metadataOps,
  applyMetadataOps,
  mergeMetadata,
  isReservedMetadataKey,
} from "./metadataOps.js";
// The ids a create or bulk create answered with, off the call or its batch
// result. See ./created.js.
export { createdId, createdIds } from "./created.js";
// UUIDv7 ids for what a client creates. See ./ids.js and the manual,
// "Retrying a write". uuidv4 works where crypto.randomUUID does not (a page
// served over plain HTTP from any host but localhost).
export { uuidv4, uuidv7, normalizeUserId } from "./ids.js";
export { wasReplayed } from "./replayed.js";
export { MAX_BATCH_OPS } from "./batch.js";
