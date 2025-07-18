(ns plaid.javascript
  (:require [clojure.string :as str]
            [camel-snake-kebab.core :as csk]
            [plaid.common :as common]))

(defn- kebab->camel
  "Convert kebab-case to camelCase"
  [s]
  (csk/->camelCase s))

(defn- transform-key-name
  "Transform a key to camelCase using shared function"
  [k]
  (common/transform-key-name k :camelCase))

(defn- transform-parameter-references
  "Transform parameter references using shared function"
  [summary-text]
  (common/transform-parameter-references summary-text :camelCase))

(defn- generate-batch-methods
  "Generate JavaScript batch control methods"
  []
  "  /**
   * Begin a batch of operations. All subsequent API calls will be queued instead of executed.
   * @returns {void}
   */
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

      try {
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
          let errorData;
          try {
            errorData = await response.json();
          } catch (parseError) {
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
        return results.map(result => this._transformResponse(result));
      } catch (error) {
        // Check if it's already our formatted HTTP error
        if (error.status) {
          throw error; // Re-throw formatted HTTP error
        }
        // Handle network-level fetch errors (CORS, DNS, timeout, etc.)
        const fetchError = new Error(`Network error: ${error.message} at ${url}`);
        fetchError.status = 0; // Indicate network error
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
  }")

(defn- generate-key-transformation-functions
  "Generate JavaScript functions for transforming keys between formats"
  []
  "  // Key transformation utilities
  _transformKeyToCamel(key) {
    // Convert kebab-case and namespaced keys to camelCase
    // 'layer-id' -> 'layerId'
    // 'relation/layer' -> 'layer' (namespace ignored)
    // 'project/name' -> 'name' (namespace ignored)
    return key.replace(/^[^/]+\\//, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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
        // Log malformed header issues
        console.warn('Failed to parse document versions header:', e);
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

")

(defn- generate-method-params-from-operation
  "Generate JavaScript method parameters using ordered params from AST"
  [operation]
  (let [{:keys [path-params required-body-params optional-body-params
                regular-query-params as-of-param]} (:ordered-params operation)
        {:keys [is-config?]} (:special-endpoints operation)
        http-method (:http-method operation)]

    ;; Special handling for SSE listen method
    (if (= (:method-name operation) "listen")
      ;; SSE listen method has project ID and onEvent callback
      (str (kebab->camel (first path-params)) ", onEvent")
      ;; Regular method parameter generation
      (let [;; Path parameters
            path-param-names (map kebab->camel path-params)

            ;; Config value parameter for config PUT endpoints
            config-params (when (and is-config? (= http-method :put))
                            ["configValue"])

            ;; Body parameters (skip if config endpoint)
            body-param-names (when-not (and is-config? (= http-method :put))
                               (concat
                                (map #(transform-key-name (:name %))
                                     required-body-params)
                                (map #(str (transform-key-name (:name %)) " = undefined")
                                     optional-body-params)))

            ;; Query parameters (exclude document-version)
            filtered-query-params (filter #(not= (:name %) "document-version") regular-query-params)
            query-param-names (map (fn [param]
                                     (let [param-name (transform-key-name (:name param))]
                                       (if (:required? param)
                                         param-name
                                         (str param-name " = undefined"))))
                                   filtered-query-params)

            ;; asOf parameter (only for GET requests)
            as-of-param-name (when (and as-of-param (= http-method :get))
                               [(str (transform-key-name (:name as-of-param)) " = undefined")])

            ;; Combine all parameters
            all-params (concat path-param-names config-params body-param-names
                               query-param-names as-of-param-name)]

        (str/join ", " (filter some? all-params))))))

(defn- generate-url-construction
  "Generate JavaScript code to construct the URL with path parameters"
  [path path-params query-params http-method]
  (let [base-url (if (empty? path-params)
                   (str "let url = `${this.baseUrl}" path "`;")
                   (let [js-path (reduce (fn [p param]
                                           (str/replace p (str "{" param "}")
                                                        (str "${" (kebab->camel param) "}")))
                                         path
                                         path-params)]
                     (str "let url = `${this.baseUrl}" js-path "`;")))
        ;; Generate query parameter construction using individual parameters
        query-construction (when (seq query-params)
                             (let [query-checks (map (fn [param]
                                                       (let [param-name (transform-key-name (:name param))
                                                             original-name (:name param)]
                                                         (str "    if (" param-name " !== undefined && " param-name " !== null) {\n"
                                                              "      queryParams.append('" original-name "', " param-name ");\n"
                                                              "    }")))
                                                     query-params)]
                               (str "\n    const queryParams = new URLSearchParams();\n"
                                    (str/join "\n" query-checks) "\n"
                                    "    const queryString = queryParams.toString();\n"
                                    "    let finalUrl = queryString ? `${url}?${queryString}` : url;")))]
    (str base-url query-construction)))

(defn- generate-body-construction
  "Generate JavaScript code to construct request body from individual parameters"
  [operation body-params]
  (when (seq body-params)
    (let [{:keys [method-name]} operation
          ;; Check if method name contains metadata/Metadata or config/Config
          has-metadata-in-name? (or (str/includes? method-name "metadata")
                                    (str/includes? method-name "Metadata"))
          has-config-in-name? (or (str/includes? method-name "config")
                                  (str/includes? method-name "Config"))
          skip-body-nesting? (or has-metadata-in-name? has-config-in-name?)]
      (cond
        ;; Special case: single array parameter that represents the entire body
        (and (= (count body-params) 1)
             (= (:type (first body-params)) "array")
             (= (:original-name (first body-params)) "body"))
        (let [param-name (transform-key-name (:name (first body-params)))]
          (if skip-body-nesting?
            (str "const requestBody = " param-name ";")
            (str "const requestBody = this._transformRequest(" param-name ");")))

        (and (= method-name "send-message") (not skip-body-nesting?))
        (str "const requestBody = { body };")

        ;; Special case for metadata/config functions with send-message
        (and (= method-name "send-message") skip-body-nesting?)
        (str "const requestBody = body;")

        ;; Handle multipart/form-data with file uploads
        (some :is-file? body-params)
        (let [form-data-lines (map (fn [{:keys [name original-name is-file?]}]
                                     (let [js-name (transform-key-name name)]
                                       (str "    formData.append('" original-name "', " js-name ");")))
                                   body-params)]
          (str "const formData = new FormData();\n"
               (str/join "\n" form-data-lines)
               "\n    const requestBody = formData;"))

        ;; Special case: single parameter that should be the entire body for metadata/config
        (and skip-body-nesting?
             (= (count body-params) 1)
             (seq body-params))
        (let [js-name (transform-key-name (:name (first body-params)))]
          (str "const requestBody = " js-name ";"))

        ;; Regular case: object parameters
        :else
        (let [all-params (map (fn [{:keys [name original-name]}]
                                (let [js-name (if (= original-name "body")
                                                (transform-key-name "body")
                                                (transform-key-name name))]
                                  (str "      \"" original-name "\": " js-name)))
                              body-params)]
          (str "const bodyObj = {\n"
               (str/join ",\n" all-params)
               "\n    };\n"
               "    // Filter out undefined optional parameters\n"
               "    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);\n"
               (if skip-body-nesting?
                 "    const requestBody = bodyObj;"
                 "    const requestBody = this._transformRequest(bodyObj);")))))))

(defn- generate-fetch-options
  "Generate JavaScript fetch options"
  [method has-body? is-login? is-multipart?]
  (let [auth-header (if is-login?
                      ""
                      "        'Authorization': `Bearer ${this.token}`,\n")]
    (cond
      ;; Multipart requests (FormData)
      (and has-body? is-multipart?)
      (str "const fetchOptions = {\n"
           "      method: '" (str/upper-case (name method)) "',\n"
           "      headers: {\n"
           auth-header
           "        // Content-Type will be set automatically by browser for FormData\n"
           "        ...(this.agentName && { 'X-Agent-Name': this.agentName })\n"
           "      },\n"
           "      body: requestBody\n"
           "    };")

      ;; JSON requests
      has-body?
      (str "const fetchOptions = {\n"
           "      method: '" (str/upper-case (name method)) "',\n"
           "      headers: {\n"
           auth-header
           "        'Content-Type': 'application/json',\n"
           "        ...(this.agentName && { 'X-Agent-Name': this.agentName })\n"
           "      },\n"
           "      body: JSON.stringify(requestBody)\n"
           "    };")

      ;; No body
      :else
      (str "const fetchOptions = {\n"
           "      method: '" (str/upper-case (name method)) "',\n"
           "      headers: {\n"
           auth-header
           "        'Content-Type': 'application/json',\n"
           "        ...(this.agentName && { 'X-Agent-Name': this.agentName })\n"
           "      }\n"
           "    };"))))

(defn- generate-sse-listen-method
  "Generate JavaScript Fetch-based SSE listen method (Python-like connection cleanup)"
  [operation]
  (let [{:keys [bundle-name method-name path path-params summary]} operation
        ;; Extract project ID from path parameters
        project-id-param (first path-params) ; Should be "id" for /projects/{id}/listen
        transformed-method-name (common/transform-method-name method-name :camelCase)
        private-method-name (str "_" bundle-name (csk/->PascalCase transformed-method-name))
        formatted-summary (transform-parameter-references (or summary ""))

        ;; Generate URL construction
        js-path (str/replace path (str "{" project-id-param "}") (str "${" (kebab->camel project-id-param) "}"))]

    (str "  /**\n"
         "   * " formatted-summary "\n"
         "   * @param {string} " (kebab->camel project-id-param) " - The UUID of the project to listen to\n"
         "   * @param {function} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop.\n"
         "   * @returns {Object} SSE connection object with .close() method and .getStats() method\n"
         "   */\n"
         "  " private-method-name "(" (kebab->camel project-id-param) ", onEvent) {\n"
         "    \n"
         "    const startTime = Date.now();\n"
         "    let isConnected = false;\n"
         "    let isClosed = false;\n"
         "    let clientId = null;\n"
         "    let eventStats = { 'audit-log': 0, message: 0, heartbeat: 0, connected: 0, other: 0 };\n"
         "    let abortController = new AbortController();\n"
         "    \n"
         "    // Capture client context for event handling\n"
         "    const client = this;\n"
         "    \n"
         "    // Helper function to send heartbeat confirmation\n"
         "    const sendHeartbeatConfirmation = async () => {\n"
         "      if (!clientId || isClosed) return;\n"
         "      \n"
         "      try {\n"
         "        const response = await fetch(`${this.baseUrl}/api/v1/projects/${" (kebab->camel project-id-param) "}/heartbeat`, {\n"
         "          method: 'POST',\n"
         "          headers: {\n"
         "            'Authorization': `Bearer ${this.token}`,\n"
         "            'Content-Type': 'application/json'\n"
         "          },\n"
         "          body: JSON.stringify({ 'client-id': clientId }),\n"
         "          signal: abortController.signal\n"
         "        });\n"
         "        \n"
         "        if (!response.ok) {\n"
         "          // Heartbeat confirmation failed\n"
         "        }\n"
         "      } catch (error) {\n"
         "        if (error.name !== 'AbortError') {\n"
         "          // Heartbeat confirmation error\n"
         "        }\n"
         "      }\n"
         "    };\n"
         "    \n"
         "    // Create SSE-like object that behaves like EventSource but uses Fetch\n"
         "    const sseConnection = {\n"
         "      readyState: 0, // CONNECTING\n"
         "      close: () => {\n"
         "        if (!isClosed) {\n"
         "          isClosed = true;\n"
         "          isConnected = false;\n"
         "          sseConnection.readyState = 2; // CLOSED\n"
         "          abortController.abort();\n"
         "        }\n"
         "      },\n"
         "      getStats: () => ({\n"
         "        durationSeconds: (Date.now() - startTime) / 1000,\n"
         "        isConnected,\n"
         "        isClosed,\n"
         "        clientId,\n"
         "        events: { ...eventStats },\n"
         "        readyState: sseConnection.readyState\n"
         "      })\n"
         "    };\n"
         "    \n"
         "    // Start the fetch streaming connection\n"
         "    (async () => {\n"
         "      try {\n"
         "        let url = `${this.baseUrl}" js-path "`;\n"
         "        \n"
         "        const response = await fetch(url, {\n"
         "          method: 'GET',\n"
         "          headers: {\n"
         "            'Authorization': `Bearer ${this.token}`,\n"
         "            'Accept': 'text/event-stream',\n"
         "            'Cache-Control': 'no-cache',\n"
         "            ...(this.agentName && { 'X-Agent-Name': this.agentName })\n"
         "          },\n"
         "          signal: abortController.signal\n"
         "        });\n"
         "        \n"
         "        if (!response.ok) {\n"
         "          throw new Error(`HTTP ${response.status} ${response.statusText}`);\n"
         "        }\n"
         "        \n"
         "        isConnected = true;\n"
         "        sseConnection.readyState = 1; // OPEN\n"
         "        \n"
         "        const reader = response.body.getReader();\n"
         "        const decoder = new TextDecoder();\n"
         "        let buffer = '';\n"
         "        \n"
         "        while (true) {\n"
         "          const { done, value } = await reader.read();\n"
         "          \n"
         "          if (done || isClosed) {\n"
         "            break;\n"
         "          }\n"
         "          \n"
         "          // Decode chunk and add to buffer\n"
         "          buffer += decoder.decode(value, { stream: true });\n"
         "          \n"
         "          // Process complete SSE messages\n"
         "          const lines = buffer.split('\\n');\n"
         "          buffer = lines.pop() || ''; // Keep incomplete line in buffer\n"
         "          \n"
         "          let eventType = '';\n"
         "          let data = '';\n"
         "          \n"
         "          for (const line of lines) {\n"
         "            if (line.startsWith('event: ')) {\n"
         "              eventType = line.slice(7).trim();\n"
         "            } else if (line.startsWith('data: ')) {\n"
         "              data = line.slice(6);\n"
         "            } else if (line === '' && eventType && data) {\n"
         "              // Complete SSE message received\n"
         "              try {\n"
         "                // Track event stats\n"
         "                eventStats[eventType] = (eventStats[eventType] || 0) + 1;\n"
         "                \n"
         "                if (eventType === 'connected') {\n"
         "                  // Extract client ID from connection message\n"
         "                  const parsedData = JSON.parse(data);\n"
         "                  clientId = parsedData['client-id'] || parsedData.clientId;\n"
         "                } else if (eventType === 'heartbeat') {\n"
         "                  // Automatically respond to heartbeat with confirmation\n"
         "                  sendHeartbeatConfirmation();\n"
         "                } else {\n"
         "                  // Pass audit-log, message, and other events to callback\n"
         "                  const parsedData = JSON.parse(data);\n"
         "                  const shouldStop = onEvent(eventType, client._transformResponse(parsedData));\n"
         "                  if (shouldStop === true) {\n"
         "                    // User callback requested to stop listening\n"
         "                    sseConnection.close();\n"
         "                    return;\n"
         "                  }\n"
         "                }\n"
         "              } catch (e) {\n"
         "                // Log failed event data parsing\n"
         "                console.warn('Failed to parse SSE event data:', e);\n"
         "              }\n"
         "              \n"
         "              // Reset for next message\n"
         "              eventType = '';\n"
         "              data = '';\n"
         "            }\n"
         "          }\n"
         "        }\n"
         "        \n"
         "      } catch (error) {\n"
         "        // Log SSE connection error or abort\n"
         "        console.warn('SSE connection error:', error);\n"
         "      } finally {\n"
         "        isConnected = false;\n"
         "        isClosed = true;\n"
         "        sseConnection.readyState = 2; // CLOSED\n"
         "      }\n"
         "    })();\n"
         "    \n"
         "    return sseConnection;\n"
         "  }\n")))

(defn- generate-private-method-from-ast
  "Generate a private JavaScript method from AST operation"
  [operation]
  (let [{:keys [bundle-name method-name path http-method summary ordered-params special-endpoints]} operation
        {:keys [path-params required-body-params optional-body-params
                regular-query-params as-of-param]} ordered-params
        {:keys [is-config? is-login?]} special-endpoints]

    ;; Check if this is an SSE listen endpoint
    (if (= method-name "listen")
      (generate-sse-listen-method operation)
      ;; Regular method generation continues below
      (let [;; Check if there's a request body
            has-body? (or (seq required-body-params)
                          (seq optional-body-params)
                          (and is-config? (= http-method :put)))

            ;; Check if method name contains metadata/Metadata or config/Config
            has-metadata-in-name? (or (str/includes? method-name "metadata")
                                      (str/includes? method-name "Metadata"))
            has-config-in-name? (or (str/includes? method-name "config")
                                    (str/includes? method-name "Config"))
            skip-transformation? (or has-metadata-in-name? has-config-in-name?)

            ;; Generate method parameters
            method-params (generate-method-params-from-operation operation)

            ;; Filter out document-version from query params for URL construction
            filtered-query-params (filter #(not= (:name %) "document-version") regular-query-params)
            all-filtered-params (concat filtered-query-params (when as-of-param [as-of-param]))

            ;; Generate URL construction
            url-construction (generate-url-construction path path-params
                                                        all-filtered-params
                                                        http-method)

            ;; Generate body construction
            body-params (concat required-body-params optional-body-params)
            body-construction (cond
                                (and is-config? (= http-method :put))
                                "const requestBody = configValue;"

                                (seq body-params)
                                (generate-body-construction operation body-params)

                                :else nil)

            ;; Generate fetch options
            is-multipart? (some :is-file? body-params)
            fetch-options (generate-fetch-options http-method has-body? is-login? is-multipart?)

            ;; Format summary
            formatted-summary (transform-parameter-references (or summary ""))

            ;; Private method name (transform method-name if it comes from x-client-method)
            transformed-method-name (common/transform-method-name method-name :camelCase)
            private-method-name (str "_" bundle-name (csk/->PascalCase transformed-method-name))

            ;; Determine URL variable name
            url-var (if (seq all-filtered-params) "finalUrl" "url")

            ;; Transform response logic
            transform-response-code (if skip-transformation?
                                      "        return data;\n"
                                      "        return this._transformResponse(data);\n")]

        (str "  /**\n"
             "   * " formatted-summary "\n"
             "   */\n"
             "  async " private-method-name "(" method-params ") {\n"
             "    " url-construction "\n"
             (when body-construction (str "    " body-construction "\n"))
             "    \n"
             "    // Add document-version parameter in strict mode for non-GET requests\n"
             "    if (this.strictModeDocumentId && 'GET' !== '" (str/upper-case (name http-method)) "') {\n"
             "      const docId = this.strictModeDocumentId;\n"
             "      if (this.documentVersions.has(docId)) {\n"
             "        const docVersion = this.documentVersions.get(docId);\n"
             "        const separator = " url-var ".includes('?') ? '&' : '?';\n"
             "        " url-var " += `${separator}document-version=${encodeURIComponent(docVersion)}`;\n"
             "      }\n"
             "    }\n"
             "    \n"
             "    // Check if we're in batch mode\n"
             "    if (this.isBatching) {\n"
             (if (:is-non-batchable? special-endpoints)
               (str "      throw new Error('This endpoint cannot be used in batch mode: " path "');\n")
               (str "      const operation = {\n"
                    "        path: " url-var ".replace(this.baseUrl, ''),\n"
                    "        method: '" (str/upper-case (name http-method)) "'\n"
                    (when has-body? "        , body: requestBody\n")
                    "      };\n"
                    "      this.batchOperations.push(operation);\n"
                    "      return { batched: true }; // Return placeholder\n"))
             "    }\n"
             "    \n"
             "    " fetch-options "\n"
             "    \n"
             "    try {\n"
             "      const response = await fetch(" url-var ", fetchOptions);\n"
             "      if (!response.ok) {\n"
             "        let errorData;\n"
             "        try {\n"
             "          errorData = await response.json();\n"
             "        } catch (parseError) {\n"
             "          errorData = { message: await response.text().catch(() => 'Unable to read error response') };\n"
             "        }\n"
             "        \n"
             "        const serverMessage = errorData?.error || errorData?.message || response.statusText;\n"
             "        const error = new Error(`HTTP ${response.status} ${serverMessage} at ${" url-var "}`);\n"
             "        error.status = response.status;\n"
             "        error.statusText = response.statusText;\n"
             "        error.url = " url-var ";\n"
             "        error.method = '" (str/upper-case (name http-method)) "';\n"
             "        error.responseData = errorData;\n"
             "        throw error;\n"
             "      }\n"
             "      \n"
             "      // Extract document versions from response headers\n"
             "      this._extractDocumentVersions(response.headers);\n"
             "      \n"
             (if (and (:is-binary-response? special-endpoints) (= http-method :get))
               "      // Return raw binary content for media downloads\n      return await response.arrayBuffer();\n"
               (str "      const contentType = response.headers.get('content-type');\n"
                    "      if (contentType && contentType.includes('application/json')) {\n"
                    "        const data = await response.json();\n"
                    transform-response-code
                    "      }\n"
                    "      return await response.text();\n"))
             "    } catch (error) {\n"
             "      // Check if it's already our formatted HTTP error\n"
             "      if (error.status) {\n"
             "        throw error; // Re-throw formatted HTTP error\n"
             "      }\n"
             "      // Handle network-level fetch errors (CORS, DNS, timeout, etc.)\n"
             "      const fetchError = new Error(`Network error: ${error.message} at ${" url-var "}`);\n"
             "      fetchError.status = 0; // Indicate network error\n"
             "      fetchError.url = " url-var ";\n"
             "      fetchError.method = '" (str/upper-case (name http-method)) "';\n"
             "      fetchError.originalError = error;\n"
             "      throw fetchError;\n"
             "    }\n"
             "  }\n")))))

(defn- generate-messages-methods
  "Generate the JavaScript messages bundle methods for service coordination"
  []
  (str "  // Message format utilities\n"
       "  _generateRequestId() {\n"
       "    return 'req_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();\n"
       "  }\n"
       "\n"
       "  _createServiceMessage(type, data = {}) {\n"
       "    return {\n"
       "      type,\n"
       "      timestamp: new Date().toISOString(),\n"
       "      ...data\n"
       "    };\n"
       "  }\n"
       "\n"
       "  _isServiceMessage(data) {\n"
       "    return data && data.type && data.timestamp;\n"
       "  }\n"
       "\n"
       "  // Service discovery implementation\n"
       "  _messagesDiscoverServices(projectId, timeout = 3000) {\n"
       "    return new Promise((resolve, reject) => {\n"
       "      const requestId = this._generateRequestId();\n"
       "      const discoveredServices = [];\n"
       "      let connection = null;\n"
       "      \n"
       "      const timer = setTimeout(() => {\n"
       "        if (connection) connection.close();\n"
       "        resolve(discoveredServices);\n"
       "      }, timeout);\n"
       "      \n"
       "      try {\n"
       "        connection = this._messagesListen(projectId, (eventType, eventData) => {\n"
       "          if (eventType === 'message' && this._isServiceMessage(eventData.data)) {\n"
       "            const message = eventData.data;\n"
       "            \n"
       "            if (message.type === 'service_registration' && message.requestId === requestId) {\n"
       "              discoveredServices.push({\n"
       "                serviceId: message.serviceId,\n"
       "                serviceName: message.serviceName,\n"
       "                description: message.description,\n"
       "                timestamp: message.timestamp\n"
       "              });\n"
       "            }\n"
       "          }\n"
       "        });\n"
       "        \n"
       "        // Send discovery request\n"
       "        const discoveryMessage = this._createServiceMessage('service_discovery', { requestId });\n"
       "        try {\n"
       "          this._messagesSendMessage(projectId, discoveryMessage);\n"
       "        } catch (error) {\n"
       "          clearTimeout(timer);\n"
       "          if (connection) connection.close();\n"
       "          reject(new Error(`Failed to send discovery message: ${error.message}`));\n"
       "          return;\n"
       "        }\n"
       "        \n"
       "      } catch (error) {\n"
       "        clearTimeout(timer);\n"
       "        if (connection) connection.close();\n"
       "        reject(new Error(`Cannot establish SSE connection: ${error.message}`));\n"
       "      }\n"
       "    });\n"
       "  }\n"
       "\n"
       "  // Service registration implementation\n"
       "  _messagesServe(projectId, serviceInfo, onServiceRequest) {\n"
       "    const { serviceId, serviceName, description } = serviceInfo;\n"
       "    let connection = null;\n"
       "    let isRunning = true;\n"
       "    \n"
       "    const serviceRegistration = {\n"
       "      stop: () => {\n"
       "        isRunning = false;\n"
       "        if (connection) connection.close();\n"
       "      },\n"
       "      isRunning: () => isRunning,\n"
       "      serviceInfo: { serviceId, serviceName, description }\n"
       "    };\n"
       "    \n"
       "    try {\n"
       "      connection = this._messagesListen(projectId, (eventType, eventData) => {\n"
       "        if (!isRunning) return true; // Stop listening\n"
       "        \n"
       "        if (eventType === 'message' && this._isServiceMessage(eventData.data)) {\n"
       "          const message = eventData.data;\n"
       "          \n"
       "          if (message.type === 'service_discovery') {\n"
       "            // Respond to service discovery\n"
       "            const registrationMessage = this._createServiceMessage('service_registration', {\n"
       "              requestId: message.requestId,\n"
       "              serviceId,\n"
       "              serviceName,\n"
       "              description\n"
       "            });\n"
       "            try {\n"
       "              this._messagesSendMessage(projectId, registrationMessage);\n"
       "            } catch (error) {\n"
       "              // Log send failures during discovery\n"
       "              console.warn('Failed to send discovery response:', error);\n"
       "            }\n"
       "          } else if (message.type === 'service_request' && message.serviceId === serviceId) {\n"
       "            // Handle service request\n"
       "            try {\n"
       "              // Send acknowledgment\n"
       "              const ackMessage = this._createServiceMessage('service_response', {\n"
       "                requestId: message.requestId,\n"
       "                status: 'received'\n"
       "              });\n"
       "              try {\n"
       "                this._messagesSendMessage(projectId, ackMessage);\n"
       "              } catch (error) {\n"
       "                // Continue even if ack fails\n"
       "              }\n"
       "              \n"
       "              // Create response helper\n"
       "              const responseHelper = {\n"
       "                progress: (percent, message) => {\n"
       "                  const progressMessage = this._createServiceMessage('service_response', {\n"
       "                    requestId: message.requestId,\n"
       "                    status: 'progress',\n"
       "                    progress: { percent, message }\n"
       "                  });\n"
       "                  try {\n"
       "                    this._messagesSendMessage(projectId, progressMessage);\n"
       "                  } catch (error) {\n"
       "                    // Log send failures for progress updates\n"
       "                    console.warn('Failed to send progress update:', error);\n"
       "                  }\n"
       "                },\n"
       "                complete: (data) => {\n"
       "                  const completionMessage = this._createServiceMessage('service_response', {\n"
       "                    requestId: message.requestId,\n"
       "                    status: 'completed',\n"
       "                    data\n"
       "                  });\n"
       "                  try {\n"
       "                    this._messagesSendMessage(projectId, completionMessage);\n"
       "                  } catch (error) {\n"
       "                    // Log send failures for completion\n"
       "                    console.warn('Failed to send completion message:', error);\n"
       "                  }\n"
       "                },\n"
       "                error: (error) => {\n"
       "                  const errorMessage = this._createServiceMessage('service_response', {\n"
       "                    requestId: message.requestId,\n"
       "                    status: 'error',\n"
       "                    data: { error: error.message || error }\n"
       "                  });\n"
       "                  try {\n"
       "                    this._messagesSendMessage(projectId, errorMessage);\n"
       "                  } catch (error) {\n"
       "                    // Log send failures for errors\n"
       "                    console.warn('Failed to send error message:', error);\n"
       "                  }\n"
       "                }\n"
       "              };\n"
       "              \n"
       "              // Call user handler\n"
       "              try {\n"
       "                onServiceRequest(message.data, responseHelper);\n"
       "              } catch (error) {\n"
       "                responseHelper.error(error.message || error);\n"
       "              }\n"
       "              \n"
       "            } catch (error) {\n"
       "              // Send error response\n"
       "              const errorMessage = this._createServiceMessage('service_response', {\n"
       "                requestId: message.requestId,\n"
       "                status: 'error',\n"
       "                data: { error: error.message || error }\n"
       "              });\n"
       "              try {\n"
       "                this._messagesSendMessage(projectId, errorMessage);\n"
       "              } catch (sendError) {\n"
       "                // Log errors when sending error responses\n"
       "                console.warn('Failed to send error response:', sendError);\n"
       "              }\n"
       "            }\n"
       "          }\n"
       "        }\n"
       "      });\n"
       "      \n"
       "    } catch (error) {\n"
       "      throw new Error(`Failed to start service: ${error.message}`);\n"
       "    }\n"
       "    \n"
       "    return serviceRegistration;\n"
       "  }\n"
       "\n"
       "  // Service request implementation\n"
       "  _messagesRequestService(projectId, serviceId, data, timeout = 10000) {\n"
       "    return new Promise((resolve, reject) => {\n"
       "      const requestId = this._generateRequestId();\n"
       "      let connection = null;\n"
       "      let isResolved = false;\n"
       "      \n"
       "      const timer = setTimeout(() => {\n"
       "        if (!isResolved) {\n"
       "          isResolved = true;\n"
       "          if (connection) connection.close();\n"
       "          reject(new Error(`Service request timed out after ${timeout}ms`));\n"
       "        }\n"
       "      }, timeout);\n"
       "      \n"
       "      try {\n"
       "        connection = this._messagesListen(projectId, (eventType, eventData) => {\n"
       "          if (eventType === 'message' && this._isServiceMessage(eventData.data)) {\n"
       "            const message = eventData.data;\n"
       "            \n"
       "            if (message.type === 'service_response' && message.requestId === requestId) {\n"
       "              if (message.status === 'completed') {\n"
       "                if (!isResolved) {\n"
       "                  isResolved = true;\n"
       "                  clearTimeout(timer);\n"
       "                  connection.close();\n"
       "                  resolve(message.data);\n"
       "                }\n"
       "              } else if (message.status === 'error') {\n"
       "                if (!isResolved) {\n"
       "                  isResolved = true;\n"
       "                  clearTimeout(timer);\n"
       "                  connection.close();\n"
       "                  reject(new Error(message.data?.error || 'Service request failed'));\n"
       "                }\n"
       "              }\n"
       "              // Ignore 'received' and 'progress' status messages for now\n"
       "            }\n"
       "          }\n"
       "        });\n"
       "        \n"
       "        // Send service request\n"
       "        const requestMessage = this._createServiceMessage('service_request', {\n"
       "          requestId,\n"
       "          serviceId,\n"
       "          data\n"
       "        });\n"
       "        try {\n"
       "          this._messagesSendMessage(projectId, requestMessage);\n"
       "        } catch (error) {\n"
       "          if (!isResolved) {\n"
       "            isResolved = true;\n"
       "            clearTimeout(timer);\n"
       "            if (connection) connection.close();\n"
       "            reject(new Error(`Failed to send service request: ${error.message}`));\n"
       "          }\n"
       "        }\n"
       "        \n"
       "      } catch (error) {\n"
       "        if (!isResolved) {\n"
       "          isResolved = true;\n"
       "          clearTimeout(timer);\n"
       "          if (connection) connection.close();\n"
       "          reject(new Error(`Cannot establish SSE connection: ${error.message}`));\n"
       "        }\n"
       "      }\n"
       "    });\n"
       "  }\n"))

(defn- generate-bundle-methods
  "Generate all private methods for the PlaidClient class"
  [bundles]
  (let [regular-methods (->> bundles
                             (mapcat (fn [[bundle-name operations]]
                                       (map generate-private-method-from-ast operations))))

        ;; Add messages bundle methods
        messages-methods (generate-messages-methods)]

    (str (str/join "\n" regular-methods) "\n\n" messages-methods)))

(defn- openapi-type-to-ts
  "Convert OpenAPI type to TypeScript type"
  [schema]
  (cond
    (nil? schema) "any"
    (string? schema) schema
    :else
    (let [type (get schema "type")
          format (get schema "format")]
      (case type
        "string" (if (= format "binary") "File" "string")
        "integer" "number"
        "number" "number"
        "boolean" "boolean"
        "array" (str (openapi-type-to-ts (get schema "items")) "[]")
        "object" "any" ; Could be more specific with properties
        "any"))))

(defn- generate-ts-method-signature
  "Generate TypeScript method signature for an operation"
  [operation]
  (let [{:keys [method-name ordered-params path-params special-endpoints http-method]} operation
        transformed-method-name (common/transform-method-name method-name :camelCase)
        {:keys [required-body-params optional-body-params
                regular-query-params as-of-param]} ordered-params
        {:keys [is-config?]} special-endpoints]

    ;; Special handling for SSE listen method
    (if (= method-name "listen")
      (let [path-param-str (str/join ", " (map #(str (kebab->camel %) ": string") path-params))]
        (str transformed-method-name "(" path-param-str ", onEvent: (eventType: string, data: any) => void): { close(): void; getStats(): any; readyState: number; };"))
      ;; Regular method generation
      (let [;; Generate parameter list with types
            ts-params (concat
                       ;; Path parameters
                       (map (fn [param]
                              (str (kebab->camel param) ": string"))
                            path-params)

                       ;; Config value parameter
                       (when (and is-config? (= http-method :put))
                         ["configValue: any"])

                       ;; Body parameters (unless config endpoint)
                       (when-not (and is-config? (= http-method :put))
                         (concat
                          (map (fn [{:keys [name original-name type is-file?]}]
                                 (let [ts-name (transform-key-name name)
                                       ts-type (if is-file?
                                                 "File"
                                                 (case type
                                                   "string" "string"
                                                   "integer" "number"
                                                   "boolean" "boolean"
                                                   "array" "any[]"
                                                   "any"))]
                                   (str ts-name ": " ts-type)))
                               required-body-params)
                          (map (fn [{:keys [name original-name type is-file?]}]
                                 (let [ts-name (transform-key-name name)
                                       ts-type (if is-file?
                                                 "File"
                                                 (case type
                                                   "string" "string"
                                                   "integer" "number"
                                                   "boolean" "boolean"
                                                   "array" "any[]"
                                                   "any"))]
                                   (str ts-name "?: " ts-type)))
                               optional-body-params)))

                       ;; Query parameters (exclude document-version)
                       (let [filtered-query-params (filter #(not= (:name %) "document-version") regular-query-params)]
                         (map (fn [param]
                                (let [param-name (transform-key-name (:name param))
                                      param-type (openapi-type-to-ts (:schema param))
                                      optional-marker (if (:required? param) "" "?")]
                                  (str param-name optional-marker ": " param-type)))
                              filtered-query-params))

                       ;; asOf parameter at the end (only for GET requests)
                       (when (and as-of-param (= http-method :get))
                         [(str (transform-key-name (:name as-of-param)) "?: "
                               (openapi-type-to-ts (:schema as-of-param)))]))

            params-str (str/join ", " ts-params)
            return-type "Promise<any>"] ; Could be more specific based on response schema

        (str transformed-method-name "(" params-str "): " return-type ";")))))

(defn- generate-jsdoc-params
  "Generate JSDoc parameter documentation from AST operation"
  [operation]
  (let [{:keys [method-name path-params ordered-params special-endpoints]} operation
        {:keys [required-body-params optional-body-params
                regular-query-params as-of-param]} ordered-params
        {:keys [is-config?]} special-endpoints
        ;; Filter out document-version from query params
        filtered-query-params (filter #(not= (:name %) "document-version") regular-query-params)
        all-query-params (concat filtered-query-params (when as-of-param [as-of-param]))]

    ;; Special handling for SSE listen method
    (if (= method-name "listen")
      (concat
        ;; Path parameters
       (map (fn [param]
              (str " * @param {string} " (kebab->camel param) " - The UUID of the project to listen to"))
            path-params)
        ;; Single callback parameter that receives all events
       [" * @param {function} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop."
        " * @returns {Object} SSE connection object with .close() and .getStats() methods"])
      ;; Regular method parameters
      (concat
        ;; Path parameters
       (map (fn [param]
              (str " * @param {string} " (kebab->camel param) " - " (str/capitalize param) " identifier"))
            path-params)

        ;; Config value parameter
       (when (and is-config? (= (:http-method operation) :put))
         [" * @param {any} configValue - Configuration value to set"])

        ;; Body parameters (unless config endpoint)
       (when-not (and is-config? (= (:http-method operation) :put))
         (concat
          (map (fn [{:keys [name original-name type required?]}]
                 (let [js-name (transform-key-name name)
                       js-type (case type
                                 "string" "string"
                                 "integer" "number"
                                 "boolean" "boolean"
                                 "array" "Array"
                                 "any")]
                   (str " * @param {" js-type "} " js-name " - Required. " (str/capitalize js-name))))
               required-body-params)
          (map (fn [{:keys [name original-name type]}]
                 (let [js-name (transform-key-name name)
                       js-type (case type
                                 "string" "string"
                                 "integer" "number"
                                 "boolean" "boolean"
                                 "array" "Array"
                                 "any")]
                   (str " * @param {" js-type "} [" js-name "] - Optional. " (str/capitalize js-name))))
               optional-body-params)))

        ;; Query parameters (excluding document-version)
       (map (fn [param]
              (let [param-name (transform-key-name (:name param))
                    param-type (case (get-in param [:schema "type"])
                                 "string" "string"
                                 "integer" "number"
                                 "boolean" "boolean"
                                 "string")
                    required? (:required? param)]
                (str " * @param {" param-type "} "
                     (if required? param-name (str "[" param-name "]"))
                     " - " (or (:description param) (str (if required? "Required" "Optional") " " param-name)))))
            all-query-params)))))

(defn- generate-ts-bundle-interface
  "Generate TypeScript interface for a bundle"
  [bundle-name operations]
  (let [methods (->> operations
                     (map (fn [operation]
                            (str "  " (generate-ts-method-signature operation))))
                     (str/join "\n"))]
    (str "interface " (csk/->PascalCase bundle-name) "Bundle {\n" methods "\n}")))

(defn- generate-ts-definitions
  "Generate complete TypeScript definitions for the client"
  [bundles]
  (let [;; Add service coordination interfaces at the top
        service-interfaces (str "interface ServiceInfo {\n"
                                "  serviceId: string;\n"
                                "  serviceName: string;\n"
                                "  description: string;\n"
                                "}\n\n"
                                "interface DiscoveredService {\n"
                                "  serviceId: string;\n"
                                "  serviceName: string;\n"
                                "  description: string;\n"
                                "  timestamp: string;\n"
                                "}\n\n"
                                "interface ServiceRegistration {\n"
                                "  stop(): void;\n"
                                "  isRunning(): boolean;\n"
                                "  serviceInfo: ServiceInfo;\n"
                                "}\n\n"
                                "interface ResponseHelper {\n"
                                "  progress(percent: number, message: string): void;\n"
                                "  complete(data: any): void;\n"
                                "  error(error: string | Error): void;\n"
                                "}\n\n")

        bundle-interfaces (->> bundles
                               (map (fn [[bundle-name operations]]
                                      (if (= bundle-name "messages")
                                        ;; Special handling for messages bundle with service coordination
                                        (str "interface MessagesBundle {\n"
                                             "  sendMessage(id: string, body: any): Promise<any>;\n"
                                             "  heartbeat(id: string, clientId: string): Promise<any>;\n"
                                             "  listen(id: string, onEvent: (eventType: string, data: any) => void): { close(): void; getStats(): any; readyState: number; };\n"
                                             "  discoverServices(projectId: string, timeout?: number): Promise<DiscoveredService[]>;\n"
                                             "  serve(projectId: string, serviceInfo: ServiceInfo, onServiceRequest: (data: any, responseHelper: ResponseHelper) => void): ServiceRegistration;\n"
                                             "  requestService(projectId: string, serviceId: string, data: any, timeout?: number): Promise<any>;\n"
                                             "}")
                                        ;; Regular bundle generation
                                        (generate-ts-bundle-interface bundle-name operations))))
                               (str/join "\n\n"))
        main-interface (->> bundles
                            (map (fn [[bundle-name _]]
                                   (str "  " bundle-name ": " (csk/->PascalCase bundle-name) "Bundle;")))
                            (str/join "\n"))]
    (str service-interfaces
         bundle-interfaces "\n\n"
         "declare class PlaidClient {\n"
         "  constructor(baseUrl: string, token: string);\n"
         "  static login(baseUrl: string, userId: string, password: string): Promise<PlaidClient>;\n"
         "  \n"
         "  // Batch control methods\n"
         "  beginBatch(): void;\n"
         "  submitBatch(): Promise<any[]>;\n"
         "  abortBatch(): void;\n"
         "  isBatchMode(): boolean;\n"
         "  \n"
         "  // Strict mode methods\n"
         "  enterStrictMode(documentId: string): void;\n"
         "  exitStrictMode(): void;\n"
         "  \n"
         "  // User agent methods\n"
         "  setAgentName(agentName: string): void;\n"
         "  \n"
         main-interface "\n"
         "}\n\n"
         "declare const client: PlaidClient;\n")))

(defn- generate-messages-bundle-initialization
  "Generate the JavaScript messages bundle initialization code"
  []
  (str "    this.messages = {\n"
       "      /**\n"
       "       * Listen for project events including service coordination messages\n"
       "       * @param {string} projectId - The UUID of the project to listen to\n"
       "       * @param {function} onEvent - Callback function that receives (eventType, data). If it returns true, listening will stop.\n"
       "       * @returns {Object} SSE connection object with .close() and .getStats() methods\n"
       "       */\n"
       "      listen: this._messagesListen.bind(this),\n"
       "      \n"
       "      /**\n"
       "       * Send a message to project listeners\n"
       "       * @param {string} projectId - The UUID of the project to send to\n"
       "       * @param {any} data - The message data to send\n"
       "       * @returns {Promise<any>} Response from the send operation\n"
       "       */\n"
       "      sendMessage: this._messagesSendMessage.bind(this),\n"
       "      \n"
       "      /**\n"
       "       * Discover available services in a project\n"
       "       * @param {string} projectId - The UUID of the project to query\n"
       "       * @param {number} timeout - Timeout in milliseconds (default: 3000)\n"
       "       * @returns {Promise<Array>} Array of discovered service information\n"
       "       */\n"
       "      discoverServices: this._messagesDiscoverServices.bind(this),\n"
       "      \n"
       "      /**\n"
       "       * Register as a service and handle incoming requests\n"
       "       * @param {string} projectId - The UUID of the project to serve\n"
       "       * @param {Object} serviceInfo - Service information {serviceId, serviceName, description}\n"
       "       * @param {function} onServiceRequest - Callback to handle service requests\n"
       "       * @returns {Object} Service registration object with .stop() method\n"
       "       */\n"
       "      serve: this._messagesServe.bind(this),\n"
       "      \n"
       "      /**\n"
       "       * Request a service to perform work\n"
       "       * @param {string} projectId - The UUID of the project\n"
       "       * @param {string} serviceId - The ID of the service to request\n"
       "       * @param {any} data - The request data\n"
       "       * @param {number} timeout - Timeout in milliseconds (default: 10000)\n"
       "       * @returns {Promise<any>} Service response\n"
       "       */\n"
       "      requestService: this._messagesRequestService.bind(this)\n"
       "    };"))

(defn- generate-bundle-initialization
  "Generate bundle initialization code for the constructor"
  [bundles]
  (let [regular-bundles (->> bundles
                             (filter #(not= (first %) "messages"))
                             (map (fn [[bundle-name operations]]
                                    (let [methods (->> operations
                                                       (map (fn [operation]
                                                              (let [{:keys [method-name bundle-name summary path]} operation
                                                                    transformed-method-name (common/transform-method-name method-name :camelCase)
                                                                    private-method-name (str "_" bundle-name (csk/->PascalCase transformed-method-name))
                                                                    formatted-summary (transform-parameter-references (or summary ""))
                                                                    jsdoc-params (generate-jsdoc-params operation)
                                                                    jsdoc-comment (when (or formatted-summary (seq jsdoc-params))
                                                                                    (str "      /**\n"
                                                                                         (when formatted-summary (str "       * " formatted-summary "\n"))
                                                                                         (str/join "\n" jsdoc-params)
                                                                                         (when (seq jsdoc-params) "\n")
                                                                                         "       */\n"))]
                                                                (str jsdoc-comment
                                                                     "      " transformed-method-name ": this." private-method-name ".bind(this)"))))
                                                       (str/join ",\n"))]
                                      (str "    this." bundle-name " = {\n" methods "\n    };"))))
                             (str/join "\n"))

        ;; Add messages bundle with service coordination methods
        messages-bundle (generate-messages-bundle-initialization)]

    (str regular-bundles "\n" messages-bundle)))

(defn generate-js-client
  "Generate the complete JavaScript client class"
  [ast]
  (let [{:keys [info bundles]} ast
        {:keys [title version description]} info
        bundle-initialization (generate-bundle-initialization bundles)
        private-methods (generate-bundle-methods bundles)
        batch-methods (generate-batch-methods)
        transformation-functions (generate-key-transformation-functions)]

    (str "/**\n"
         " * " title " - " description "\n"
         " * Version: " version "\n"
         " * Generated on: " (java.util.Date.) "\n"
         " */\n"
         "\n"
         "class PlaidClient {\n"
         "  /**\n"
         "   * Create a new PlaidClient instance\n"
         "   * @param {string} baseUrl - The base URL for the API\n"
         "   * @param {string} token - The authentication token\n"
         "   */\n"
         "  constructor(baseUrl, token) {\n"
         "    this.baseUrl = baseUrl.replace(/\\/$/, ''); // Remove trailing slash\n"
         "    this.token = token;\n"
         "    this.agentName = null; // User agent name for audit logging\n"
         "    \n"
         "    // Initialize batch state\n"
         "    this.isBatching = false;\n"
         "    this.batchOperations = [];\n"
         "    \n"
         "    // Initialize document version tracking\n"
         "    this.documentVersions = new Map(); // Map of document-id -> version\n"
         "    this.strictModeDocumentId = null;  // Document ID for strict mode\n"
         "    \n"
         "    // Initialize API bundles\n"
         bundle-initialization "\n"
         "  }\n"
         "\n"
         transformation-functions
         "\n"
         "  /**\n"
         "   * Enter strict mode for a specific document.\n"
         "   * \n"
         "   * When in strict mode, write operations will automatically include \n"
         "   * document-version parameters to prevent concurrent modifications.\n"
         "   * Operations on stale documents will fail with HTTP 409 errors.\n"
         "   * \n"
         "   * @param {string} documentId - The ID of the document to track versions for\n"
         "   */\n"
         "  enterStrictMode(documentId) {\n"
         "    this.strictModeDocumentId = documentId;\n"
         "  }\n"
         "\n"
         "  /**\n"
         "   * Exit strict mode and stop tracking document versions for writes.\n"
         "   */\n"
         "  exitStrictMode() {\n"
         "    this.strictModeDocumentId = null;\n"
         "  }\n"
         "\n"
         "  /**\n"
         "   * Set the user agent name for audit logging.\n"
         "   * \n"
         "   * When set, the client will include an X-Agent-Name header in all requests\n"
         "   * to identify non-human clients in the audit log.\n"
         "   * \n"
         "   * @param {string} agentName - Name to identify this client in audit logs\n"
         "   */\n"
         "  setAgentName(agentName) {\n"
         "    this.agentName = agentName;\n"
         "  }\n"
         "\n"
         batch-methods
         "\n"
         private-methods
         "\n"
         "  /**\n"
         "   * Authenticate and return a new client instance with token\n"
         "   * @param {string} baseUrl - The base URL for the API\n"
         "   * @param {string} userId - User ID for authentication\n"
         "   * @param {string} password - Password for authentication\n"
         "   * @returns {Promise<PlaidClient>} - Authenticated client instance\n"
         "   */\n"
         "  static async login(baseUrl, userId, password) {\n"
         "    try {\n"
         "      const response = await fetch(`${baseUrl}/api/v1/login`, {\n"
         "        method: 'POST',\n"
         "        headers: {\n"
         "          'Content-Type': 'application/json'\n"
         "        },\n"
         "        body: JSON.stringify({ \"user-id\": userId, password })\n"
         "      });\n"
         "      \n"
         "      if (!response.ok) {\n"
         "        let errorData;\n"
         "        try {\n"
         "          errorData = await response.json();\n"
         "        } catch (parseError) {\n"
         "          errorData = { message: await response.text().catch(() => 'Unable to read error response') };\n"
         "        }\n"
         "        \n"
         "        const serverMessage = errorData?.error || errorData?.message || response.statusText;\n"
         "        const error = new Error(`HTTP ${response.status} ${serverMessage} at ${baseUrl}/api/v1/login`);\n"
         "        error.status = response.status;\n"
         "        error.statusText = response.statusText;\n"
         "        error.url = `${baseUrl}/api/v1/login`;\n"
         "        error.method = 'POST';\n"
         "        error.responseData = errorData;\n"
         "        throw error;\n"
         "      }\n"
         "      \n"
         "      const data = await response.json();\n"
         "      const token = data.token || '';\n"
         "      return new PlaidClient(baseUrl, token);\n"
         "    } catch (error) {\n"
         "      // Check if it's already our formatted HTTP error\n"
         "      if (error.status) {\n"
         "        throw error; // Re-throw formatted HTTP error\n"
         "      }\n"
         "      // Handle network-level fetch errors (CORS, DNS, timeout, etc.)\n"
         "      const fetchError = new Error(`Network error: ${error.message} at ${baseUrl}/api/v1/login`);\n"
         "      fetchError.status = 0; // Indicate network error\n"
         "      fetchError.url = `${baseUrl}/api/v1/login`;\n"
         "      fetchError.method = 'POST';\n"
         "      fetchError.originalError = error;\n"
         "      throw fetchError;\n"
         "    }\n"
         "  }\n"
         "}\n"
         "\n"
         "// Export for Node.js environments\n"
         "if (typeof module !== 'undefined' && module.exports) {\n"
         "  module.exports = PlaidClient;\n"
         "}\n"
         "\n"
         "// Export for ES6 modules\n"
         "if (typeof window !== 'undefined') {\n"
         "  window.PlaidClient = PlaidClient;\n"
         "}\n")))

(defn generate-javascript-client
  "Generate a JavaScript client from an OpenAPI AST and write it to files.
  
  This function creates a complete JavaScript client library with the following features:
  - Promise-based HTTP methods for all API endpoints
  - Automatic parameter transformation (kebab-case to camelCase)
  - Structured service coordination system for inter-service communication
  - Batch operations support for efficient bulk API calls
  - Document version tracking for optimistic concurrency control
  - Comprehensive error handling with custom PlaidAPIError exceptions
  - TypeScript definitions for full type safety and IDE support
  
  Args:
    ast: OpenAPI AST containing parsed API specification with bundled operations
    output-file: Path where the generated JavaScript client will be written
    
  Generated files:
    - .js file: Complete JavaScript client implementation
    - .d.ts file: TypeScript definitions for type safety
    
  Generated client includes:
    - Resource classes for each API bundle (projects, documents, tokens, etc.)
    - MessagesBundle for service coordination and real-time messaging
    - PlaidClient main class with configuration and batch management
    - Authentication methods (login/loginAsync)
    - Key transformation utilities for API compatibility
    - Document version extraction for concurrent modification detection"
  [ast output-file]
  (let [js-client (generate-js-client ast)
        ts-definitions (generate-ts-definitions (:bundles ast))
        ts-output-file (str/replace output-file #"\.js$" ".d.ts")]
    (spit output-file js-client)
    (spit ts-output-file ts-definitions)
    (println (str "✅ JavaScript client generated successfully: " output-file))
    (println (str "✅ TypeScript definitions generated: " ts-output-file))
    (println (str "📊 Generated "
                  (count (re-seq #"async \w+\(" js-client))
                  " API methods"))))