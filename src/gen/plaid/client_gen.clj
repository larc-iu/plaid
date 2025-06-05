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
        query-param (when (seq query-params) "queryParams")]
    (str/join ", " (filter some? (concat path-param-names [body-param query-param])))))

(defn- generate-url-construction
  "Generate JavaScript code to construct the URL with path parameters"
  [path path-params]
  (if (empty? path-params)
    (str "const url = `${this.baseUrl}" path "`;")
    (let [js-path (reduce (fn [p param]
                            (str/replace p (str "{" param "}") 
                                        (str "${" (kebab->camel param) "}")))
                          path
                          path-params)]
      (str "const url = `${this.baseUrl}" js-path "`;"))))

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

(defn- generate-method
  "Generate a JavaScript method for an API endpoint"
  [path method operation]
  (let [method-name (js-method-name method path (get operation "operationId"))
        path-params (extract-path-params path)
        parameters (get operation "parameters" [])
        query-params (filter #(= (get % "in") "query") parameters)
        request-body (get operation "requestBody")
        request-body-schema (extract-request-body-schema request-body)
        has-body? (some? request-body-schema)
        method-params (generate-method-params path-params query-params request-body-schema)
        url-construction (generate-url-construction path path-params)
        fetch-options (generate-fetch-options method has-body?)
        summary (get operation "summary" "")]
    
    (str "  /**\n"
         "   * " summary "\n"
         "   */\n"
         "  async " method-name "(" method-params ") {\n"
         "    " url-construction "\n"
         "    " fetch-options "\n"
         "    \n"
         "    const response = await fetch(url, options);\n"
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

(defn- generate-class-methods
  "Generate all methods for the PlaidClient class"
  [paths]
  (->> paths
       (mapcat (fn [[path methods]]
                 (map (fn [[method operation]]
                        (generate-method path (keyword method) operation))
                      methods)))
       (str/join "\n")))

(defn- generate-js-client
  "Generate the complete JavaScript client class"
  [openapi-spec]
  (let [info (get openapi-spec "info")
        title (get info "title" "API Client")
        version (get info "version" "1.0.0")
        description (get info "description" "Generated API client")
        paths (get openapi-spec "paths")
        methods (generate-class-methods paths)]
    
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
         "  }\n"
         "\n"
         methods
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