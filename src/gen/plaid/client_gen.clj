(ns plaid.client-gen
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [clojure.java.io :as io]
            [camel-snake-kebab.core :as csk]))

(defn- kebab->camel
  "Convert kebab-case to camelCase"
  [s]
  (csk/->camelCase s))

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

(defn- generate-method-params
  "Generate JavaScript method parameters"
  [path-params query-params request-body-schema]
  (let [path-param-names (map kebab->camel path-params)
        body-param (when request-body-schema "body")
        options-param (when (seq query-params) "options")]
    (str/join ", " (filter some? (concat path-param-names [body-param options-param])))))

(defn- generate-url-construction
  "Generate JavaScript code to construct the URL with path parameters"
  [path path-params query-params]
  (let [base-url (if (empty? path-params)
                   (str "const url = `${this.baseUrl}" path "`;")
                   (let [js-path (reduce (fn [p param]
                                         (str/replace p (str "{" param "}") 
                                                     (str "${" (kebab->camel param) "}")))
                                       path
                                       path-params)]
                     (str "const url = `${this.baseUrl}" js-path "`;")))
        query-construction (when (seq query-params)
                           "\n    const queryParams = new URLSearchParams();\n    if (options) {\n      Object.entries(options).forEach(([key, value]) => {\n        if (value !== undefined && value !== null) {\n          queryParams.append(key, value);\n        }\n      });\n    }\n    const queryString = queryParams.toString();\n    const finalUrl = queryString ? `${url}?${queryString}` : url;")]
    (str base-url query-construction)))

(defn- generate-fetch-options
  "Generate JavaScript fetch options"
  [method has-body?]
  (if has-body?
    (str "const options = {\n"
         "      method: '" (str/upper-case (name method)) "',\n"
         "      headers: {\n"
         "        'Authorization': `Bearer ${this.token}`,\n"
         "        'Content-Type': 'application/json'\n"
         "      },\n"
         "      body: JSON.stringify(body)\n"
         "    };")
    (str "const options = {\n"
         "      method: '" (str/upper-case (name method)) "',\n"
         "      headers: {\n"
         "        'Authorization': `Bearer ${this.token}`,\n"
         "        'Content-Type': 'application/json'\n"
         "      }\n"
         "    };")))

(defn- generate-private-method
  "Generate a private JavaScript method for an API endpoint"
  [bundle-name method-name path method operation]
  (let [path-params (extract-path-params path)
        parameters (get operation "parameters" [])
        query-params (filter #(= (get % "in") "query") parameters)
        request-body (get operation "requestBody")
        request-body-schema (extract-request-body-schema request-body)
        has-body? (some? request-body-schema)
        method-params (generate-method-params path-params query-params request-body-schema)
        url-construction (generate-url-construction path path-params query-params)
        fetch-options (generate-fetch-options method has-body?)
        summary (get operation "summary" "")
        private-method-name (str "_" bundle-name (csk/->PascalCase method-name))
        url-var (if (seq query-params) "finalUrl" "url")]
    
    (str "  /**\n"
         "   * " summary "\n"
         "   */\n"
         "  async " private-method-name "(" method-params ") {\n"
         "    " url-construction "\n"
         "    " fetch-options "\n"
         "    \n"
         "    const response = await fetch(" url-var ", options);\n"
         "    if (!response.ok) {\n"
         "      throw new Error(`HTTP error! status: ${response.status}`);\n"
         "    }\n"
         "    \n"
         "    const contentType = response.headers.get('content-type');\n"
         "    if (contentType && contentType.includes('application/json')) {\n"
         "      return await response.json();\n"
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

(defn- generate-bundle-initialization
  "Generate bundle initialization code for the constructor"
  [paths]
  (let [bundles (group-operations-by-bundle paths)]
    (->> bundles
         (map (fn [[bundle-name operations]]
                (let [methods (->> operations
                                   (map (fn [{:keys [method-name]}]
                                          (let [private-method-name (str "_" bundle-name (csk/->PascalCase method-name))]
                                            (str "      " method-name ": this." private-method-name ".bind(this)"))))
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
        private-methods (generate-bundle-methods paths)]
    
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
          js-client (generate-js-client openapi-spec)]
      (spit output-file js-client)
      (println (str "✅ JavaScript client generated successfully: " output-file))
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