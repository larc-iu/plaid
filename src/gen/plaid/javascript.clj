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

(defn- generate-batch-builder-class
  "Generate JavaScript BatchBuilder class"
  []
  "  /**
   * BatchBuilder class for building and executing batch operations
   */
  class BatchBuilder {
    constructor(client) {
      this.client = client;
      this.operations = [];
    }

    /**
     * Add an operation to the batch
     * @param {Function} method - The client method to call
     * @param {...any} args - Arguments for the method
     * @returns {BatchBuilder} - Returns this for chaining
     */
    add(method, ...args) {
      // Extract the method metadata to build the operation
      const methodInfo = this._extractMethodInfo(method, args);
      this.operations.push(methodInfo);
      return this;
    }

    /**
     * Execute all operations in the batch
     * @returns {Promise<Array>} - Array of results corresponding to each operation
     */
    async execute() {
      if (this.operations.length === 0) {
        return [];
      }

      const url = `${this.client.baseUrl}/api/v1/bulk`;
      const body = this.operations.map(op => ({
        path: op.path,
        method: op.method.toUpperCase(),
        ...(op.body && { body: op.body })
      }));

      const fetchOptions = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.client.token}`,
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
      return results.map(result => this.client._transformResponse(result));
    }

    /**
     * Extract method information from a bound method and its arguments
     * @private
     */
    _extractMethodInfo(method, args) {
      // Find the method in the client bundles
      for (const [bundleName, bundle] of Object.entries(this.client)) {
        if (typeof bundle === 'object' && bundle !== null) {
          for (const [methodName, boundMethod] of Object.entries(bundle)) {
            if (boundMethod === method) {
              return this._buildOperationFromMethod(bundleName, methodName, args);
            }
          }
        }
      }
      throw new Error('Method not found in client bundles');
    }

    /**
     * Build operation descriptor from method name and arguments
     * @private
     */
    _buildOperationFromMethod(bundleName, methodName, args) {
      // This is a simplified approach - in a real implementation, we'd need
      // to reconstruct the full operation based on the method signature
      // For now, we'll store the method info and delegate to the actual method
      // when we have more sophisticated introspection
      
      // Get the private method name
      const privateMethodName = `_${bundleName}${methodName.charAt(0).toUpperCase() + methodName.slice(1)}`;
      const privateMethod = this.client[privateMethodName];
      
      if (!privateMethod) {
        throw new Error(`Private method ${privateMethodName} not found`);
      }

      // Extract operation info from the method's path construction
      // This is a simplified version - real implementation would be more robust
      return this._simulateMethodCall(privateMethod, args);
    }

    /**
     * Simulate a method call to extract the operation details
     * @private
     */
    _simulateMethodCall(method, args) {
      // Create a mock fetch function to capture the request details
      const originalFetch = global.fetch;
      let capturedOperation = null;

      global.fetch = (url, options) => {
        const parsedUrl = new URL(url);
        const path = parsedUrl.pathname;
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : undefined;
        
        capturedOperation = {
          path: path,
          method: method.toLowerCase(),
          body: body
        };
        
        // Return a resolved promise to avoid actually making the request
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('')
        });
      };

      try {
        // Call the method to capture the operation
        method.apply(this.client, args);
        return capturedOperation;
      } finally {
        // Restore original fetch
        global.fetch = originalFetch;
      }
    }
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
   * Create a new batch builder for executing multiple operations
   * @returns {BatchBuilder} - New batch builder instance
   */
  batch() {
    return new BatchBuilder(this);
  }
")





(defn- generate-method-params-from-operation
  "Generate JavaScript method parameters using ordered params from AST"
  [operation]
  (let [{:keys [path-params required-body-params optional-body-params 
                regular-query-params as-of-param]} (:ordered-params operation)
        {:keys [is-config?]} (:special-endpoints operation)
        http-method (:http-method operation)
        
        ;; Path parameters
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
        
        ;; Query parameters
        query-param-names (map (fn [param]
                                (let [param-name (transform-key-name (:name param))]
                                  (if (:required? param)
                                    param-name
                                    (str param-name " = undefined"))))
                              regular-query-params)
        
        ;; asOf parameter (only for GET requests)
        as-of-param-name (when (and as-of-param (= http-method :get))
                          [(str (transform-key-name (:name as-of-param)) " = undefined")])
        
        ;; Combine all parameters
        all-params (concat path-param-names config-params body-param-names 
                          query-param-names as-of-param-name)]
    
    (str/join ", " (filter some? all-params))))

(defn- generate-url-construction
  "Generate JavaScript code to construct the URL with path parameters"
  [path path-params query-params http-method]
  (let [base-url (if (empty? path-params)
                   (str "const url = `${this.baseUrl}" path "`;")
                   (let [js-path (reduce (fn [p param]
                                           (str/replace p (str "{" param "}")
                                                        (str "${" (kebab->camel param) "}")))
                                         path
                                         path-params)]
                     (str "const url = `${this.baseUrl}" js-path "`;")))
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
                                    "    const finalUrl = queryString ? `${url}?${queryString}` : url;")))]
    (str base-url query-construction)))

(defn- generate-body-construction
  "Generate JavaScript code to construct request body from individual parameters"
  [body-params]
  (when (seq body-params)
    (cond
      ;; Special case: single array parameter that represents the entire body
      (and (= (count body-params) 1)
           (= (:type (first body-params)) "array")
           (= (:original-name (first body-params)) "body"))
      (let [param-name (transform-key-name (:name (first body-params)))]
        (str "const requestBody = " param-name ";"))
      
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
             "    const requestBody = this._transformRequest(bodyObj);")))))

(defn- generate-fetch-options
  "Generate JavaScript fetch options"
  [method has-body? is-login?]
  (let [auth-header (if is-login? 
                      ""
                      "        'Authorization': `Bearer ${this.token}`,\n")]
    (if has-body?
      (str "const fetchOptions = {\n"
           "      method: '" (str/upper-case (name method)) "',\n"
           "      headers: {\n"
           auth-header
           "        'Content-Type': 'application/json'\n"
           "      },\n"
           "      body: JSON.stringify(requestBody)\n"
           "    };")
      (str "const fetchOptions = {\n"
           "      method: '" (str/upper-case (name method)) "',\n"
           "      headers: {\n"
           auth-header
           "        'Content-Type': 'application/json'\n"
           "      }\n"
           "    };"))))

(defn- generate-private-method-from-ast
  "Generate a private JavaScript method from AST operation"
  [operation]
  (let [{:keys [bundle-name method-name path http-method summary ordered-params special-endpoints]} operation
        {:keys [path-params required-body-params optional-body-params 
                regular-query-params as-of-param]} ordered-params
        {:keys [is-config? is-login?]} special-endpoints
        
        ;; Check if there's a request body
        has-body? (or (seq required-body-params) 
                     (seq optional-body-params)
                     (and is-config? (= http-method :put)))
        
        ;; Generate method parameters
        method-params (generate-method-params-from-operation operation)
        
        ;; Generate URL construction
        url-construction (generate-url-construction path path-params 
                                                   (concat regular-query-params 
                                                          (when as-of-param [as-of-param]))
                                                   http-method)
        
        ;; Generate body construction
        body-params (concat required-body-params optional-body-params)
        body-construction (cond
                           (and is-config? (= http-method :put))
                           "const requestBody = configValue;"
                           
                           (seq body-params)
                           (generate-body-construction body-params)
                           
                           :else nil)
        
        ;; Generate fetch options
        fetch-options (generate-fetch-options http-method has-body? is-login?)
        
        ;; Format summary
        formatted-summary (transform-parameter-references (or summary ""))
        
        ;; Private method name
        private-method-name (str "_" bundle-name (csk/->PascalCase method-name))
        
        ;; Determine URL variable name
        url-var (if (or (seq regular-query-params) as-of-param) "finalUrl" "url")]
    
    (str "  /**\n"
         "   * " formatted-summary "\n"
         "   */\n"
         "  async " private-method-name "(" method-params ") {\n"
         "    " url-construction "\n"
         (when body-construction (str "    " body-construction "\n"))
         "    " fetch-options "\n"
         "    \n"
         "    const response = await fetch(" url-var ", fetchOptions);\n"
         "    if (!response.ok) {\n"
         "      const errorBody = await response.text().catch(() => 'Unable to read error response');\n"
         "      const error = new Error(`HTTP ${response.status} ${response.statusText} at ${" url-var "}`);\n"
         "      error.status = response.status;\n"
         "      error.statusText = response.statusText;\n"
         "      error.url = " url-var ";\n"
         "      error.method = '" (str/upper-case (name http-method)) "';\n"
         "      error.responseBody = errorBody;\n"
         "      throw error;\n"
         "    }\n"
         "    \n"
         "    const contentType = response.headers.get('content-type');\n"
         "    if (contentType && contentType.includes('application/json')) {\n"
         "      const data = await response.json();\n"
         "      return this._transformResponse(data);\n"
         "    }\n"
         "    return await response.text();\n"
         "  }\n")))

(defn- generate-bundle-methods
  "Generate all private methods for the PlaidClient class"
  [bundles]
  (->> bundles
       (mapcat (fn [[bundle-name operations]]
                 (map generate-private-method-from-ast operations)))
       (str/join "\n")))

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
        "string" "string"
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
        {:keys [required-body-params optional-body-params 
                regular-query-params as-of-param]} ordered-params
        {:keys [is-config?]} special-endpoints
        
        ;; Generate parameter list with types
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
                      (map (fn [{:keys [name original-name type]}]
                             (let [ts-name (transform-key-name name)
                                   ts-type (case type
                                            "string" "string"
                                            "integer" "number"
                                            "boolean" "boolean"
                                            "array" "any[]"
                                            "any")]
                               (str ts-name ": " ts-type)))
                           required-body-params)
                      (map (fn [{:keys [name original-name type]}]
                             (let [ts-name (transform-key-name name)
                                   ts-type (case type
                                            "string" "string"
                                            "integer" "number"
                                            "boolean" "boolean"
                                            "array" "any[]"
                                            "any")]
                               (str ts-name "?: " ts-type)))
                           optional-body-params)))
                   
                   ;; Query parameters
                   (map (fn [param]
                          (let [param-name (transform-key-name (:name param))
                                param-type (openapi-type-to-ts (:schema param))
                                optional-marker (if (:required? param) "" "?")]
                            (str param-name optional-marker ": " param-type)))
                        regular-query-params)
                   
                   ;; asOf parameter at the end (only for GET requests)
                   (when (and as-of-param (= http-method :get))
                     [(str (transform-key-name (:name as-of-param)) "?: " 
                           (openapi-type-to-ts (:schema as-of-param)))]))
        
        params-str (str/join ", " ts-params)
        return-type "Promise<any>"] ; Could be more specific based on response schema
    
    (str method-name "(" params-str "): " return-type ";")))

(defn- generate-jsdoc-params
  "Generate JSDoc parameter documentation from AST operation"
  [operation]
  (let [{:keys [path-params ordered-params special-endpoints]} operation
        {:keys [required-body-params optional-body-params 
                regular-query-params as-of-param]} ordered-params
        {:keys [is-config?]} special-endpoints
        all-query-params (concat regular-query-params (when as-of-param [as-of-param]))]
    
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
      
      ;; Query parameters  
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
           all-query-params))))

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
  (let [bundle-interfaces (->> bundles
                              (map (fn [[bundle-name operations]]
                                     (generate-ts-bundle-interface bundle-name operations)))
                              (str/join "\n\n"))
        main-interface (->> bundles
                           (map (fn [[bundle-name _]]
                                  (str "  " bundle-name ": " (csk/->PascalCase bundle-name) "Bundle;")))
                           (str/join "\n"))]
    (str bundle-interfaces "\n\n"
         "declare class PlaidClient {\n"
         "  constructor(baseUrl: string, token: string);\n"
         main-interface "\n"
         "}\n\n"
         "declare const client: PlaidClient;\n")))

(defn- generate-bundle-initialization
  "Generate bundle initialization code for the constructor"
  [bundles]
  (->> bundles
       (map (fn [[bundle-name operations]]
              (let [methods (->> operations
                                (map (fn [operation]
                                       (let [{:keys [method-name bundle-name summary path]} operation
                                             private-method-name (str "_" bundle-name (csk/->PascalCase method-name))
                                             formatted-summary (transform-parameter-references (or summary ""))
                                             jsdoc-params (generate-jsdoc-params operation)
                                             jsdoc-comment (when (or formatted-summary (seq jsdoc-params))
                                                            (str "      /**\n"
                                                                 (when formatted-summary (str "       * " formatted-summary "\n"))
                                                                 (str/join "\n" jsdoc-params)
                                                                 (when (seq jsdoc-params) "\n")
                                                                 "       */\n"))]
                                         (str jsdoc-comment
                                              "      " method-name ": this." private-method-name ".bind(this)"))))
                                (str/join ",\n"))]
                (str "    this." bundle-name " = {\n" methods "\n    };"))))
       (str/join "\n")))

(defn generate-js-client
  "Generate the complete JavaScript client class"
  [ast]
  (let [{:keys [info bundles]} ast
        {:keys [title version description]} info
        bundle-initialization (generate-bundle-initialization bundles)
        private-methods (generate-bundle-methods bundles)
        batch-builder-class (generate-batch-builder-class)
        transformation-functions (generate-key-transformation-functions)]
    
    (str "/**\n"
         " * " title " - " description "\n"
         " * Version: " version "\n"
         " * Generated on: " (java.util.Date.) "\n"
         " */\n"
         "\n"
         batch-builder-class
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
         "    \n"
         "    // Initialize API bundles\n"
         bundle-initialization "\n"
         "  }\n"
         "\n"
         transformation-functions
         "\n"
         private-methods
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
  "Generate a JavaScript client from an OpenAPI AST"
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