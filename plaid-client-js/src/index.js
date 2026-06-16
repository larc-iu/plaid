/**
 * plaid-client - JavaScript client for the Plaid annotation API
 */

import { transformRequest, transformResponse } from './transforms.js';
import {
  makeRequest, extractDocumentVersions, parseErrorBody, makeHttpError,
  makeNetworkError, timeoutSignal, DEFAULT_TIMEOUT_MS,
} from './http.js';
import { listAll, listPage, iterPages } from './pagination.js';
import { createSSEConnection } from './sse.js';
import {
  discoverServices,
  discardService,
  serve,
  requestService,
} from './services.js';

// Helper: build body object, filtering out undefined values
function bodyOf(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

class PlaidClient {
  /**
   * Create a new PlaidClient instance
   * @param {string} baseUrl - The base URL for the API
   * @param {string} token - The authentication token
   * @param {object} [options] - Client options
   * @param {number} [options.timeout=30000] - Per-request timeout in ms (0 or null disables it)
   */
  constructor(baseUrl, token, options = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.timeout = options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS;
    this.isBatching = false;
    this.batchOperations = [];
    this.documentVersions = {};
    this.strictModeDocumentId = null;
    // Ambient custom audit-log message applied to write requests; null = use
    // the server's auto-generated description. See setAuditMessage / withAuditMessage.
    this.auditMessage = null;

    // --- API Bundles ---

    this.vocabLinks = {
      /**
       * Create a new vocab link between tokens and a vocab item.
       * @param {string} vocabItem - The vocab item to link
       * @param {Array} tokens - The tokens to link
       * @param {any} [metadata] - Metadata for the link. Omit to leave unset; pass null to send JSON null.
       */
      create: (vocabItem, tokens, metadata, auditMessage) =>
        this._request('POST', '/api/v1/vocab-links', { auditMessage,
          body: bodyOf({ 'vocab-item': vocabItem, tokens, metadata }),
        }),
      /**
       * Replace all metadata for a vocab link. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
       * @param {string} id - The resource ID
       * @param {any} body - The request body
       */
      setMetadata: (id, body, auditMessage) =>
        this._request('PUT', `/api/v1/vocab-links/${id}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a vocab link.
       * @param {string} id - The resource ID
       */
      deleteMetadata: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/vocab-links/${id}/metadata`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a vocab link. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} id - The resource ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (id, body, auditMessage) =>
        this._request('PATCH', `/api/v1/vocab-links/${id}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Get a vocab link by ID
       * @param {string} id - The resource ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (id, asOf) =>
        this._request('GET', `/api/v1/vocab-links/${id}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a vocab link
       * @param {string} id - The resource ID
       */
      delete: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/vocab-links/${id}`, { auditMessage }),
    };

    this.vocabLayers = {
      /**
       * Get a vocab layer by ID
       * @param {string} id - The resource ID
       * @param {boolean} [includeItems] - Include vocab items
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (id, includeItems, asOf) =>
        this._request('GET', `/api/v1/vocab-layers/${id}`, {
          queryParams: { 'include-items': includeItems, 'as-of': asOf },
        }),
      /**
       * Delete a vocab layer.
       * @param {string} id - The resource ID
       */
      delete: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}`, { auditMessage }),
      /**
       * Update a vocab layer's name.
       * @param {string} id - The resource ID
       * @param {string} name - The name
       */
      update: (id, name, auditMessage) =>
        this._request('PATCH', `/api/v1/vocab-layers/${id}`, { auditMessage,
          body: bodyOf({ name }),
        }),
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} id - The resource ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (id, namespace, configKey, configValue, auditMessage) =>
        this._request('PUT', `/api/v1/vocab-layers/${id}/config/${namespace}/${configKey}`, { auditMessage,
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} id - The resource ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (id, namespace, configKey, auditMessage) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}/config/${namespace}/${configKey}`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * List all vocab layers accessible to user. Transparently follows
       * pagination cursors and returns the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {string} [asOf] - Temporal query timestamp
       */
      list: (asOf) =>
        listAll(this, '/api/v1/vocab-layers', { query: { 'as-of': asOf } }),
      /**
       * Fetch a single page of vocab layers.
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {string} [opts.asOf] - Temporal query timestamp
       * @returns {Promise<{entries: Array, nextCursor: (string|null)}>}
       */
      listPage: ({ limit, cursor, asOf } = {}) =>
        listPage(this, '/api/v1/vocab-layers', { limit, cursor, query: { 'as-of': asOf } }),
      /**
       * Async-iterate vocab layers page by page; yields each page's entries array.
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * @param {string} [opts.asOf] - Temporal query timestamp
       * Cannot be used inside a batch (auto-paginates across requests); throws on first iteration if called while batching — use listPage() for a single page in a batch.
       * @returns {AsyncGenerator<Array>}
       */
      iterPages: ({ pageSize, asOf } = {}) =>
        iterPages(this, '/api/v1/vocab-layers', { pageSize, query: { 'as-of': asOf } }),
      /**
       * Create a new vocab layer. Note: this also registers the user as a maintainer.
       * @param {string} name - The name
       */
      create: (name, auditMessage) =>
        this._request('POST', '/api/v1/vocab-layers', { auditMessage,
          body: bodyOf({ name }),
        }),
      /**
       * Assign a user as a maintainer for this vocab layer.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      addMaintainer: (id, userId, auditMessage) =>
        this._request('POST', `/api/v1/vocab-layers/${id}/maintainers/${userId}`, { auditMessage }),
      /**
       * Remove a user's maintainer privileges for this vocab layer.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      removeMaintainer: (id, userId, auditMessage) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}/maintainers/${userId}`, { auditMessage }),
    };

    this.relations = {
      /**
       * Replace all metadata for a relation.
       * @param {string} relationId - The relation ID
       * @param {any} body - The request body
       */
      setMetadata: (relationId, body, auditMessage) =>
        this._request('PUT', `/api/v1/relations/${relationId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a relation.
       * @param {string} relationId - The relation ID
       */
      deleteMetadata: (relationId, auditMessage) =>
        this._request('DELETE', `/api/v1/relations/${relationId}/metadata`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a relation. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} relationId - The relation ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (relationId, body, auditMessage) =>
        this._request('PATCH', `/api/v1/relations/${relationId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Update the target span of a relation.
       * @param {string} relationId - The relation ID
       * @param {string} spanId - The span ID
       */
      setTarget: (relationId, spanId, auditMessage) =>
        this._request('PUT', `/api/v1/relations/${relationId}/target`, { auditMessage,
          body: bodyOf({ 'span-id': spanId }),
        }),
      /**
       * Get a relation by ID.
       * @param {string} relationId - The relation ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (relationId, asOf) =>
        this._request('GET', `/api/v1/relations/${relationId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a relation.
       * @param {string} relationId - The relation ID
       */
      delete: (relationId, auditMessage) =>
        this._request('DELETE', `/api/v1/relations/${relationId}`, { auditMessage }),
      /**
       * Update a relation's value.
       * @param {string} relationId - The relation ID
       * @param {any} value - The value
       */
      update: (relationId, value, auditMessage) =>
        this._request('PATCH', `/api/v1/relations/${relationId}`, { auditMessage,
          body: bodyOf({ value }),
        }),
      /**
       * Update the source span of a relation.
       * @param {string} relationId - The relation ID
       * @param {string} spanId - The span ID
       */
      setSource: (relationId, spanId, auditMessage) =>
        this._request('PUT', `/api/v1/relations/${relationId}/source`, { auditMessage,
          body: bodyOf({ 'span-id': spanId }),
        }),
      /**
       * Create a new relation. A relation is a directed edge between two spans
       * with a value, useful for expressing phenomena such as syntactic or
       * semantic relations.
       * @param {string} layerId - The relation layer ID
       * @param {string} sourceId - The source span ID
       * @param {string} targetId - The target span ID
       * @param {any} value - The value
       * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
       */
      create: (layerId, sourceId, targetId, value, metadata, auditMessage) =>
        this._request('POST', '/api/v1/relations', { auditMessage,
          body: bodyOf({ 'layer-id': layerId, 'source-id': sourceId, 'target-id': targetId, value, metadata }),
        }),
      /**
       * Create multiple relations in a single operation.
       * @param {Array} body - The request body
       */
      bulkCreate: (body, auditMessage) =>
        this._request('POST', '/api/v1/relations/bulk', { auditMessage, body }),
      /**
       * Delete multiple relations in a single operation. Provide an array of IDs.
       * @param {Array} body - The request body
       */
      bulkDelete: (body, auditMessage) =>
        this._request('DELETE', '/api/v1/relations/bulk', { auditMessage, body }),
    };

    this.spanLayers = {
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (spanLayerId, namespace, configKey, configValue, auditMessage) =>
        this._request('PUT', `/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`, { auditMessage,
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (spanLayerId, namespace, configKey, auditMessage) =>
        this._request('DELETE', `/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Get a span layer by ID.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (spanLayerId, asOf) =>
        this._request('GET', `/api/v1/span-layers/${spanLayerId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a span layer.
       * @param {string} spanLayerId - The span layer ID
       */
      delete: (spanLayerId, auditMessage) =>
        this._request('DELETE', `/api/v1/span-layers/${spanLayerId}`, { auditMessage }),
      /**
       * Update a span layer's name.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} name - The name
       */
      update: (spanLayerId, name, auditMessage) =>
        this._request('PATCH', `/api/v1/span-layers/${spanLayerId}`, { auditMessage,
          body: bodyOf({ name }),
        }),
      /**
       * Create a new span layer.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} name - The name
       */
      create: (tokenLayerId, name, auditMessage) =>
        this._request('POST', '/api/v1/span-layers', { auditMessage,
          body: bodyOf({ 'token-layer-id': tokenLayerId, name }),
        }),
      /**
       * Shift a span layer's display order.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} direction - The direction ("up" or "down")
       */
      shift: (spanLayerId, direction, auditMessage) =>
        this._request('POST', `/api/v1/span-layers/${spanLayerId}/shift`, { auditMessage,
          body: bodyOf({ direction }),
        }),
    };

    this.spans = {
      /**
       * Replace tokens for a span.
       * @param {string} spanId - The span ID
       * @param {Array} tokens - The tokens
       */
      setTokens: (spanId, tokens, auditMessage) =>
        this._request('PUT', `/api/v1/spans/${spanId}/tokens`, { auditMessage,
          body: bodyOf({ tokens }),
        }),
      /**
       * Create a new span. A span holds a primary atomic value and optional
       * metadata, and must at all times be associated with one or more tokens.
       * @param {string} spanLayerId - The span layer ID
       * @param {Array} tokens - The tokens
       * @param {any} value - The value
       * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
       */
      create: (spanLayerId, tokens, value, metadata, auditMessage) =>
        this._request('POST', '/api/v1/spans', { auditMessage,
          body: bodyOf({ 'span-layer-id': spanLayerId, tokens, value, metadata }),
        }),
      /**
       * Get a span by ID.
       * @param {string} spanId - The span ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (spanId, asOf) =>
        this._request('GET', `/api/v1/spans/${spanId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a span.
       * @param {string} spanId - The span ID
       */
      delete: (spanId, auditMessage) =>
        this._request('DELETE', `/api/v1/spans/${spanId}`, { auditMessage }),
      /**
       * Update a span's value.
       * @param {string} spanId - The span ID
       * @param {any} value - The value
       */
      update: (spanId, value, auditMessage) =>
        this._request('PATCH', `/api/v1/spans/${spanId}`, { auditMessage,
          body: bodyOf({ value }),
        }),
      /**
       * Create multiple spans in a single operation.
       * @param {Array} body - The request body
       */
      bulkCreate: (body, auditMessage) =>
        this._request('POST', '/api/v1/spans/bulk', { auditMessage, body }),
      /**
       * Delete multiple spans in a single operation. Provide an array of IDs.
       * @param {Array} body - The request body
       */
      bulkDelete: (body, auditMessage) =>
        this._request('DELETE', '/api/v1/spans/bulk', { auditMessage, body }),
      /**
       * Replace all metadata for a span.
       * @param {string} spanId - The span ID
       * @param {any} body - The request body
       */
      setMetadata: (spanId, body, auditMessage) =>
        this._request('PUT', `/api/v1/spans/${spanId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a span.
       * @param {string} spanId - The span ID
       */
      deleteMetadata: (spanId, auditMessage) =>
        this._request('DELETE', `/api/v1/spans/${spanId}/metadata`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a span. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} spanId - The span ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (spanId, body, auditMessage) =>
        this._request('PATCH', `/api/v1/spans/${spanId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
    };

    this.batch = {
      /**
       * Execute multiple API operations atomically. If any operation fails, all
       * changes are rolled back.
       * @param {Array} body - The request body
       */
      submit: (body, auditMessage) =>
        this._request('POST', '/api/v1/batch', { auditMessage,
          body, noBatch: true,
        }),
    };

    this.texts = {
      /**
       * Replace all metadata for a text.
       * @param {string} textId - The text ID
       * @param {any} body - The request body
       */
      setMetadata: (textId, body, auditMessage) =>
        this._request('PUT', `/api/v1/texts/${textId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a text.
       * @param {string} textId - The text ID
       */
      deleteMetadata: (textId, auditMessage) =>
        this._request('DELETE', `/api/v1/texts/${textId}/metadata`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a text. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} textId - The text ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (textId, body, auditMessage) =>
        this._request('PATCH', `/api/v1/texts/${textId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Create a new text in a document's text layer. A text is a container for
       * one long string in `body` for a given layer.
       * @param {string} textLayerId - The text layer ID
       * @param {string} documentId - The document ID
       * @param {string} body - The request body
       * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
       */
      create: (textLayerId, documentId, body, metadata, auditMessage) =>
        this._request('POST', '/api/v1/texts', { auditMessage,
          body: bodyOf({ 'text-layer-id': textLayerId, 'document-id': documentId, body, metadata }),
        }),
      /**
       * Get a text.
       * @param {string} textId - The text ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (textId, asOf) =>
        this._request('GET', `/api/v1/texts/${textId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a text and all dependent data.
       * @param {string} textId - The text ID
       */
      delete: (textId, auditMessage) =>
        this._request('DELETE', `/api/v1/texts/${textId}`, { auditMessage }),
      /**
       * Update a text's body. A diff is computed and token indices are updated
       * so that tokens remain intact. Alternatively, `body` can be a list of
       * edit directives.
       * @param {string} textId - The text ID
       * @param {any} body - The request body
       */
      update: (textId, body, auditMessage) =>
        this._request('PATCH', `/api/v1/texts/${textId}`, { auditMessage,
          body: bodyOf({ body }),
        }),
    };

    this.users = {
      /**
       * List (or search) users. Transparently follows pagination cursors and
       * returns the full flat array. Admin-or-maintainer only.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {object} [opts]
       * @param {string} [opts.q] - Filter to usernames containing this text (case-insensitive)
       * @param {string} [opts.asOf] - Temporal query timestamp
       */
      list: ({ q, asOf } = {}) =>
        listAll(this, '/api/v1/users', { query: { q, 'as-of': asOf } }),
      /**
       * Fetch a single page of users (optionally filtered by `q`).
       * @param {object} [opts]
       * @param {string} [opts.q] - Filter to usernames containing this text (case-insensitive)
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {string} [opts.asOf] - Temporal query timestamp
       * @returns {Promise<{entries: Array, nextCursor: (string|null)}>}
       */
      listPage: ({ q, limit, cursor, asOf } = {}) =>
        listPage(this, '/api/v1/users', { limit, cursor, query: { q, 'as-of': asOf } }),
      /**
       * Async-iterate users page by page; yields each page's entries array.
       * @param {object} [opts]
       * @param {string} [opts.q] - Filter to usernames containing this text (case-insensitive)
       * @param {number} [opts.pageSize] - Per-request page size
       * @param {string} [opts.asOf] - Temporal query timestamp
       * Cannot be used inside a batch (auto-paginates across requests); throws on first iteration if called while batching — use listPage() for a single page in a batch.
       * @returns {AsyncGenerator<Array>}
       */
      iterPages: ({ q, pageSize, asOf } = {}) =>
        iterPages(this, '/api/v1/users', { pageSize, query: { q, 'as-of': asOf } }),
      /**
       * Create a new user
       * @param {string} username - The username
       * @param {string} password - The password
       * @param {boolean} isAdmin - Whether the user is an admin
       */
      create: (username, password, isAdmin, auditMessage) =>
        this._request('POST', '/api/v1/users', { auditMessage,
          body: bodyOf({ username, password, 'is-admin': isAdmin }),
        }),
      /**
       * Get audit log for a user's actions. Transparently follows pagination
       * cursors and returns the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {string} userId - The user ID
       * @param {string} [startTime] - Start of time range
       * @param {string} [endTime] - End of time range
       * @param {string} [asOf] - Temporal query timestamp
       */
      audit: (userId, startTime, endTime, asOf) =>
        listAll(this, `/api/v1/users/${userId}/audit`, {
          query: { 'start-time': startTime, 'end-time': endTime, 'as-of': asOf },
        }),
      /**
       * Get a user by ID
       * @param {string} id - The resource ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (id, asOf) =>
        this._request('GET', `/api/v1/users/${id}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Deactivate a user. Users are never hard-deleted: deactivation
       * rejects their logins and tokens, strips their project memberships
       * and vocab maintainerships, and revokes their API tokens. The user
       * stays visible in listings with a deactivated-at timestamp.
       * Reversible via activate(), which restores login only.
       * @param {string} id - The resource ID
       */
      delete: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/users/${id}`, { auditMessage }),
      /**
       * Reactivate a deactivated user, restoring their ability to log in.
       * Project memberships, vocab maintainerships, and API tokens removed
       * at deactivation are NOT restored — re-grant them deliberately.
       * @param {string} id - The resource ID
       */
      activate: (id, auditMessage) =>
        this._request('POST', `/api/v1/users/${id}/activate`, { auditMessage }),
      /**
       * Modify a user. Admins may change the username, password, and admin
       * status of any user. All other users may only modify their own username
       * or password.
       * @param {string} id - The resource ID
       * @param {string} [password] - New password
       * @param {string} [username] - New username
       * @param {boolean} [isAdmin] - New admin status
       */
      update: (id, password, username, isAdmin, auditMessage) =>
        this._request('PATCH', `/api/v1/users/${id}`, { auditMessage,
          body: bodyOf({ password, username, 'is-admin': isAdmin }),
        }),
    };

    this.apiTokens = {
      /**
       * List a user's named API tokens. Never includes the signed token
       * string itself — that is only returned once, by create().
       * Transparently follows pagination cursors and returns the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {string} userId - The user ID who owns the tokens
       */
      list: (userId) =>
        listAll(this, `/api/v1/users/${userId}/tokens`),
      /**
       * Fetch a single page of a user's named API tokens.
       * @param {string} userId - The user ID who owns the tokens
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @returns {Promise<{entries: Array, nextCursor: (string|null)}>}
       */
      listPage: (userId, { limit, cursor } = {}) =>
        listPage(this, `/api/v1/users/${userId}/tokens`, { limit, cursor }),
      /**
       * Async-iterate a user's named API tokens page by page; yields each
       * page's entries array.
       * @param {string} userId - The user ID who owns the tokens
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * Cannot be used inside a batch (auto-paginates across requests); throws on first iteration if called while batching — use listPage() for a single page in a batch.
       * @returns {AsyncGenerator<Array>}
       */
      iterPages: (userId, { pageSize } = {}) =>
        iterPages(this, `/api/v1/users/${userId}/tokens`, { pageSize }),
      /**
       * Mint a named API token for a user. The returned `token` is the signed
       * credential and is shown ONLY here — store it immediately. API tokens
       * do not expire and survive password changes / logout; revoke to kill.
       * @param {string} userId - The user ID who will own the token
       * @param {string} name - A human label, e.g. "Stanza Parser"
       * @returns {Promise<{id: string, name: string, token: string}>}
       */
      create: (userId, name, auditMessage) =>
        this._request('POST', `/api/v1/users/${userId}/tokens`, { auditMessage,
          body: bodyOf({ name }),
        }),
      /**
       * Revoke a named API token (soft-revoke; idempotent).
       * @param {string} userId - The user ID who owns the token
       * @param {string} tokenId - The token ID to revoke
       */
      revoke: (userId, tokenId, auditMessage) =>
        this._request('DELETE', `/api/v1/users/${userId}/tokens/${tokenId}`, { auditMessage }),
    };

    this.tokenLayers = {
      /**
       * Shift a token layer's display order.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} direction - The direction ("up" or "down")
       */
      shift: (tokenLayerId, direction, auditMessage) =>
        this._request('POST', `/api/v1/token-layers/${tokenLayerId}/shift`, { auditMessage,
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new token layer.
       * @param {string} textLayerId - The text layer ID
       * @param {string} name - The name
       * @param {string} [overlapMode] - Per-layer, immutable token invariant: "any" (default), "non-overlapping", or "partitioning". On partitioning layers, single token create/update/delete are rejected; use bulkCreate plus split/merge/shift.
       * @param {string} [parentTokenLayerId] - Optional immutable parent token layer. Tokens in this layer must nest within a parent-layer token; the parent layer must be in the same text layer and be "non-overlapping" or "partitioning" (an "any" parent is rejected). A nested layer may be "any" or "non-overlapping" but not "partitioning" (partitioning is only for root layers), e.g. words (non-overlapping, parent=sentences) within sentences (partitioning).
       */
      create: (textLayerId, name, overlapMode, parentTokenLayerId, auditMessage) =>
        this._request('POST', '/api/v1/token-layers', { auditMessage,
          body: bodyOf({ 'text-layer-id': textLayerId, name, 'overlap-mode': overlapMode, 'parent-token-layer-id': parentTokenLayerId }),
        }),
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (tokenLayerId, namespace, configKey, configValue, auditMessage) =>
        this._request('PUT', `/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`, { auditMessage,
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (tokenLayerId, namespace, configKey, auditMessage) =>
        this._request('DELETE', `/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Get a token layer by ID.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (tokenLayerId, asOf) =>
        this._request('GET', `/api/v1/token-layers/${tokenLayerId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a token layer.
       * @param {string} tokenLayerId - The token layer ID
       */
      delete: (tokenLayerId, auditMessage) =>
        this._request('DELETE', `/api/v1/token-layers/${tokenLayerId}`, { auditMessage }),
      /**
       * Update a token layer's name.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} name - The name
       */
      update: (tokenLayerId, name, auditMessage) =>
        this._request('PATCH', `/api/v1/token-layers/${tokenLayerId}`, { auditMessage,
          body: bodyOf({ name }),
        }),
    };

    this.documents = {
      /**
       * Check the lock status of a document.
       * @param {string} documentId - The document ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      checkLock: (documentId, asOf) =>
        this._request('GET', `/api/v1/documents/${documentId}/lock`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Acquire or refresh a document lock
       * @param {string} documentId - The document ID
       */
      acquireLock: (documentId, auditMessage) =>
        this._request('POST', `/api/v1/documents/${documentId}/lock`, { auditMessage }),
      /**
       * Release a document lock
       * @param {string} documentId - The document ID
       */
      releaseLock: (documentId, auditMessage) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/lock`, { auditMessage }),
      /**
       * Get media file for a document
       * @param {string} documentId - The document ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      getMedia: (documentId, asOf) =>
        this._request('GET', `/api/v1/documents/${documentId}/media`, {
          queryParams: { 'as-of': asOf },
          noBatch: true,
          binaryResponse: true,
        }),
      /**
       * Upload a media file for a document. Uses Apache Tika for content validation.
       * @param {string} documentId - The document ID
       * @param {File} file - The file to upload
       */
      uploadMedia: (documentId, file, auditMessage) => {
        const fd = new FormData();
        fd.append('file', file);
        return this._request('PUT', `/api/v1/documents/${documentId}/media`, { auditMessage,
          body: fd, formData: true, noBatch: true,
        });
      },
      /**
       * Delete media file for a document
       * @param {string} documentId - The document ID
       */
      deleteMedia: (documentId, auditMessage) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/media`, { auditMessage,
          noBatch: true,
        }),
      /**
       * Replace all metadata for a document.
       * @param {string} documentId - The document ID
       * @param {any} body - The request body
       */
      setMetadata: (documentId, body, auditMessage) =>
        this._request('PUT', `/api/v1/documents/${documentId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a document.
       * @param {string} documentId - The document ID
       */
      deleteMetadata: (documentId, auditMessage) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/metadata`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a document. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} documentId - The document ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (documentId, body, auditMessage) =>
        this._request('PATCH', `/api/v1/documents/${documentId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Get audit log for a document. Transparently follows pagination cursors
       * and returns the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {string} documentId - The document ID
       * @param {string} [startTime] - Start of time range
       * @param {string} [endTime] - End of time range
       * @param {string} [asOf] - Temporal query timestamp
       */
      audit: (documentId, startTime, endTime, asOf) =>
        listAll(this, `/api/v1/documents/${documentId}/audit`, {
          query: { 'start-time': startTime, 'end-time': endTime, 'as-of': asOf },
        }),
      /**
       * Get a document. Set `includeBody` to true to include all data.
       * @param {string} documentId - The document ID
       * @param {boolean} [includeBody] - Include document body data
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (documentId, includeBody, asOf) =>
        this._request('GET', `/api/v1/documents/${documentId}`, {
          queryParams: { 'include-body': includeBody, 'as-of': asOf },
        }),
      /**
       * Delete a document and all data contained.
       * @param {string} documentId - The document ID
       */
      delete: (documentId, auditMessage) =>
        this._request('DELETE', `/api/v1/documents/${documentId}`, { auditMessage }),
      /**
       * Update a document's name.
       * @param {string} documentId - The document ID
       * @param {string} name - The name
       */
      update: (documentId, name, auditMessage) =>
        this._request('PATCH', `/api/v1/documents/${documentId}`, { auditMessage,
          body: bodyOf({ name }),
        }),
      /**
       * Create a new document in a project.
       * @param {string} projectId - The project ID
       * @param {string} name - The name
       * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
       */
      create: (projectId, name, metadata, auditMessage) =>
        this._request('POST', '/api/v1/documents', { auditMessage,
          body: bodyOf({ 'project-id': projectId, name, metadata }),
        }),
    };

    this.projects = {
      /**
       * Set a user's access level to read and write for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      addWriter: (id, userId, auditMessage) =>
        this._request('POST', `/api/v1/projects/${id}/writers/${userId}`, { auditMessage }),
      /**
       * Remove a user's writer privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      removeWriter: (id, userId, auditMessage) =>
        this._request('DELETE', `/api/v1/projects/${id}/writers/${userId}`, { auditMessage }),
      /**
       * Set a user's access level to read-only for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      addReader: (id, userId, auditMessage) =>
        this._request('POST', `/api/v1/projects/${id}/readers/${userId}`, { auditMessage }),
      /**
       * Remove a user's reader privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      removeReader: (id, userId, auditMessage) =>
        this._request('DELETE', `/api/v1/projects/${id}/readers/${userId}`, { auditMessage }),
      /**
       * Set a configuration value for a project in an editor namespace.
       * @param {string} id - The resource ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (id, namespace, configKey, configValue, auditMessage) =>
        this._request('PUT', `/api/v1/projects/${id}/config/${namespace}/${configKey}`, { auditMessage,
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a project.
       * @param {string} id - The resource ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (id, namespace, configKey, auditMessage) =>
        this._request('DELETE', `/api/v1/projects/${id}/config/${namespace}/${configKey}`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Assign a user as a maintainer for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      addMaintainer: (id, userId, auditMessage) =>
        this._request('POST', `/api/v1/projects/${id}/maintainers/${userId}`, { auditMessage }),
      /**
       * Remove a user's maintainer privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      removeMaintainer: (id, userId, auditMessage) =>
        this._request('DELETE', `/api/v1/projects/${id}/maintainers/${userId}`, { auditMessage }),
      /**
       * Get audit log for a project. Transparently follows pagination cursors
       * and returns the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {string} projectId - The project ID
       * @param {string} [startTime] - Start of time range
       * @param {string} [endTime] - End of time range
       * @param {string} [asOf] - Temporal query timestamp
       */
      audit: (projectId, startTime, endTime, asOf) =>
        listAll(this, `/api/v1/projects/${projectId}/audit`, {
          query: { 'start-time': startTime, 'end-time': endTime, 'as-of': asOf },
        }),
      /**
       * Link a vocabulary to a project.
       * @param {string} id - The resource ID
       * @param {string} vocabId - The vocab layer ID
       */
      linkVocab: (id, vocabId, auditMessage) =>
        this._request('POST', `/api/v1/projects/${id}/vocabs/${vocabId}`, { auditMessage }),
      /**
       * Unlink a vocabulary from a project.
       * @param {string} id - The resource ID
       * @param {string} vocabId - The vocab layer ID
       */
      unlinkVocab: (id, vocabId, auditMessage) =>
        this._request('DELETE', `/api/v1/projects/${id}/vocabs/${vocabId}`, { auditMessage }),
      /**
       * Get a project by ID. To fetch the project's documents, use
       * listDocuments(id) — the include-documents flag has been removed.
       * @param {string} id - The resource ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (id, asOf) =>
        this._request('GET', `/api/v1/projects/${id}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * List all documents in a project. Transparently follows pagination
       * cursors and returns the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       *
       * Note: this endpoint does not support temporal (`as-of`) queries; the
       * server rejects `?as-of=` on the documents-list route with a 400.
       * @param {string} id - The project ID
       */
      listDocuments: (id) =>
        listAll(this, `/api/v1/projects/${id}/documents`),
      /**
       * Fetch a single page of a project's documents.
       *
       * Note: this endpoint does not support temporal (`as-of`) queries; the
       * server rejects `?as-of=` on the documents-list route with a 400.
       * @param {string} id - The project ID
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @returns {Promise<{entries: Array, nextCursor: (string|null)}>}
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
       * Cannot be used inside a batch (auto-paginates across requests); throws on first iteration if called while batching — use listPage() for a single page in a batch.
       * @returns {AsyncGenerator<Array>}
       */
      iterDocuments: (id, { pageSize } = {}) =>
        iterPages(this, `/api/v1/projects/${id}/documents`, { pageSize }),
      /**
       * Delete a project.
       * @param {string} id - The resource ID
       */
      delete: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/projects/${id}`, { auditMessage }),
      /**
       * Update a project's name.
       * @param {string} id - The resource ID
       * @param {string} name - The name
       */
      update: (id, name, auditMessage) =>
        this._request('PATCH', `/api/v1/projects/${id}`, { auditMessage,
          body: bodyOf({ name }),
        }),
      /**
       * List all projects accessible to user. Transparently follows pagination
       * cursors and returns the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {string} [asOf] - Temporal query timestamp
       */
      list: (asOf) =>
        listAll(this, '/api/v1/projects', { query: { 'as-of': asOf } }),
      /**
       * Fetch a single page of projects.
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {string} [opts.asOf] - Temporal query timestamp
       * @returns {Promise<{entries: Array, nextCursor: (string|null)}>}
       */
      listPage: ({ limit, cursor, asOf } = {}) =>
        listPage(this, '/api/v1/projects', { limit, cursor, query: { 'as-of': asOf } }),
      /**
       * Async-iterate projects page by page; yields each page's entries array.
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * @param {string} [opts.asOf] - Temporal query timestamp
       * Cannot be used inside a batch (auto-paginates across requests); throws on first iteration if called while batching — use listPage() for a single page in a batch.
       * @returns {AsyncGenerator<Array>}
       */
      iterPages: ({ pageSize, asOf } = {}) =>
        iterPages(this, '/api/v1/projects', { pageSize, query: { 'as-of': asOf } }),
      /**
       * Create a new project. Note: this also registers the user as a maintainer.
       * @param {string} name - The name
       */
      create: (name, auditMessage) =>
        this._request('POST', '/api/v1/projects', { auditMessage,
          body: bodyOf({ name }),
        }),
    };

    this.textLayers = {
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} textLayerId - The text layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (textLayerId, namespace, configKey, configValue, auditMessage) =>
        this._request('PUT', `/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`, { auditMessage,
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} textLayerId - The text layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (textLayerId, namespace, configKey, auditMessage) =>
        this._request('DELETE', `/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Get a text layer by ID.
       * @param {string} textLayerId - The text layer ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (textLayerId, asOf) =>
        this._request('GET', `/api/v1/text-layers/${textLayerId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a text layer.
       * @param {string} textLayerId - The text layer ID
       */
      delete: (textLayerId, auditMessage) =>
        this._request('DELETE', `/api/v1/text-layers/${textLayerId}`, { auditMessage }),
      /**
       * Update a text layer's name.
       * @param {string} textLayerId - The text layer ID
       * @param {string} name - The name
       */
      update: (textLayerId, name, auditMessage) =>
        this._request('PATCH', `/api/v1/text-layers/${textLayerId}`, { auditMessage,
          body: bodyOf({ name }),
        }),
      /**
       * Shift a text layer's display order within the project.
       * @param {string} textLayerId - The text layer ID
       * @param {string} direction - The direction ("up" or "down")
       */
      shift: (textLayerId, direction, auditMessage) =>
        this._request('POST', `/api/v1/text-layers/${textLayerId}/shift`, { auditMessage,
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new text layer for a project.
       * @param {string} projectId - The project ID
       * @param {string} name - The name
       */
      create: (projectId, name, auditMessage) =>
        this._request('POST', '/api/v1/text-layers', { auditMessage,
          body: bodyOf({ 'project-id': projectId, name }),
        }),
    };

    this.vocabItems = {
      /**
       * Replace all metadata for a vocab item.
       * @param {string} id - The resource ID
       * @param {any} body - The request body
       */
      setMetadata: (id, body, auditMessage) =>
        this._request('PUT', `/api/v1/vocab-items/${id}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a vocab item.
       * @param {string} id - The resource ID
       */
      deleteMetadata: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/vocab-items/${id}/metadata`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a vocab item. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} id - The resource ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (id, body, auditMessage) =>
        this._request('PATCH', `/api/v1/vocab-items/${id}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Create a new vocab item
       * @param {string} vocabLayerId - The vocab layer ID
       * @param {string} form - The vocab item form
       * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
       */
      create: (vocabLayerId, form, metadata, auditMessage) =>
        this._request('POST', '/api/v1/vocab-items', { auditMessage,
          body: bodyOf({ 'vocab-layer-id': vocabLayerId, form, metadata }),
        }),
      /**
       * Get a vocab item by ID
       * @param {string} id - The resource ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (id, asOf) =>
        this._request('GET', `/api/v1/vocab-items/${id}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a vocab item
       * @param {string} id - The resource ID
       */
      delete: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/vocab-items/${id}`, { auditMessage }),
      /**
       * Update a vocab item's form
       * @param {string} id - The resource ID
       * @param {string} form - The vocab item form
       */
      update: (id, form, auditMessage) =>
        this._request('PATCH', `/api/v1/vocab-items/${id}`, { auditMessage,
          body: bodyOf({ form }),
        }),
    };

    this.relationLayers = {
      /**
       * Shift a relation layer's display order.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} direction - The direction ("up" or "down")
       */
      shift: (relationLayerId, direction, auditMessage) =>
        this._request('POST', `/api/v1/relation-layers/${relationLayerId}/shift`, { auditMessage,
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new relation layer.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} name - The name
       */
      create: (spanLayerId, name, auditMessage) =>
        this._request('POST', '/api/v1/relation-layers', { auditMessage,
          body: bodyOf({ 'span-layer-id': spanLayerId, name }),
        }),
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (relationLayerId, namespace, configKey, configValue, auditMessage) =>
        this._request('PUT', `/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`, { auditMessage,
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (relationLayerId, namespace, configKey, auditMessage) =>
        this._request('DELETE', `/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Get a relation layer by ID.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (relationLayerId, asOf) =>
        this._request('GET', `/api/v1/relation-layers/${relationLayerId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a relation layer.
       * @param {string} relationLayerId - The relation layer ID
       */
      delete: (relationLayerId, auditMessage) =>
        this._request('DELETE', `/api/v1/relation-layers/${relationLayerId}`, { auditMessage }),
      /**
       * Update a relation layer's name.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} name - The name
       */
      update: (relationLayerId, name, auditMessage) =>
        this._request('PATCH', `/api/v1/relation-layers/${relationLayerId}`, { auditMessage,
          body: bodyOf({ name }),
        }),
    };

    this.tokens = {
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
       */
      create: (tokenLayerId, text, begin, end, precedence, metadata, auditMessage) =>
        this._request('POST', '/api/v1/tokens', { auditMessage,
          body: bodyOf({ 'token-layer-id': tokenLayerId, text, begin, end, precedence, metadata }),
        }),
      /**
       * Get a token.
       * @param {string} tokenId - The token ID
       * @param {string} [asOf] - Temporal query timestamp
       */
      get: (tokenId, asOf) =>
        this._request('GET', `/api/v1/tokens/${tokenId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a token and remove it from any spans. If this causes a span to
       * have no remaining tokens, the span will also be deleted.
       * @param {string} tokenId - The token ID
       */
      delete: (tokenId, auditMessage) =>
        this._request('DELETE', `/api/v1/tokens/${tokenId}`, { auditMessage }),
      /**
       * Update a token.
       * @param {string} tokenId - The token ID
       * @param {number} [begin] - New start offset, inclusive (Unicode code points)
       * @param {number} [end] - New end offset, exclusive (Unicode code points)
       * @param {?number} [precedence] - Ordering precedence. Omit (undefined)
       *   to leave unchanged; pass a number to set; pass null explicitly to
       *   CLEAR it (revert to no explicit ordering). bodyOf keeps null but
       *   drops undefined, so the three cases map correctly to the server.
       */
      update: (tokenId, begin, end, precedence, auditMessage) =>
        this._request('PATCH', `/api/v1/tokens/${tokenId}`, { auditMessage,
          body: bodyOf({ begin, end, precedence }),
        }),
      /**
       * Create multiple tokens in a single operation.
       * @param {Array} body - The request body
       */
      bulkCreate: (body, auditMessage) =>
        this._request('POST', '/api/v1/tokens/bulk', { auditMessage, body }),
      /**
       * Delete multiple tokens in a single operation. Provide an array of IDs.
       * @param {Array} body - The request body
       */
      bulkDelete: (body, auditMessage) =>
        this._request('DELETE', '/api/v1/tokens/bulk', { auditMessage, body }),
      /**
       * Split a token at a Unicode code-point offset. The original token becomes the
       * left half (keeps its ID, spans, vocab-links); the new right token's ID is returned.
       * @param {string} tokenId - The token ID
       * @param {number} position - Code-point offset to split at (strictly between begin and end)
       */
      split: (tokenId, position, auditMessage) =>
        this._request('POST', `/api/v1/tokens/${tokenId}/split`, { auditMessage,
          body: bodyOf({ position }),
        }),
      /**
       * Merge two tokens. The left token (smaller begin) survives with the combined
       * extent; the right is deleted and its spans/vocab-links are reparented to the left.
       * On partitioning layers the tokens must be adjacent; on non-overlapping layers the
       * merged extent must not engulf a third token.
       * @param {string} tokenId - The anchor token ID
       * @param {string} otherTokenId - The other token to merge in
       */
      merge: (tokenId, otherTokenId, auditMessage) =>
        this._request('POST', `/api/v1/tokens/${tokenId}/merge`, { auditMessage,
          body: bodyOf({ 'other-token-id': otherTokenId }),
        }),
      /**
       * Shift a token's boundary. On partitioning layers the adjacent token is
       * auto-adjusted to preserve the partition; on non-overlapping layers a shift that
       * would create an overlap is rejected.
       * @param {string} tokenId - The token ID
       * @param {number} [begin] - New start offset, inclusive (Unicode code points)
       * @param {number} [end] - New end offset, exclusive (Unicode code points)
       */
      shift: (tokenId, begin, end, auditMessage) =>
        this._request('POST', `/api/v1/tokens/${tokenId}/shift`, { auditMessage,
          body: bodyOf({ begin, end }),
        }),
      /**
       * Replace all metadata for a token.
       * @param {string} tokenId - The token ID
       * @param {any} body - The request body
       */
      setMetadata: (tokenId, body, auditMessage) =>
        this._request('PUT', `/api/v1/tokens/${tokenId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a token.
       * @param {string} tokenId - The token ID
       */
      deleteMetadata: (tokenId, auditMessage) =>
        this._request('DELETE', `/api/v1/tokens/${tokenId}/metadata`, { auditMessage,
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a token. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} tokenId - The token ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (tokenId, body, auditMessage) =>
        this._request('PATCH', `/api/v1/tokens/${tokenId}/metadata`, { auditMessage,
          rawBody: body, skipResponseTransform: true,
        }),
    };

    this.messages = {
      /**
       * Open a Server-Sent Events stream for a project.
       * @param {string} projectId - The UUID of the project to listen to
       * @param {function} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop.
       * @param {string} [path] - Stream path under baseUrl (defaults to the project /listen bus; service channels pass their own).
       * @returns {Object} SSE connection object with .close() and .getStats() methods
       */
      listen: (projectId, onEvent, path) =>
        createSSEConnection(this, projectId, onEvent, path),

      /**
       * Send a message to project listeners
       * @param {string} projectId - The UUID of the project to send to
       * @param {any} data - The message data to send
       * @returns {Promise<any>} Response from the send operation
       */
      sendMessage: (projectId, data, auditMessage) =>
        this._request('POST', `/api/v1/projects/${projectId}/message`, { auditMessage,
          body: { body: data },
        }),

      /**
       * Discover the services seen on a project (synchronous GET). Currently
       * connected services carry `online: true`; previously-seen offline ones
       * carry `online: false` plus a `lastSeenAt` stamp.
       * @param {string} projectId - The UUID of the project to query
       * @returns {Promise<Array>} Array of discovered service information
       */
      discoverServices: (projectId) =>
        discoverServices(this, projectId),

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
       * Register as a service and handle incoming work requests.
       * @param {string} projectId - The UUID of the project to serve
       * @param {Object} serviceInfo - Service information {serviceId, serviceName, description}
       * @param {function} onServiceRequest - Callback (data, responseHelper)
       * @param {Object} [extras] - Optional additional service metadata
       * @returns {Object} Service registration object with .stop() method
       */
      serve: (projectId, serviceInfo, onServiceRequest, extras) =>
        serve(this, projectId, serviceInfo, onServiceRequest, extras),

      /**
       * Request a service to perform work and await its result.
       * @param {string} projectId - The UUID of the project
       * @param {string} serviceId - The ID of the service to request
       * @param {any} data - The request data
       * @param {number} [timeout] - Timeout in milliseconds (default: 10000)
       * @param {function} [onProgress] - Called with each progress payload {percent, message}
       * @returns {Promise<any>} Service response
       */
      requestService: (projectId, serviceId, data, timeout, onProgress) =>
        requestService(this, projectId, serviceId, data, timeout, onProgress),
    };

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
     * Optional keys: `scope` (restrict to projects by id, `{projectIds}`), `orderBy`
     * (sort rows), and `bindings` (substitute `?name` placeholders with literals).
     * `return` may also be an aggregate spec `{group, aggregates}`. See the query
     * language reference.
     *
     * @param {Object} body - The query AST ({find, where, scope?, limit?, orderBy?,
     *   return?, bindings?}).
     * @returns {Promise<Object>} For 'ids'/'entities': {columns, results, count, truncated}.
     *   For 'count': {return: 'count', count}. Entity cells are full entity objects
     *   (same shape as the GET endpoints).
     */
    this.query = (body, auditMessage) =>
      this._request('POST', '/api/v1/query', { auditMessage, body });
  }

  // --- Core methods ---

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
   * Set a custom audit-log message applied to every subsequent write request,
   * OVERRIDING the server's auto-generated description (e.g. "Patch metadata
   * on span X"). The message may template the endpoint's own path/query/body
   * params with `{param}` placeholders, resolved server-side — e.g.
   * `"Approve span {spanId}"`. Placeholder names are case/separator-insensitive
   * (`{spanId}` == `{span-id}` == `{span_id}`). Applies to GET-less requests
   * only, including every operation queued in a batch.
   * @param {string} message - The custom message (template).
   */
  setAuditMessage(message) {
    this.auditMessage = message;
    return this;
  }

  /** Clear the ambient custom audit-log message (revert to auto-generated). */
  clearAuditMessage() {
    this.auditMessage = null;
    return this;
  }

  /**
   * Run `fn` with a custom audit-log message in effect, restoring the previous
   * message afterward (supports nesting). Use it to scope ONE call (per-call
   * precision) or MANY (a logical unit):
   *
   *   await client.withAuditMessage('Approve span {spanId}', () =>
   *     client.spans.update(spanId, ...));
   *
   *   await client.withAuditMessage('Import sentence', async () => {
   *     await client.tokens.create(...);
   *     await client.spans.create(...);
   *   });
   *
   * @param {string} message - The custom message (template).
   * @param {() => (Promise<any>|any)} fn - The work to run with the message set.
   * @returns {Promise<any>} Whatever `fn` resolves to.
   */
  async withAuditMessage(message, fn) {
    const prev = this.auditMessage;
    this.auditMessage = message;
    try {
      return await fn();
    } finally {
      this.auditMessage = prev;
    }
  }

  /** Begin a batch of operations. Subsequent API calls will be queued. */
  beginBatch() {
    this.isBatching = true;
    this.batchOperations = [];
    // Strict mode stamps the expected document-version on the FIRST write of
    // the batch only (see _request) — reset the marker per batch.
    this.batchVersionStamped = false;
  }

  /**
   * Submit all queued batch operations as a single batch request, executed
   * atomically. If any operation fails, all changes are rolled back.
   * @returns {Promise<Array>} Array of results corresponding to each operation
   */
  async submitBatch() {
    if (!this.isBatching) {
      throw new Error('No active batch. Call beginBatch() first.');
    }

    if (this.batchOperations.length === 0) {
      this.isBatching = false;
      return [];
    }

    try {
      let url = `${this.baseUrl}/api/v1/batch`;
      const body = this.batchOperations.map(op => ({
        path: op.path,
        method: op.method.toUpperCase(),
        ...(op.body && { body: op.body }),
      }));

      const fetchOptions = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      };
      const signal = timeoutSignal(this.timeout);
      if (signal) fetchOptions.signal = signal;

      try {
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
          throw makeHttpError(response, await parseErrorBody(response), url, 'POST');
        }

        const results = await response.json();

        // Extract document versions from each batch response
        for (const result of results) {
          if (result.headers && result.headers['X-Document-Versions']) {
            try {
              const versionsMap = JSON.parse(result.headers['X-Document-Versions']);
              if (typeof versionsMap === 'object' && versionsMap !== null) {
                // Clone once per response, then merge — not once per entry.
                this.documentVersions = { ...this.documentVersions, ...versionsMap };
              }
            } catch (e) {
              console.warn('Failed to parse document versions header from batch response:', e);
            }
          }
        }

        return results.map(result => transformResponse(result));
      } catch (error) {
        if (error.status) throw error;
        throw makeNetworkError(error, url, 'POST');
      }
    } finally {
      this.isBatching = false;
      this.batchOperations = [];
    }
  }

  /** Abort the current batch without executing any operations. */
  abortBatch() {
    this.isBatching = false;
    this.batchOperations = [];
  }

  /**
   * Check if currently in batch mode.
   * @returns {boolean}
   */
  isBatchMode() {
    return this.isBatching;
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
    baseUrl = baseUrl.replace(/\/$/, '');
    const url = `${baseUrl}/api/v1/login`;
    try {
      const fetchOptions = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'user-id': userId, password }),
      };
      const signal = timeoutSignal(options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS);
      if (signal) fetchOptions.signal = signal;

      const response = await fetch(url, fetchOptions);
      if (!response.ok) {
        throw makeHttpError(response, await parseErrorBody(response), url, 'POST');
      }

      const data = await response.json();
      const token = data.token || '';
      return new PlaidClient(baseUrl, token, options);
    } catch (error) {
      if (error.status) throw error;
      throw makeNetworkError(error, url, 'POST');
    }
  }
}

export default PlaidClient;
export { PlaidClient };

// Unicode code-point helpers for text offsets (token begin/end are code-point
// indices). See ./codepoint.js.
export { cpLength, cpSlice, cpSlicer, utf16ToCp, cpToUtf16, cpIndexOf } from './codepoint.js';
export { PLAID_NAMESPACE, ROLE_KEY, ROLES, readRole, findByRole } from './roles.js';
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
} from './serviceSchema.js';
// Provenance: the cross-app convention for machine-provided vs human-labeled
// information (flat prov/provSource/provConfirmed metadata; absence = human),
// plus the machine-writer contract. See ./provenance.js and the manual,
// "Provenance".
export {
  PROV,
  PROV_STATES,
  stampInferred,
  confirmedInferred,
  provState,
  isProtected,
  verifyOnEdit,
  serviceSource,
} from './provenance.js';
