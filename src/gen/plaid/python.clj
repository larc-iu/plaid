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
        (str "        body_data = self.client._transform_request(" param-name ")"))

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

(defn- generate-python-sse-listen-method
  "Generate a Python SSE listen method with heartbeat confirmation support"
  [operation]
  (let [{:keys [bundle-name method-name path path-params summary]} operation
        ;; Extract project ID from path parameters
        project-id-param (first path-params) ; Should be "id" for /projects/{id}/listen
        transformed-method-name (common/transform-method-name method-name :snake_case)]

    (str "    def " transformed-method-name "(self, " (kebab->snake project-id-param) ": str, on_event: Callable[[str, Dict[str, Any]], None]) -> Dict[str, Any]:\n"
         "        \"\"\"\n"
         "        " (transform-parameter-references (or summary "")) " (with heartbeat confirmation protocol)\n"
         "        \n"
         "        Args:\n"
         "            " (kebab->snake project-id-param) ": The UUID of the project to listen to\n"
         "            on_event: Callback function that receives (event_type: str, data: dict). \n"
         "                     Heartbeat events are automatically filtered out.\n"
         "                     If it returns True, listening will stop.\n"
         "            \n"
         "        Returns:\n"
         "            Dict[str, Any]: Summary of the listening session\n"
         "        \"\"\"\n"
         "        import requests\n"
         "        import json\n"
         "        import time\n"
         "        import threading\n"
         "        \n"
         "        url = f\"{self.client.base_url}" path "\"\n"
         "        headers = {\n"
         "            'Authorization': f'Bearer {self.client.token}',\n"
         "            'Accept': 'text/event-stream',\n"
         "            'Cache-Control': 'no-cache',\n"
         "            'Connection': 'keep-alive'\n"
         "        }\n"
         "        \n"
         "        session = requests.Session()\n"
         "        session.headers.update(headers)\n"
         "        \n"
         "        # Event counters\n"
         "        audit_events_received = 0\n"
         "        message_events_received = 0\n"
         "        connection_events = 0\n"
         "        heartbeat_events = 0\n"
         "        heartbeat_confirmations_sent = 0\n"
         "        error_events = 0\n"
         "        start_time = time.time()\n"
         "        last_heartbeat = time.time()\n"
         "        client_id = None\n"
         "        \n"
         "        def send_heartbeat_confirmation(client_id: str):\n"
         "            \"\"\"Send heartbeat confirmation to server\"\"\"\n"
         "            nonlocal heartbeat_confirmations_sent\n"
         "            try:\n"
         "                heartbeat_url = f\"{self.client.base_url}/api/v1/projects/{" (kebab->snake project-id-param) "}/heartbeat\"\n"
         "                heartbeat_response = session.post(\n"
         "                    heartbeat_url,\n"
         "                    json={'client-id': client_id},\n"
         "                    headers={'Content-Type': 'application/json'}\n"
         "                )\n"
         "                if heartbeat_response.status_code == 200:\n"
         "                    heartbeat_confirmations_sent += 1\n"
         "            except Exception as e:\n"
         "                pass\n"
         "        \n"
         "        try:\n"
         "            with session.get(url, stream=True, timeout=None) as response:\n"
         "                response.raise_for_status()\n"
         "                \n"
         "                # Parse SSE stream\n"
         "                event_type = None\n"
         "                \n"
         "                for line in response.iter_lines(decode_unicode=True, chunk_size=None):\n"
         "                    if line and line.strip():\n"
         "                        if line.startswith('event: '):\n"
         "                            event_type = line[7:].strip()\n"
         "                        elif line.startswith('data: '):\n"
         "                            try:\n"
         "                                data_str = line[6:].strip()\n"
         "                                # Only attempt JSON parsing if we have non-empty, JSON-like content\n"
         "                                if data_str and len(data_str) > 0 and (data_str.startswith('{') or data_str.startswith('[') or data_str.startswith('\"')):\n"
         "                                    # Parse JSON data\n"
         "                                    data = json.loads(data_str)\n"
         "                                    \n"
         "                                    # Handle different event types\n"
         "                                    if event_type == 'connected':\n"
         "                                        connection_events += 1\n"
         "                                        client_id = data.get('client-id') or data.get('clientId')\n"
         "                                    elif event_type == 'heartbeat':\n"
         "                                        heartbeat_events += 1\n"
         "                                        last_heartbeat = time.time()\n"
         "                                        if client_id:\n"
         "                                            threading.Thread(\n"
         "                                                target=send_heartbeat_confirmation,\n"
         "                                                args=(client_id,),\n"
         "                                                daemon=True\n"
         "                                            ).start()\n"
         "                                    elif event_type == 'audit-log':\n"
         "                                        audit_events_received += 1\n"
         "                                        transformed_data = self.client._transform_response(data)\n"
         "                                        should_stop = on_event(event_type, transformed_data)\n"
         "                                        if should_stop is True:\n"
         "                                            break\n"
         "                                    elif event_type == 'message':\n"
         "                                        message_events_received += 1\n"
         "                                        transformed_data = self.client._transform_response(data)\n"
         "                                        should_stop = on_event(event_type, transformed_data)\n"
         "                                        if should_stop is True:\n"
         "                                            break\n"
         "                                    else:\n"
         "                                        transformed_data = self.client._transform_response(data)\n"
         "                                        should_stop = on_event(event_type, transformed_data)\n"
         "                                        if should_stop is True:\n"
         "                                            break\n"
         "                                else:\n"
         "                                    # Skip non-JSON data\n"
         "                                    pass\n"
         "                            except json.JSONDecodeError as e:\n"
         "                                error_events += 1\n"
         "                    elif line == '':\n"
         "                        event_type = None\n"
         "        \n"
         "        except requests.exceptions.RequestException as e:\n"
         "            error_events += 1\n"
         "        finally:\n"
         "            session.close()\n"
         "        \n"
         "        # Return session summary\n"
         "        return {\n"
         "            'audit_events': audit_events_received,\n"
         "            'message_events': message_events_received,\n"
         "            'connection_events': connection_events,\n"
         "            'heartbeat_events': heartbeat_events,\n"
         "            'heartbeat_confirmations_sent': heartbeat_confirmations_sent,\n"
         "            'error_events': error_events,\n"
         "            'duration_seconds': time.time() - start_time,\n"
         "            'last_heartbeat_seconds_ago': time.time() - last_heartbeat if heartbeat_events > 0 else None,\n"
         "            'client_id': client_id\n"
         "        }\n")))

(defn- generate-python-method
  "Generate a Python method for an API endpoint"
  [operation sync?]
  (let [{:keys [bundle-name method-name path http-method summary ordered-params special-endpoints]} operation
        {:keys [required-body-params optional-body-params]} ordered-params
        {:keys [is-login? is-config?]} special-endpoints
        has-body? (or (seq required-body-params)
                      (seq optional-body-params)
                      (and is-config? (= http-method :put)))

        ;; Method naming (transform method-name if it comes from x-client-method)
        transformed-method-name (common/transform-method-name method-name :snake_case)
        py-method-name (str transformed-method-name (when-not sync? "_async"))

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
        response-text (if sync? "response.text" "await response.text")]

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
         "        # Check if we're in batch mode\n"
         "        if self.client._is_batching:\n"
         "            operation = {\n"
         "                'path': url.replace(self.client.base_url, ''),\n"
         "                'method': '" (str/upper-case (name http-method)) "'\n"
         (when has-body? "                ,'body': body_data\n")
         "            }\n"
         "            self.client._batch_operations.append(operation)\n"
         "            return {'batched': True}  # Return placeholder\n"
         "        \n"
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
                         ;; Check if this is an SSE listen method
                          (if (= (:method-name op) "listen")
                           ;; Generate only the SSE method for listen endpoints
                            [(generate-python-sse-listen-method op)]
                           ;; Generate sync and async methods for regular endpoints
                            [(generate-python-method op true)
                             (generate-python-method op false)]))
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

(defn- generate-python-batch-methods
  "Generate Python batch control methods"
  []
  "    def begin_batch(self) -> None:
        \"\"\"
        Begin a batch of operations. All subsequent API calls will be queued instead of executed.
        \"\"\"
        self._is_batching = True
        self._batch_operations = []
    
    def submit_batch(self) -> List[Any]:
        \"\"\"
        Submit all queued batch operations as a single bulk request (synchronous).
        
        Returns:
            List[Any]: Array of results corresponding to each operation
        \"\"\"
        if not self._is_batching:
            raise ValueError('No active batch. Call begin_batch() first.')
        
        if not self._batch_operations:
            self._is_batching = False
            return []
        
        try:
            url = f\"{self.base_url}/api/v1/bulk\"
            body = []
            
            for op in self._batch_operations:
                operation_data = {
                    'path': op['path'],
                    'method': op['method'].upper()
                }
                if op.get('body'):
                    operation_data['body'] = op['body']
                body.append(operation_data)
            
            headers = {
                'Authorization': f'Bearer {self.token}',
                'Content-Type': 'application/json'
            }
            
            response = requests.post(url, json=body, headers=headers)
            response.raise_for_status()
            
            results = response.json()
            return [self._transform_response(result) for result in results]
        finally:
            self._is_batching = False
            self._batch_operations = []
    
    async def submit_batch_async(self) -> List[Any]:
        \"\"\"
        Submit all queued batch operations as a single bulk request (asynchronous).
        
        Returns:
            List[Any]: Array of results corresponding to each operation
        \"\"\"
        if not self._is_batching:
            raise ValueError('No active batch. Call begin_batch() first.')
        
        if not self._batch_operations:
            self._is_batching = False
            return []
        
        try:
            url = f\"{self.base_url}/api/v1/bulk\"
            body = []
            
            for op in self._batch_operations:
                operation_data = {
                    'path': op['path'],
                    'method': op['method'].upper()
                }
                if op.get('body'):
                    operation_data['body'] = op['body']
                body.append(operation_data)
            
            headers = {
                'Authorization': f'Bearer {self.token}',
                'Content-Type': 'application/json'
            }
            
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=body, headers=headers) as response:
                    response.raise_for_status()
                    results = await response.json()
                    return [self._transform_response(result) for result in results]
        finally:
            self._is_batching = False
            self._batch_operations = []
    
    def abort_batch(self) -> None:
        \"\"\"
        Abort the current batch without executing any operations.
        \"\"\"
        self._is_batching = False
        self._batch_operations = []
    
    def is_batch_mode(self) -> bool:
        \"\"\"
        Check if currently in batch mode.
        
        Returns:
            bool: True if batching is active
        \"\"\"
        return self._is_batching")

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
            transformed = {}
            for k, v in obj.items():
                new_key = self._transform_key_from_snake(k)
                # Preserve metadata contents without transformation
                if k == 'metadata' and isinstance(v, dict):
                    transformed[new_key] = v
                else:
                    transformed[new_key] = self._transform_request(v)
            return transformed
        return obj
    
    def _transform_response(self, obj: Any) -> Any:
        \"\"\"Transform response data from API conventions to Python conventions\"\"\"
        if obj is None or isinstance(obj, (str, int, float, bool)):
            return obj
        if isinstance(obj, list):
            return [self._transform_response(item) for item in obj]
        if isinstance(obj, dict):
            transformed = {}
            for k, v in obj.items():
                new_key = self._transform_key_to_snake(k)
                # Preserve metadata contents without transformation
                if new_key == 'metadata' and isinstance(v, dict):
                    transformed[new_key] = v
                else:
                    transformed[new_key] = self._transform_response(v)
            return transformed
        return obj
    
")

(defn- generate-login-method
  "Generate login method that returns a new authenticated client"
  []
  "    @classmethod
    def login(cls, base_url: str, user_id: str, password: str) -> 'PlaidClient':
        \"\"\"
        Authenticate and return a new client instance with token
        
        Args:
            base_url: The base URL for the API
            user_id: User ID for authentication
            password: Password for authentication
            
        Returns:
            PlaidClient: Authenticated client instance
        \"\"\"
        temp_client = cls(base_url, '')
        response = requests.post(
            f\"{base_url}/api/v1/login\",
            json={'user-id': user_id, 'password': password},
            headers={'Content-Type': 'application/json'}
        )
        response.raise_for_status()
        token = response.json().get('token', '')
        return cls(base_url, token)
    
    @classmethod
    async def login_async(cls, base_url: str, user_id: str, password: str) -> 'PlaidClient':
        \"\"\"
        Authenticate asynchronously and return a new client instance with token
        
        Args:
            base_url: The base URL for the API
            user_id: User ID for authentication
            password: Password for authentication
            
        Returns:
            PlaidClient: Authenticated client instance
        \"\"\"
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f\"{base_url}/api/v1/login\",
                json={'user-id': user_id, 'password': password},
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

        ;; Generate batch builder class
        batch-methods (generate-python-batch-methods)

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
         "from typing import Any, Dict, List, Optional, Union, Callable\n"
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
         "    Batch operations:\n"
         "        # Synchronous batch\n"
         "        client.begin_batch()\n"
         "        client.projects.create(name='Project 1')  # Gets queued\n"
         "        client.projects.create(name='Project 2')  # Gets queued\n"
         "        results = client.submit_batch()  # Executes all as one bulk request\n"
         "        \n"
         "        # Asynchronous batch\n"
         "        client.begin_batch()\n"
         "        await client.projects.create_async(name='Project 1')  # Gets queued\n"
         "        await client.projects.create_async(name='Project 2')  # Gets queued\n"
         "        results = await client.submit_batch_async()  # Executes all as one bulk request\n"
         "    \n"
         "    Example:\n"
         "        # Authenticate\n"
         "        client = PlaidClient.login('http://localhost:8085', 'user_id', 'password')\n"
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
         "        # Initialize batch state\n"
         "        self._is_batching = False\n"
         "        self._batch_operations = []\n"
         "        \n"
         "        # Initialize resource objects\n"
         resource-init "\n"
         "    \n"
         key-transformations "\n"
         "    \n"
         batch-methods "\n"
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