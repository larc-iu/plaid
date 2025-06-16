(ns plaid.python
  (:require [clojure.string :as str]
            [camel-snake-kebab.core :as csk]
            [plaid.common :as common]))

(defn- kebab->snake
  "Convert kebab-case to snake_case"
  [s]
  (csk/->snake_case s))

(defn- kebab->pascal
  "Convert kebab-case to PascalCase"
  [s]
  (csk/->PascalCase s))

(defn- transform-key-name-python
  "Transform a key to snake_case using shared function"
  [k]
  (common/transform-key-name k :snake_case))

(defn- transform-parameter-references
  "Transform parameter references using shared function"
  [summary-text]
  (common/transform-parameter-references summary-text :snake_case))

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
  "Generate Python method parameters using ordered params from AST"
  [operation]
  (let [{:keys [path-params required-body-params optional-body-params 
                regular-query-params as-of-param]} (:ordered-params operation)
        {:keys [is-config?]} (:special-endpoints operation)
        http-method (:http-method operation)
        
        ;; Path parameters are always required
        path-param-strs (map (fn [param]
                              (str (kebab->snake param) ": str"))
                            path-params)
        
        ;; Config value parameter for config PUT endpoints
        config-param-strs (when (and is-config? (= http-method :put))
                           ["config_value: Any"])
        
        ;; Body parameters (skip if config endpoint)
        body-param-strs (when-not (and is-config? (= http-method :put))
                         (concat
                          (map (fn [{:keys [name original-name type]}]
                                 (let [param-name (transform-key-name-python name)
                                       py-type (case type
                                                "string" "str"
                                                "integer" "int"
                                                "boolean" "bool"
                                                "array" "List[Any]"
                                                "Any")]
                                   (str param-name ": " py-type)))
                               required-body-params)
                          (map (fn [{:keys [name original-name type]}]
                                 (let [param-name (transform-key-name-python name)
                                       py-type (case type
                                                "string" "str"
                                                "integer" "int"
                                                "boolean" "bool"
                                                "array" "List[Any]"
                                                "Any")]
                                   (str param-name ": " py-type " = None")))
                               optional-body-params)))
        
        ;; Query parameters
        query-param-strs (map (fn [param]
                               (let [param-name (transform-key-name-python (:name param))
                                     py-type (openapi-type-to-python (:schema param))
                                     optional-marker (if (:required? param) "" " = None")]
                                 (str param-name ": " py-type optional-marker)))
                             regular-query-params)
        
        ;; asOf parameter (only for GET requests)
        as-of-param-strs (when (and as-of-param (= http-method :get))
                          [(str (transform-key-name-python (:name as-of-param)) ": " 
                                (openapi-type-to-python (:schema as-of-param)) " = None")])
        
        ;; Combine all parameters
        all-params (concat path-param-strs config-param-strs body-param-strs 
                          query-param-strs as-of-param-strs)]
    
    (str/join ", " (filter some? all-params))))

(defn- generate-python-url-construction
  "Generate Python code to construct URL with path parameters"
  [operation]
  (let [{:keys [path path-params ordered-params]} operation
        {:keys [regular-query-params as-of-param]} ordered-params
        all-query-params (concat regular-query-params (when as-of-param [as-of-param]))
        
        ;; Build URL with path parameters
        url-construction (if (empty? path-params)
                          (str "url = f\"{self.client.base_url}" path "\"")
                          (let [py-path (reduce (fn [p param]
                                                (str/replace p (str "{" param "}") 
                                                           (str "{" (kebab->snake param) "}")))
                                              path
                                              path-params)]
                            (str "url = f\"{self.client.base_url}" py-path "\"")))
        
        ;; Generate query parameter construction
        query-construction (when (seq all-query-params)
                            (let [query-checks (map (fn [param]
                                                     (let [param-name (transform-key-name-python (:name param))
                                                           original-name (:name param)]
                                                       (str "        if " param-name " is not None:\n"
                                                            "            params['" original-name "'] = " param-name)))
                                                   all-query-params)]
                              (str "\n        params = {}\n"
                                   (str/join "\n" query-checks) "\n"
                                   "        if params:\n"
                                   "            from urllib.parse import urlencode\n"
                                   "            # Convert boolean values to lowercase strings\n"
                                   "            params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}\n"
                                   "            url += '?' + urlencode(params)")))]
    
    (str url-construction query-construction)))

(defn- generate-python-body-construction
  "Generate Python code to construct request body"
  [operation]
  (let [{:keys [ordered-params special-endpoints http-method]} operation
        {:keys [required-body-params optional-body-params]} ordered-params
        {:keys [is-config?]} special-endpoints
        body-params (concat required-body-params optional-body-params)]
    (cond
      (and is-config? (= http-method :put))
      "        body_data = config_value"
      
      ;; Special case: single array parameter that represents the entire body
      (and (= (count body-params) 1)
           (= (:type (first body-params)) "array")
           (= (:original-name (first body-params)) "body"))
      (let [param-name (transform-key-name-python (:name (first body-params)))]
        (str "        body_data = " param-name))
      
      (seq body-params)
      (let [body-dict-items (map (fn [{:keys [name original-name]}]
                                  (let [param-name (transform-key-name-python name)]
                                    (str "            '" original-name "': " param-name)))
                                body-params)]
        (str "        body_dict = {\n"
             (str/join ",\n" body-dict-items) "\n"
             "        }\n"
             "        # Filter out None values\n"
             "        body_dict = {k: v for k, v in body_dict.items() if v is not None}\n"
             "        body_data = self.client._transform_request(body_dict)"))
      
      :else nil)))

(defn- generate-python-method
  "Generate a Python method for an API endpoint"
  [operation sync?]
  (let [{:keys [bundle-name method-name path http-method summary ordered-params special-endpoints]} operation
        {:keys [required-body-params optional-body-params]} ordered-params
        {:keys [is-login? is-config?]} special-endpoints
        has-body? (or (seq required-body-params) 
                     (seq optional-body-params)
                     (and is-config? (= http-method :put)))
        
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
                     "        headers['Authorization'] = f'Bearer {self.client.token}'\n")
        
        ;; HTTP method setup
        method-call (if sync? "requests" "aiohttp.ClientSession")
        
        async-def (if sync? "def" "async def")
        await-keyword (if sync? "" "await ")
        response-json (if sync? "response.json()" "await response.json()")
        response-text (if sync? "response.text()" "await response.text()")]
    
    (str "    " async-def " " py-method-name "(" full-params ") -> Any:\n"
         "        \"\"\"\n"
         "        " (transform-parameter-references (or summary "")) "\n"
         (when (not (empty? method-params))
           (str "\n"
                "        Args:\n"
                (str/join "\n" 
                  (concat
                    ;; Path parameters
                    (map (fn [param]
                           (str "            " (kebab->snake param) ": Path parameter"))
                         (:path-params operation))
                    ;; Config value parameter
                    (when (and is-config? (= http-method :put))
                      ["            config_value: Configuration value to set"])
                    ;; Body parameters (unless config endpoint)
                    (when-not (and is-config? (= http-method :put))
                      (concat
                       (map (fn [{:keys [name original-name]}]
                              (let [param-name (transform-key-name-python name)]
                                (str "            " param-name ": Required body parameter")))
                            required-body-params)
                       (map (fn [{:keys [name original-name]}]
                              (let [param-name (transform-key-name-python name)]
                                (str "            " param-name ": Optional body parameter")))
                            optional-body-params)))
                    ;; Query parameters
                    (let [{:keys [regular-query-params as-of-param]} ordered-params
                          all-query-params (concat regular-query-params (when as-of-param [as-of-param]))]
                      (map (fn [param]
                             (str "            " (transform-key-name-python (:name param)) ": " 
                                  (if (:required? param) "Required" "Optional") " query parameter"))
                           all-query-params))))
                "\n"))
         "        \"\"\"\n"
         "        " url-construction "\n"
         (when body-construction (str body-construction "\n"))
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
                "            return self.client._transform_response(data)\n"
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
                "                    return self.client._transform_response(data)\n"
                "                return " response-text "\n")))))

(defn- generate-python-resource-class
  "Generate a Python resource class for a bundle"
  [bundle-name operations]
  (let [class-name (str (kebab->pascal bundle-name) "Resource")
        methods (mapcat (fn [op]
                         [(generate-python-method op true)
                          (generate-python-method op false)])
                       operations)]
    (str "class " class-name ":\n"
         "    \"\"\"\n"
         "    Resource class for " bundle-name " operations\n"
         "    \"\"\"\n"
         "    \n"
         "    def __init__(self, client: 'PlaidClient'):\n"
         "        self.client = client\n"
         "\n"
         (str/join "\n" methods))))

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

(defn- generate-login-method
  "Generate login method that returns a new authenticated client"
  []
  "    @classmethod
    def login(cls, base_url: str, username: str, password: str) -> 'PlaidClient':
        \"\"\"
        Authenticate and return a new client instance with token
        
        Args:
            base_url: The base URL for the API
            username: Username for authentication
            password: Password for authentication
            
        Returns:
            PlaidClient: Authenticated client instance
        \"\"\"
        temp_client = cls(base_url, '')
        response = requests.post(
            f\"{base_url}/api/v1/login\",
            json={'username': username, 'password': password},
            headers={'Content-Type': 'application/json'}
        )
        response.raise_for_status()
        token = response.json().get('token', '')
        return cls(base_url, token)
    
    @classmethod
    async def login_async(cls, base_url: str, username: str, password: str) -> 'PlaidClient':
        \"\"\"
        Authenticate asynchronously and return a new client instance with token
        
        Args:
            base_url: The base URL for the API
            username: Username for authentication
            password: Password for authentication
            
        Returns:
            PlaidClient: Authenticated client instance
        \"\"\"
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f\"{base_url}/api/v1/login\",
                json={'username': username, 'password': password},
                headers={'Content-Type': 'application/json'}
            ) as response:
                response.raise_for_status()
                data = await response.json()
                token = data.get('token', '')
                return cls(base_url, token)")

(defn generate-python-client
  "Generate the complete Python client class"
  [ast]
  (let [info (:info ast)
        title (:title info)
        version (:version info)
        description (:description info)
        bundles (:bundles ast)
        
        ;; Generate resource classes
        resource-classes (->> bundles
                             (map (fn [[bundle-name operations]]
                                    (generate-python-resource-class bundle-name operations)))
                             (str/join "\n\n"))
        
        ;; Generate resource initialization
        resource-init (->> bundles
                          (map (fn [[bundle-name _]]
                                 (let [snake-name (kebab->snake bundle-name)
                                       class-name (str (kebab->pascal bundle-name) "Resource")]
                                   (str "        self." snake-name " = " class-name "(self)"))))
                          (str/join "\n"))
        
        key-transformations (generate-python-key-transformations)
        login-methods (generate-login-method)]
    
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
         resource-classes "\n\n"
         "class PlaidClient:\n"
         "    \"\"\"\n"
         "    " title " client\n"
         "    \n"
         "    Provides both synchronous and asynchronous methods for API access.\n"
         "    Sync methods: client.projects.create(...)\n"
         "    Async methods: await client.projects.create_async(...)\n"
         "    \n"
         "    Example:\n"
         "        # Authenticate\n"
         "        client = PlaidClient.login('http://localhost:8085', 'username', 'password')\n"
         "        \n"
         "        # Create a project\n"
         "        project = client.projects.create(name='My Project')\n"
         "        \n"
         "        # Get all documents\n"
         "        docs = client.documents.list()\n"
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
         "        # Initialize resource objects\n"
         resource-init "\n"
         "    \n"
         key-transformations "\n"
         "    \n"
         login-methods "\n")))

(defn generate-python-client-file
  "Generate a Python client from an OpenAPI AST"
  [ast output-file]
  (let [py-client (generate-python-client ast)]
    (spit output-file py-client)
    (println (str "✅ Python client generated successfully: " output-file))
    (println (str "📊 Generated " 
                  (count (:bundles ast)) 
                  " resource classes with sync and async methods"))))