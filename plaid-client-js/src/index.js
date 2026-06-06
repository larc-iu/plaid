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

    // --- API Bundles ---

    this.vocabLinks = {
      /**
       * Create a new vocab link between tokens and a vocab item.
       * @param {string} vocabItem - The vocab item to link
       * @param {Array} tokens - The tokens to link
       * @param {any} [metadata] - Metadata for the link. Omit to leave unset; pass null to send JSON null.
       */
      create: (vocabItem, tokens, metadata) =>
        this._request('POST', '/api/v1/vocab-links', {
          body: bodyOf({ 'vocab-item': vocabItem, tokens, metadata }),
        }),
      /**
       * Replace all metadata for a vocab link. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
       * @param {string} id - The resource ID
       * @param {any} body - The request body
       */
      setMetadata: (id, body) =>
        this._request('PUT', `/api/v1/vocab-links/${id}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a vocab link.
       * @param {string} id - The resource ID
       */
      deleteMetadata: (id) =>
        this._request('DELETE', `/api/v1/vocab-links/${id}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a vocab link. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} id - The resource ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (id, body) =>
        this._request('PATCH', `/api/v1/vocab-links/${id}/metadata`, {
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
      delete: (id) =>
        this._request('DELETE', `/api/v1/vocab-links/${id}`),
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
      delete: (id) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}`),
      /**
       * Update a vocab layer's name.
       * @param {string} id - The resource ID
       * @param {string} name - The name
       */
      update: (id, name) =>
        this._request('PATCH', `/api/v1/vocab-layers/${id}`, {
          body: bodyOf({ name }),
        }),
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} id - The resource ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (id, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/vocab-layers/${id}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} id - The resource ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (id, namespace, configKey) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}/config/${namespace}/${configKey}`, {
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
      create: (name) =>
        this._request('POST', '/api/v1/vocab-layers', {
          body: bodyOf({ name }),
        }),
      /**
       * Assign a user as a maintainer for this vocab layer.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      addMaintainer: (id, userId) =>
        this._request('POST', `/api/v1/vocab-layers/${id}/maintainers/${userId}`),
      /**
       * Remove a user's maintainer privileges for this vocab layer.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      removeMaintainer: (id, userId) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}/maintainers/${userId}`),
    };

    this.relations = {
      /**
       * Replace all metadata for a relation.
       * @param {string} relationId - The relation ID
       * @param {any} body - The request body
       */
      setMetadata: (relationId, body) =>
        this._request('PUT', `/api/v1/relations/${relationId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a relation.
       * @param {string} relationId - The relation ID
       */
      deleteMetadata: (relationId) =>
        this._request('DELETE', `/api/v1/relations/${relationId}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a relation. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} relationId - The relation ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (relationId, body) =>
        this._request('PATCH', `/api/v1/relations/${relationId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Update the target span of a relation.
       * @param {string} relationId - The relation ID
       * @param {string} spanId - The span ID
       */
      setTarget: (relationId, spanId) =>
        this._request('PUT', `/api/v1/relations/${relationId}/target`, {
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
      delete: (relationId) =>
        this._request('DELETE', `/api/v1/relations/${relationId}`),
      /**
       * Update a relation's value.
       * @param {string} relationId - The relation ID
       * @param {any} value - The value
       */
      update: (relationId, value) =>
        this._request('PATCH', `/api/v1/relations/${relationId}`, {
          body: bodyOf({ value }),
        }),
      /**
       * Update the source span of a relation.
       * @param {string} relationId - The relation ID
       * @param {string} spanId - The span ID
       */
      setSource: (relationId, spanId) =>
        this._request('PUT', `/api/v1/relations/${relationId}/source`, {
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
      create: (layerId, sourceId, targetId, value, metadata) =>
        this._request('POST', '/api/v1/relations', {
          body: bodyOf({ 'layer-id': layerId, 'source-id': sourceId, 'target-id': targetId, value, metadata }),
        }),
      /**
       * Create multiple relations in a single operation.
       * @param {Array} body - The request body
       */
      bulkCreate: (body) =>
        this._request('POST', '/api/v1/relations/bulk', { body }),
      /**
       * Delete multiple relations in a single operation. Provide an array of IDs.
       * @param {Array} body - The request body
       */
      bulkDelete: (body) =>
        this._request('DELETE', '/api/v1/relations/bulk', { body }),
    };

    this.spanLayers = {
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (spanLayerId, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (spanLayerId, namespace, configKey) =>
        this._request('DELETE', `/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`, {
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
      delete: (spanLayerId) =>
        this._request('DELETE', `/api/v1/span-layers/${spanLayerId}`),
      /**
       * Update a span layer's name.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} name - The name
       */
      update: (spanLayerId, name) =>
        this._request('PATCH', `/api/v1/span-layers/${spanLayerId}`, {
          body: bodyOf({ name }),
        }),
      /**
       * Create a new span layer.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} name - The name
       */
      create: (tokenLayerId, name) =>
        this._request('POST', '/api/v1/span-layers', {
          body: bodyOf({ 'token-layer-id': tokenLayerId, name }),
        }),
      /**
       * Shift a span layer's display order.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} direction - The direction ("up" or "down")
       */
      shift: (spanLayerId, direction) =>
        this._request('POST', `/api/v1/span-layers/${spanLayerId}/shift`, {
          body: bodyOf({ direction }),
        }),
    };

    this.spans = {
      /**
       * Replace tokens for a span.
       * @param {string} spanId - The span ID
       * @param {Array} tokens - The tokens
       */
      setTokens: (spanId, tokens) =>
        this._request('PUT', `/api/v1/spans/${spanId}/tokens`, {
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
      create: (spanLayerId, tokens, value, metadata) =>
        this._request('POST', '/api/v1/spans', {
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
      delete: (spanId) =>
        this._request('DELETE', `/api/v1/spans/${spanId}`),
      /**
       * Update a span's value.
       * @param {string} spanId - The span ID
       * @param {any} value - The value
       */
      update: (spanId, value) =>
        this._request('PATCH', `/api/v1/spans/${spanId}`, {
          body: bodyOf({ value }),
        }),
      /**
       * Create multiple spans in a single operation.
       * @param {Array} body - The request body
       */
      bulkCreate: (body) =>
        this._request('POST', '/api/v1/spans/bulk', { body }),
      /**
       * Delete multiple spans in a single operation. Provide an array of IDs.
       * @param {Array} body - The request body
       */
      bulkDelete: (body) =>
        this._request('DELETE', '/api/v1/spans/bulk', { body }),
      /**
       * Replace all metadata for a span.
       * @param {string} spanId - The span ID
       * @param {any} body - The request body
       */
      setMetadata: (spanId, body) =>
        this._request('PUT', `/api/v1/spans/${spanId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a span.
       * @param {string} spanId - The span ID
       */
      deleteMetadata: (spanId) =>
        this._request('DELETE', `/api/v1/spans/${spanId}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a span. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} spanId - The span ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (spanId, body) =>
        this._request('PATCH', `/api/v1/spans/${spanId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
    };

    this.batch = {
      /**
       * Execute multiple API operations atomically. If any operation fails, all
       * changes are rolled back.
       * @param {Array} body - The request body
       */
      submit: (body) =>
        this._request('POST', '/api/v1/batch', {
          body, noBatch: true,
        }),
    };

    this.texts = {
      /**
       * Replace all metadata for a text.
       * @param {string} textId - The text ID
       * @param {any} body - The request body
       */
      setMetadata: (textId, body) =>
        this._request('PUT', `/api/v1/texts/${textId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a text.
       * @param {string} textId - The text ID
       */
      deleteMetadata: (textId) =>
        this._request('DELETE', `/api/v1/texts/${textId}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a text. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} textId - The text ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (textId, body) =>
        this._request('PATCH', `/api/v1/texts/${textId}/metadata`, {
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
      create: (textLayerId, documentId, body, metadata) =>
        this._request('POST', '/api/v1/texts', {
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
      delete: (textId) =>
        this._request('DELETE', `/api/v1/texts/${textId}`),
      /**
       * Update a text's body. A diff is computed and token indices are updated
       * so that tokens remain intact. Alternatively, `body` can be a list of
       * edit directives.
       * @param {string} textId - The text ID
       * @param {any} body - The request body
       */
      update: (textId, body) =>
        this._request('PATCH', `/api/v1/texts/${textId}`, {
          body: bodyOf({ body }),
        }),
    };

    this.users = {
      /**
       * List all users. Transparently follows pagination cursors and returns
       * the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {string} [asOf] - Temporal query timestamp
       */
      list: (asOf) =>
        listAll(this, '/api/v1/users', { query: { 'as-of': asOf } }),
      /**
       * Fetch a single page of users.
       * @param {object} [opts]
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @param {string} [opts.asOf] - Temporal query timestamp
       * @returns {Promise<{entries: Array, nextCursor: (string|null)}>}
       */
      listPage: ({ limit, cursor, asOf } = {}) =>
        listPage(this, '/api/v1/users', { limit, cursor, query: { 'as-of': asOf } }),
      /**
       * Async-iterate users page by page; yields each page's entries array.
       * @param {object} [opts]
       * @param {number} [opts.pageSize] - Per-request page size
       * @param {string} [opts.asOf] - Temporal query timestamp
       * Cannot be used inside a batch (auto-paginates across requests); throws on first iteration if called while batching — use listPage() for a single page in a batch.
       * @returns {AsyncGenerator<Array>}
       */
      iterPages: ({ pageSize, asOf } = {}) =>
        iterPages(this, '/api/v1/users', { pageSize, query: { 'as-of': asOf } }),
      /**
       * Create a new user
       * @param {string} username - The username
       * @param {string} password - The password
       * @param {boolean} isAdmin - Whether the user is an admin
       */
      create: (username, password, isAdmin) =>
        this._request('POST', '/api/v1/users', {
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
       * Delete a user
       * @param {string} id - The resource ID
       */
      delete: (id) =>
        this._request('DELETE', `/api/v1/users/${id}`),
      /**
       * Modify a user. Admins may change the username, password, and admin
       * status of any user. All other users may only modify their own username
       * or password.
       * @param {string} id - The resource ID
       * @param {string} [password] - New password
       * @param {string} [username] - New username
       * @param {boolean} [isAdmin] - New admin status
       */
      update: (id, password, username, isAdmin) =>
        this._request('PATCH', `/api/v1/users/${id}`, {
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
      create: (userId, name) =>
        this._request('POST', `/api/v1/users/${userId}/tokens`, {
          body: bodyOf({ name }),
        }),
      /**
       * Revoke a named API token (soft-revoke; idempotent).
       * @param {string} userId - The user ID who owns the token
       * @param {string} tokenId - The token ID to revoke
       */
      revoke: (userId, tokenId) =>
        this._request('DELETE', `/api/v1/users/${userId}/tokens/${tokenId}`),
    };

    this.tokenLayers = {
      /**
       * Shift a token layer's display order.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} direction - The direction ("up" or "down")
       */
      shift: (tokenLayerId, direction) =>
        this._request('POST', `/api/v1/token-layers/${tokenLayerId}/shift`, {
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new token layer.
       * @param {string} textLayerId - The text layer ID
       * @param {string} name - The name
       * @param {string} [overlapMode] - Per-layer, immutable token invariant: "any" (default), "non-overlapping", or "partitioning". On partitioning layers, single token create/update/delete are rejected; use bulkCreate plus split/merge/shift.
       * @param {string} [parentTokenLayerId] - Optional immutable parent token layer. Tokens in this layer must nest within a parent-layer token; the parent layer must be in the same text layer and be "non-overlapping" or "partitioning" (an "any" parent is rejected). A nested layer may be "any" or "non-overlapping" but not "partitioning" (partitioning is only for root layers), e.g. words (non-overlapping, parent=sentences) within sentences (partitioning).
       */
      create: (textLayerId, name, overlapMode, parentTokenLayerId) =>
        this._request('POST', '/api/v1/token-layers', {
          body: bodyOf({ 'text-layer-id': textLayerId, name, 'overlap-mode': overlapMode, 'parent-token-layer-id': parentTokenLayerId }),
        }),
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (tokenLayerId, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (tokenLayerId, namespace, configKey) =>
        this._request('DELETE', `/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`, {
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
      delete: (tokenLayerId) =>
        this._request('DELETE', `/api/v1/token-layers/${tokenLayerId}`),
      /**
       * Update a token layer's name.
       * @param {string} tokenLayerId - The token layer ID
       * @param {string} name - The name
       */
      update: (tokenLayerId, name) =>
        this._request('PATCH', `/api/v1/token-layers/${tokenLayerId}`, {
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
      acquireLock: (documentId) =>
        this._request('POST', `/api/v1/documents/${documentId}/lock`),
      /**
       * Release a document lock
       * @param {string} documentId - The document ID
       */
      releaseLock: (documentId) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/lock`),
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
      uploadMedia: (documentId, file) => {
        const fd = new FormData();
        fd.append('file', file);
        return this._request('PUT', `/api/v1/documents/${documentId}/media`, {
          body: fd, formData: true, noBatch: true,
        });
      },
      /**
       * Delete media file for a document
       * @param {string} documentId - The document ID
       */
      deleteMedia: (documentId) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/media`, {
          noBatch: true,
        }),
      /**
       * Replace all metadata for a document.
       * @param {string} documentId - The document ID
       * @param {any} body - The request body
       */
      setMetadata: (documentId, body) =>
        this._request('PUT', `/api/v1/documents/${documentId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a document.
       * @param {string} documentId - The document ID
       */
      deleteMetadata: (documentId) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a document. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} documentId - The document ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (documentId, body) =>
        this._request('PATCH', `/api/v1/documents/${documentId}/metadata`, {
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
      delete: (documentId) =>
        this._request('DELETE', `/api/v1/documents/${documentId}`),
      /**
       * Update a document's name.
       * @param {string} documentId - The document ID
       * @param {string} name - The name
       */
      update: (documentId, name) =>
        this._request('PATCH', `/api/v1/documents/${documentId}`, {
          body: bodyOf({ name }),
        }),
      /**
       * Create a new document in a project.
       * @param {string} projectId - The project ID
       * @param {string} name - The name
       * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
       */
      create: (projectId, name, metadata) =>
        this._request('POST', '/api/v1/documents', {
          body: bodyOf({ 'project-id': projectId, name, metadata }),
        }),
    };

    this.projects = {
      /**
       * Set a user's access level to read and write for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      addWriter: (id, userId) =>
        this._request('POST', `/api/v1/projects/${id}/writers/${userId}`),
      /**
       * Remove a user's writer privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      removeWriter: (id, userId) =>
        this._request('DELETE', `/api/v1/projects/${id}/writers/${userId}`),
      /**
       * Set a user's access level to read-only for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      addReader: (id, userId) =>
        this._request('POST', `/api/v1/projects/${id}/readers/${userId}`),
      /**
       * Remove a user's reader privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      removeReader: (id, userId) =>
        this._request('DELETE', `/api/v1/projects/${id}/readers/${userId}`),
      /**
       * Set a configuration value for a project in an editor namespace.
       * @param {string} id - The resource ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (id, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/projects/${id}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a project.
       * @param {string} id - The resource ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (id, namespace, configKey) =>
        this._request('DELETE', `/api/v1/projects/${id}/config/${namespace}/${configKey}`, {
          skipResponseTransform: true,
        }),
      /**
       * Assign a user as a maintainer for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      addMaintainer: (id, userId) =>
        this._request('POST', `/api/v1/projects/${id}/maintainers/${userId}`),
      /**
       * Remove a user's maintainer privileges for this project.
       * @param {string} id - The resource ID
       * @param {string} userId - The user ID
       */
      removeMaintainer: (id, userId) =>
        this._request('DELETE', `/api/v1/projects/${id}/maintainers/${userId}`),
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
      linkVocab: (id, vocabId) =>
        this._request('POST', `/api/v1/projects/${id}/vocabs/${vocabId}`),
      /**
       * Unlink a vocabulary from a project.
       * @param {string} id - The resource ID
       * @param {string} vocabId - The vocab layer ID
       */
      unlinkVocab: (id, vocabId) =>
        this._request('DELETE', `/api/v1/projects/${id}/vocabs/${vocabId}`),
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
      delete: (id) =>
        this._request('DELETE', `/api/v1/projects/${id}`),
      /**
       * Update a project's name.
       * @param {string} id - The resource ID
       * @param {string} name - The name
       */
      update: (id, name) =>
        this._request('PATCH', `/api/v1/projects/${id}`, {
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
      create: (name) =>
        this._request('POST', '/api/v1/projects', {
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
      setConfig: (textLayerId, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} textLayerId - The text layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (textLayerId, namespace, configKey) =>
        this._request('DELETE', `/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`, {
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
      delete: (textLayerId) =>
        this._request('DELETE', `/api/v1/text-layers/${textLayerId}`),
      /**
       * Update a text layer's name.
       * @param {string} textLayerId - The text layer ID
       * @param {string} name - The name
       */
      update: (textLayerId, name) =>
        this._request('PATCH', `/api/v1/text-layers/${textLayerId}`, {
          body: bodyOf({ name }),
        }),
      /**
       * Shift a text layer's display order within the project.
       * @param {string} textLayerId - The text layer ID
       * @param {string} direction - The direction ("up" or "down")
       */
      shift: (textLayerId, direction) =>
        this._request('POST', `/api/v1/text-layers/${textLayerId}/shift`, {
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new text layer for a project.
       * @param {string} projectId - The project ID
       * @param {string} name - The name
       */
      create: (projectId, name) =>
        this._request('POST', '/api/v1/text-layers', {
          body: bodyOf({ 'project-id': projectId, name }),
        }),
    };

    this.vocabItems = {
      /**
       * Replace all metadata for a vocab item.
       * @param {string} id - The resource ID
       * @param {any} body - The request body
       */
      setMetadata: (id, body) =>
        this._request('PUT', `/api/v1/vocab-items/${id}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a vocab item.
       * @param {string} id - The resource ID
       */
      deleteMetadata: (id) =>
        this._request('DELETE', `/api/v1/vocab-items/${id}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a vocab item. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} id - The resource ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (id, body) =>
        this._request('PATCH', `/api/v1/vocab-items/${id}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Create a new vocab item
       * @param {string} vocabLayerId - The vocab layer ID
       * @param {string} form - The vocab item form
       * @param {any} [metadata] - Metadata map. Omit to leave unset; pass null to send JSON null.
       */
      create: (vocabLayerId, form, metadata) =>
        this._request('POST', '/api/v1/vocab-items', {
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
      delete: (id) =>
        this._request('DELETE', `/api/v1/vocab-items/${id}`),
      /**
       * Update a vocab item's form
       * @param {string} id - The resource ID
       * @param {string} form - The vocab item form
       */
      update: (id, form) =>
        this._request('PATCH', `/api/v1/vocab-items/${id}`, {
          body: bodyOf({ form }),
        }),
    };

    this.relationLayers = {
      /**
       * Shift a relation layer's display order.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} direction - The direction ("up" or "down")
       */
      shift: (relationLayerId, direction) =>
        this._request('POST', `/api/v1/relation-layers/${relationLayerId}/shift`, {
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new relation layer.
       * @param {string} spanLayerId - The span layer ID
       * @param {string} name - The name
       */
      create: (spanLayerId, name) =>
        this._request('POST', '/api/v1/relation-layers', {
          body: bodyOf({ 'span-layer-id': spanLayerId, name }),
        }),
      /**
       * Set a configuration value for a layer in an editor namespace.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (relationLayerId, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} namespace - The config namespace
       * @param {string} configKey - The config key
       */
      deleteConfig: (relationLayerId, namespace, configKey) =>
        this._request('DELETE', `/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`, {
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
      delete: (relationLayerId) =>
        this._request('DELETE', `/api/v1/relation-layers/${relationLayerId}`),
      /**
       * Update a relation layer's name.
       * @param {string} relationLayerId - The relation layer ID
       * @param {string} name - The name
       */
      update: (relationLayerId, name) =>
        this._request('PATCH', `/api/v1/relation-layers/${relationLayerId}`, {
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
      create: (tokenLayerId, text, begin, end, precedence, metadata) =>
        this._request('POST', '/api/v1/tokens', {
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
      delete: (tokenId) =>
        this._request('DELETE', `/api/v1/tokens/${tokenId}`),
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
      update: (tokenId, begin, end, precedence) =>
        this._request('PATCH', `/api/v1/tokens/${tokenId}`, {
          body: bodyOf({ begin, end, precedence }),
        }),
      /**
       * Create multiple tokens in a single operation.
       * @param {Array} body - The request body
       */
      bulkCreate: (body) =>
        this._request('POST', '/api/v1/tokens/bulk', { body }),
      /**
       * Delete multiple tokens in a single operation. Provide an array of IDs.
       * @param {Array} body - The request body
       */
      bulkDelete: (body) =>
        this._request('DELETE', '/api/v1/tokens/bulk', { body }),
      /**
       * Split a token at a Unicode code-point offset. The original token becomes the
       * left half (keeps its ID, spans, vocab-links); the new right token's ID is returned.
       * @param {string} tokenId - The token ID
       * @param {number} position - Code-point offset to split at (strictly between begin and end)
       */
      split: (tokenId, position) =>
        this._request('POST', `/api/v1/tokens/${tokenId}/split`, {
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
      merge: (tokenId, otherTokenId) =>
        this._request('POST', `/api/v1/tokens/${tokenId}/merge`, {
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
      shift: (tokenId, begin, end) =>
        this._request('POST', `/api/v1/tokens/${tokenId}/shift`, {
          body: bodyOf({ begin, end }),
        }),
      /**
       * Replace all metadata for a token.
       * @param {string} tokenId - The token ID
       * @param {any} body - The request body
       */
      setMetadata: (tokenId, body) =>
        this._request('PUT', `/api/v1/tokens/${tokenId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a token.
       * @param {string} tokenId - The token ID
       */
      deleteMetadata: (tokenId) =>
        this._request('DELETE', `/api/v1/tokens/${tokenId}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Patch (shallow-merge) metadata for a token. Keys present in the body are set or overwritten; keys not present are left untouched; a key whose value is null is deleted. Merging is top-level only (nested objects are replaced wholesale, not deep-merged), so a literal null cannot be stored as a value. An empty body changes no metadata.
       * @param {string} tokenId - The token ID
       * @param {any} body - The metadata patch
       */
      patchMetadata: (tokenId, body) =>
        this._request('PATCH', `/api/v1/tokens/${tokenId}/metadata`, {
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
      sendMessage: (projectId, data) =>
        this._request('POST', `/api/v1/projects/${projectId}/message`, {
          body: { body: data },
        }),

      /**
       * Discover the services currently connected to a project (synchronous GET).
       * @param {string} projectId - The UUID of the project to query
       * @param {number} [timeout] - Ignored; kept for back-compat
       * @returns {Promise<Array>} Array of discovered service information
       */
      discoverServices: (projectId, timeout) =>
        discoverServices(this, projectId, timeout),

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
     *       ['span', '?s1', { layer: 'pos', value: 'NOUN' }],
     *       ['span', '?s2', { layer: 'pos', value: 'VERB' }],
     *       ['covers', '?s1', '?t1'], ['covers', '?s2', '?t2'],
     *       ['precedes', '?t1', '?t2'],
     *     ],
     *     return: 'entities',   // 'ids' (default) | 'entities' | 'count'
     *     limit: 100,
     *   });
     *
     * Optional keys: `scope` (restrict to named projects/ids), `orderBy`
     * (sort rows), `strictLayers` (require layer ids, not names), and `bindings`
     * (substitute `?name` placeholders with literals). `return` may also be an
     * aggregate spec `{group, aggregates}`. See the query language reference.
     *
     * @param {Object} body - The query AST ({find, where, scope?, limit?, orderBy?,
     *   return?, strictLayers?, bindings?}).
     * @returns {Promise<Object>} For 'ids'/'entities': {columns, results, count, truncated}.
     *   For 'count': {return: 'count', count}. Entity cells are full entity objects
     *   (same shape as the GET endpoints).
     */
    this.query = (body) =>
      this._request('POST', '/api/v1/query', { body });
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

  /** Begin a batch of operations. Subsequent API calls will be queued. */
  beginBatch() {
    this.isBatching = true;
    this.batchOperations = [];
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
