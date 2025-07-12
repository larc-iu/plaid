(ns plaid.client-gen
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [clojure.java.io :as io]
            [camel-snake-kebab.core :as csk]
            [plaid.common :as common]
            [plaid.javascript :as js]
            [plaid.python :as py]))

;; ============================================================================
;; Shared AST Parsing Functions  
;; ============================================================================

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
    (let [schema-info (common/extract-request-body-schema request-body)]
      (when schema-info
        {:schema (:schema schema-info)
         :content-type (:content-type schema-info)
         :required? (get request-body "required" false)
         :body-params (common/extract-body-params schema-info)}))))

(defn- parse-operation
  "Parse an OpenAPI operation into a normalized AST node"
  [path http-method operation]
  (let [path-params (common/extract-path-params path)
        parameters (get operation "parameters" [])
        query-params (filter #(= (get % "in") "query") parameters)
        request-body (parse-request-body (get operation "requestBody"))
        special-endpoints (common/detect-special-endpoints path)
        base-operation {:path path
                        :http-method http-method
                        :operation-id (get operation "operationId")
                        :summary (get operation "summary")
                        :description (get operation "description")
                        :parameters {:path (map parse-parameter (filter #(= (get % "in") "path") parameters))
                                     :query (map parse-parameter query-params)
                                     :body request-body}
                        :path-params path-params
                        :bundle-name (common/get-bundle-name path operation)
                        :method-name (common/get-method-name http-method path operation)
                        :tags (get operation "tags" [])
                        :raw-operation operation
                        :special-endpoints special-endpoints}]
    (assoc base-operation :ordered-params (common/order-parameters base-operation))))

(defn parse-openapi-spec
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