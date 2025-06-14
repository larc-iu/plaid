(ns plaid.python
  (:require [clojure.string :as str]
            [camel-snake-kebab.core :as csk]))

(defn- kebab->snake
  "Convert kebab-case to snake_case"
  [s]
  (csk/->snake_case s))

(defn- transform-key-name-python
  "Transform a key from kebab-case/namespaced to snake_case.
   Examples: 
   'layer-id' -> 'layer_id'
   'relation/layer' -> 'layer' (namespace ignored)
   'project/name' -> 'name' (namespace ignored)"
  [k]
  (-> k
      (str/replace #"^[^/]+/" "") ; Remove namespace prefix
      (kebab->snake)))

(defn- openapi-type-to-python
  "Convert OpenAPI type to Python type annotation"
  [schema]
  (cond
    (nil? schema) "Any"
    (string? schema) schema
    :else
    (let [type (get schema "type")
          format (get schema "format")]
      (case type
        "string" "str"
        "integer" "int"
        "number" "float"
        "boolean" "bool"
        "array" (str "List[" (openapi-type-to-python (get schema "items")) "]")
        "object" "Dict[str, Any]"
        "Any"))))

(defn- generate-python-method-params
  "Generate Python method parameters with type hints"
  [operation]
  (let [path-params (:path-params operation)
        query-params (get-in operation [:parameters :query])
        body-params (get-in operation [:parameters :body :body-params])
        http-method (:http-method operation)
        
        ;; Path parameters are always required
        path-param-strs (map (fn [param]
                              (str (kebab->snake param) ": str"))
                            path-params)
        
        ;; Body parameters
        body-param-strs (map (fn [{:keys [name original-name required? type]}]
                              (let [param-name (if (= original-name "body") "body_text" (transform-key-name-python original-name))
                                    py-type (case type
                                             "string" "str"
                                             "integer" "int"
                                             "boolean" "bool"
                                             "array" "List[Any]"
                                             "Any")
                                    optional-marker (if required? "" " = None")]
                                (str param-name ": " py-type optional-marker)))
                            body-params)
        
        ;; Query parameters (filter asOf for non-GET)
        filtered-query-params (if (= http-method :get)
                               query-params
                               (filter #(not= (:name %) "as-of") query-params))
        
        query-param-strs (map (fn [param]
                               (let [param-name (transform-key-name-python (:name param))
                                     py-type (openapi-type-to-python (:schema param))
                                     optional-marker (if (:required? param) "" " = None")]
                                 (str param-name ": " py-type optional-marker)))
                             filtered-query-params)]
    
    (str/join ", " (filter some? (concat path-param-strs body-param-strs query-param-strs)))))

(defn- generate-python-url-construction
  "Generate Python code to construct URL with path parameters"
  [operation]
  (let [path (:path operation)
        path-params (:path-params operation)
        query-params (get-in operation [:parameters :query])
        http-method (:http-method operation)
        
        ;; Build URL with path parameters
        url-construction (if (empty? path-params)
                          (str "url = f\"{self.base_url}" path "\"")
                          (let [py-path (reduce (fn [p param]
                                                (str/replace p (str "{" param "}") 
                                                           (str "{" (kebab->snake param) "}")))
                                              path
                                              path-params)]
                            (str "url = f\"{self.base_url}" py-path "\"")))
        
        ;; Filter query params for non-GET requests
        filtered-query-params (if (= http-method :get)
                               query-params
                               (filter #(not= (:name %) "as-of") query-params))
        
        ;; Generate query parameter construction
        query-construction (when (seq filtered-query-params)
                            (let [query-checks (map (fn [param]
                                                     (let [param-name (transform-key-name-python (:name param))
                                                           original-name (:name param)]
                                                       (str "        if " param-name " is not None:\n"
                                                            "            params['" original-name "'] = " param-name)))
                                                   filtered-query-params)]
                              (str "\n        params = {}\n"
                                   (str/join "\n" query-checks) "\n"
                                   "        if params:\n"
                                   "            url += '?' + '&'.join(f'{k}={v}' for k, v in params.items())")))]
    
    (str url-construction query-construction)))

(defn- generate-python-body-construction
  "Generate Python code to construct request body"
  [operation]
  (let [body-params (get-in operation [:parameters :body :body-params])
        is-config? (str/includes? (:path operation) "/config/")
        http-method (:http-method operation)]
    (cond
      (and is-config? (= http-method :put))
      "        body_data = config_value"
      
      (seq body-params)
      (let [body-dict-items (map (fn [{:keys [name original-name]}]
                                  (let [param-name (if (= original-name "body") "body_text" (transform-key-name-python original-name))]
                                    (str "            '" original-name "': " param-name)))
                                body-params)]
        (str "        body_dict = {\n"
             (str/join ",\n" body-dict-items) "\n"
             "        }\n"
             "        # Filter out None values\n"
             "        body_dict = {k: v for k, v in body_dict.items() if v is not None}\n"
             "        body_data = self._transform_request(body_dict)"))
      
      :else nil)))

(defn- generate-python-method
  "Generate a Python method for an API endpoint"
  [operation sync?]
  (let [bundle-name (:bundle-name operation)
        method-name (:method-name operation)
        path (:path operation)
        http-method (:http-method operation)
        summary (:summary operation)
        is-login? (str/includes? path "/login")
        has-body? (some? (get-in operation [:parameters :body]))
        is-config? (str/includes? path "/config/")
        
        ;; Method naming
        py-method-name (str (kebab->snake method-name) (when-not sync? "_async"))
        
        ;; Parameters
        method-params (generate-python-method-params operation)
        full-params (if (empty? method-params) "self" (str "self, " method-params))
        
        ;; URL construction
        url-construction (generate-python-url-construction operation)
        
        ;; Body construction
        body-construction (generate-python-body-construction operation)
        
        ;; Headers
        auth-header (if is-login?
                     ""
                     "        headers['Authorization'] = f'Bearer {self.token}'\n")
        
        ;; HTTP method setup
        method-call (if sync? "requests" "aiohttp.ClientSession")
        
        async-def (if sync? "def" "async def")
        await-keyword (if sync? "" "await ")
        response-json (if sync? "response.json()" "await response.json()")
        response-text (if sync? "response.text()" "await response.text()")]
    
    (str "    " async-def " " py-method-name "(" full-params ") -> Any:\n"
         "        \"\"\"" (or summary "") "\"\"\"\n"
         "        " url-construction "\n"
         (when body-construction (str "        " body-construction "\n"))
         "        \n"
         "        headers = {'Content-Type': 'application/json'}\n"
         auth-header
         "        \n"
         (if sync?
           ;; Sync version using requests
           (str "        response = requests." (str/lower-case (name http-method))
                "(url" (when has-body? ", json=body_data") ", headers=headers)\n"
                "        response.raise_for_status()\n"
                "        \n"
                "        if 'application/json' in response.headers.get('content-type', '').lower():\n"
                "            data = " response-json "\n"
                "            return self._transform_response(data)\n"
                "        return " response-text "\n")
           ;; Async version using aiohttp
           (str "        async with aiohttp.ClientSession() as session:\n"
                "            async with session." (str/lower-case (name http-method))
                "(url" (when has-body? ", json=body_data") ", headers=headers) as response:\n"
                "                response.raise_for_status()\n"
                "                \n"
                "                content_type = response.headers.get('content-type', '').lower()\n"
                "                if 'application/json' in content_type:\n"
                "                    data = " response-json "\n"
                "                    return self._transform_response(data)\n"
                "                return " response-text "\n")))))

(defn- generate-python-bundle-methods
  "Generate Python methods for a bundle"
  [bundle-name operations]
  (let [sync-methods (map #(generate-python-method % true) operations)
        async-methods (map #(generate-python-method % false) operations)]
    (str/join "\n" (concat sync-methods async-methods))))

(defn- generate-python-key-transformations
  "Generate Python key transformation methods"
  []
  "    def _transform_key_to_snake(self, key: str) -> str:
        \"\"\"Convert kebab-case and namespaced keys to snake_case\"\"\"
        import re
        # Remove namespace prefix
        key = re.sub(r'^[^/]+/', '', key)
        # Convert kebab-case to snake_case
        return re.sub(r'-([a-z])', lambda m: '_' + m.group(1), key)
    
    def _transform_key_from_snake(self, key: str) -> str:
        \"\"\"Convert snake_case back to kebab-case\"\"\"
        return key.replace('_', '-')
    
    def _transform_request(self, obj: Any) -> Any:
        \"\"\"Transform request data from Python conventions to API conventions\"\"\"
        if obj is None or isinstance(obj, (str, int, float, bool)):
            return obj
        if isinstance(obj, list):
            return [self._transform_request(item) for item in obj]
        if isinstance(obj, dict):
            return {self._transform_key_from_snake(k): self._transform_request(v) 
                   for k, v in obj.items()}
        return obj
    
    def _transform_response(self, obj: Any) -> Any:
        \"\"\"Transform response data from API conventions to Python conventions\"\"\"
        if obj is None or isinstance(obj, (str, int, float, bool)):
            return obj
        if isinstance(obj, list):
            return [self._transform_response(item) for item in obj]
        if isinstance(obj, dict):
            return {self._transform_key_to_snake(k): self._transform_response(v) 
                   for k, v in obj.items()}
        return obj")

(defn generate-python-client
  "Generate the complete Python client class"
  [ast]
  (let [info (:info ast)
        title (:title info)
        version (:version info)
        description (:description info)
        bundles (:bundles ast)
        
        ;; Generate bundle methods
        bundle-methods (->> bundles
                            (map (fn [[bundle-name operations]]
                                   (generate-python-bundle-methods bundle-name operations)))
                            (str/join "\n\n"))
        
        ;; Generate bundle initialization
        bundle-init (->> bundles
                         (map (fn [[bundle-name operations]]
                                (let [method-names (->> operations
                                                        (mapcat (fn [op]
                                                                  (let [base-name (kebab->snake (:method-name op))]
                                                                    [(str "'" base-name "': self." base-name)
                                                                     (str "'" base-name "_async': self." base-name "_async")])))
                                                        (str/join ",\n            "))]
                                  (str "        self." (kebab->snake bundle-name) " = {\n"
                                       "            " method-names "\n"
                                       "        }"))))
                         (str/join "\n"))
        
        key-transformations (generate-python-key-transformations)]
    
    (str "\"\"\"\n"
         title " - " description "\n"
         "Version: " version "\n"
         "Generated on: " (java.util.Date.) "\n"
         "\"\"\"\n"
         "\n"
         "import requests\n"
         "import aiohttp\n"
         "from typing import Any, Dict, List, Optional, Union\n"
         "\n"
         "\n"
         "class PlaidClient:\n"
         "    \"\"\"\n"
         "    " title " client\n"
         "    \n"
         "    Provides both synchronous and asynchronous methods for API access.\n"
         "    Sync methods: client.projects.create_project(...)\n"
         "    Async methods: await client.projects.create_project_async(...)\n"
         "    \"\"\"\n"
         "    \n"
         "    def __init__(self, base_url: str, token: str):\n"
         "        \"\"\"\n"
         "        Initialize the PlaidClient\n"
         "        \n"
         "        Args:\n"
         "            base_url: The base URL for the API\n"
         "            token: The authentication token\n"
         "        \"\"\"\n"
         "        self.base_url = base_url.rstrip('/')\n"
         "        self.token = token\n"
         "        \n"
         "        # Initialize API bundles\n"
         bundle-init "\n"
         "    \n"
         key-transformations "\n"
         "\n"
         bundle-methods "\n")))

(defn generate-python-client-file
  "Generate a Python client from an OpenAPI AST"
  [ast output-file]
  (let [py-client (generate-python-client ast)]
    (spit output-file py-client)
    (println (str "✅ Python client generated successfully: " output-file))
    (println (str "📊 Generated " 
                  (count (re-seq #"def \w+\(" py-client)) 
                  " sync methods and "
                  (count (re-seq #"async def \w+\(" py-client))
                  " async methods"))))