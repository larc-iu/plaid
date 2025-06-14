(ns plaid.client-gen
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [clojure.java.io :as io]
            [camel-snake-kebab.core :as csk]
            [plaid.javascript :as js]
            [plaid.python :as py]))

;; ============================================================================
;; Shared AST Parsing Functions  
;; ============================================================================

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

(defn- extract-request-body-schema
  "Extract the JSON schema from a request body definition"
  [request-body]
  (get-in request-body ["content" "application/json" "schema"]))

(defn- parse-parameter
  "Parse an OpenAPI parameter into a normalized structure"
  [param]
  {:name (get param "name")
   :in (get param "in")
   :required? (get param "required" false)
   :schema (get param "schema")
   :description (get param "description")})

(defn- parse-request-body
  "Parse an OpenAPI request body into a normalized structure"
  [request-body]
  (when request-body
    (let [schema (extract-request-body-schema request-body)]
      {:schema schema
       :required? (get request-body "required" false)
       :body-params (when (and schema 
                              (= "object" (get schema "type"))
                              (get schema "properties"))
                     (let [properties (get schema "properties")
                           required-set (set (get schema "required" []))]
                       (map (fn [[k v]]
                              {:name k
                               :original-name k
                               :required? (contains? required-set k)
                               :type (get v "type")})
                            properties)))})))

(defn- parse-operation
  "Parse an OpenAPI operation into a normalized AST node"
  [path http-method operation]
  (let [path-params (extract-path-params path)
        parameters (get operation "parameters" [])
        query-params (filter #(= (get % "in") "query") parameters)
        request-body (parse-request-body (get operation "requestBody"))]
    {:path path
     :http-method http-method
     :operation-id (get operation "operationId")
     :summary (get operation "summary")
     :description (get operation "description")
     :parameters {:path (map parse-parameter (filter #(= (get % "in") "path") parameters))
                  :query (map parse-parameter query-params)
                  :body request-body}
     :path-params path-params
     :bundle-name (get-bundle-name path operation)
     :method-name (get-method-name http-method path operation)
     :tags (get operation "tags" [])
     :raw-operation operation}))

(defn- parse-openapi-spec
  "Parse an OpenAPI specification into a normalized AST"
  [openapi-spec]
  (let [info (get openapi-spec "info")
        paths (get openapi-spec "paths")]
    {:info {:title (get info "title" "API Client")
            :version (get info "version" "1.0.0")
            :description (get info "description" "Generated API client")}
     :operations (->> paths
                      (mapcat (fn [[path methods]]
                                (map (fn [[http-method operation]]
                                       (parse-operation path (keyword http-method) operation))
                                     methods)))
                      (vec))
     :bundles (->> paths
                   (mapcat (fn [[path methods]]
                             (map (fn [[http-method operation]]
                                    (parse-operation path (keyword http-method) operation))
                                  methods)))
                   (group-by :bundle-name))
     :raw-spec openapi-spec}))

;; ============================================================================
;; Client Generation Functions
;; ============================================================================

(defn generate-javascript-client
  "Generate a JavaScript client from an OpenAPI AST"
  [ast output-file]
  (js/generate-javascript-client ast output-file))

(defn generate-python-client-file
  "Generate a Python client from an OpenAPI AST"
  [ast output-file]
  (py/generate-python-client-file ast output-file))

(defn generate-client
  "Generate a client from an OpenAPI specification file"
  ([input-file output-file]
   (generate-client input-file output-file "javascript"))
  ([input-file output-file target-language]
   (try
     (let [openapi-spec (json/read-str (slurp input-file))
           ast (parse-openapi-spec openapi-spec)]
       (case (str/lower-case target-language)
         "javascript" (js/generate-javascript-client ast output-file)
         "js" (js/generate-javascript-client ast output-file)
         "python" (py/generate-python-client-file ast output-file)
         "py" (py/generate-python-client-file ast output-file)
         (do
           (println (str "❌ Unsupported target language: " target-language))
           (println "Supported languages: javascript, python")
           (System/exit 1))))
     (catch Exception e
       (println (str "❌ Error generating client: " (.getMessage e)))
       (System/exit 1)))))

(defn -main
  "Main entry point for the client generator"
  [& args]
  (let [input-file (or (first args) "api.json")
        output-file (or (second args) "PlaidClient.js")
        target-language (or (nth args 2 nil) "javascript")
        ;; Auto-detect language from output file extension if not specified
        detected-language (cond
                           (and (= target-language "javascript") 
                                (str/ends-with? output-file ".py")) "python"
                           (and (= target-language "javascript") 
                                (str/ends-with? output-file ".js")) "javascript"
                           :else target-language)]
    (println (str "🚀 Generating " detected-language " client from " input-file "..."))
    (generate-client input-file output-file detected-language)
    (println "🎉 Done!")))