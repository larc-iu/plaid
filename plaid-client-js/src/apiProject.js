/**
 * The project bundles: projects, their guidelines, comments and events, and
 * the logical-operation groups of the audit log, each a factory of the
 * client (client.js installs them).
 */

import { recorderFor } from "./events.js";
import { auditMethods, bodyOf, configMethods } from "./families.js";
import { iterPages, listAll, listPage } from "./pagination.js";

/** The query of an events read: `types` as the wire's comma-separated list. */
function eventQuery(types, startTime, endTime) {
  return {
    types: Array.isArray(types) ? types.join(",") || undefined : types,
    "start-time": startTime,
    "end-time": endTime,
  };
}

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
export function projectsApi(client) {
  return {
    /**
     * Set a user's access level to read and write for this project.
     * @param {string} id - The resource ID
     * @param {string} userId - The user ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    addWriter: (id, userId, auditMessage) =>
      client._request("POST", `/api/v1/projects/${id}/writers/${userId}`, {
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
      client._request("DELETE", `/api/v1/projects/${id}/writers/${userId}`, {
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
      client._request("POST", `/api/v1/projects/${id}/readers/${userId}`, {
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
      client._request("DELETE", `/api/v1/projects/${id}/readers/${userId}`, {
        auditMessage,
      }),
    ...configMethods(client, "projects"),
    /**
     * Assign a user as a maintainer for this project.
     * @param {string} id - The resource ID
     * @param {string} userId - The user ID
     * @param {string} [auditMessage] - Audit message for this write
     * @returns {Promise<void>}
     */
    addMaintainer: (id, userId, auditMessage) =>
      client._request("POST", `/api/v1/projects/${id}/maintainers/${userId}`, {
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
      client._request(
        "DELETE",
        `/api/v1/projects/${id}/maintainers/${userId}`,
        { auditMessage },
      ),
    ...auditMethods(client, "projects"),
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
      client._request("GET", `/api/v1/projects/${projectId}/audit/last-edits`, {
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
      client._request("POST", `/api/v1/projects/${id}/vocabs/${vocabId}`, {
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
      client._request("DELETE", `/api/v1/projects/${id}/vocabs/${vocabId}`, {
        auditMessage,
      }),
    /**
     * Get a project by ID. To fetch the project's documents, use
     * listDocuments(id) — the include-documents flag has been removed.
     * @param {string} id - The resource ID
     * @returns {Promise<Project>}
     */
    get: (id) =>
      client._request("GET", `/api/v1/projects/${id}`),
    /**
     * List all documents in a project. Transparently follows pagination
     * cursors and returns the full flat array.
     *
     * Note: this endpoint does not support temporal (`as-of`) queries; the
     * server rejects `?as-of=` on the documents-list route with a 400.
     * @param {string} id - The project ID
     * @returns {Promise<DocumentListEntry[]>}
     */
    listDocuments: (id) => listAll(client, `/api/v1/projects/${id}/documents`),
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
      listPage(client, `/api/v1/projects/${id}/documents`, { limit, cursor }),
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
      iterPages(client, `/api/v1/projects/${id}/documents`, { pageSize }),
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
      client._request("DELETE", `/api/v1/projects/${id}`, {
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
      client._request("PATCH", `/api/v1/projects/${id}`, {
        auditMessage,
        body: bodyOf({ name }),
      }),
    /**
     * List all projects accessible to user. Transparently follows pagination
     * cursors and returns the full flat array.
     * @returns {Promise<ProjectListEntry[]>}
     */
    list: () => listAll(client, "/api/v1/projects"),
    /**
     * Fetch a single page of projects.
     * @param {object} [opts]
     * @param {number} [opts.limit] - Page size (1..1000; server default 100)
     * @param {string} [opts.cursor] - Opaque cursor from a previous page
     * @returns {Promise<Page<ProjectListEntry>>}
     */
    listPage: ({ limit, cursor } = {}) =>
      listPage(client, "/api/v1/projects", {
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
      iterPages(client, "/api/v1/projects", {
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
      client._request("POST", "/api/v1/projects", {
        auditMessage,
        body: bodyOf({ id, name }),
      }),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function guidelinesApi(client) {
  return {
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
      client._request("POST", `/api/v1/projects/${projectId}/guidelines`, {
        auditMessage,
        body: bodyOf({ id, title, body, pinned }),
      }),
    /**
     * Read one guideline, Markdown body included.
     * @param {string} id - The guideline id
     * @returns {Promise<Guideline>}
     */
    get: (id) => client._request("GET", `/api/v1/guidelines/${id}`),
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
      client._request("PATCH", `/api/v1/guidelines/${id}`, {
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
      client._request("DELETE", `/api/v1/guidelines/${id}`, { auditMessage }),
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
      listAll(client, `/api/v1/projects/${projectId}/guidelines`, {
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
      listPage(client, `/api/v1/projects/${projectId}/guidelines`, {
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
      iterPages(client, `/api/v1/projects/${projectId}/guidelines`, {
        pageSize,
        query: { "include-bodies": includeBodies },
      }),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function commentsApi(client) {
  return {
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
      client._request("POST", "/api/v1/comments", {
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
    get: (id) => client._request("GET", `/api/v1/comments/${id}`),
    /**
     * Edit a comment's body. Only the comment's AUTHOR may do this - not
     * maintainers, not admins. Sets `edited` on the comment.
     * @param {string} id - The comment id
     * @param {string} body - The replacement text
     * @returns {Promise<Comment>}
     */
    update: (id, body) =>
      client._request("PATCH", `/api/v1/comments/${id}`, {
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
      client._request("DELETE", `/api/v1/comments/${id}`, { noOperation: true }),
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
      listAll(client, `/api/v1/projects/${projectId}/comments`, {
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
      listPage(client, `/api/v1/projects/${projectId}/comments`, {
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
      iterPages(client, `/api/v1/projects/${projectId}/comments`, {
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
      client._request("GET", `/api/v1/projects/${projectId}/comments/counts`, {
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
      listAll(client, `/api/v1/vocab-layers/${vocabId}/comments`, {
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
      listPage(client, `/api/v1/vocab-layers/${vocabId}/comments`, {
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
      iterPages(client, `/api/v1/vocab-layers/${vocabId}/comments`, {
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
      client._request(
        "GET",
        `/api/v1/vocab-layers/${vocabId}/comments/counts`,
        {
          queryParams: { "entity-id": entityId },
          skipResponseTransform: true,
        },
      ),
  };
}

/** @param {import("./client.js").PlaidClient} client */
export function eventsApi(client) {
  return {
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
    record: (type, fields) => recorderFor(client).record(client, type, fields),
    /**
     * Send what the recorder holds now, rather than at its next interval.
     * @returns {void}
     */
    flush: () => recorderFor(client).flush(),
    /**
     * Tell the recorder a project's switch at once, e.g. right after a
     * maintainer changed it. Turning it off drops what is buffered.
     * @param {string} projectId - The project
     * @param {boolean} on - Whether telemetry is on
     * @returns {void}
     */
    setEnabled: (projectId, on) => recorderFor(client).setEnabled(projectId, on),
    /**
     * Record events directly, with no buffering. Requires write access, and
     * the server refuses with a 403 while the project's switch is off. All
     * or nothing: one bad event refuses the request with a 400 naming it.
     * @param {string} projectId - The project the events happened in
     * @param {Array<{type: string, documentId?: string, targetId?: string, data?: object, clientTs?: string}>} events - At most 500 events
     * @returns {Promise<{count: number}>}
     */
    create: (projectId, events) =>
      client._request("POST", `/api/v1/projects/${projectId}/events`, {
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
      listAll(client, `/api/v1/projects/${projectId}/events`, {
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
      listPage(client, `/api/v1/projects/${projectId}/events`, {
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
      iterPages(client, `/api/v1/projects/${projectId}/events`, {
        pageSize,
        query: eventQuery(types, startTime, endTime),
      }),
  };
}

// Logical-operation groups (audit-log grouping). There is no create: a
// group row is made lazily by the first write carrying `?group-id=`
// (see beginOperation). Not an audited write, so no auditMessage arg.
/** @param {import("./client.js").PlaidClient} client */
export function operationGroupsApi(client) {
  return {
    /**
     * Get a logical-operation group (its label + creator).
     * @param {string} id - The group id
     * @returns {Promise<OperationGroup>}
     */
    get: (id) => client._request("GET", `/api/v1/operation-groups/${id}`),
    /**
     * Relabel a logical-operation group after the fact. Owner or admin only.
     * @param {string} id - The group id
     * @param {string|null} message - The new label
     * @returns {Promise<OperationGroup>}
     */
    update: (id, message) =>
      client._request("PATCH", `/api/v1/operation-groups/${id}`, {
        body: { message },
      }),
  };
}
