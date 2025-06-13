(ns plaid.client-gen
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [clojure.java.io :as io]
            [camel-snake-kebab.core :as csk]))

(defn- kebab->camel
  "Convert kebab-case to camelCase"
  [s]
  (csk/->camelCase s))

(defn- transform-key-name
  "Transform a key from kebab-case/namespaced to camelCase.
   Examples: 
   'layer-id' -> 'layerId'
   'relation/layer' -> 'layer' (namespace ignored)
   'project/name' -> 'name' (namespace ignored)"
  [k]
  (-> k
      (str/replace #"^[^/]+/" "") ; Remove namespace prefix
      (kebab->camel)))

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
")

(defn- extract-path-params
  "Extract path parameters from an OpenAPI path like '/api/v1/users/{id}'"
  [path]
  (->> (re-seq #"\{([^}]+)\}" path)
       (map second)))

(defn- infer-bundle-name
  "Infer bundle name from API path.
   E.g., '/api/v1/relation-layers' -> 'relationLayers'"
  [path]
  (let [cleaned-path (-> path
                         (str/replace #"^/api/v[0-9]+/" "")
                         (str/replace #"/\{[^}]+\}.*" "")
                         (str/replace #"/.*" ""))]
    (kebab->camel cleaned-path)))

(defn- infer-method-name
  "Infer method name from HTTP method and path pattern"
  [http-method path]
  (let [path-parts (-> path
                       (str/replace #"^/api/v[0-9]+/" "")
                       (str/split #"/"))
        has-id? (some #(re-matches #"\{[^}]+\}" %) path-parts)
        last-part (last path-parts)
        is-param? #(re-matches #"\{[^}]+\}" %)
        special-action? (and has-id? (not (is-param? last-part)))
        ;; For config routes, look for the word "config" in the path
        is-config-route? (some #(= "config" %) path-parts)
        ;; For user management routes like /projects/{id}/readers/{user-id}
        user-role-route? (some #(contains? #{"readers" "writers" "maintainers"} %) path-parts)
        role-type (first (filter #(contains? #{"readers" "writers" "maintainers"} %) path-parts))]
    (cond
      ;; Config routes: /layer/{id}/config/{namespace}/{key}
      (and is-config-route? (= http-method :put))
      "setConfig"
      
      (and is-config-route? (= http-method :delete))
      "deleteConfig"
      
      ;; User role management routes: /projects/{id}/readers/{user-id}
      (and user-role-route? (= http-method :post))
      (str "add" (csk/->PascalCase (str/replace role-type #"s$" "")))
      
      (and user-role-route? (= http-method :delete))
      (str "remove" (csk/->PascalCase (str/replace role-type #"s$" "")))
      
      ;; Special actions like /shift, /source, /target
      special-action?
      (kebab->camel last-part)
      
      ;; Standard REST patterns
      (= http-method :get) (if has-id? "get" "list")
      (= http-method :post) (if has-id? (kebab->camel last-part) "create")
      (= http-method :patch) "update"
      (= http-method :put) "replace"
      (= http-method :delete) "delete"
      :else (str (name http-method) (when has-id? "ById")))))

(defn- get-bundle-name
  "Get bundle name from operation metadata or infer from path"
  [path operation]
  (or (get operation "x-client-bundle")
      (get-in operation ["x-openapi" "x-client-bundle"])
      (infer-bundle-name path)))

(defn- get-method-name
  "Get method name from operation metadata or infer from HTTP method and path"
  [http-method path operation]
  (or (get operation "x-client-method")
      (get-in operation ["x-openapi" "x-client-method"])
      (infer-method-name http-method path)))

(defn- js-method-name
  "Convert an OpenAPI operation to a JavaScript method name"
  [method path operation-id]
  (if operation-id
    (kebab->camel operation-id)
    (let [path-parts (-> path
                         (str/replace #"^/api/v[0-9]+/" "")
                         (str/replace #"\{[^}]+\}" "")
                         (str/split #"/")
                         (->> (remove empty?)))
          method-name (str (name method) (str/join "-" path-parts))]
      (kebab->camel method-name))))

(defn- extract-request-body-schema
  "Extract the JSON schema from a request body definition"
  [request-body]
  (get-in request-body ["content" "application/json" "schema"]))

(defn- extract-body-params
  "Extract individual parameters from request body schema"
  [request-body-schema]
  (when (and request-body-schema 
             (= "object" (get request-body-schema "type"))
             (get request-body-schema "properties"))
    (let [properties (get request-body-schema "properties")
          required-set (set (get request-body-schema "required" []))]
      (map (fn [[k v]]
             {:name (if (= k "body") "bodyText" (transform-key-name k))
              :original-name k
              :required? (contains? required-set k)
              :type (get v "type")})
           properties))))

(defn- generate-method-params
  "Generate JavaScript method parameters"
  [path-params query-params request-body-schema http-method]
  (let [path-param-names (map kebab->camel path-params)
        body-params (extract-body-params request-body-schema)
        ;; Put required params first, then optional ones
        required-body-params (filter :required? body-params)
        optional-body-params (remove :required? body-params)
        body-param-names (concat (map :name required-body-params)
                                (map #(str (:name %) " = undefined") optional-body-params))
        ;; Filter out asOf for non-GET requests and separate it for ordering
        filtered-query-params (if (= http-method :get)
                                query-params
                                (filter #(not= (get % "name") "as-of") query-params))
        as-of-param (first (filter #(= (get % "name") "as-of") query-params))
        ;; Extract non-asOf query parameter names and make them optional
        regular-query-param-names (map (fn [param]
                                        (let [param-name (transform-key-name (get param "name"))
                                              required? (get param "required" false)]
                                          (if required?
                                            param-name
                                            (str param-name " = undefined"))))
                                      (filter #(not= (get % "name") "as-of") filtered-query-params))
        ;; Add asOf parameter at the end if it exists in filtered params
        as-of-param-name (when (and as-of-param (= http-method :get))
                          [(str (transform-key-name (get as-of-param "name")) " = undefined")])]
    (str/join ", " (filter some? (concat path-param-names body-param-names regular-query-param-names as-of-param-name)))))

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
        ;; Filter query params based on HTTP method (remove asOf for non-GET)
        filtered-query-params (if (= http-method :get)
                                query-params
                                (filter #(not= (get % "name") "as-of") query-params))
        ;; Generate query parameter construction using individual parameters
        query-construction (when (seq filtered-query-params)
                           (let [query-checks (map (fn [param]
                                                    (let [param-name (transform-key-name (get param "name"))
                                                          original-name (get param "name")]
                                                      (str "    if (" param-name " !== undefined && " param-name " !== null) {\n"
                                                           "      queryParams.append('" original-name "', " param-name ");\n"
                                                           "    }")))
                                                  filtered-query-params)]
                             (str "\n    const queryParams = new URLSearchParams();\n"
                                  (str/join "\n" query-checks) "\n"
                                  "    const queryString = queryParams.toString();\n"
                                  "    const finalUrl = queryString ? `${url}?${queryString}` : url;")))]
    (str base-url query-construction)))

(defn- generate-body-construction
  "Generate JavaScript code to construct request body from individual parameters"
  [body-params]
  (when (seq body-params)
    (let [all-params (map (fn [{:keys [name original-name]}]
                           (str "      \"" original-name "\": " name))
                         body-params)]
      (str "const bodyObj = {\n" 
           (str/join ",\n" all-params) 
           "\n    };\n"
           "    // Filter out undefined optional parameters\n"
           "    Object.keys(bodyObj).forEach(key => bodyObj[key] === undefined && delete bodyObj[key]);\n"
           "    const body = this._transformRequest(bodyObj);"))))

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
           "      body: JSON.stringify(body)\n"
           "    };")
      (str "const fetchOptions = {\n"
           "      method: '" (str/upper-case (name method)) "',\n"
           "      headers: {\n"
           auth-header
           "        'Content-Type': 'application/json'\n"
           "      }\n"
           "    };"))))

(defn- generate-private-method
  "Generate a private JavaScript method for an API endpoint"
  [bundle-name method-name path method operation]
  (let [path-params (extract-path-params path)
        parameters (get operation "parameters" [])
        query-params (filter #(= (get % "in") "query") parameters)
        request-body (get operation "requestBody")
        request-body-schema (extract-request-body-schema request-body)
        body-params (extract-body-params request-body-schema)
        is-config? (str/includes? path "/config/")
        is-login? (str/includes? path "/login")
        has-body? (some? request-body-schema)
        ;; For config endpoints, add configValue parameter if it's a PUT
        config-params (when (and is-config? (= method :put)) ["configValue"])
        all-path-params (concat path-params config-params)
        method-params (if is-config?
                        (generate-method-params all-path-params query-params nil method)
                        (generate-method-params path-params query-params request-body-schema method))
        url-construction (generate-url-construction path path-params query-params method)
        body-construction (cond
                            (and is-config? (= method :put))
                            "const body = configValue;"
                            body-params
                            (generate-body-construction body-params)
                            :else nil)
        fetch-options (generate-fetch-options method has-body? is-login?)
        summary (get operation "summary" "")
        private-method-name (str "_" bundle-name (csk/->PascalCase method-name))
        url-var (if (seq query-params) "finalUrl" "url")]
    
    (str "  /**\n"
         "   * " summary "\n"
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
         "      error.method = '" (str/upper-case (name method)) "';\n"
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

(defn- group-operations-by-bundle
  "Group operations by their bundle names"
  [paths]
  (reduce
    (fn [acc [path methods]]
      (reduce
        (fn [acc2 [http-method operation]]
          (let [bundle-name (get-bundle-name path operation)
                method-name (get-method-name (keyword http-method) path operation)
                operation-info {:path path
                               :http-method (keyword http-method)
                               :operation operation
                               :method-name method-name}]
            (update acc2 bundle-name (fnil conj []) operation-info)))
        acc
        methods))
    {}
    paths))

(defn- generate-bundle-methods
  "Generate all private methods for the PlaidClient class"
  [paths]
  (let [bundles (group-operations-by-bundle paths)]
    (->> bundles
         (mapcat (fn [[bundle-name operations]]
                   (map (fn [{:keys [path http-method operation method-name]}]
                          (generate-private-method bundle-name method-name path http-method operation))
                        operations)))
         (str/join "\n"))))

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
  [method-name path operation http-method]
  (let [path-params (extract-path-params path)
        parameters (get operation "parameters" [])
        query-params (filter #(= (get % "in") "query") parameters)
        request-body (get operation "requestBody")
        request-body-schema (extract-request-body-schema request-body)
        body-params (extract-body-params request-body-schema)
        is-config? (str/includes? path "/config/")
        
        ;; Filter out asOf for non-GET requests and separate it for ordering
        filtered-query-params (if (= http-method :get)
                                query-params
                                (filter #(not= (get % "name") "as-of") query-params))
        as-of-param (first (filter #(= (get % "name") "as-of") query-params))
        
        ;; Generate parameter list with types
        ts-params (concat
                    ;; Path parameters
                    (map (fn [param]
                           (str (kebab->camel param) ": string"))
                         path-params)
                    
                    ;; Body parameters
                    (map (fn [{:keys [name type required?]}]
                           (let [ts-type (case type
                                          "string" "string"
                                          "integer" "number"
                                          "boolean" "boolean"
                                          "array" "any[]"
                                          "any")
                                 optional-marker (if required? "" "?")]
                             (str name optional-marker ": " ts-type)))
                         body-params)
                    
                    ;; Non-asOf query parameters
                    (map (fn [param]
                           (let [param-name (transform-key-name (get param "name"))
                                 param-type (openapi-type-to-ts (get param "schema"))
                                 required? (get param "required" false)
                                 optional-marker (if required? "" "?")]
                             (str param-name optional-marker ": " param-type)))
                         (filter #(not= (get % "name") "as-of") filtered-query-params))
                    
                    ;; Config value parameter
                    (when (and is-config? (get operation "requestBody"))
                      ["configValue: any"])
                    
                    ;; asOf parameter at the end (only for GET requests)
                    (when (and as-of-param (= http-method :get))
                      [(str (transform-key-name (get as-of-param "name")) "?: " 
                            (openapi-type-to-ts (get as-of-param "schema")))]))
        
        params-str (str/join ", " ts-params)
        return-type "Promise<any>"] ; Could be more specific based on response schema
    
    (str method-name "(" params-str "): " return-type ";")))

(defn- generate-jsdoc-params
  "Generate JSDoc parameter documentation from OpenAPI operation"
  [path operation]
  (let [path-params (extract-path-params path)
        parameters (get operation "parameters" [])
        query-params (filter #(= (get % "in") "query") parameters)
        request-body (get operation "requestBody")
        request-body-schema (extract-request-body-schema request-body)
        body-params (extract-body-params request-body-schema)
        is-config? (str/includes? path "/config/")
        config-params (when (and is-config? (get operation "requestBody")) [{"name" "configValue" "type" "any"}])]
    
    (concat
      ;; Path parameters
      (map (fn [param]
             (str " * @param {string} " (kebab->camel param) " - " (str/capitalize param) " identifier"))
           path-params)
      
      ;; Body parameters
      (map (fn [{:keys [name type required?]}]
             (let [js-type (case type
                            "string" "string"
                            "integer" "number"
                            "boolean" "boolean"
                            "array" "Array"
                            "any")]
               (str " * @param {" js-type "} " name " - " (if required? "Required. " "Optional. ") (str/capitalize name))))
           body-params)
      
      ;; Query parameters  
      (map (fn [param]
             (let [param-name (transform-key-name (get param "name"))
                   param-type (case (get-in param ["schema" "type"])
                               "string" "string"
                               "integer" "number" 
                               "boolean" "boolean"
                               "string")
                   required? (get param "required" false)]
               (str " * @param {" param-type "} [" param-name "] - " (get param "description" (str "Optional " param-name)))))
           query-params)
      
      ;; Config value parameter
      (when config-params
        (map (fn [param]
               (str " * @param {any} " (get param "name") " - Configuration value to set"))
             config-params)))))

(defn- generate-ts-bundle-interface
  "Generate TypeScript interface for a bundle"
  [bundle-name operations]
  (let [methods (->> operations
                     (map (fn [{:keys [method-name path operation http-method]}]
                            (let [summary (get operation "summary" "")]
                              (str "  " (generate-ts-method-signature method-name path operation http-method)))))
                     (str/join "\n"))]
    (str "interface " (csk/->PascalCase bundle-name) "Bundle {\n" methods "\n}")))

(defn- generate-ts-definitions
  "Generate complete TypeScript definitions for the client"
  [paths]
  (let [bundles (group-operations-by-bundle paths)
        bundle-interfaces (->> bundles
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
  [paths]
  (let [bundles (group-operations-by-bundle paths)]
    (->> bundles
         (map (fn [[bundle-name operations]]
                (let [methods (->> operations
                                   (map (fn [{:keys [method-name path operation]}]
                                          (let [private-method-name (str "_" bundle-name (csk/->PascalCase method-name))
                                                summary (get operation "summary" "")
                                                jsdoc-params (generate-jsdoc-params path operation)
                                                jsdoc-comment (when (or summary (seq jsdoc-params))
                                                               (str "      /**\n"
                                                                    (when summary (str "       * " summary "\n"))
                                                                    (str/join "\n" jsdoc-params)
                                                                    (when (seq jsdoc-params) "\n")
                                                                    "       */\n"))]
                                            (str jsdoc-comment
                                                 "      " method-name ": this." private-method-name ".bind(this)"))))
                                   (str/join ",\n"))]
                  (str "    this." bundle-name " = {\n" methods "\n    };"))))
         (str/join "\n"))))

(defn- generate-js-client
  "Generate the complete JavaScript client class"
  [openapi-spec]
  (let [info (get openapi-spec "info")
        title (get info "title" "API Client")
        version (get info "version" "1.0.0")
        description (get info "description" "Generated API client")
        paths (get openapi-spec "paths")
        bundle-initialization (generate-bundle-initialization paths)
        private-methods (generate-bundle-methods paths)
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

(defn generate-client
  "Generate a JavaScript client from an OpenAPI specification file"
  [input-file output-file]
  (try
    (let [openapi-spec (json/read-str (slurp input-file))
          js-client (generate-js-client openapi-spec)
          paths (get openapi-spec "paths")
          ts-definitions (generate-ts-definitions paths)
          ts-output-file (str/replace output-file #"\.js$" ".d.ts")]
      (spit output-file js-client)
      (spit ts-output-file ts-definitions)
      (println (str "✅ JavaScript client generated successfully: " output-file))
      (println (str "✅ TypeScript definitions generated: " ts-output-file))
      (println (str "📊 Generated " 
                    (count (re-seq #"async \w+\(" js-client)) 
                    " API methods")))
    (catch Exception e
      (println (str "❌ Error generating client: " (.getMessage e)))
      (System/exit 1))))

(defn -main
  "Main entry point for the client generator"
  [& args]
  (let [input-file (or (first args) "api.json")
        output-file (or (second args) "PlaidClient.js")]
    (println (str "🚀 Generating JavaScript client from " input-file "..."))
    (generate-client input-file output-file)
    (println "🎉 Done!"))) 