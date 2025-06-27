(ns plaid.common
  (:require [clojure.string :as str]
            [camel-snake-kebab.core :as csk]))

;; ============================================================================
;; Shared Utility Functions
;; ============================================================================

(defn transform-key-name
  "Transform a key from kebab-case/namespaced to target format.
   Examples: 
   'layer-id' -> 'layerId' (camelCase) or 'layer_id' (snake_case)
   'relation/layer' -> 'layer' (namespace ignored)
   'project/name' -> 'name' (namespace ignored)"
  [k target-format]
  (let [without-namespace (str/replace k #"^[^/]+/" "")]
    (case target-format
      :camelCase (csk/->camelCase without-namespace)
      :snake_case (csk/->snake_case without-namespace)
      without-namespace)))

(defn transform-parameter-references
  "Transform parameter references in XML tags within summary strings.
   Converts <body>param-name</body>, <query>param-name</query>, <path>param-name</path>
   to the target format and removes the XML tags."
  [summary-text target-format]
  (-> summary-text
      (str/replace #"<body>([^<]+)</body>" 
                   (fn [[_ param-name]] (transform-key-name param-name target-format)))
      (str/replace #"<query>([^<]+)</query>" 
                   (fn [[_ param-name]] (transform-key-name param-name target-format)))
      (str/replace #"<path>([^<]+)</path>" 
                   (fn [[_ param-name]] (transform-key-name param-name target-format)))))

(defn extract-path-params
  "Extract path parameters from an OpenAPI path like '/api/v1/users/{id}'"
  [path]
  (->> (re-seq #"\{([^}]+)\}" path)
       (map second)))

(defn infer-bundle-name
  "Infer bundle name from API path.
   E.g., '/api/v1/relation-layers' -> 'relationLayers'"
  [path]
  (let [cleaned-path (-> path
                         (str/replace #"^/api/v[0-9]+/" "")
                         (str/replace #"/\{[^}]+\}.*" "")
                         (str/replace #"/.*" ""))]
    (csk/->camelCase cleaned-path)))

(defn infer-method-name
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
      (csk/->camelCase last-part)
      
      ;; Standard REST patterns
      (= http-method :get) (if has-id? "get" "list")
      (= http-method :post) (if has-id? (csk/->camelCase last-part) "create")
      (= http-method :patch) "update"
      (= http-method :put) "replace"
      (= http-method :delete) "delete"
      :else (str (name http-method) (when has-id? "ById")))))

(defn get-bundle-name
  "Get bundle name from operation metadata or infer from path"
  [path operation]
  (or (get operation "x-client-bundle")
      (get-in operation ["x-openapi" "x-client-bundle"])
      (infer-bundle-name path)))

(defn get-method-name
  "Get method name from operation metadata or infer from HTTP method and path"
  [http-method path operation]
  (or (get operation "x-client-method")
      (get-in operation ["x-openapi" "x-client-method"])
      (infer-method-name http-method path)))

(defn transform-method-name
  "Transform method name from kebab-case to target format"
  [method-name target-format]
  (case target-format
    :camelCase (csk/->camelCase method-name)
    :snake_case (csk/->snake_case method-name)
    method-name))

(defn extract-request-body-schema
  "Extract the JSON schema from a request body definition"
  [request-body]
  (get-in request-body ["content" "application/json" "schema"]))

(defn extract-body-params
  "Extract individual parameters from request body schema"
  [request-body-schema]
  (when request-body-schema
    (let [schema-type (get request-body-schema "type")]
      (cond
        ;; Handle object schemas with properties
        (and (= schema-type "object")
             (get request-body-schema "properties"))
        (let [properties (get request-body-schema "properties")
              required-set (set (get request-body-schema "required" []))]
          (map (fn [[k v]]
                 {:name k
                  :original-name k
                  :required? (contains? required-set k)
                  :type (get v "type")})
               properties))
        
        ;; Handle array schemas at the top level
        (= schema-type "array")
        [{:name "body"
          :original-name "body"
          :required? true
          :type "array"}]
        
        ;; Handle other schema types (fallback)
        :else
        [{:name "body"
          :original-name "body"
          :required? true
          :type (or schema-type "Any")}]))))

(defn detect-special-endpoints
  "Detect special endpoint types"
  [path]
  {:is-config? (str/includes? path "/config/")
   :is-login? (str/includes? path "/login")
   :user-role-route? (some #(contains? #{"readers" "writers" "maintainers"} %) 
                           (str/split path #"/"))
   :role-type (first (filter #(contains? #{"readers" "writers" "maintainers"} %) 
                             (str/split path #"/")))})

(defn filter-query-params
  "Filter query parameters based on HTTP method"
  [query-params http-method]
  (if (= http-method :get)
    query-params
    (filter #(not= (:name %) "as-of") query-params)))

(defn order-parameters
  "Order parameters consistently across all client generators
   Returns a map with ordered parameter lists for each type"
  [operation]
  (let [{:keys [path-params parameters http-method path]} operation
        {:keys [query body]} parameters
        body-params (:body-params body)
        special-endpoints (detect-special-endpoints path)
        
        ;; Separate required and optional body params
        required-body-params (filter :required? body-params)
        optional-body-params (remove :required? body-params)
        
        ;; Filter query params based on HTTP method
        filtered-query-params (filter-query-params query http-method)
        
        ;; Separate as-of parameter for special handling
        as-of-param (first (filter #(= (:name %) "as-of") filtered-query-params))
        regular-query-params (filter #(not= (:name %) "as-of") filtered-query-params)]
    
    {:path-params path-params
     :required-body-params required-body-params
     :optional-body-params optional-body-params
     :regular-query-params regular-query-params
     :as-of-param as-of-param
     :all-params (concat path-params 
                        required-body-params 
                        optional-body-params 
                        regular-query-params
                        (when as-of-param [as-of-param]))}))