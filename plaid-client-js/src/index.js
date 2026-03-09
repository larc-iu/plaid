/**
 * plaid-client - JavaScript client for the Plaid annotation API
 */

import { transformRequest, transformResponse } from './transforms.js';
import { makeRequest, extractDocumentVersions } from './http.js';
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
   */
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.agentName = null;
    this.isBatching = false;
    this.batchOperations = [];
    this.documentVersions = {};
    this.strictModeDocumentId = null;

    // --- API Bundles ---

    this.vocabLinks = {
      /**
       * Create a new vocab link (link between tokens and vocab item).
       * @param {string} vocabItem - Required. Vocabitem
       * @param {Array} tokens - Required. Tokens
       * @param {any} [metadata] - Optional. Metadata
       */
      create: (vocabItem, tokens, metadata) =>
        this._request('POST', '/api/v1/vocab-links', {
          body: bodyOf({ 'vocab-item': vocabItem, tokens, metadata }),
        }),
      /**
       * Replace all metadata for a vocab link. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
       * @param {string} id - Id identifier
       * @param {any} body - Required. Body
       */
      setMetadata: (id, body) =>
        this._request('PUT', `/api/v1/vocab-links/${id}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a vocab link.
       * @param {string} id - Id identifier
       */
      deleteMetadata: (id) =>
        this._request('DELETE', `/api/v1/vocab-links/${id}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Get a vocab link by ID
       * @param {string} id - Id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (id, asOf) =>
        this._request('GET', `/api/v1/vocab-links/${id}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a vocab link
       * @param {string} id - Id identifier
       */
      delete: (id) =>
        this._request('DELETE', `/api/v1/vocab-links/${id}`),
    };

    this.vocabLayers = {
      /**
       * Get a vocab layer by ID
       * @param {string} id - Id identifier
       * @param {boolean} [includeItems] - Optional includeItems
       * @param {string} [asOf] - Optional asOf
       */
      get: (id, includeItems, asOf) =>
        this._request('GET', `/api/v1/vocab-layers/${id}`, {
          queryParams: { 'include-items': includeItems, 'as-of': asOf },
        }),
      /**
       * Delete a vocab layer.
       * @param {string} id - Id identifier
       */
      delete: (id) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}`),
      /**
       * Update a vocab layer's name.
       * @param {string} id - Id identifier
       * @param {string} name - Required. Name
       */
      update: (id, name) =>
        this._request('PATCH', `/api/v1/vocab-layers/${id}`, {
          body: bodyOf({ name }),
        }),
      /**
       * Set a configuration value for a layer in a editor namespace.
       * @param {string} id - Id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (id, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/vocab-layers/${id}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} id - Id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       */
      deleteConfig: (id, namespace, configKey) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}/config/${namespace}/${configKey}`, {
          skipResponseTransform: true,
        }),
      /**
       * List all vocab layers accessible to user
       * @param {string} [asOf] - Optional asOf
       */
      list: (asOf) =>
        this._request('GET', '/api/v1/vocab-layers', {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Create a new vocab layer. Note: this also registers the user as a maintainer.
       * @param {string} name - Required. Name
       */
      create: (name) =>
        this._request('POST', '/api/v1/vocab-layers', {
          body: bodyOf({ name }),
        }),
      /**
       * Assign a user as a maintainer for this vocab layer.
       * @param {string} id - Id identifier
       * @param {string} userId - User-id identifier
       */
      addMaintainer: (id, userId) =>
        this._request('POST', `/api/v1/vocab-layers/${id}/maintainers/${userId}`),
      /**
       * Remove a user's maintainer privileges for this vocab layer.
       * @param {string} id - Id identifier
       * @param {string} userId - User-id identifier
       */
      removeMaintainer: (id, userId) =>
        this._request('DELETE', `/api/v1/vocab-layers/${id}/maintainers/${userId}`),
    };

    this.relations = {
      /**
       * Replace all metadata for a relation.
       * @param {string} relationId - Relation-id identifier
       * @param {any} body - Required. Body
       */
      setMetadata: (relationId, body) =>
        this._request('PUT', `/api/v1/relations/${relationId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a relation.
       * @param {string} relationId - Relation-id identifier
       */
      deleteMetadata: (relationId) =>
        this._request('DELETE', `/api/v1/relations/${relationId}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Update the target span of a relation.
       * @param {string} relationId - Relation-id identifier
       * @param {string} spanId - Required. Spanid
       */
      setTarget: (relationId, spanId) =>
        this._request('PUT', `/api/v1/relations/${relationId}/target`, {
          body: bodyOf({ 'span-id': spanId }),
        }),
      /**
       * Get a relation by ID.
       * @param {string} relationId - Relation-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (relationId, asOf) =>
        this._request('GET', `/api/v1/relations/${relationId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a relation.
       * @param {string} relationId - Relation-id identifier
       */
      delete: (relationId) =>
        this._request('DELETE', `/api/v1/relations/${relationId}`),
      /**
       * Update a relation's value.
       * @param {string} relationId - Relation-id identifier
       * @param {any} value - Required. Value
       */
      update: (relationId, value) =>
        this._request('PATCH', `/api/v1/relations/${relationId}`, {
          body: bodyOf({ value }),
        }),
      /**
       * Update the source span of a relation.
       * @param {string} relationId - Relation-id identifier
       * @param {string} spanId - Required. Spanid
       */
      setSource: (relationId, spanId) =>
        this._request('PUT', `/api/v1/relations/${relationId}/source`, {
          body: bodyOf({ 'span-id': spanId }),
        }),
      /**
       * Create a new relation.
       * @param {string} layerId - Required. Layerid
       * @param {string} sourceId - Required. Sourceid
       * @param {string} targetId - Required. Targetid
       * @param {any} value - Required. Value
       * @param {any} [metadata] - Optional. Metadata
       */
      create: (layerId, sourceId, targetId, value, metadata) =>
        this._request('POST', '/api/v1/relations', {
          body: bodyOf({ 'layer-id': layerId, 'source-id': sourceId, 'target-id': targetId, value, metadata }),
        }),
      /**
       * Create multiple relations in a single operation.
       * @param {Array} body - Required. Body
       */
      bulkCreate: (body) =>
        this._request('POST', '/api/v1/relations/bulk', { body }),
      /**
       * Delete multiple relations in a single operation. Provide an array of IDs.
       * @param {Array} body - Required. Body
       */
      bulkDelete: (body) =>
        this._request('DELETE', '/api/v1/relations/bulk', { body }),
    };

    this.spanLayers = {
      /**
       * Set a configuration value for a layer in a editor namespace.
       * @param {string} spanLayerId - Span-layer-id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (spanLayerId, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} spanLayerId - Span-layer-id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       */
      deleteConfig: (spanLayerId, namespace, configKey) =>
        this._request('DELETE', `/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`, {
          skipResponseTransform: true,
        }),
      /**
       * Get a span layer by ID.
       * @param {string} spanLayerId - Span-layer-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (spanLayerId, asOf) =>
        this._request('GET', `/api/v1/span-layers/${spanLayerId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a span layer.
       * @param {string} spanLayerId - Span-layer-id identifier
       */
      delete: (spanLayerId) =>
        this._request('DELETE', `/api/v1/span-layers/${spanLayerId}`),
      /**
       * Update a span layer's name.
       * @param {string} spanLayerId - Span-layer-id identifier
       * @param {string} name - Required. Name
       */
      update: (spanLayerId, name) =>
        this._request('PATCH', `/api/v1/span-layers/${spanLayerId}`, {
          body: bodyOf({ name }),
        }),
      /**
       * Create a new span layer.
       * @param {string} tokenLayerId - Required. Tokenlayerid
       * @param {string} name - Required. Name
       */
      create: (tokenLayerId, name) =>
        this._request('POST', '/api/v1/span-layers', {
          body: bodyOf({ 'token-layer-id': tokenLayerId, name }),
        }),
      /**
       * Shift a span layer's order.
       * @param {string} spanLayerId - Span-layer-id identifier
       * @param {string} direction - Required. Direction
       */
      shift: (spanLayerId, direction) =>
        this._request('POST', `/api/v1/span-layers/${spanLayerId}/shift`, {
          body: bodyOf({ direction }),
        }),
    };

    this.spans = {
      /**
       * Replace tokens for a span.
       * @param {string} spanId - Span-id identifier
       * @param {Array} tokens - Required. Tokens
       */
      setTokens: (spanId, tokens) =>
        this._request('PUT', `/api/v1/spans/${spanId}/tokens`, {
          body: bodyOf({ tokens }),
        }),
      /**
       * Create a new span.
       * @param {string} spanLayerId - Required. Spanlayerid
       * @param {Array} tokens - Required. Tokens
       * @param {any} value - Required. Value
       * @param {any} [metadata] - Optional. Metadata
       */
      create: (spanLayerId, tokens, value, metadata) =>
        this._request('POST', '/api/v1/spans', {
          body: bodyOf({ 'span-layer-id': spanLayerId, tokens, value, metadata }),
        }),
      /**
       * Get a span by ID.
       * @param {string} spanId - Span-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (spanId, asOf) =>
        this._request('GET', `/api/v1/spans/${spanId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a span.
       * @param {string} spanId - Span-id identifier
       */
      delete: (spanId) =>
        this._request('DELETE', `/api/v1/spans/${spanId}`),
      /**
       * Update a span's value.
       * @param {string} spanId - Span-id identifier
       * @param {any} value - Required. Value
       */
      update: (spanId, value) =>
        this._request('PATCH', `/api/v1/spans/${spanId}`, {
          body: bodyOf({ value }),
        }),
      /**
       * Create multiple spans in a single operation.
       * @param {Array} body - Required. Body
       */
      bulkCreate: (body) =>
        this._request('POST', '/api/v1/spans/bulk', { body }),
      /**
       * Delete multiple spans in a single operation. Provide an array of IDs.
       * @param {Array} body - Required. Body
       */
      bulkDelete: (body) =>
        this._request('DELETE', '/api/v1/spans/bulk', { body }),
      /**
       * Replace all metadata for a span.
       * @param {string} spanId - Span-id identifier
       * @param {any} body - Required. Body
       */
      setMetadata: (spanId, body) =>
        this._request('PUT', `/api/v1/spans/${spanId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a span.
       * @param {string} spanId - Span-id identifier
       */
      deleteMetadata: (spanId) =>
        this._request('DELETE', `/api/v1/spans/${spanId}/metadata`, {
          skipResponseTransform: true,
        }),
    };

    this.batch = {
      /**
       * Execute multiple API operations atomically.
       * @param {Array} body - Required. Body
       */
      submit: (body) =>
        this._request('POST', '/api/v1/batch', {
          body, noBatch: true,
        }),
    };

    this.texts = {
      /**
       * Replace all metadata for a text.
       * @param {string} textId - Text-id identifier
       * @param {any} body - Required. Body
       */
      setMetadata: (textId, body) =>
        this._request('PUT', `/api/v1/texts/${textId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a text.
       * @param {string} textId - Text-id identifier
       */
      deleteMetadata: (textId) =>
        this._request('DELETE', `/api/v1/texts/${textId}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Create a new text in a document's text layer.
       * @param {string} textLayerId - Required. Textlayerid
       * @param {string} documentId - Required. Documentid
       * @param {string} body - Required. Body
       * @param {any} [metadata] - Optional. Metadata
       */
      create: (textLayerId, documentId, body, metadata) =>
        this._request('POST', '/api/v1/texts', {
          body: bodyOf({ 'text-layer-id': textLayerId, 'document-id': documentId, body, metadata }),
        }),
      /**
       * Get a text.
       * @param {string} textId - Text-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (textId, asOf) =>
        this._request('GET', `/api/v1/texts/${textId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a text and all dependent data.
       * @param {string} textId - Text-id identifier
       */
      delete: (textId) =>
        this._request('DELETE', `/api/v1/texts/${textId}`),
      /**
       * Update a text's body.
       * @param {string} textId - Text-id identifier
       * @param {any} body - Required. Body
       */
      update: (textId, body) =>
        this._request('PATCH', `/api/v1/texts/${textId}`, {
          body: bodyOf({ body }),
        }),
    };

    this.users = {
      /**
       * List all users
       * @param {string} [asOf] - Optional asOf
       */
      list: (asOf) =>
        this._request('GET', '/api/v1/users', {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Create a new user
       * @param {string} username - Required. Username
       * @param {string} password - Required. Password
       * @param {boolean} isAdmin - Required. Isadmin
       */
      create: (username, password, isAdmin) =>
        this._request('POST', '/api/v1/users', {
          body: bodyOf({ username, password, 'is-admin': isAdmin }),
        }),
      /**
       * Get audit log for a user's actions
       * @param {string} userId - User-id identifier
       * @param {string} [startTime] - Optional startTime
       * @param {string} [endTime] - Optional endTime
       * @param {string} [asOf] - Optional asOf
       */
      audit: (userId, startTime, endTime, asOf) =>
        this._request('GET', `/api/v1/users/${userId}/audit`, {
          queryParams: { 'start-time': startTime, 'end-time': endTime, 'as-of': asOf },
        }),
      /**
       * Get a user by ID
       * @param {string} id - Id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (id, asOf) =>
        this._request('GET', `/api/v1/users/${id}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a user
       * @param {string} id - Id identifier
       */
      delete: (id) =>
        this._request('DELETE', `/api/v1/users/${id}`),
      /**
       * Modify a user.
       * @param {string} id - Id identifier
       * @param {string} [password] - Optional. Password
       * @param {string} [username] - Optional. Username
       * @param {boolean} [isAdmin] - Optional. Isadmin
       */
      update: (id, password, username, isAdmin) =>
        this._request('PATCH', `/api/v1/users/${id}`, {
          body: bodyOf({ password, username, 'is-admin': isAdmin }),
        }),
    };

    this.tokenLayers = {
      /**
       * Shift a token layer's order.
       * @param {string} tokenLayerId - Token-layer-id identifier
       * @param {string} direction - Required. Direction
       */
      shift: (tokenLayerId, direction) =>
        this._request('POST', `/api/v1/token-layers/${tokenLayerId}/shift`, {
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new token layer.
       * @param {string} textLayerId - Required. Textlayerid
       * @param {string} name - Required. Name
       */
      create: (textLayerId, name) =>
        this._request('POST', '/api/v1/token-layers', {
          body: bodyOf({ 'text-layer-id': textLayerId, name }),
        }),
      /**
       * Set a configuration value for a layer in a editor namespace.
       * @param {string} tokenLayerId - Token-layer-id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (tokenLayerId, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} tokenLayerId - Token-layer-id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       */
      deleteConfig: (tokenLayerId, namespace, configKey) =>
        this._request('DELETE', `/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`, {
          skipResponseTransform: true,
        }),
      /**
       * Get a token layer by ID.
       * @param {string} tokenLayerId - Token-layer-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (tokenLayerId, asOf) =>
        this._request('GET', `/api/v1/token-layers/${tokenLayerId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a token layer.
       * @param {string} tokenLayerId - Token-layer-id identifier
       */
      delete: (tokenLayerId) =>
        this._request('DELETE', `/api/v1/token-layers/${tokenLayerId}`),
      /**
       * Update a token layer's name.
       * @param {string} tokenLayerId - Token-layer-id identifier
       * @param {string} name - Required. Name
       */
      update: (tokenLayerId, name) =>
        this._request('PATCH', `/api/v1/token-layers/${tokenLayerId}`, {
          body: bodyOf({ name }),
        }),
    };

    this.documents = {
      /**
       * Get information about a document lock
       * @param {string} documentId - Document-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      checkLock: (documentId, asOf) =>
        this._request('GET', `/api/v1/documents/${documentId}/lock`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Acquire or refresh a document lock
       * @param {string} documentId - Document-id identifier
       */
      acquireLock: (documentId) =>
        this._request('POST', `/api/v1/documents/${documentId}/lock`),
      /**
       * Release a document lock
       * @param {string} documentId - Document-id identifier
       */
      releaseLock: (documentId) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/lock`),
      /**
       * Get media file for a document
       * @param {string} documentId - Document-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      getMedia: (documentId, asOf) =>
        this._request('GET', `/api/v1/documents/${documentId}/media`, {
          queryParams: { 'as-of': asOf },
          noBatch: true,
          binaryResponse: true,
        }),
      /**
       * Upload a media file for a document. Uses Apache Tika for content validation.
       * @param {string} documentId - Document-id identifier
       * @param {File} file - Required. File
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
       * @param {string} documentId - Document-id identifier
       */
      deleteMedia: (documentId) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/media`, {
          noBatch: true,
        }),
      /**
       * Replace all metadata for a document.
       * @param {string} documentId - Document-id identifier
       * @param {any} body - Required. Body
       */
      setMetadata: (documentId, body) =>
        this._request('PUT', `/api/v1/documents/${documentId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a document.
       * @param {string} documentId - Document-id identifier
       */
      deleteMetadata: (documentId) =>
        this._request('DELETE', `/api/v1/documents/${documentId}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Get audit log for a document
       * @param {string} documentId - Document-id identifier
       * @param {string} [startTime] - Optional startTime
       * @param {string} [endTime] - Optional endTime
       * @param {string} [asOf] - Optional asOf
       */
      audit: (documentId, startTime, endTime, asOf) =>
        this._request('GET', `/api/v1/documents/${documentId}/audit`, {
          queryParams: { 'start-time': startTime, 'end-time': endTime, 'as-of': asOf },
        }),
      /**
       * Get a document. Set includeBody to true in order to include all data contained in the document.
       * @param {string} documentId - Document-id identifier
       * @param {boolean} [includeBody] - Optional includeBody
       * @param {string} [asOf] - Optional asOf
       */
      get: (documentId, includeBody, asOf) =>
        this._request('GET', `/api/v1/documents/${documentId}`, {
          queryParams: { 'include-body': includeBody, 'as-of': asOf },
        }),
      /**
       * Delete a document and all data contained.
       * @param {string} documentId - Document-id identifier
       */
      delete: (documentId) =>
        this._request('DELETE', `/api/v1/documents/${documentId}`),
      /**
       * Update a document's name.
       * @param {string} documentId - Document-id identifier
       * @param {string} name - Required. Name
       */
      update: (documentId, name) =>
        this._request('PATCH', `/api/v1/documents/${documentId}`, {
          body: bodyOf({ name }),
        }),
      /**
       * Create a new document in a project.
       * @param {string} projectId - Required. Projectid
       * @param {string} name - Required. Name
       * @param {any} [metadata] - Optional. Metadata
       */
      create: (projectId, name, metadata) =>
        this._request('POST', '/api/v1/documents', {
          body: bodyOf({ 'project-id': projectId, name, metadata }),
        }),
    };

    this.projects = {
      /**
       * Set a user's access level to read and write for this project.
       * @param {string} id - Id identifier
       * @param {string} userId - User-id identifier
       */
      addWriter: (id, userId) =>
        this._request('POST', `/api/v1/projects/${id}/writers/${userId}`),
      /**
       * Remove a user's writer privileges for this project.
       * @param {string} id - Id identifier
       * @param {string} userId - User-id identifier
       */
      removeWriter: (id, userId) =>
        this._request('DELETE', `/api/v1/projects/${id}/writers/${userId}`),
      /**
       * Set a user's access level to read-only for this project.
       * @param {string} id - Id identifier
       * @param {string} userId - User-id identifier
       */
      addReader: (id, userId) =>
        this._request('POST', `/api/v1/projects/${id}/readers/${userId}`),
      /**
       * Remove a user's reader privileges for this project.
       * @param {string} id - Id identifier
       * @param {string} userId - User-id identifier
       */
      removeReader: (id, userId) =>
        this._request('DELETE', `/api/v1/projects/${id}/readers/${userId}`),
      /**
       * Set a configuration value for a project in a editor namespace.
       * @param {string} id - Id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (id, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/projects/${id}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a project.
       * @param {string} id - Id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       */
      deleteConfig: (id, namespace, configKey) =>
        this._request('DELETE', `/api/v1/projects/${id}/config/${namespace}/${configKey}`, {
          skipResponseTransform: true,
        }),
      /**
       * Assign a user as a maintainer for this project.
       * @param {string} id - Id identifier
       * @param {string} userId - User-id identifier
       */
      addMaintainer: (id, userId) =>
        this._request('POST', `/api/v1/projects/${id}/maintainers/${userId}`),
      /**
       * Remove a user's maintainer privileges for this project.
       * @param {string} id - Id identifier
       * @param {string} userId - User-id identifier
       */
      removeMaintainer: (id, userId) =>
        this._request('DELETE', `/api/v1/projects/${id}/maintainers/${userId}`),
      /**
       * Get audit log for a project
       * @param {string} projectId - Project-id identifier
       * @param {string} [startTime] - Optional startTime
       * @param {string} [endTime] - Optional endTime
       * @param {string} [asOf] - Optional asOf
       */
      audit: (projectId, startTime, endTime, asOf) =>
        this._request('GET', `/api/v1/projects/${projectId}/audit`, {
          queryParams: { 'start-time': startTime, 'end-time': endTime, 'as-of': asOf },
        }),
      /**
       * Link a vocabulary to a project.
       * @param {string} id - Id identifier
       * @param {string} vocabId - Vocab-id identifier
       */
      linkVocab: (id, vocabId) =>
        this._request('POST', `/api/v1/projects/${id}/vocabs/${vocabId}`),
      /**
       * Unlink a vocabulary from a project.
       * @param {string} id - Id identifier
       * @param {string} vocabId - Vocab-id identifier
       */
      unlinkVocab: (id, vocabId) =>
        this._request('DELETE', `/api/v1/projects/${id}/vocabs/${vocabId}`),
      /**
       * Get a project by ID.
       * @param {string} id - Id identifier
       * @param {boolean} [includeDocuments] - Optional includeDocuments
       * @param {string} [asOf] - Optional asOf
       */
      get: (id, includeDocuments, asOf) =>
        this._request('GET', `/api/v1/projects/${id}`, {
          queryParams: { 'include-documents': includeDocuments, 'as-of': asOf },
        }),
      /**
       * Delete a project.
       * @param {string} id - Id identifier
       */
      delete: (id) =>
        this._request('DELETE', `/api/v1/projects/${id}`),
      /**
       * Update a project's name.
       * @param {string} id - Id identifier
       * @param {string} name - Required. Name
       */
      update: (id, name) =>
        this._request('PATCH', `/api/v1/projects/${id}`, {
          body: bodyOf({ name }),
        }),
      /**
       * List all projects accessible to user
       * @param {string} [asOf] - Optional asOf
       */
      list: (asOf) =>
        this._request('GET', '/api/v1/projects', {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Create a new project. Note: this also registers the user as a maintainer.
       * @param {string} name - Required. Name
       */
      create: (name) =>
        this._request('POST', '/api/v1/projects', {
          body: bodyOf({ name }),
        }),
    };

    this.textLayers = {
      /**
       * Set a configuration value for a layer in a editor namespace.
       * @param {string} textLayerId - Text-layer-id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (textLayerId, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} textLayerId - Text-layer-id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       */
      deleteConfig: (textLayerId, namespace, configKey) =>
        this._request('DELETE', `/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`, {
          skipResponseTransform: true,
        }),
      /**
       * Get a text layer by ID.
       * @param {string} textLayerId - Text-layer-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (textLayerId, asOf) =>
        this._request('GET', `/api/v1/text-layers/${textLayerId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a text layer.
       * @param {string} textLayerId - Text-layer-id identifier
       */
      delete: (textLayerId) =>
        this._request('DELETE', `/api/v1/text-layers/${textLayerId}`),
      /**
       * Update a text layer's name.
       * @param {string} textLayerId - Text-layer-id identifier
       * @param {string} name - Required. Name
       */
      update: (textLayerId, name) =>
        this._request('PATCH', `/api/v1/text-layers/${textLayerId}`, {
          body: bodyOf({ name }),
        }),
      /**
       * Shift a text layer's order within the project.
       * @param {string} textLayerId - Text-layer-id identifier
       * @param {string} direction - Required. Direction
       */
      shift: (textLayerId, direction) =>
        this._request('POST', `/api/v1/text-layers/${textLayerId}/shift`, {
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new text layer for a project.
       * @param {string} projectId - Required. Projectid
       * @param {string} name - Required. Name
       */
      create: (projectId, name) =>
        this._request('POST', '/api/v1/text-layers', {
          body: bodyOf({ 'project-id': projectId, name }),
        }),
    };

    this.login = {
      /**
       * Authenticate with a userId and password and get a JWT token.
       * @param {string} userId - Required. Userid
       * @param {string} password - Required. Password
       */
      create: (userId, password) =>
        this._request('POST', '/api/v1/login', {
          body: bodyOf({ 'user-id': userId, password }),
          noAuth: true,
        }),
    };

    this.vocabItems = {
      /**
       * Replace all metadata for a vocab item.
       * @param {string} id - Id identifier
       * @param {any} body - Required. Body
       */
      setMetadata: (id, body) =>
        this._request('PUT', `/api/v1/vocab-items/${id}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a vocab item.
       * @param {string} id - Id identifier
       */
      deleteMetadata: (id) =>
        this._request('DELETE', `/api/v1/vocab-items/${id}/metadata`, {
          skipResponseTransform: true,
        }),
      /**
       * Create a new vocab item
       * @param {string} vocabLayerId - Required. Vocablayerid
       * @param {string} form - Required. Form
       * @param {any} [metadata] - Optional. Metadata
       */
      create: (vocabLayerId, form, metadata) =>
        this._request('POST', '/api/v1/vocab-items', {
          body: bodyOf({ 'vocab-layer-id': vocabLayerId, form, metadata }),
        }),
      /**
       * Get a vocab item by ID
       * @param {string} id - Id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (id, asOf) =>
        this._request('GET', `/api/v1/vocab-items/${id}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a vocab item
       * @param {string} id - Id identifier
       */
      delete: (id) =>
        this._request('DELETE', `/api/v1/vocab-items/${id}`),
      /**
       * Update a vocab item's form
       * @param {string} id - Id identifier
       * @param {string} form - Required. Form
       */
      update: (id, form) =>
        this._request('PATCH', `/api/v1/vocab-items/${id}`, {
          body: bodyOf({ form }),
        }),
    };

    this.relationLayers = {
      /**
       * Shift a relation layer's order.
       * @param {string} relationLayerId - Relation-layer-id identifier
       * @param {string} direction - Required. Direction
       */
      shift: (relationLayerId, direction) =>
        this._request('POST', `/api/v1/relation-layers/${relationLayerId}/shift`, {
          body: bodyOf({ direction }),
        }),
      /**
       * Create a new relation layer.
       * @param {string} spanLayerId - Required. Spanlayerid
       * @param {string} name - Required. Name
       */
      create: (spanLayerId, name) =>
        this._request('POST', '/api/v1/relation-layers', {
          body: bodyOf({ 'span-layer-id': spanLayerId, name }),
        }),
      /**
       * Set a configuration value for a layer in a editor namespace.
       * @param {string} relationLayerId - Relation-layer-id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       * @param {any} configValue - Configuration value to set
       */
      setConfig: (relationLayerId, namespace, configKey, configValue) =>
        this._request('PUT', `/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`, {
          rawBody: configValue, skipResponseTransform: true,
        }),
      /**
       * Remove a configuration value for a layer.
       * @param {string} relationLayerId - Relation-layer-id identifier
       * @param {string} namespace - Namespace identifier
       * @param {string} configKey - Config-key identifier
       */
      deleteConfig: (relationLayerId, namespace, configKey) =>
        this._request('DELETE', `/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`, {
          skipResponseTransform: true,
        }),
      /**
       * Get a relation layer by ID.
       * @param {string} relationLayerId - Relation-layer-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (relationLayerId, asOf) =>
        this._request('GET', `/api/v1/relation-layers/${relationLayerId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a relation layer.
       * @param {string} relationLayerId - Relation-layer-id identifier
       */
      delete: (relationLayerId) =>
        this._request('DELETE', `/api/v1/relation-layers/${relationLayerId}`),
      /**
       * Update a relation layer's name.
       * @param {string} relationLayerId - Relation-layer-id identifier
       * @param {string} name - Required. Name
       */
      update: (relationLayerId, name) =>
        this._request('PATCH', `/api/v1/relation-layers/${relationLayerId}`, {
          body: bodyOf({ name }),
        }),
    };

    this.tokens = {
      /**
       * Create a new token in a token layer.
       * @param {string} tokenLayerId - Required. Tokenlayerid
       * @param {string} text - Required. Text
       * @param {number} begin - Required. Begin
       * @param {number} end - Required. End
       * @param {number} [precedence] - Optional. Precedence
       * @param {any} [metadata] - Optional. Metadata
       */
      create: (tokenLayerId, text, begin, end, precedence, metadata) =>
        this._request('POST', '/api/v1/tokens', {
          body: bodyOf({ 'token-layer-id': tokenLayerId, text, begin, end, precedence, metadata }),
        }),
      /**
       * Get a token.
       * @param {string} tokenId - Token-id identifier
       * @param {string} [asOf] - Optional asOf
       */
      get: (tokenId, asOf) =>
        this._request('GET', `/api/v1/tokens/${tokenId}`, {
          queryParams: { 'as-of': asOf },
        }),
      /**
       * Delete a token.
       * @param {string} tokenId - Token-id identifier
       */
      delete: (tokenId) =>
        this._request('DELETE', `/api/v1/tokens/${tokenId}`),
      /**
       * Update a token.
       * @param {string} tokenId - Token-id identifier
       * @param {number} [begin] - Optional. Begin
       * @param {number} [end] - Optional. End
       * @param {number} [precedence] - Optional. Precedence
       */
      update: (tokenId, begin, end, precedence) =>
        this._request('PATCH', `/api/v1/tokens/${tokenId}`, {
          body: bodyOf({ begin, end, precedence }),
        }),
      /**
       * Create multiple tokens in a single operation.
       * @param {Array} body - Required. Body
       */
      bulkCreate: (body) =>
        this._request('POST', '/api/v1/tokens/bulk', { body }),
      /**
       * Delete multiple tokens in a single operation. Provide an array of IDs.
       * @param {Array} body - Required. Body
       */
      bulkDelete: (body) =>
        this._request('DELETE', '/api/v1/tokens/bulk', { body }),
      /**
       * Replace all metadata for a token.
       * @param {string} tokenId - Token-id identifier
       * @param {any} body - Required. Body
       */
      setMetadata: (tokenId, body) =>
        this._request('PUT', `/api/v1/tokens/${tokenId}/metadata`, {
          rawBody: body, skipResponseTransform: true,
        }),
      /**
       * Remove all metadata from a token.
       * @param {string} tokenId - Token-id identifier
       */
      deleteMetadata: (tokenId) =>
        this._request('DELETE', `/api/v1/tokens/${tokenId}/metadata`, {
          skipResponseTransform: true,
        }),
    };

    this.messages = {
      /**
       * Listen for project events including service coordination messages
       * @param {string} projectId - The UUID of the project to listen to
       * @param {function} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop.
       * @returns {Object} SSE connection object with .close() and .getStats() methods
       */
      listen: (projectId, onEvent) =>
        createSSEConnection(this, projectId, onEvent),

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
       * Discover available services in a project
       * @param {string} projectId - The UUID of the project to query
       * @param {number} [timeout] - Timeout in milliseconds (default: 3000)
       * @returns {Promise<Array>} Array of discovered service information
       */
      discoverServices: (projectId, timeout) =>
        discoverServices(
          this,
          this.messages.listen,
          this.messages.sendMessage,
          projectId,
          timeout,
        ),

      /**
       * Register as a service and handle incoming requests
       * @param {string} projectId - The UUID of the project to serve
       * @param {Object} serviceInfo - Service information {serviceId, serviceName, description}
       * @param {function} onServiceRequest - Callback to handle service requests
       * @param {Object} [extras] - Optional additional service metadata
       * @returns {Object} Service registration object with .stop() method
       */
      serve: (projectId, serviceInfo, onServiceRequest, extras) =>
        serve(
          this,
          this.messages.listen,
          this.messages.sendMessage,
          projectId,
          serviceInfo,
          onServiceRequest,
          extras,
        ),

      /**
       * Request a service to perform work
       * @param {string} projectId - The UUID of the project
       * @param {string} serviceId - The ID of the service to request
       * @param {any} data - The request data
       * @param {number} [timeout] - Timeout in milliseconds (default: 10000)
       * @returns {Promise<any>} Service response
       */
      requestService: (projectId, serviceId, data, timeout) =>
        requestService(
          this,
          this.messages.listen,
          this.messages.sendMessage,
          projectId,
          serviceId,
          data,
          timeout,
        ),
    };
  }

  // --- Core methods ---

  async _request(method, path, options = {}) {
    return makeRequest(this, method, path, options);
  }

  /**
   * Enter strict mode for a specific document.
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
   * Set the user agent name for audit logging.
   * @param {string} agentName - Name to identify this client in audit logs
   */
  setAgentName(agentName) {
    this.agentName = agentName;
  }

  /** Begin a batch of operations. Subsequent API calls will be queued. */
  beginBatch() {
    this.isBatching = true;
    this.batchOperations = [];
  }

  /**
   * Submit all queued batch operations as a single batch request.
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
          ...(this.agentName && { 'X-Agent-Name': this.agentName }),
        },
        body: JSON.stringify(body),
      };

      try {
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
          let errorData;
          try {
            errorData = await response.json();
          } catch (_) {
            errorData = { message: await response.text().catch(() => 'Unable to read error response') };
          }

          const serverMessage = errorData?.error || errorData?.message || response.statusText;
          const error = new Error(`HTTP ${response.status} ${serverMessage} at ${url}`);
          error.status = response.status;
          error.statusText = response.statusText;
          error.url = url;
          error.method = 'POST';
          error.responseData = errorData;
          throw error;
        }

        const results = await response.json();

        // Extract document versions from each batch response
        for (const result of results) {
          if (result.headers && result.headers['X-Document-Versions']) {
            try {
              const versionsMap = JSON.parse(result.headers['X-Document-Versions']);
              if (typeof versionsMap === 'object' && versionsMap !== null) {
                Object.entries(versionsMap).forEach(([docId, version]) => {
                  this.documentVersions = { ...this.documentVersions };
                  this.documentVersions[docId] = version;
                });
              }
            } catch (e) {
              console.warn('Failed to parse document versions header from batch response:', e);
            }
          }
        }

        return results.map(result => transformResponse(result));
      } catch (error) {
        if (error.status) throw error;
        const fetchError = new Error(`Network error: ${error.message} at ${url}`);
        fetchError.status = 0;
        fetchError.url = url;
        fetchError.method = 'POST';
        fetchError.originalError = error;
        throw fetchError;
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
   * Authenticate and return a new client instance with token
   * @param {string} baseUrl - The base URL for the API
   * @param {string} userId - User ID for authentication
   * @param {string} password - Password for authentication
   * @returns {Promise<PlaidClient>} - Authenticated client instance
   */
  static async login(baseUrl, userId, password) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 'user-id': userId, password }),
      });

      if (!response.ok) {
        let errorData;
        try {
          errorData = await response.json();
        } catch (_) {
          errorData = { message: await response.text().catch(() => 'Unable to read error response') };
        }

        const serverMessage = errorData?.error || errorData?.message || response.statusText;
        const error = new Error(`HTTP ${response.status} ${serverMessage} at ${baseUrl}/api/v1/login`);
        error.status = response.status;
        error.statusText = response.statusText;
        error.url = `${baseUrl}/api/v1/login`;
        error.method = 'POST';
        error.responseData = errorData;
        throw error;
      }

      const data = await response.json();
      const token = data.token || '';
      return new PlaidClient(baseUrl, token);
    } catch (error) {
      if (error.status) throw error;
      const fetchError = new Error(`Network error: ${error.message} at ${baseUrl}/api/v1/login`);
      fetchError.status = 0;
      fetchError.url = `${baseUrl}/api/v1/login`;
      fetchError.method = 'POST';
      fetchError.originalError = error;
      throw fetchError;
    }
  }
}

export default PlaidClient;
export { PlaidClient };
