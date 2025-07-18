/**
 * plaid-api-v1 - Plaid's REST API
 * Version: v1.0
 * Generated on: Wed Jun 11 10:03:58 EDT 2025
 */

class PlaidClient {
  /**
   * Create a new PlaidClient instance
   * @param {string} baseUrl - The base URL for the API
   * @param {string} token - The authentication token
   */
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.token = token;
    
    // Initialize API bundles
    this.relations = {
      /**
       * Update the target span of a relation.
 * @param {string} relationId - Relation-id identifier
 * @param {string} spanId - Required. Spanid
       */
      target: this._relationsTarget.bind(this),
      /**
       * Get a relation by ID.
 * @param {string} relationId - Relation-id identifier
       */
      get: this._relationsGet.bind(this),
      /**
       * Delete a relation.
 * @param {string} relationId - Relation-id identifier
       */
      delete: this._relationsDelete.bind(this),
      /**
       * Update a relation's value.
 * @param {string} relationId - Relation-id identifier
 * @param {any} value - Required. Value
       */
      update: this._relationsUpdate.bind(this),
      /**
       * Update the source span of a relation.
 * @param {string} relationId - Relation-id identifier
 * @param {string} spanId - Required. Spanid
       */
      source: this._relationsSource.bind(this),
      /**
       * Create a new relation.
 * @param {string} layerId - Required. Layerid
 * @param {string} sourceId - Required. Sourceid
 * @param {string} targetId - Required. Targetid
 * @param {any} value - Required. Value
 * @param {string} id - Optional. Id
       */
      create: this._relationsCreate.bind(this)
    };
    this.spanLayers = {
      /**
       * Set a configuration value for a layer in a editor namespace. Good for storing data useful for 
 * @param {string} spanLayerId - Span-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._spanLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer in a editor namespace
 * @param {string} spanLayerId - Span-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._spanLayersDeleteConfig.bind(this),
      /**
       * Get a span layer by ID.
 * @param {string} spanLayerId - Span-layer-id identifier
       */
      get: this._spanLayersGet.bind(this),
      /**
       * Delete a span layer.
 * @param {string} spanLayerId - Span-layer-id identifier
       */
      delete: this._spanLayersDelete.bind(this),
      /**
       * Update a span layer's name.
 * @param {string} spanLayerId - Span-layer-id identifier
 * @param {string} name - Required. Name
       */
      update: this._spanLayersUpdate.bind(this),
      /**
       * Create a new span layer.
 * @param {string} tokenLayerId - Required. Tokenlayerid
 * @param {string} name - Required. Name
       */
      create: this._spanLayersCreate.bind(this),
      /**
       * Shift a span layer's order.
 * @param {string} spanLayerId - Span-layer-id identifier
 * @param {string} direction - Required. Direction
       */
      shift: this._spanLayersShift.bind(this)
    };
    this.spans = {
      /**
       * Replace tokens for a span.
 * @param {string} spanId - Span-id identifier
 * @param {Array} tokens - Required. Tokens
       */
      tokens: this._spansTokens.bind(this),
      /**
       * Create a new span in a span layer.
 * @param {string} spanLayerId - Required. Spanlayerid
 * @param {Array} tokens - Required. Tokens
 * @param {any} value - Required. Value
       */
      create: this._spansCreate.bind(this),
      /**
       * Get a span by ID.
 * @param {string} spanId - Span-id identifier
       */
      get: this._spansGet.bind(this),
      /**
       * Delete a span.
 * @param {string} spanId - Span-id identifier
       */
      delete: this._spansDelete.bind(this),
      /**
       * Update a span's value.
 * @param {string} spanId - Span-id identifier
 * @param {any} value - Required. Value
       */
      update: this._spansUpdate.bind(this)
    };
    this.texts = {
      /**
       * Create a new text for a document.
 * @param {string} textLayerId - Required. Textlayerid
 * @param {string} documentId - Required. Documentid
 * @param {string} bodyText - Required. Bodytext
       */
      create: this._textsCreate.bind(this),
      /**
       * Get a text by ID.
 * @param {string} textId - Text-id identifier
       */
      get: this._textsGet.bind(this),
      /**
       * Delete a text.
 * @param {string} textId - Text-id identifier
       */
      delete: this._textsDelete.bind(this),
      /**
       * Update a text's body.
 * @param {string} textId - Text-id identifier
 * @param {string} bodyText - Required. Bodytext
       */
      update: this._textsUpdate.bind(this)
    };
    this.users = {
      /**
       * List all users
       */
      list: this._usersList.bind(this),
      /**
       * Create a new user
 * @param {string} username - Required. Username
 * @param {string} password - Required. Password
 * @param {boolean} isAdmin - Required. Isadmin
       */
      create: this._usersCreate.bind(this),
      /**
       * Get a user by ID
 * @param {string} id - Id identifier
       */
      get: this._usersGet.bind(this),
      /**
       * Delete a user
 * @param {string} id - Id identifier
       */
      delete: this._usersDelete.bind(this),
      /**
       * Modify a user
 * @param {string} id - Id identifier
 * @param {string} password - Optional. Password
 * @param {string} username - Optional. Username
 * @param {boolean} isAdmin - Optional. Isadmin
       */
      update: this._usersUpdate.bind(this)
    };
    this.tokenLayers = {
      /**
       * Shift a token layer's order.
 * @param {string} tokenLayerId - Token-layer-id identifier
 * @param {string} direction - Required. Direction
       */
      shift: this._tokenLayersShift.bind(this),
      /**
       * Create a new token layer.
 * @param {string} textLayerId - Required. Textlayerid
 * @param {string} name - Required. Name
       */
      create: this._tokenLayersCreate.bind(this),
      /**
       * Set a configuration value for a layer in a editor namespace. Good for storing data useful for 
 * @param {string} tokenLayerId - Token-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._tokenLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer in a editor namespace
 * @param {string} tokenLayerId - Token-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._tokenLayersDeleteConfig.bind(this),
      /**
       * Get a token layer by ID.
 * @param {string} tokenLayerId - Token-layer-id identifier
       */
      get: this._tokenLayersGet.bind(this),
      /**
       * Delete a token layer.
 * @param {string} tokenLayerId - Token-layer-id identifier
       */
      delete: this._tokenLayersDelete.bind(this),
      /**
       * Update a token layer's name.
 * @param {string} tokenLayerId - Token-layer-id identifier
 * @param {string} name - Required. Name
       */
      update: this._tokenLayersUpdate.bind(this)
    };
    this.documents = {
      /**
       * Get a document by ID. If includeBody is true, also includes all layers with data.
 * @param {string} documentId - Document-id identifier
 * @param {boolean} [includeBody] - Optional includeBody
       */
      get: this._documentsGet.bind(this),
      /**
       * Delete a document.
 * @param {string} documentId - Document-id identifier
       */
      delete: this._documentsDelete.bind(this),
      /**
       * Update a document's name.
 * @param {string} documentId - Document-id identifier
 * @param {string} name - Required. Name
       */
      update: this._documentsUpdate.bind(this),
      /**
       * Create a new document for a project.
 * @param {string} projectId - Required. Projectid
 * @param {string} name - Required. Name
       */
      create: this._documentsCreate.bind(this)
    };
    this.projects = {
      /**
       * Add a user as a writer to the project
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      addWriter: this._projectsAddWriter.bind(this),
      /**
       * Remove a user's writer access from the project
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      removeWriter: this._projectsRemoveWriter.bind(this),
      /**
       * Add a user as a reader to the project
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      addReader: this._projectsAddReader.bind(this),
      /**
       * Remove a user's reader access from the project
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      removeReader: this._projectsRemoveReader.bind(this),
      /**
       * Add a user as a maintainer to the project
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      addMaintainer: this._projectsAddMaintainer.bind(this),
      /**
       * Remove a user's maintainer access from the project
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      removeMaintainer: this._projectsRemoveMaintainer.bind(this),
      /**
       * Get a project by ID
 * @param {string} id - Id identifier
 * @param {boolean} [includeDocuments] - Optional includeDocuments
       */
      get: this._projectsGet.bind(this),
      /**
       * Delete a project
 * @param {string} id - Id identifier
       */
      delete: this._projectsDelete.bind(this),
      /**
       * Update a project's name.
 * @param {string} id - Id identifier
 * @param {string} name - Required. Name
       */
      update: this._projectsUpdate.bind(this),
      /**
       * List all projects accessible to user
       */
      list: this._projectsList.bind(this),
      /**
       * Create a new project. Note: this also registers the user as a maintainer.
 * @param {string} name - Required. Name
       */
      create: this._projectsCreate.bind(this)
    };
    this.textLayers = {
      /**
       * Set a configuration value for a layer in a editor namespace. Good for storing data useful for 
 * @param {string} textLayerId - Text-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._textLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer in a editor namespace
 * @param {string} textLayerId - Text-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._textLayersDeleteConfig.bind(this),
      /**
       * Get a text layer by ID.
 * @param {string} textLayerId - Text-layer-id identifier
       */
      get: this._textLayersGet.bind(this),
      /**
       * Delete a text layer.
 * @param {string} textLayerId - Text-layer-id identifier
       */
      delete: this._textLayersDelete.bind(this),
      /**
       * Update a text layer's name.
 * @param {string} textLayerId - Text-layer-id identifier
 * @param {string} name - Required. Name
       */
      update: this._textLayersUpdate.bind(this),
      /**
       * Shift a text layer's order within the project.
 * @param {string} textLayerId - Text-layer-id identifier
 * @param {string} direction - Required. Direction
       */
      shift: this._textLayersShift.bind(this),
      /**
       * Create a new text layer for a project.
 * @param {string} projectId - Required. Projectid
 * @param {string} name - Required. Name
       */
      create: this._textLayersCreate.bind(this)
    };
    this.login = {
      /**
       * Authenticate a user and get a JWT token
 * @param {string} username - Required. Username
 * @param {string} password - Required. Password
       */
      create: this._loginCreate.bind(this)
    };
    this.relationLayers = {
      /**
       * Shift a relation layer's order.
 * @param {string} relationLayerId - Relation-layer-id identifier
 * @param {string} direction - Required. Direction
       */
      shift: this._relationLayersShift.bind(this),
      /**
       * Create a new relation layer.
 * @param {string} spanLayerId - Required. Spanlayerid
 * @param {string} name - Required. Name
       */
      create: this._relationLayersCreate.bind(this),
      /**
       * Set a configuration value for a layer in a editor namespace. Good for storing data useful for 
 * @param {string} relationLayerId - Relation-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._relationLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer in a editor namespace
 * @param {string} relationLayerId - Relation-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._relationLayersDeleteConfig.bind(this),
      /**
       * Get a relation layer by ID.
 * @param {string} relationLayerId - Relation-layer-id identifier
       */
      get: this._relationLayersGet.bind(this),
      /**
       * Delete a relation layer.
 * @param {string} relationLayerId - Relation-layer-id identifier
       */
      delete: this._relationLayersDelete.bind(this),
      /**
       * Update a relation layer's name.
 * @param {string} relationLayerId - Relation-layer-id identifier
 * @param {string} name - Required. Name
       */
      update: this._relationLayersUpdate.bind(this)
    };
    this.tokens = {
      /**
       * Create a new token in a token layer.
 * @param {string} tokenLayerId - Required. Tokenlayerid
 * @param {string} textId - Required. Textid
 * @param {number} begin - Required. Begin
 * @param {number} end - Required. End
 * @param {number} precedence - Optional. Precedence
       */
      create: this._tokensCreate.bind(this),
      /**
       * Get a token by ID.
 * @param {string} tokenId - Token-id identifier
       */
      get: this._tokensGet.bind(this),
      /**
       * Delete a token.
 * @param {string} tokenId - Token-id identifier
       */
      delete: this._tokensDelete.bind(this),
      /**
       * Update a token's extent and/or precedence.
 * @param {string} tokenId - Token-id identifier
 * @param {number} begin - Optional. Begin
 * @param {number} end - Optional. End
 * @param {number} precedence - Optional. Precedence
       */
      update: this._tokensUpdate.bind(this)
    };
  }

  // Key transformation utilities
  _transformKeyToCamel(key) {
    // Convert kebab-case and namespaced keys to camelCase
    // 'layer-id' -> 'layerId'
    // 'relation/layer' -> 'layer' (namespace ignored)
    // 'project/name' -> 'name' (namespace ignored)
    return key.replace(/^[^/]+\//, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  }

  _transformKeyFromCamel(key) {
    // Convert camelCase back to kebab-case
    // 'layerId' -> 'layer-id'
    return key.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
  }

  _transformRequest(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(item => this._transformRequest(item));
    if (typeof obj !== 'object') return obj;
    
    const transformed = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey = this._transformKeyFromCamel(key);
      transformed[newKey] = this._transformRequest(value);
    }
    return transformed;
  }

  _transformResponse(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(item => this._transformResponse(item));
    if (typeof obj !== 'object') return obj;
    
    const transformed = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey = this._transformKeyToCamel(key);
      transformed[newKey] = this._transformResponse(value);
    }
    return transformed;
  }

  /**
   * Update the target span of a relation.
   */
  async _relationsTarget(relationId, spanId) {
    const url = `${this.baseUrl}/api/v1/relations/${relationId}/target`;
    const bodyObj = {
      "span-id": spanId
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PUT';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a relation by ID.
   */
  async _relationsGet(relationId) {
    const url = `${this.baseUrl}/api/v1/relations/${relationId}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a relation.
   */
  async _relationsDelete(relationId) {
    const url = `${this.baseUrl}/api/v1/relations/${relationId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a relation's value.
   */
  async _relationsUpdate(relationId, value) {
    const url = `${this.baseUrl}/api/v1/relations/${relationId}`;
    const bodyObj = {
      "value": value
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update the source span of a relation.
   */
  async _relationsSource(relationId, spanId) {
    const url = `${this.baseUrl}/api/v1/relations/${relationId}/source`;
    const bodyObj = {
      "span-id": spanId
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PUT';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new relation.
   */
  async _relationsCreate(layerId, sourceId, targetId, value, id = undefined) {
    const url = `${this.baseUrl}/api/v1/relations`;
    const bodyObj = {
      "layer-id": layerId,
      "source-id": sourceId,
      "target-id": targetId,
      "value": value,
      "id": id
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Good for storing data useful for 
   */
  async _spanLayersSetConfig(spanLayerId, namespace, configKey, configValue) {
    const url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`;
    const body = configValue;
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PUT';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer in a editor namespace
   */
  async _spanLayersDeleteConfig(spanLayerId, namespace, configKey) {
    const url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a span layer by ID.
   */
  async _spanLayersGet(spanLayerId) {
    const url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a span layer.
   */
  async _spanLayersDelete(spanLayerId) {
    const url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a span layer's name.
   */
  async _spanLayersUpdate(spanLayerId, name) {
    const url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new span layer.
   */
  async _spanLayersCreate(tokenLayerId, name) {
    const url = `${this.baseUrl}/api/v1/span-layers`;
    const bodyObj = {
      "token-layer-id": tokenLayerId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Shift a span layer's order.
   */
  async _spanLayersShift(spanLayerId, direction) {
    const url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}/shift`;
    const bodyObj = {
      "direction": direction
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Replace tokens for a span.
   */
  async _spansTokens(spanId, tokens) {
    const url = `${this.baseUrl}/api/v1/spans/${spanId}/tokens`;
    const bodyObj = {
      "tokens": tokens
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PUT';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new span in a span layer.
   */
  async _spansCreate(spanLayerId, tokens, value) {
    const url = `${this.baseUrl}/api/v1/spans`;
    const bodyObj = {
      "span-layer-id": spanLayerId,
      "tokens": tokens,
      "value": value
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a span by ID.
   */
  async _spansGet(spanId) {
    const url = `${this.baseUrl}/api/v1/spans/${spanId}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a span.
   */
  async _spansDelete(spanId) {
    const url = `${this.baseUrl}/api/v1/spans/${spanId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a span's value.
   */
  async _spansUpdate(spanId, value) {
    const url = `${this.baseUrl}/api/v1/spans/${spanId}`;
    const bodyObj = {
      "value": value
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new text for a document.
   */
  async _textsCreate(textLayerId, documentId, bodyText) {
    const url = `${this.baseUrl}/api/v1/texts`;
    const bodyObj = {
      "text-layer-id": textLayerId,
      "document-id": documentId,
      "body": bodyText
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a text by ID.
   */
  async _textsGet(textId) {
    const url = `${this.baseUrl}/api/v1/texts/${textId}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a text.
   */
  async _textsDelete(textId) {
    const url = `${this.baseUrl}/api/v1/texts/${textId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a text's body.
   */
  async _textsUpdate(textId, bodyText) {
    const url = `${this.baseUrl}/api/v1/texts/${textId}`;
    const bodyObj = {
      "body": bodyText
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * List all users
   */
  async _usersList() {
    const url = `${this.baseUrl}/api/v1/users`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new user
   */
  async _usersCreate(username, password, isAdmin) {
    const url = `${this.baseUrl}/api/v1/users`;
    const bodyObj = {
      "username": username,
      "password": password,
      "is-admin": isAdmin
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a user by ID
   */
  async _usersGet(id) {
    const url = `${this.baseUrl}/api/v1/users/${id}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a user
   */
  async _usersDelete(id) {
    const url = `${this.baseUrl}/api/v1/users/${id}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Modify a user
   */
  async _usersUpdate(id, password = undefined, username = undefined, isAdmin = undefined) {
    const url = `${this.baseUrl}/api/v1/users/${id}`;
    const bodyObj = {
      "password": password,
      "username": username,
      "is-admin": isAdmin
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Shift a token layer's order.
   */
  async _tokenLayersShift(tokenLayerId, direction) {
    const url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}/shift`;
    const bodyObj = {
      "direction": direction
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new token layer.
   */
  async _tokenLayersCreate(textLayerId, name) {
    const url = `${this.baseUrl}/api/v1/token-layers`;
    const bodyObj = {
      "text-layer-id": textLayerId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Good for storing data useful for 
   */
  async _tokenLayersSetConfig(tokenLayerId, namespace, configKey, configValue) {
    const url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`;
    const body = configValue;
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PUT';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer in a editor namespace
   */
  async _tokenLayersDeleteConfig(tokenLayerId, namespace, configKey) {
    const url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a token layer by ID.
   */
  async _tokenLayersGet(tokenLayerId) {
    const url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a token layer.
   */
  async _tokenLayersDelete(tokenLayerId) {
    const url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a token layer's name.
   */
  async _tokenLayersUpdate(tokenLayerId, name) {
    const url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a document by ID. If includeBody is true, also includes all layers with data.
   */
  async _documentsGet(documentId, includeBody = undefined) {
    const url = `${this.baseUrl}/api/v1/documents/${documentId}`;
    const queryParams = new URLSearchParams();
    if (includeBody !== undefined && includeBody !== null) {
      queryParams.append('include-body', includeBody);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(finalUrl, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${finalUrl}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = finalUrl;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a document.
   */
  async _documentsDelete(documentId) {
    const url = `${this.baseUrl}/api/v1/documents/${documentId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a document's name.
   */
  async _documentsUpdate(documentId, name) {
    const url = `${this.baseUrl}/api/v1/documents/${documentId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new document for a project.
   */
  async _documentsCreate(projectId, name) {
    const url = `${this.baseUrl}/api/v1/documents`;
    const bodyObj = {
      "project-id": projectId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Add a user as a writer to the project
   */
  async _projectsAddWriter(id, userId) {
    const url = `${this.baseUrl}/api/v1/projects/${id}/writers/${userId}`;
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a user's writer access from the project
   */
  async _projectsRemoveWriter(id, userId) {
    const url = `${this.baseUrl}/api/v1/projects/${id}/writers/${userId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Add a user as a reader to the project
   */
  async _projectsAddReader(id, userId) {
    const url = `${this.baseUrl}/api/v1/projects/${id}/readers/${userId}`;
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a user's reader access from the project
   */
  async _projectsRemoveReader(id, userId) {
    const url = `${this.baseUrl}/api/v1/projects/${id}/readers/${userId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Add a user as a maintainer to the project
   */
  async _projectsAddMaintainer(id, userId) {
    const url = `${this.baseUrl}/api/v1/projects/${id}/maintainers/${userId}`;
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a user's maintainer access from the project
   */
  async _projectsRemoveMaintainer(id, userId) {
    const url = `${this.baseUrl}/api/v1/projects/${id}/maintainers/${userId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a project by ID
   */
  async _projectsGet(id, includeDocuments = undefined) {
    const url = `${this.baseUrl}/api/v1/projects/${id}`;
    const queryParams = new URLSearchParams();
    if (includeDocuments !== undefined && includeDocuments !== null) {
      queryParams.append('include-documents', includeDocuments);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(finalUrl, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${finalUrl}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = finalUrl;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a project
   */
  async _projectsDelete(id) {
    const url = `${this.baseUrl}/api/v1/projects/${id}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a project's name.
   */
  async _projectsUpdate(id, name) {
    const url = `${this.baseUrl}/api/v1/projects/${id}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * List all projects accessible to user
   */
  async _projectsList() {
    const url = `${this.baseUrl}/api/v1/projects`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new project. Note: this also registers the user as a maintainer.
   */
  async _projectsCreate(name) {
    const url = `${this.baseUrl}/api/v1/projects`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Good for storing data useful for 
   */
  async _textLayersSetConfig(textLayerId, namespace, configKey, configValue) {
    const url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`;
    const body = configValue;
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PUT';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer in a editor namespace
   */
  async _textLayersDeleteConfig(textLayerId, namespace, configKey) {
    const url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a text layer by ID.
   */
  async _textLayersGet(textLayerId) {
    const url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a text layer.
   */
  async _textLayersDelete(textLayerId) {
    const url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a text layer's name.
   */
  async _textLayersUpdate(textLayerId, name) {
    const url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Shift a text layer's order within the project.
   */
  async _textLayersShift(textLayerId, direction) {
    const url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}/shift`;
    const bodyObj = {
      "direction": direction
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new text layer for a project.
   */
  async _textLayersCreate(projectId, name) {
    const url = `${this.baseUrl}/api/v1/text-layers`;
    const bodyObj = {
      "project-id": projectId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Authenticate a user and get a JWT token
   */
  async _loginCreate(username, password) {
    const url = `${this.baseUrl}/api/v1/login`;
    const bodyObj = {
      "username": username,
      "password": password
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Shift a relation layer's order.
   */
  async _relationLayersShift(relationLayerId, direction) {
    const url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}/shift`;
    const bodyObj = {
      "direction": direction
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new relation layer.
   */
  async _relationLayersCreate(spanLayerId, name) {
    const url = `${this.baseUrl}/api/v1/relation-layers`;
    const bodyObj = {
      "span-layer-id": spanLayerId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Good for storing data useful for 
   */
  async _relationLayersSetConfig(relationLayerId, namespace, configKey, configValue) {
    const url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`;
    const body = configValue;
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PUT';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer in a editor namespace
   */
  async _relationLayersDeleteConfig(relationLayerId, namespace, configKey) {
    const url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a relation layer by ID.
   */
  async _relationLayersGet(relationLayerId) {
    const url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a relation layer.
   */
  async _relationLayersDelete(relationLayerId) {
    const url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a relation layer's name.
   */
  async _relationLayersUpdate(relationLayerId, name) {
    const url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new token in a token layer.
   */
  async _tokensCreate(tokenLayerId, textId, begin, end, precedence = undefined) {
    const url = `${this.baseUrl}/api/v1/tokens`;
    const bodyObj = {
      "token-layer-id": tokenLayerId,
      "text-id": textId,
      "begin": begin,
      "end": end,
      "precedence": precedence
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a token by ID.
   */
  async _tokensGet(tokenId) {
    const url = `${this.baseUrl}/api/v1/tokens/${tokenId}`;
    const fetchOptions = {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'GET';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a token.
   */
  async _tokensDelete(tokenId) {
    const url = `${this.baseUrl}/api/v1/tokens/${tokenId}`;
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'DELETE';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a token's extent and/or precedence.
   */
  async _tokensUpdate(tokenId, begin = undefined, end = undefined, precedence = undefined) {
    const url = `${this.baseUrl}/api/v1/tokens/${tokenId}`;
    const bodyObj = {
      "begin": begin,
      "end": end,
      "precedence": precedence
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const body = this._transformRequest(bodyObj);
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    };
    
    const response = await fetch(url, fetchOptions);
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${url}`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = url;
      error.method = 'PATCH';
      error.responseBody = errorBody;
      throw error;
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }
}

// Export for Node.js environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PlaidClient;
}

// Export for ES6 modules
if (typeof window !== 'undefined') {
  window.PlaidClient = PlaidClient;
}
