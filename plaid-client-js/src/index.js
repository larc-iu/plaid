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

// Helper: normalize a document-read `layers` filter to the wire's
// comma-separated form. Accepts an array of layer ids or a ready-made string;
// anything empty becomes undefined so no `?layers=` is sent at all.
function layersParam(layers) {
  if (layers === undefined || layers === null) return undefined;
  const joined = Array.isArray(layers) ? layers.join(',') : String(layers);
  return joined.length > 0 ? joined : undefined;
}

// Helper: normalize an audit `opTypes` filter to the wire's comma-separated
// form. Accepts an array of op types or a ready-made string; anything empty
// becomes undefined so no `?op-types=` is sent at all.
function opTypesParam(opTypes) {
  if (opTypes === undefined || opTypes === null) return undefined;
  const joined = Array.isArray(opTypes) ? opTypes.join(',') : String(opTypes);
  return joined.length > 0 ? joined : undefined;
}

// Helper: build body object, filtering out undefined values
function bodyOf(obj) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

// POST to an endpoint that takes no Authorization header (login, invite lookup
// and redemption). Deliberately does not go through PlaidClient._request: these
// are called before any client exists, which is the whole point.
async function anonymousPost(baseUrl, path, body, options = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const url = `${base}${path}`;
  try {
    const fetchOptions = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    const signal = timeoutSignal(options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS);
    if (signal) fetchOptions.signal = signal;

    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      throw makeHttpError(response, await parseErrorBody(response), url, 'POST');
    }
    return transformResponse(await response.json());
  } catch (error) {
    if (error.status) throw error;
    throw makeNetworkError(error, url, 'POST');
  }
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
    // The open logical operation (audit-log group), or null. While set, every
    // write is stamped with `?group-id=` (+ `group-message`) so the audit log
    // folds them into ONE expandable entry. See beginOperation / withOperation.
    // Shape: { id, message, depth, written, refined }.
    this.operationGroup = null;
    // Optional callback fired once (per client) when any request returns HTTP
    // 401 — i.e. the token is missing/expired/invalid. Apps use it to discard
    // the stored token and route back to login. See makeRequest in http.js.
    this.onAuthError = options.onAuthError || null;
    this._authErrorFired = false;

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
       * Create multiple vocab links in a single operation. Entries may
       * reference different vocab items, but all tokens across the call must
       * belong to one document.
       * @param {Array<{vocabItem: string, tokens: string[], metadata?: any}>} body - The vocab links to create
       * @returns {Promise<{ids: string[]}>} The created entity IDs, in input order. (bulkDelete resolves to no value.)
       */
      bulkCreate: (body, auditMessage) =>
        this._request('POST', '/api/v1/vocab-links/bulk', { auditMessage, body }),
      /**
       * Delete multiple vocab links in a single operation. Provide an array of IDs.
       * @param {string[]} body - The vocab link IDs to delete
       */
      bulkDelete: (body, auditMessage) =>
        this._request('DELETE', '/api/v1/vocab-links/bulk', { auditMessage, body }),
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
       * @returns {Promise<{ids: string[]}>} The created entity IDs, in input order. (bulkDelete resolves to no value.)
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
       * @returns {Promise<{ids: string[]}>} The created entity IDs, in input order. (bulkDelete resolves to no value.)
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
       * @param {string[]|string} [opTypes] - Only return operations of these
       *   types, spelled as in an entry's `op/type` (e.g.
       *   `['span-layer/create', 'span-layer/delete']`). An entry appears when
       *   one of its operations matches, carrying only the ones that did.
       */
      audit: (userId, startTime, endTime, asOf, opTypes) =>
        listAll(this, `/api/v1/users/${userId}/audit`, {
          query: {
            'start-time': startTime,
            'end-time': endTime,
            'as-of': asOf,
            'op-types': opTypesParam(opTypes),
          },
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
      /**
       * Build a URL for a user's profile picture, suitable for use directly as
       * an `<img>` src. An image element cannot send an Authorization header,
       * so the session token rides in the query string, the same way document
       * media does.
       *
       * Pass the user record's `avatarHash` as the second argument whenever you
       * have it: the URL then addresses that exact picture, so the browser can
       * cache it indefinitely and still pick up a replacement the moment the
       * user changes it. Returns null when the user has no picture, so callers
       * can fall back to initials without a wasted request.
       * @param {string} id - The user ID
       * @param {string} [avatarHash] - The user record's `avatarHash`
       * @returns {string|null}
       */
      avatarUrl: (id, avatarHash) => {
        if (avatarHash === null) return null;
        const params = new URLSearchParams({ token: this.token });
        if (avatarHash) params.set('v', avatarHash);
        return `${this.baseUrl}/api/v1/users/${id}/avatar?${params}`;
      },
      /**
       * Fetch a user's profile picture as raw bytes. Most callers want
       * avatarUrl() instead. This one is for non-browser consumers.
       * @param {string} id - The user ID
       */
      getAvatar: (id) =>
        this._request('GET', `/api/v1/users/${id}/avatar`, {
          noBatch: true,
          binaryResponse: true,
        }),
      /**
       * Upload a profile picture. Your own, or anyone's if you are an admin.
       * The server center-crops to a square, scales to the configured edge
       * length, and re-encodes, so no client-side resizing is needed. Accepts
       * PNG, JPEG, WebP, and GIF. Resolves to the updated user record.
       * @param {string} id - The user ID
       * @param {File} file - The image to upload
       */
      setAvatar: (id, file, auditMessage) => {
        const fd = new FormData();
        fd.append('file', file);
        return this._request('PUT', `/api/v1/users/${id}/avatar`, { auditMessage,
          body: fd, formData: true, noBatch: true,
        });
      },
      /**
       * Remove a profile picture. Your own, or anyone's if you are an admin.
       * @param {string} id - The user ID
       */
      deleteAvatar: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/users/${id}/avatar`, { auditMessage,
          noBatch: true,
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

    this.invites = {
      /**
       * List invites you minted, oldest first. With `projectId`, lists that
       * project's invites instead (including co-maintainers'), which requires
       * maintainer or admin on it. Never includes invite codes — the code is
       * returned once, by create(), and is not recoverable afterward.
       * Transparently follows pagination cursors and returns the full flat array.
       * Cannot be used inside a batch (auto-paginates across requests); throws if called while batching — use listPage() for a single page in a batch.
       * @param {object} [opts]
       * @param {string} [opts.projectId] - List this project's invites instead of your own
       */
      list: ({ projectId } = {}) =>
        listAll(this, '/api/v1/invites', { query: { 'project-id': projectId } }),
      /**
       * Fetch a single page of invites.
       * @param {object} [opts]
       * @param {string} [opts.projectId] - List this project's invites instead of your own
       * @param {number} [opts.limit] - Page size (1..1000; server default 100)
       * @param {string} [opts.cursor] - Opaque cursor from a previous page
       * @returns {Promise<{entries: Array, nextCursor: (string|null)}>}
       */
      listPage: ({ projectId, limit, cursor } = {}) =>
        listPage(this, '/api/v1/invites', { limit, cursor, query: { 'project-id': projectId } }),
      /**
       * Async-iterate invites page by page; yields each page's entries array.
       * @param {object} [opts]
       * @param {string} [opts.projectId] - List this project's invites instead of your own
       * @param {number} [opts.pageSize] - Per-request page size
       * Cannot be used inside a batch (auto-paginates across requests); throws on first iteration if called while batching — use listPage() for a single page in a batch.
       * @returns {AsyncGenerator<Array>}
       */
      iterPages: ({ projectId, pageSize } = {}) =>
        iterPages(this, '/api/v1/invites', { pageSize, query: { 'project-id': projectId } }),
      /**
       * Mint an invite. The returned `code` is shown ONLY here — it is never
       * stored and cannot be recovered, so build and hand off the link now.
       * Use PlaidClient.inviteUrl() to turn it into one.
       *
       * Admins may mint anything. A project maintainer may mint role grants on
       * projects they maintain, and nothing else: no admin grant, no grantless
       * invite, no password resets.
       * @param {object} opts
       * @param {string} [opts.projectId] - Project the redeemer joins (with projectRole)
       * @param {string} [opts.projectRole] - "reader" | "writer" | "maintainer"
       * @param {boolean} [opts.grantAdmin] - Make the new account a global admin (admin only)
       * @param {string} [opts.targetUserId] - Make this a password reset for that user (admin only)
       * @param {number} [opts.maxUses] - How many accounts this link may create (default 1)
       * @param {number} [opts.ttlDays] - Days until it expires (default 14, max 365)
       * @param {string} [opts.note] - Human label shown in your invite list
       * @returns {Promise<{id: string, code: string, kind: string, status: string}>}
       */
      create: ({ projectId, projectRole, grantAdmin, targetUserId, maxUses, ttlDays, note } = {}, auditMessage) =>
        this._request('POST', '/api/v1/invites', { auditMessage,
          body: bodyOf({
            'project-id': projectId, 'project-role': projectRole,
            'grant-admin': grantAdmin, 'target-user-id': targetUserId,
            'max-uses': maxUses, 'ttl-days': ttlDays, note,
          }),
        }),
      /**
       * Revoke an invite, killing the link immediately. Idempotent. Allowed for
       * the creator, an admin, or a maintainer of the invite's project.
       * @param {string} id - The invite ID
       */
      revoke: (id, auditMessage) =>
        this._request('DELETE', `/api/v1/invites/${id}`, { auditMessage }),
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
       * @param {string[]|string} [opTypes] - Only return operations of these
       *   types, spelled as in an entry's `op/type` (e.g.
       *   `['span-layer/create', 'span-layer/delete']`). An entry appears when
       *   one of its operations matches, carrying only the ones that did.
       */
      audit: (documentId, startTime, endTime, asOf, opTypes) =>
        listAll(this, `/api/v1/documents/${documentId}/audit`, {
          query: {
            'start-time': startTime,
            'end-time': endTime,
            'as-of': asOf,
            'op-types': opTypesParam(opTypes),
          },
        }),
      /**
       * Get a document. Set `includeBody` to true to include all data.
       *
       * `layers` narrows a body read to the layers you name (ids of any kind:
       * text, token, span, or relation). A layer comes back when it is named
       * or is an ancestor of a named layer, and carries its own
       * texts/tokens/spans/relations/vocabs only when it is itself named — so
       * name the text layer too if you also want the text body. An id that is
       * not a layer of this document's project is an error, not a quietly
       * smaller response. Requires `includeBody`.
       * @param {string} documentId - The document ID
       * @param {boolean} [includeBody] - Include document body data
       * @param {string} [asOf] - Temporal query timestamp
       * @param {string[]|string} [layers] - Layer ids to restrict a body read to
       */
      get: (documentId, includeBody, asOf, layers) =>
        this._request('GET', `/api/v1/documents/${documentId}`, {
          queryParams: {
            'include-body': includeBody,
            'as-of': asOf,
            layers: layersParam(layers),
          },
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
       * @param {string[]|string} [opTypes] - Only return operations of these
       *   types, spelled as in an entry's `op/type` (e.g.
       *   `['span-layer/create', 'span-layer/delete']`). An entry appears when
       *   one of its operations matches, carrying only the ones that did.
       */
      audit: (projectId, startTime, endTime, asOf, opTypes) =>
        listAll(this, `/api/v1/projects/${projectId}/audit`, {
          query: {
            'start-time': startTime,
            'end-time': endTime,
            'as-of': asOf,
            'op-types': opTypesParam(opTypes),
          },
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
       * Delete a project and everything in it. This is irrecoverable.
       *
       * For a large project this can take a long time, so the client's
       * per-request timeout is DISABLED by default. Pass `{ timeout }` to
       * impose a finite bound.
       * @param {string} id - The resource ID
       * @param {string} [auditMessage] - Custom audit-log message
       * @param {object} [options]
       * @param {number} [options.timeout=0] - Per-request timeout in ms (0/null disables)
       */
      delete: (id, auditMessage, { timeout = 0 } = {}) =>
        this._request('DELETE', `/api/v1/projects/${id}`, { auditMessage, timeout }),
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
       * Create multiple vocab items in a single operation. Entries may target
       * different vocab layers; the user must have write access to each.
       * @param {Array<{vocabLayerId: string, form: string, metadata?: any}>} body - The vocab items to create
       */
      bulkCreate: (body, auditMessage) =>
        this._request('POST', '/api/v1/vocab-items/bulk', { auditMessage, body }),
      /**
       * Delete multiple vocab items in a single operation. Each item's
       * descendant vocab links are deleted too. Provide an array of IDs.
       * @param {string[]} body - The vocab item IDs to delete
       */
      bulkDelete: (body, auditMessage) =>
        this._request('DELETE', '/api/v1/vocab-items/bulk', { auditMessage, body }),
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
       * @returns {Promise<{ids: string[]}>} The created entity IDs, in input order. (bulkDelete resolves to no value.)
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
       * Send a message to project listeners.
       *
       * `data` may be any JSON value and is sent VERBATIM (`rawBody`): a
       * message payload is opaque application data, like `metadata` and
       * `config`, so its keys must not be re-cased on the way out. Without
       * this a key such as `case-marker` would reach listeners as
       * `caseMarker` in JS and `case_marker` in Python. `listen` restores it
       * verbatim on the way in.
       * @param {string} projectId - The UUID of the project to send to
       * @param {any} data - The message data to send
       * @returns {Promise<any>} Response from the send operation
       */
      sendMessage: (projectId, data, auditMessage) =>
        this._request('POST', `/api/v1/projects/${projectId}/message`, { auditMessage,
          rawBody: { body: data },
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

    // Logical-operation groups (audit-log grouping). There is no create: a
    // group row is made lazily by the first write carrying `?group-id=`
    // (see beginOperation). Not an audited write, so no auditMessage arg.
    this.operationGroups = {
      /**
       * Get a logical-operation group (its label + creator).
       * @param {string} id - The group id
       */
      get: (id) =>
        this._request('GET', `/api/v1/operation-groups/${id}`),
      /**
       * Relabel a logical-operation group after the fact. Owner or admin only.
       * @param {string} id - The group id
       * @param {string|null} message - The new label
       */
      update: (id, message) =>
        this._request('PATCH', `/api/v1/operation-groups/${id}`, { body: { message } }),
    };
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
   * @param {string} message - Human label for the operation.
   * @param {object} [opts] - Optional `{ id }`: adopt an existing group id instead of minting one (a service joining the requester's operation; `requestService` propagates an open operation to the service automatically).
   * @returns {string} The operation's group id.
   */
  beginOperation(message, { id } = {}) {
    if (this.operationGroup) {
      this.operationGroup.depth += 1;
      return this.operationGroup.id;
    }
    this.operationGroup = {
      id: id || crypto.randomUUID(),
      message: message == null ? null : String(message),
      depth: 1,
      written: false,
      refined: undefined,
    };
    return this.operationGroup.id;
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
    const group = this.operationGroup;
    if (!group) return;
    if (group.depth > 1) {
      group.depth -= 1;
      return;
    }
    this.operationGroup = null;
    const refined = message !== undefined ? message : group.refined;
    if (refined !== undefined && group.written) {
      try {
        await this.operationGroups.update(group.id, refined);
      } catch (e) {
        // 404: the group never materialized server-side (every tagged write
        // failed or a batch was aborted). Nothing to relabel — not an error.
        if (e.status !== 404) throw e;
      }
    }
  }

  /**
   * Run `fn` as one logical operation (see beginOperation), ending it when
   * `fn` settles — including on throw. `fn` receives a `setMessage(msg)`
   * callback to refine the label once the outcome is known.
   *
   *   await client.withOperation('Merge morphemes', async (setMessage) => {
   *     await client.batched(() => { ... });
   *     setMessage(`Merged ${n} morphemes`);
   *   });
   *
   * @param {string} message - Human label for the operation.
   * @param {function} fn - The work to run; receives `setMessage(msg)` to refine the label once the outcome is known.
   * @returns {Promise<any>} Whatever `fn` resolves to.
   */
  async withOperation(message, fn) {
    this.beginOperation(message);
    const group = this.operationGroup;
    const setMessage = (msg) => { if (group.depth === 1) group.refined = msg; };
    try {
      return await fn(setMessage);
    } finally {
      await this.endOperation();
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
   * Run `fn` with a batch open, then submit all queued ops as ONE atomic
   * request — or abort the batch if `fn` throws, so a half-open batch can never
   * silently swallow later non-batch calls. `fn` makes the (queued) client
   * calls; it must NOT call submitBatch itself. Resolves to the batch results
   * array (`[]` if `fn` queued nothing).
   *
   *   const [sentRes, wordRes] = await client.batched(async () => {
   *     client.tokens.bulkCreate(sentenceOps);
   *     client.tokens.bulkCreate(wordOps);
   *   });
   *
   * Server-side a batch runs sequentially in one transaction (a child op sees
   * parents created earlier in the same `fn`; any op's failure rolls the whole
   * batch back). Not nestable. Named `batched()` because `client.batch` is the
   * low-level batch resource.
   * @param {() => (void | Promise<void>)} fn
   * @returns {Promise<Array>}
   */
  async batched(fn) {
    this.beginBatch();
    try {
      await fn();
    } catch (e) {
      // fn failed: drop the queued ops so the client leaves batch mode and
      // later plain calls don't queue into a never-submitted batch.
      if (this.isBatchMode()) this.abortBatch();
      throw e;
    }
    return this.submitBatch();
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
    return `${appUrl.replace(/#.*$/, '').replace(/\/$/, '')}/#/invite/${encodeURIComponent(code)}`;
  }

  /**
   * Describe an invite code, with NO authentication — this is what a signup
   * page calls before the redeemer has an account. Returns the kind of link
   * ("signup" or "password-reset"), its status ("active", "used", "expired",
   * "revoked"), and the project it grants access to, if any.
   *
   * Throws a 404-shaped error if the code is unknown. A known-but-dead code
   * resolves normally with a non-"active" status, so the page can say why.
   * @param {string} baseUrl - The API base URL
   * @param {string} code - The invite code
   * @param {object} [options]
   * @returns {Promise<{kind: string, status: string, expiresAt: string, projectName?: string, projectRole?: string, username?: string, grantAdmin: boolean}>}
   */
  static async lookupInvite(baseUrl, code, options = {}) {
    return anonymousPost(baseUrl, '/api/v1/invite-codes/lookup', { code }, options);
  }

  /**
   * Redeem an invite code, with NO authentication.
   *
   * For a signup invite, pass `username` and `password` to create the account;
   * the invite's grants are applied in the same transaction. For a password
   * reset link, pass `password` only. Resolves to a logged-in client, exactly
   * like login() — the redeemer just chose these credentials, so there is no
   * reason to send them to a login form to retype them.
   * @param {string} baseUrl - The API base URL
   * @param {string} code - The invite code
   * @param {object} credentials
   * @param {string} [credentials.username] - Desired username (signup only)
   * @param {string} credentials.password - Desired password (min 8 characters)
   * @param {object} [options]
   * @returns {Promise<{client: PlaidClient, userId: string, kind: string}>}
   */
  static async redeemInvite(baseUrl, code, { username, password } = {}, options = {}) {
    const data = await anonymousPost(
      baseUrl, '/api/v1/invite-codes/redeem',
      bodyOf({ code, username, password }), options,
    );
    return {
      client: new PlaidClient(baseUrl.replace(/\/$/, ''), data.token || '', options),
      userId: data.userId,
      kind: data.kind,
    };
  }

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
  PROV_CONFIRMED,
  stampInferred,
  confirmedInferred,
  provState,
  isMachine,
  isProtected,
  verifyOnEdit,
  serviceSource,
} from './provenance.js';
