/**
 * plaid-api-v1 - Plaid's REST API
 * Version: v1.0
 * Generated on: Fri Jul 11 13:48:24 EDT 2025
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
    
    // Initialize batch state
    this.isBatching = false;
    this.batchOperations = [];
    
    // Initialize document version tracking
    this.documentVersions = new Map(); // Map of document-id -> version
    this.strictModeDocumentId = null;  // Document ID for strict mode
    
    // Initialize API bundles
    this.vocabLinks = {
      /**
       * Create a new vocab link (link between tokens and vocab item).
 * @param {string} vocabItem - Required. Vocabitem
 * @param {Array} tokens - Required. Tokens
 * @param {any} [metadata] - Optional. Metadata
       */
      create: this._vocabLinksCreate.bind(this),
      /**
       * Replace all metadata for a vocab link. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
 * @param {string} id - Id identifier
 * @param {any} body - Required. Body
       */
      setMetadata: this._vocabLinksSetMetadata.bind(this),
      /**
       * Remove all metadata from a vocab link.
 * @param {string} id - Id identifier
       */
      deleteMetadata: this._vocabLinksDeleteMetadata.bind(this),
      /**
       * Get a vocab link by ID
 * @param {string} id - Id identifier
 * @param {string} [asOf] - Optional asOf
       */
      get: this._vocabLinksGet.bind(this),
      /**
       * Delete a vocab link
 * @param {string} id - Id identifier
       */
      delete: this._vocabLinksDelete.bind(this)
    };
    this.vocabLayers = {
      /**
       * Get a vocab layer by ID
 * @param {string} id - Id identifier
 * @param {boolean} [includeItems] - Optional includeItems
 * @param {string} [asOf] - Optional asOf
       */
      get: this._vocabLayersGet.bind(this),
      /**
       * Delete a vocab layer.
 * @param {string} id - Id identifier
       */
      delete: this._vocabLayersDelete.bind(this),
      /**
       * Update a vocab layer's name.
 * @param {string} id - Id identifier
 * @param {string} name - Required. Name
       */
      update: this._vocabLayersUpdate.bind(this),
      /**
       * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
 * @param {string} id - Id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._vocabLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer.
 * @param {string} id - Id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._vocabLayersDeleteConfig.bind(this),
      /**
       * List all vocab layers accessible to user
 * @param {string} [asOf] - Optional asOf
       */
      list: this._vocabLayersList.bind(this),
      /**
       * Create a new vocab layer. Note: this also registers the user as a maintainer.
 * @param {string} name - Required. Name
       */
      create: this._vocabLayersCreate.bind(this),
      /**
       * Assign a user as a maintainer for this vocab layer.
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      addMaintainer: this._vocabLayersAddMaintainer.bind(this),
      /**
       * Remove a user's maintainer privileges for this vocab layer.
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      removeMaintainer: this._vocabLayersRemoveMaintainer.bind(this)
    };
    this.relations = {
      /**
       * Replace all metadata for a relation. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
 * @param {string} relationId - Relation-id identifier
 * @param {any} body - Required. Body
       */
      setMetadata: this._relationsSetMetadata.bind(this),
      /**
       * Remove all metadata from a relation.
 * @param {string} relationId - Relation-id identifier
       */
      deleteMetadata: this._relationsDeleteMetadata.bind(this),
      /**
       * Update the target span of a relation.
 * @param {string} relationId - Relation-id identifier
 * @param {string} spanId - Required. Spanid
       */
      setTarget: this._relationsSetTarget.bind(this),
      /**
       * Get a relation by ID.
 * @param {string} relationId - Relation-id identifier
 * @param {string} [asOf] - Optional asOf
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
      setSource: this._relationsSetSource.bind(this),
      /**
       * Create a new relation. A relation is a directed edge between two spans with a value, useful for expressing phenomena such as syntactic or semantic relations. A relation must at all times have both a valid source and target span. These spans must also belong to a single span layer which is linked to the relation's relation layer.

layerId: the relation layer
sourceId: the source span this relation originates from
targetId: the target span this relation goes to
<body>value</value>: the label for the relation
 * @param {string} layerId - Required. Layerid
 * @param {string} sourceId - Required. Sourceid
 * @param {string} targetId - Required. Targetid
 * @param {any} value - Required. Value
 * @param {any} [metadata] - Optional. Metadata
       */
      create: this._relationsCreate.bind(this),
      /**
       * Create multiple relations in a single operation. Provide an array of objects whose keysare:
relationLayerId, the relation's layer
source, the span id of the relation's source
target, the span id of the relation's target
value, the relation's value
metadata, an optional map of metadata
 * @param {Array} body - Required. Body
       */
      bulkCreate: this._relationsBulkCreate.bind(this),
      /**
       * Delete multiple relations in a single operation. Provide an array of IDs.
 * @param {Array} body - Required. Body
       */
      bulkDelete: this._relationsBulkDelete.bind(this)
    };
    this.spanLayers = {
      /**
       * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
 * @param {string} spanLayerId - Span-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._spanLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer.
 * @param {string} spanLayerId - Span-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._spanLayersDeleteConfig.bind(this),
      /**
       * Get a span layer by ID.
 * @param {string} spanLayerId - Span-layer-id identifier
 * @param {string} [asOf] - Optional asOf
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
      setTokens: this._spansSetTokens.bind(this),
      /**
       * Create a new span. A span holds a primary atomic value and optional metadata, and must at all times be associated with one or more tokens.

spanLayerId: the span's associated layer
tokens: a list of tokens associated with this span. Must contain at least one token. All tokens must belong to a single layer which is linked to the span layer indicated by spanLayerId.
value: the primary value of the span (must be string, number, boolean, or null).
metadata: optional key-value pairs for additional annotation data.
 * @param {string} spanLayerId - Required. Spanlayerid
 * @param {Array} tokens - Required. Tokens
 * @param {any} value - Required. Value
 * @param {any} [metadata] - Optional. Metadata
       */
      create: this._spansCreate.bind(this),
      /**
       * Get a span by ID.
 * @param {string} spanId - Span-id identifier
 * @param {string} [asOf] - Optional asOf
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
      update: this._spansUpdate.bind(this),
      /**
       * Create multiple spans in a single operation. Provide an array of objects whose keysare:
spanLayerId, the span's layer
tokens, the IDs of the span's constituent tokens
value, the relation's value
metadata, an optional map of metadata
 * @param {Array} body - Required. Body
       */
      bulkCreate: this._spansBulkCreate.bind(this),
      /**
       * Delete multiple spans in a single operation. Provide an array of IDs.
 * @param {Array} body - Required. Body
       */
      bulkDelete: this._spansBulkDelete.bind(this),
      /**
       * Replace all metadata for a span. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
 * @param {string} spanId - Span-id identifier
 * @param {any} body - Required. Body
       */
      setMetadata: this._spansSetMetadata.bind(this),
      /**
       * Remove all metadata from a span.
 * @param {string} spanId - Span-id identifier
       */
      deleteMetadata: this._spansDeleteMetadata.bind(this)
    };
    this.batch = {
      /**
       * Execute multiple API operations in a single request.
 * @param {Array} body - Required. Body
       */
      submit: this._batchSubmit.bind(this)
    };
    this.texts = {
      /**
       * Replace all metadata for a text. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
 * @param {string} textId - Text-id identifier
 * @param {any} body - Required. Body
       */
      setMetadata: this._textsSetMetadata.bind(this),
      /**
       * Remove all metadata from a text.
 * @param {string} textId - Text-id identifier
       */
      deleteMetadata: this._textsDeleteMetadata.bind(this),
      /**
       * Create a new text in a document's text layer. A text is simply a container for one long string in body for a given layer.

textLayerId: the text's associated layer.
documentId: the text's associated document.
body: the string which is the content of this text.
 * @param {string} textLayerId - Required. Textlayerid
 * @param {string} documentId - Required. Documentid
 * @param {string} body - Required. Body
 * @param {any} [metadata] - Optional. Metadata
       */
      create: this._textsCreate.bind(this),
      /**
       * Get a text.
 * @param {string} textId - Text-id identifier
 * @param {string} [asOf] - Optional asOf
       */
      get: this._textsGet.bind(this),
      /**
       * Delete a text and all dependent data.
 * @param {string} textId - Text-id identifier
       */
      delete: this._textsDelete.bind(this),
      /**
       * Update a text's body. A diff is computed between the new and old bodies, and a best effort is made to minimize Levenshtein distance between the two. Token indices are updated so that tokens remain intact. Tokens which fall within a range of deleted text are either shrunk appropriately if there is partial overlap or else deleted if there is whole overlap.
 * @param {string} textId - Text-id identifier
 * @param {string} body - Required. Body
       */
      update: this._textsUpdate.bind(this)
    };
    this.users = {
      /**
       * List all users
 * @param {string} [asOf] - Optional asOf
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
       * Get audit log for a user's actions
 * @param {string} userId - User-id identifier
 * @param {string} [startTime] - Optional startTime
 * @param {string} [endTime] - Optional endTime
 * @param {string} [asOf] - Optional asOf
       */
      audit: this._usersAudit.bind(this),
      /**
       * Get a user by ID
 * @param {string} id - Id identifier
 * @param {string} [asOf] - Optional asOf
       */
      get: this._usersGet.bind(this),
      /**
       * Delete a user
 * @param {string} id - Id identifier
       */
      delete: this._usersDelete.bind(this),
      /**
       * Modify a user. Admins may change the username, password, and admin status of any user. All other users may only modify their own username or password.
 * @param {string} id - Id identifier
 * @param {string} [password] - Optional. Password
 * @param {string} [username] - Optional. Username
 * @param {boolean} [isAdmin] - Optional. Isadmin
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
       * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
 * @param {string} tokenLayerId - Token-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._tokenLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer.
 * @param {string} tokenLayerId - Token-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._tokenLayersDeleteConfig.bind(this),
      /**
       * Get a token layer by ID.
 * @param {string} tokenLayerId - Token-layer-id identifier
 * @param {string} [asOf] - Optional asOf
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
       * Get information about a document lock
 * @param {string} documentId - Document-id identifier
 * @param {string} [asOf] - Optional asOf
       */
      checkLock: this._documentsCheckLock.bind(this),
      /**
       * Acquire or refresh a document lock
 * @param {string} documentId - Document-id identifier
       */
      acquireLock: this._documentsAcquireLock.bind(this),
      /**
       * Release a document lock
 * @param {string} documentId - Document-id identifier
       */
      releaseLock: this._documentsReleaseLock.bind(this),
      /**
       * Replace all metadata for a document. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
 * @param {string} documentId - Document-id identifier
 * @param {any} body - Required. Body
       */
      setMetadata: this._documentsSetMetadata.bind(this),
      /**
       * Remove all metadata from a document.
 * @param {string} documentId - Document-id identifier
       */
      deleteMetadata: this._documentsDeleteMetadata.bind(this),
      /**
       * Get audit log for a document
 * @param {string} documentId - Document-id identifier
 * @param {string} [startTime] - Optional startTime
 * @param {string} [endTime] - Optional endTime
 * @param {string} [asOf] - Optional asOf
       */
      audit: this._documentsAudit.bind(this),
      /**
       * Get a document. Set includeBody to true in order to include all data contained in the document.
 * @param {string} documentId - Document-id identifier
 * @param {boolean} [includeBody] - Optional includeBody
 * @param {string} [asOf] - Optional asOf
       */
      get: this._documentsGet.bind(this),
      /**
       * Delete a document and all data contained.
 * @param {string} documentId - Document-id identifier
       */
      delete: this._documentsDelete.bind(this),
      /**
       * Update a document. Supported keys:

name: update a document's name.
 * @param {string} documentId - Document-id identifier
 * @param {string} name - Required. Name
       */
      update: this._documentsUpdate.bind(this),
      /**
       * Create a new document in a project. Requires projectId and name.
 * @param {string} projectId - Required. Projectid
 * @param {string} name - Required. Name
 * @param {any} [metadata] - Optional. Metadata
       */
      create: this._documentsCreate.bind(this)
    };
    this.projects = {
      /**
       * Send a message to all clients that are listening to a project. Useful for e.g. telling an NLP service to perform some work.
 * @param {string} id - Id identifier
 * @param {any} body - Required. Body
       */
      sendMessage: this._projectsSendMessage.bind(this),
      /**
       * Set a user's access level to read and write for this project.
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      addWriter: this._projectsAddWriter.bind(this),
      /**
       * Remove a user's writer privileges for this project.
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      removeWriter: this._projectsRemoveWriter.bind(this),
      /**
       * Set a user's access level to read-only for this project.
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      addReader: this._projectsAddReader.bind(this),
      /**
       * Remove a user's reader privileges for this project.
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      removeReader: this._projectsRemoveReader.bind(this),
      /**
       * INTERNAL, do not use directly.
 * @param {string} id - Id identifier
 * @param {string} clientId - Required. Clientid
       */
      heartbeat: this._projectsHeartbeat.bind(this),
      /**
       * Listen to audit log events and messages for a project via Server-Sent Events
 * @param {string} id - The UUID of the project to listen to
 * @param {function} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop.
 * @returns {Object} SSE connection object with .close() and .getStats() methods
       */
      listen: this._projectsListen.bind(this),
      /**
       * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
 * @param {string} id - Id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._projectsSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer.
 * @param {string} id - Id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._projectsDeleteConfig.bind(this),
      /**
       * Assign a user as a maintainer for this project.
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      addMaintainer: this._projectsAddMaintainer.bind(this),
      /**
       * Remove a user's maintainer privileges for this project.
 * @param {string} id - Id identifier
 * @param {string} userId - User-id identifier
       */
      removeMaintainer: this._projectsRemoveMaintainer.bind(this),
      /**
       * Get audit log for a project
 * @param {string} projectId - Project-id identifier
 * @param {string} [startTime] - Optional startTime
 * @param {string} [endTime] - Optional endTime
 * @param {string} [asOf] - Optional asOf
       */
      audit: this._projectsAudit.bind(this),
      /**
       * Link a vocabulary to a project.
 * @param {string} id - Id identifier
 * @param {string} vocabId - Vocab-id identifier
       */
      linkVocab: this._projectsLinkVocab.bind(this),
      /**
       * Unlink a vocabulary to a project.
 * @param {string} id - Id identifier
 * @param {string} vocabId - Vocab-id identifier
       */
      unlinkVocab: this._projectsUnlinkVocab.bind(this),
      /**
       * Get a project by ID. If includeDocuments is true, also include document IDs and names.
 * @param {string} id - Id identifier
 * @param {boolean} [includeDocuments] - Optional includeDocuments
 * @param {string} [asOf] - Optional asOf
       */
      get: this._projectsGet.bind(this),
      /**
       * Delete a project.
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
 * @param {string} [asOf] - Optional asOf
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
       * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
 * @param {string} textLayerId - Text-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._textLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer.
 * @param {string} textLayerId - Text-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._textLayersDeleteConfig.bind(this),
      /**
       * Get a text layer by ID.
 * @param {string} textLayerId - Text-layer-id identifier
 * @param {string} [asOf] - Optional asOf
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
       * Authenticate with a userId and password and get a JWT token. The token should be included in request headers under "Authorization: Bearer ..." in order to prove successful authentication to the server.
 * @param {string} userId - Required. Userid
 * @param {string} password - Required. Password
       */
      create: this._loginCreate.bind(this)
    };
    this.vocabItems = {
      /**
       * Replace all metadata for a vocab item. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
 * @param {string} id - Id identifier
 * @param {any} body - Required. Body
       */
      setMetadata: this._vocabItemsSetMetadata.bind(this),
      /**
       * Remove all metadata from a vocab item.
 * @param {string} id - Id identifier
       */
      deleteMetadata: this._vocabItemsDeleteMetadata.bind(this),
      /**
       * Create a new vocab item
 * @param {string} vocabLayerId - Required. Vocablayerid
 * @param {string} form - Required. Form
 * @param {any} [metadata] - Optional. Metadata
       */
      create: this._vocabItemsCreate.bind(this),
      /**
       * Get a vocab item by ID
 * @param {string} id - Id identifier
 * @param {string} [asOf] - Optional asOf
       */
      get: this._vocabItemsGet.bind(this),
      /**
       * Delete a vocab item
 * @param {string} id - Id identifier
       */
      delete: this._vocabItemsDelete.bind(this),
      /**
       * Update a vocab item's form
 * @param {string} id - Id identifier
 * @param {string} form - Required. Form
       */
      update: this._vocabItemsUpdate.bind(this)
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
       * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
 * @param {string} relationLayerId - Relation-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
 * @param {any} configValue - Configuration value to set
       */
      setConfig: this._relationLayersSetConfig.bind(this),
      /**
       * Remove a configuration value for a layer.
 * @param {string} relationLayerId - Relation-layer-id identifier
 * @param {string} namespace - Namespace identifier
 * @param {string} configKey - Config-key identifier
       */
      deleteConfig: this._relationLayersDeleteConfig.bind(this),
      /**
       * Get a relation layer by ID.
 * @param {string} relationLayerId - Relation-layer-id identifier
 * @param {string} [asOf] - Optional asOf
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
       * Create a new token in a token layer. Tokens define text substrings usingbegin and end offsets in the text. Tokens may be zero-width, and they may overlap with each other. For tokens which share the same begin, precedence may be used to indicate a preferred linear ordering, with tokens with lower precedence occurring earlier.

tokenLayerId: the layer in which to insert this token.
text: the text in which this token is found.
begin: the inclusive character-based offset at which this token begins in the body of the text specified by text
end: the exclusive character-based offset at which this token ends in the body of the text specified by text
precedence: used for tokens with the same begin value in order to indicate their preferred linear order.
 * @param {string} tokenLayerId - Required. Tokenlayerid
 * @param {string} text - Required. Text
 * @param {number} begin - Required. Begin
 * @param {number} end - Required. End
 * @param {number} [precedence] - Optional. Precedence
 * @param {any} [metadata] - Optional. Metadata
       */
      create: this._tokensCreate.bind(this),
      /**
       * Get a token.
 * @param {string} tokenId - Token-id identifier
 * @param {string} [asOf] - Optional asOf
       */
      get: this._tokensGet.bind(this),
      /**
       * Delete a token and remove it from any spans. If this causes the span to have no remaining associated tokens, the span will also be deleted.
 * @param {string} tokenId - Token-id identifier
       */
      delete: this._tokensDelete.bind(this),
      /**
       * Update a token. Supported keys:

begin: start index of the token
end: end index of the token
precedence: ordering value for the token relative to other tokens with the same begin--lower means earlier
 * @param {string} tokenId - Token-id identifier
 * @param {number} [begin] - Optional. Begin
 * @param {number} [end] - Optional. End
 * @param {number} [precedence] - Optional. Precedence
       */
      update: this._tokensUpdate.bind(this),
      /**
       * Create multiple tokens in a single operation. Provide an array of objects whose keysare:
tokenLayerId, the token's layer
text, the ID of the token's text
begin, the character index at which the token begins (inclusive)
end, the character index at which the token ends (exclusive)
precedence, optional, an integer controlling which orders appear first in linear order when two or more tokens have the same begin
metadata, an optional map of metadata
 * @param {Array} body - Required. Body
       */
      bulkCreate: this._tokensBulkCreate.bind(this),
      /**
       * Delete multiple tokens in a single operation. Provide an array of IDs.
 * @param {Array} body - Required. Body
       */
      bulkDelete: this._tokensBulkDelete.bind(this),
      /**
       * Replace all metadata for a token. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
 * @param {string} tokenId - Token-id identifier
 * @param {any} body - Required. Body
       */
      setMetadata: this._tokensSetMetadata.bind(this),
      /**
       * Remove all metadata from a token.
 * @param {string} tokenId - Token-id identifier
       */
      deleteMetadata: this._tokensDeleteMetadata.bind(this)
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

  _extractDocumentVersions(responseHeaders) {
    // Extract and update document versions from response headers
    const docVersionsHeader = responseHeaders.get('X-Document-Versions');
    if (docVersionsHeader) {
      try {
        const versionsMap = JSON.parse(docVersionsHeader);
        if (typeof versionsMap === 'object' && versionsMap !== null) {
          // Update internal document versions map
          Object.entries(versionsMap).forEach(([docId, version]) => {
            this.documentVersions.set(docId, version);
          });
        }
      } catch (e) {
        // Ignore malformed header
      }
    }
  }

  _transformRequest(obj) {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(item => this._transformRequest(item));
    if (typeof obj !== 'object') return obj;
    
    const transformed = {};
    for (const [key, value] of Object.entries(obj)) {
      const newKey = this._transformKeyFromCamel(key);
      // Preserve metadata contents without transformation
      if (key === 'metadata' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        transformed[newKey] = value;
      } else {
        transformed[newKey] = this._transformRequest(value);
      }
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
      // Preserve metadata contents without transformation
      if (newKey === 'metadata' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        transformed[newKey] = value;
      } else {
        transformed[newKey] = this._transformResponse(value);
      }
    }
    return transformed;
  }


  /**
   * Enter strict mode for a specific document.
   * 
   * When in strict mode, write operations will automatically include 
   * document-version parameters to prevent concurrent modifications.
   * Operations on stale documents will fail with HTTP 409 errors.
   * 
   * @param {string} documentId - The ID of the document to track versions for
   */
  enterStrictMode(documentId) {
    this.strictModeDocumentId = documentId;
  }

  /**
   * Exit strict mode and stop tracking document versions for writes.
   */
  exitStrictMode() {
    this.strictModeDocumentId = null;
  }

  /**
   * Begin a batch of operations. All subsequent API calls will be queued instead of executed.
   * @returns {void}
   */
  beginBatch() {
    this.isBatching = true;
    this.batchOperations = [];
  }

  /**
   * Submit all queued batch operations as a single bulk request.
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
      let url = `${this.baseUrl}/api/v1/bulk`;
      const body = this.batchOperations.map(op => ({
        path: op.path,
        method: op.method.toUpperCase(),
        ...(op.body && { body: op.body })
      }));

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

      const results = await response.json();
      return results.map(result => this._transformResponse(result));
    } finally {
      this.isBatching = false;
      this.batchOperations = [];
    }
  }

  /**
   * Abort the current batch without executing any operations.
   * @returns {void}
   */
  abortBatch() {
    this.isBatching = false;
    this.batchOperations = [];
  }

  /**
   * Check if currently in batch mode.
   * @returns {boolean} True if batching is active
   */
  isBatchMode() {
    return this.isBatching;
  }
  /**
   * Create a new vocab link (link between tokens and vocab item).
   */
  async _vocabLinksCreate(vocabItem, tokens, metadata = undefined) {
    let url = `${this.baseUrl}/api/v1/vocab-links`;
    const bodyObj = {
      "vocab-item": vocabItem,
      "tokens": tokens,
      "metadata": metadata
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Replace all metadata for a vocab link. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
   */
  async _vocabLinksSetMetadata(id, body) {
    let url = `${this.baseUrl}/api/v1/vocab-links/${id}/metadata`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove all metadata from a vocab link.
   */
  async _vocabLinksDeleteMetadata(id) {
    let url = `${this.baseUrl}/api/v1/vocab-links/${id}/metadata`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a vocab link by ID
   */
  async _vocabLinksGet(id, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/vocab-links/${id}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a vocab link
   */
  async _vocabLinksDelete(id) {
    let url = `${this.baseUrl}/api/v1/vocab-links/${id}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a vocab layer by ID
   */
  async _vocabLayersGet(id, includeItems = undefined, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/vocab-layers/${id}`;
    const queryParams = new URLSearchParams();
    if (includeItems !== undefined && includeItems !== null) {
      queryParams.append('include-items', includeItems);
    }
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a vocab layer.
   */
  async _vocabLayersDelete(id) {
    let url = `${this.baseUrl}/api/v1/vocab-layers/${id}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a vocab layer's name.
   */
  async _vocabLayersUpdate(id, name) {
    let url = `${this.baseUrl}/api/v1/vocab-layers/${id}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
   */
  async _vocabLayersSetConfig(id, namespace, configKey, configValue) {
    let url = `${this.baseUrl}/api/v1/vocab-layers/${id}/config/${namespace}/${configKey}`;
    const requestBody = configValue;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer.
   */
  async _vocabLayersDeleteConfig(id, namespace, configKey) {
    let url = `${this.baseUrl}/api/v1/vocab-layers/${id}/config/${namespace}/${configKey}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * List all vocab layers accessible to user
   */
  async _vocabLayersList(asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/vocab-layers`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new vocab layer. Note: this also registers the user as a maintainer.
   */
  async _vocabLayersCreate(name) {
    let url = `${this.baseUrl}/api/v1/vocab-layers`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Assign a user as a maintainer for this vocab layer.
   */
  async _vocabLayersAddMaintainer(id, userId) {
    let url = `${this.baseUrl}/api/v1/vocab-layers/${id}/maintainers/${userId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a user's maintainer privileges for this vocab layer.
   */
  async _vocabLayersRemoveMaintainer(id, userId) {
    let url = `${this.baseUrl}/api/v1/vocab-layers/${id}/maintainers/${userId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Replace all metadata for a relation. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
   */
  async _relationsSetMetadata(relationId, body) {
    let url = `${this.baseUrl}/api/v1/relations/${relationId}/metadata`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove all metadata from a relation.
   */
  async _relationsDeleteMetadata(relationId) {
    let url = `${this.baseUrl}/api/v1/relations/${relationId}/metadata`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update the target span of a relation.
   */
  async _relationsSetTarget(relationId, spanId) {
    let url = `${this.baseUrl}/api/v1/relations/${relationId}/target`;
    const bodyObj = {
      "span-id": spanId
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _relationsGet(relationId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/relations/${relationId}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/relations/${relationId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/relations/${relationId}`;
    const bodyObj = {
      "value": value
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _relationsSetSource(relationId, spanId) {
    let url = `${this.baseUrl}/api/v1/relations/${relationId}/source`;
    const bodyObj = {
      "span-id": spanId
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new relation. A relation is a directed edge between two spans with a value, useful for expressing phenomena such as syntactic or semantic relations. A relation must at all times have both a valid source and target span. These spans must also belong to a single span layer which is linked to the relation's relation layer.

layerId: the relation layer
sourceId: the source span this relation originates from
targetId: the target span this relation goes to
<body>value</value>: the label for the relation
   */
  async _relationsCreate(layerId, sourceId, targetId, value, metadata = undefined) {
    let url = `${this.baseUrl}/api/v1/relations`;
    const bodyObj = {
      "layer-id": layerId,
      "source-id": sourceId,
      "target-id": targetId,
      "value": value,
      "metadata": metadata
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create multiple relations in a single operation. Provide an array of objects whose keysare:
relationLayerId, the relation's layer
source, the span id of the relation's source
target, the span id of the relation's target
value, the relation's value
metadata, an optional map of metadata
   */
  async _relationsBulkCreate(body) {
    let url = `${this.baseUrl}/api/v1/relations/bulk`;
    const requestBody = this._transformRequest(body);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete multiple relations in a single operation. Provide an array of IDs.
   */
  async _relationsBulkDelete(body) {
    let url = `${this.baseUrl}/api/v1/relations/bulk`;
    const requestBody = this._transformRequest(body);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
   */
  async _spanLayersSetConfig(spanLayerId, namespace, configKey, configValue) {
    let url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`;
    const requestBody = configValue;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer.
   */
  async _spanLayersDeleteConfig(spanLayerId, namespace, configKey) {
    let url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}/config/${namespace}/${configKey}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _spanLayersGet(spanLayerId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/span-layers`;
    const bodyObj = {
      "token-layer-id": tokenLayerId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/span-layers/${spanLayerId}/shift`;
    const bodyObj = {
      "direction": direction
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _spansSetTokens(spanId, tokens) {
    let url = `${this.baseUrl}/api/v1/spans/${spanId}/tokens`;
    const bodyObj = {
      "tokens": tokens
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new span. A span holds a primary atomic value and optional metadata, and must at all times be associated with one or more tokens.

spanLayerId: the span's associated layer
tokens: a list of tokens associated with this span. Must contain at least one token. All tokens must belong to a single layer which is linked to the span layer indicated by spanLayerId.
value: the primary value of the span (must be string, number, boolean, or null).
metadata: optional key-value pairs for additional annotation data.
   */
  async _spansCreate(spanLayerId, tokens, value, metadata = undefined) {
    let url = `${this.baseUrl}/api/v1/spans`;
    const bodyObj = {
      "span-layer-id": spanLayerId,
      "tokens": tokens,
      "value": value,
      "metadata": metadata
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _spansGet(spanId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/spans/${spanId}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/spans/${spanId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/spans/${spanId}`;
    const bodyObj = {
      "value": value
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create multiple spans in a single operation. Provide an array of objects whose keysare:
spanLayerId, the span's layer
tokens, the IDs of the span's constituent tokens
value, the relation's value
metadata, an optional map of metadata
   */
  async _spansBulkCreate(body) {
    let url = `${this.baseUrl}/api/v1/spans/bulk`;
    const requestBody = this._transformRequest(body);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete multiple spans in a single operation. Provide an array of IDs.
   */
  async _spansBulkDelete(body) {
    let url = `${this.baseUrl}/api/v1/spans/bulk`;
    const requestBody = this._transformRequest(body);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Replace all metadata for a span. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
   */
  async _spansSetMetadata(spanId, body) {
    let url = `${this.baseUrl}/api/v1/spans/${spanId}/metadata`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove all metadata from a span.
   */
  async _spansDeleteMetadata(spanId) {
    let url = `${this.baseUrl}/api/v1/spans/${spanId}/metadata`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Execute multiple API operations in a single request.
   */
  async _batchSubmit(body) {
    let url = `${this.baseUrl}/api/v1/batch`;
    const requestBody = this._transformRequest(body);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Replace all metadata for a text. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
   */
  async _textsSetMetadata(textId, body) {
    let url = `${this.baseUrl}/api/v1/texts/${textId}/metadata`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove all metadata from a text.
   */
  async _textsDeleteMetadata(textId) {
    let url = `${this.baseUrl}/api/v1/texts/${textId}/metadata`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new text in a document's text layer. A text is simply a container for one long string in body for a given layer.

textLayerId: the text's associated layer.
documentId: the text's associated document.
body: the string which is the content of this text.
   */
  async _textsCreate(textLayerId, documentId, body, metadata = undefined) {
    let url = `${this.baseUrl}/api/v1/texts`;
    const bodyObj = {
      "text-layer-id": textLayerId,
      "document-id": documentId,
      "body": body,
      "metadata": metadata
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a text.
   */
  async _textsGet(textId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/texts/${textId}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a text and all dependent data.
   */
  async _textsDelete(textId) {
    let url = `${this.baseUrl}/api/v1/texts/${textId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a text's body. A diff is computed between the new and old bodies, and a best effort is made to minimize Levenshtein distance between the two. Token indices are updated so that tokens remain intact. Tokens which fall within a range of deleted text are either shrunk appropriately if there is partial overlap or else deleted if there is whole overlap.
   */
  async _textsUpdate(textId, body) {
    let url = `${this.baseUrl}/api/v1/texts/${textId}`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _usersList(asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/users`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/users`;
    const bodyObj = {
      "username": username,
      "password": password,
      "is-admin": isAdmin
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get audit log for a user's actions
   */
  async _usersAudit(userId, startTime = undefined, endTime = undefined, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/users/${userId}/audit`;
    const queryParams = new URLSearchParams();
    if (startTime !== undefined && startTime !== null) {
      queryParams.append('start-time', startTime);
    }
    if (endTime !== undefined && endTime !== null) {
      queryParams.append('end-time', endTime);
    }
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _usersGet(id, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/users/${id}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/users/${id}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Modify a user. Admins may change the username, password, and admin status of any user. All other users may only modify their own username or password.
   */
  async _usersUpdate(id, password = undefined, username = undefined, isAdmin = undefined) {
    let url = `${this.baseUrl}/api/v1/users/${id}`;
    const bodyObj = {
      "password": password,
      "username": username,
      "is-admin": isAdmin
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}/shift`;
    const bodyObj = {
      "direction": direction
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/token-layers`;
    const bodyObj = {
      "text-layer-id": textLayerId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
   */
  async _tokenLayersSetConfig(tokenLayerId, namespace, configKey, configValue) {
    let url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`;
    const requestBody = configValue;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer.
   */
  async _tokenLayersDeleteConfig(tokenLayerId, namespace, configKey) {
    let url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}/config/${namespace}/${configKey}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _tokenLayersGet(tokenLayerId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/token-layers/${tokenLayerId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get information about a document lock
   */
  async _documentsCheckLock(documentId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}/lock`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Acquire or refresh a document lock
   */
  async _documentsAcquireLock(documentId) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}/lock`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Release a document lock
   */
  async _documentsReleaseLock(documentId) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}/lock`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Replace all metadata for a document. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
   */
  async _documentsSetMetadata(documentId, body) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}/metadata`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove all metadata from a document.
   */
  async _documentsDeleteMetadata(documentId) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}/metadata`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get audit log for a document
   */
  async _documentsAudit(documentId, startTime = undefined, endTime = undefined, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}/audit`;
    const queryParams = new URLSearchParams();
    if (startTime !== undefined && startTime !== null) {
      queryParams.append('start-time', startTime);
    }
    if (endTime !== undefined && endTime !== null) {
      queryParams.append('end-time', endTime);
    }
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a document. Set includeBody to true in order to include all data contained in the document.
   */
  async _documentsGet(documentId, includeBody = undefined, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}`;
    const queryParams = new URLSearchParams();
    if (includeBody !== undefined && includeBody !== null) {
      queryParams.append('include-body', includeBody);
    }
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a document and all data contained.
   */
  async _documentsDelete(documentId) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a document. Supported keys:

name: update a document's name.
   */
  async _documentsUpdate(documentId, name) {
    let url = `${this.baseUrl}/api/v1/documents/${documentId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new document in a project. Requires projectId and name.
   */
  async _documentsCreate(projectId, name, metadata = undefined) {
    let url = `${this.baseUrl}/api/v1/documents`;
    const bodyObj = {
      "project-id": projectId,
      "name": name,
      "metadata": metadata
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Send a message to all clients that are listening to a project. Useful for e.g. telling an NLP service to perform some work.
   */
  async _projectsSendMessage(id, body) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/message`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a user's access level to read and write for this project.
   */
  async _projectsAddWriter(id, userId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/writers/${userId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a user's writer privileges for this project.
   */
  async _projectsRemoveWriter(id, userId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/writers/${userId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a user's access level to read-only for this project.
   */
  async _projectsAddReader(id, userId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/readers/${userId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a user's reader privileges for this project.
   */
  async _projectsRemoveReader(id, userId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/readers/${userId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * INTERNAL, do not use directly.
   */
  async _projectsHeartbeat(id, clientId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/heartbeat`;
    const bodyObj = {
      "client-id": clientId
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Listen to audit log events and messages for a project via Server-Sent Events
   * @param {string} id - The UUID of the project to listen to
   * @param {function} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop.
   * @returns {Object} SSE connection object with .close() method and .getStats() method
   */
  _projectsListen(id, onEvent) {
    
    const startTime = Date.now();
    let isConnected = false;
    let isClosed = false;
    let clientId = null;
    let eventStats = { 'audit-log': 0, message: 0, heartbeat: 0, connected: 0, other: 0 };
    let abortController = new AbortController();
    
    // Capture client context for event handling
    const client = this;
    
    // Helper function to send heartbeat confirmation
    const sendHeartbeatConfirmation = async () => {
      if (!clientId || isClosed) return;
      
      try {
        const response = await fetch(`${this.baseUrl}/api/v1/projects/${id}/heartbeat`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ 'client-id': clientId }),
          signal: abortController.signal
        });
        
        if (!response.ok) {
          // Heartbeat confirmation failed
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          // Heartbeat confirmation error
        }
      }
    };
    
    // Create SSE-like object that behaves like EventSource but uses Fetch
    const sseConnection = {
      readyState: 0, // CONNECTING
      close: () => {
        if (!isClosed) {
          isClosed = true;
          isConnected = false;
          sseConnection.readyState = 2; // CLOSED
          abortController.abort();
        }
      },
      getStats: () => ({
        durationSeconds: (Date.now() - startTime) / 1000,
        isConnected,
        isClosed,
        clientId,
        events: { ...eventStats },
        readyState: sseConnection.readyState
      })
    };
    
    // Start the fetch streaming connection
    (async () => {
      try {
        let url = `${this.baseUrl}/api/v1/projects/${id}/listen`;
        
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache'
          },
          signal: abortController.signal
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        
        isConnected = true;
        sseConnection.readyState = 1; // OPEN
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
          const { done, value } = await reader.read();
          
          if (done || isClosed) {
            break;
          }
          
          // Decode chunk and add to buffer
          buffer += decoder.decode(value, { stream: true });
          
          // Process complete SSE messages
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer
          
          let eventType = '';
          let data = '';
          
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              data = line.slice(6);
            } else if (line === '' && eventType && data) {
              // Complete SSE message received
              try {
                // Track event stats
                eventStats[eventType] = (eventStats[eventType] || 0) + 1;
                
                if (eventType === 'connected') {
                  // Extract client ID from connection message
                  const parsedData = JSON.parse(data);
                  clientId = parsedData['client-id'] || parsedData.clientId;
                } else if (eventType === 'heartbeat') {
                  // Automatically respond to heartbeat with confirmation
                  sendHeartbeatConfirmation();
                } else {
                  // Pass audit-log, message, and other events to callback
                  const parsedData = JSON.parse(data);
                  const shouldStop = onEvent(eventType, client._transformResponse(parsedData));
                  if (shouldStop === true) {
                    // User callback requested to stop listening
                    sseConnection.close();
                    return;
                  }
                }
              } catch (e) {
                // Failed to parse event data
              }
              
              // Reset for next message
              eventType = '';
              data = '';
            }
          }
        }
        
      } catch (error) {
        // SSE connection error or abort
      } finally {
        isConnected = false;
        isClosed = true;
        sseConnection.readyState = 2; // CLOSED
      }
    })();
    
    return sseConnection;
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
   */
  async _projectsSetConfig(id, namespace, configKey, configValue) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/config/${namespace}/${configKey}`;
    const requestBody = configValue;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer.
   */
  async _projectsDeleteConfig(id, namespace, configKey) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/config/${namespace}/${configKey}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Assign a user as a maintainer for this project.
   */
  async _projectsAddMaintainer(id, userId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/maintainers/${userId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a user's maintainer privileges for this project.
   */
  async _projectsRemoveMaintainer(id, userId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/maintainers/${userId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get audit log for a project
   */
  async _projectsAudit(projectId, startTime = undefined, endTime = undefined, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/projects/${projectId}/audit`;
    const queryParams = new URLSearchParams();
    if (startTime !== undefined && startTime !== null) {
      queryParams.append('start-time', startTime);
    }
    if (endTime !== undefined && endTime !== null) {
      queryParams.append('end-time', endTime);
    }
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Link a vocabulary to a project.
   */
  async _projectsLinkVocab(id, vocabId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/vocabs/${vocabId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Unlink a vocabulary to a project.
   */
  async _projectsUnlinkVocab(id, vocabId) {
    let url = `${this.baseUrl}/api/v1/projects/${id}/vocabs/${vocabId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a project by ID. If includeDocuments is true, also include document IDs and names.
   */
  async _projectsGet(id, includeDocuments = undefined, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/projects/${id}`;
    const queryParams = new URLSearchParams();
    if (includeDocuments !== undefined && includeDocuments !== null) {
      queryParams.append('include-documents', includeDocuments);
    }
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a project.
   */
  async _projectsDelete(id) {
    let url = `${this.baseUrl}/api/v1/projects/${id}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/projects/${id}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _projectsList(asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/projects`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/projects`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
   */
  async _textLayersSetConfig(textLayerId, namespace, configKey, configValue) {
    let url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`;
    const requestBody = configValue;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer.
   */
  async _textLayersDeleteConfig(textLayerId, namespace, configKey) {
    let url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}/config/${namespace}/${configKey}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _textLayersGet(textLayerId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/text-layers/${textLayerId}/shift`;
    const bodyObj = {
      "direction": direction
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/text-layers`;
    const bodyObj = {
      "project-id": projectId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Authenticate with a userId and password and get a JWT token. The token should be included in request headers under "Authorization: Bearer ..." in order to prove successful authentication to the server.
   */
  async _loginCreate(userId, password) {
    let url = `${this.baseUrl}/api/v1/login`;
    const bodyObj = {
      "user-id": userId,
      "password": password
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Replace all metadata for a vocab item. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
   */
  async _vocabItemsSetMetadata(id, body) {
    let url = `${this.baseUrl}/api/v1/vocab-items/${id}/metadata`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove all metadata from a vocab item.
   */
  async _vocabItemsDeleteMetadata(id) {
    let url = `${this.baseUrl}/api/v1/vocab-items/${id}/metadata`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new vocab item
   */
  async _vocabItemsCreate(vocabLayerId, form, metadata = undefined) {
    let url = `${this.baseUrl}/api/v1/vocab-items`;
    const bodyObj = {
      "vocab-layer-id": vocabLayerId,
      "form": form,
      "metadata": metadata
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a vocab item by ID
   */
  async _vocabItemsGet(id, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/vocab-items/${id}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a vocab item
   */
  async _vocabItemsDelete(id) {
    let url = `${this.baseUrl}/api/v1/vocab-items/${id}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a vocab item's form
   */
  async _vocabItemsUpdate(id, form) {
    let url = `${this.baseUrl}/api/v1/vocab-items/${id}`;
    const bodyObj = {
      "form": form
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}/shift`;
    const bodyObj = {
      "direction": direction
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/relation-layers`;
    const bodyObj = {
      "span-layer-id": spanLayerId,
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Set a configuration value for a layer in a editor namespace. Intended for storing metadata about how the layer is intended to be used, e.g. for morpheme tokenization or sentence boundary marking.
   */
  async _relationLayersSetConfig(relationLayerId, namespace, configKey, configValue) {
    let url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`;
    const requestBody = configValue;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove a configuration value for a layer.
   */
  async _relationLayersDeleteConfig(relationLayerId, namespace, configKey) {
    let url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}/config/${namespace}/${configKey}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
  async _relationLayersGet(relationLayerId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
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
    let url = `${this.baseUrl}/api/v1/relation-layers/${relationLayerId}`;
    const bodyObj = {
      "name": name
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create a new token in a token layer. Tokens define text substrings usingbegin and end offsets in the text. Tokens may be zero-width, and they may overlap with each other. For tokens which share the same begin, precedence may be used to indicate a preferred linear ordering, with tokens with lower precedence occurring earlier.

tokenLayerId: the layer in which to insert this token.
text: the text in which this token is found.
begin: the inclusive character-based offset at which this token begins in the body of the text specified by text
end: the exclusive character-based offset at which this token ends in the body of the text specified by text
precedence: used for tokens with the same begin value in order to indicate their preferred linear order.
   */
  async _tokensCreate(tokenLayerId, text, begin, end, precedence = undefined, metadata = undefined) {
    let url = `${this.baseUrl}/api/v1/tokens`;
    const bodyObj = {
      "token-layer-id": tokenLayerId,
      "text": text,
      "begin": begin,
      "end": end,
      "precedence": precedence,
      "metadata": metadata
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Get a token.
   */
  async _tokensGet(tokenId, asOf = undefined) {
    let url = `${this.baseUrl}/api/v1/tokens/${tokenId}`;
    const queryParams = new URLSearchParams();
    if (asOf !== undefined && asOf !== null) {
      queryParams.append('as-of', asOf);
    }
    const queryString = queryParams.toString();
    const finalUrl = queryString ? `${url}?${queryString}` : url;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'GET') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: finalUrl.replace(this.baseUrl, ''),
        method: 'GET'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete a token and remove it from any spans. If this causes the span to have no remaining associated tokens, the span will also be deleted.
   */
  async _tokensDelete(tokenId) {
    let url = `${this.baseUrl}/api/v1/tokens/${tokenId}`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Update a token. Supported keys:

begin: start index of the token
end: end index of the token
precedence: ordering value for the token relative to other tokens with the same begin--lower means earlier
   */
  async _tokensUpdate(tokenId, begin = undefined, end = undefined, precedence = undefined) {
    let url = `${this.baseUrl}/api/v1/tokens/${tokenId}`;
    const bodyObj = {
      "begin": begin,
      "end": end,
      "precedence": precedence
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PATCH') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PATCH'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Create multiple tokens in a single operation. Provide an array of objects whose keysare:
tokenLayerId, the token's layer
text, the ID of the token's text
begin, the character index at which the token begins (inclusive)
end, the character index at which the token ends (exclusive)
precedence, optional, an integer controlling which orders appear first in linear order when two or more tokens have the same begin
metadata, an optional map of metadata
   */
  async _tokensBulkCreate(body) {
    let url = `${this.baseUrl}/api/v1/tokens/bulk`;
    const requestBody = this._transformRequest(body);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'POST') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'POST'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Delete multiple tokens in a single operation. Provide an array of IDs.
   */
  async _tokensBulkDelete(body) {
    let url = `${this.baseUrl}/api/v1/tokens/bulk`;
    const requestBody = this._transformRequest(body);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Replace all metadata for a token. The entire metadata map is replaced - existing metadata keys not included in the request will be removed.
   */
  async _tokensSetMetadata(tokenId, body) {
    let url = `${this.baseUrl}/api/v1/tokens/${tokenId}/metadata`;
    const bodyObj = {
      "body": body
    };
    // Filter out undefined optional parameters
    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);
    const requestBody = this._transformRequest(bodyObj);
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'PUT') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'PUT'
        , body: requestBody
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
    const fetchOptions = {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Remove all metadata from a token.
   */
  async _tokensDeleteMetadata(tokenId) {
    let url = `${this.baseUrl}/api/v1/tokens/${tokenId}/metadata`;
    
    // Add document-version parameter in strict mode for non-GET requests
    if (this.strictModeDocumentId && 'GET' !== 'DELETE') {
      const docId = this.strictModeDocumentId;
      if (this.documentVersions.has(docId)) {
        const docVersion = this.documentVersions.get(docId);
        const separator = url.includes('?') ? '&' : '?';
        url += `${separator}document-version=${encodeURIComponent(docVersion)}`;
      }
    }
    
    // Check if we're in batch mode
    if (this.isBatching) {
      const operation = {
        path: url.replace(this.baseUrl, ''),
        method: 'DELETE'
      };
      this.batchOperations.push(operation);
      return { batched: true }; // Return placeholder
    }
    
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
    
    // Extract document versions from response headers
    this._extractDocumentVersions(response.headers);
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      return this._transformResponse(data);
    }
    return await response.text();
  }

  /**
   * Authenticate and return a new client instance with token
   * @param {string} baseUrl - The base URL for the API
   * @param {string} userId - User ID for authentication
   * @param {string} password - Password for authentication
   * @returns {Promise<PlaidClient>} - Authenticated client instance
   */
  static async login(baseUrl, userId, password) {
    const response = await fetch(`${baseUrl}/api/v1/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ "user-id": userId, password })
    });
    
    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unable to read error response');
      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${baseUrl}/api/v1/login`);
      error.status = response.status;
      error.statusText = response.statusText;
      error.url = `${baseUrl}/api/v1/login`;
      error.method = 'POST';
      error.responseBody = errorBody;
      throw error;
    }
    
    const data = await response.json();
    const token = data.token || '';
    return new PlaidClient(baseUrl, token);
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
