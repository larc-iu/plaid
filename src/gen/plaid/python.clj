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

(defn- generate-python-sse-listen-method
  "Generate a Python SSE listen method for audit events"
  [operation]
  (let [{:keys [bundle-name method-name path path-params summary]} operation
        ;; Extract project ID from path parameters
        project-id-param (first path-params)  ; Should be "id" for /projects/{id}/listen
        transformed-method-name (common/transform-method-name method-name :snake_case)]
    
    (str "    def " transformed-method-name "(self, " (kebab->snake project-id-param) ": str, on_event: Callable[[str, Dict[str, Any]], None], timeout: int = 30) -> Dict[str, Any]:\n"
         "        \"\"\"\n"
         "        " (transform-parameter-references (or summary "")) "\n"
         "        \n"
         "        Args:\n"
         "            " (kebab->snake project-id-param) ": The UUID of the project to listen to\n"
         "            on_event: Callback function that receives (event_type: str, data: dict)\n"
         "            timeout: Maximum time to listen in seconds (None for infinite)\n"
         "            \n"
         "        Returns:\n"
         "            Dict[str, Any]: Summary of the listening session\n"
         "        \"\"\"\n"
         "        import requests\n"
         "        import json\n"
         "        import time\n"
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
         "        audit_events_received = 0\n"
         "        connection_events = 0\n"
         "        heartbeat_events = 0\n"
         "        error_events = 0\n"
         "        start_time = time.time()\n"
         "        last_heartbeat = time.time()\n"
         "        \n"
         "        try:\n"
         "            with session.get(url, stream=True, timeout=None) as response:\n"
         "                response.raise_for_status()\n"
         "                \n"
         "                for line in response.iter_lines(decode_unicode=True, chunk_size=None):\n"
         "                    if timeout and (time.time() - start_time) > timeout:\n"
         "                        break\n"
         "                        \n"
         "                    if line and line.strip():\n"
         "                        if line.startswith('event: '):\n"
         "                            event_type = line[7:].strip()\n"
         "                            # Event type received\n"
         "                        elif line.startswith('data: '):\n"
         "                            try:\n"
         "                                data_str = line[6:].strip()\n"
         "                                # Only attempt JSON parsing if we have non-empty, JSON-like content\n"
         "                                if data_str and len(data_str) > 0 and (data_str.startswith('{') or data_str.startswith('[') or data_str.startswith('\"')):\n"
         "                                    # Parse JSON data\n"
         "                                    data = json.loads(data_str)\n"
         "                                    \n"
         "                                    # Handle different event types internally\n"
         "                                    if event_type == 'connected':\n"
         "                                        connection_events += 1\n"
         "                                        # Connected to event stream\n"
         "                                    elif event_type == 'heartbeat':\n"
         "                                        heartbeat_events += 1\n"
         "                                        last_heartbeat = time.time()\n"
         "                                        # Heartbeats handled silently\n"
         "                                    elif event_type == 'audit-log':\n"
         "                                        audit_events_received += 1\n"
         "                                        # Transform response data and call user callback\n"
         "                                        transformed_data = self.client._transform_response(data)\n"
         "                                        on_event(event_type, transformed_data)\n"
         "                                    else:\n"
         "                                        # Pass all other event types to the callback\n"
         "                                        transformed_data = self.client._transform_response(data)\n"
         "                                        on_event(event_type, transformed_data)\n"
         "                                else:\n"
         "                                    # Skip non-JSON data\n"
         "                                    pass\n"
         "                            except json.JSONDecodeError as e:\n"
         "                                error_events += 1\n"
         "                                # JSON decode error occurred\n"
         "                                # Don't call user callback for JSON errors\n"
         "        \n"
         "        except requests.exceptions.RequestException as e:\n"
         "            error_events += 1\n"
         "            # Connection error occurred\n"
         "            # Don't call user callback for connection errors\n"
         "        finally:\n"
         "            # Explicitly close the session to ensure connection cleanup\n"
         "            session.close()\n"
         "        \n"
         "        # Return session summary\n"
         "        return {\n"
         "            'audit_events': audit_events_received,\n"
         "            'connection_events': connection_events,\n"
         "            'heartbeat_events': heartbeat_events,\n"
         "            'error_events': error_events,\n"
         "            'duration_seconds': time.time() - start_time,\n"
         "            'last_heartbeat_seconds_ago': time.time() - last_heartbeat if heartbeat_events > 0 else None\n"
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

(defn- generate-python-batch-builder-class
  "Generate Python BatchBuilder class"  
  []
  "class BatchBuilder:
    \"\"\"
    BatchBuilder class for building and executing batch operations
    \"\"\"
    
    def __init__(self, client: 'PlaidClient'):
        self.client = client
        self.operations = []
    
    def add(self, method, *args, **kwargs) -> 'BatchBuilder':
        \"\"\"
        Add an operation to the batch
        
        Args:
            method: The client method to call
            *args: Positional arguments for the method
            **kwargs: Keyword arguments for the method
            
        Returns:
            BatchBuilder: Returns self for chaining
        \"\"\"
        operation = self._extract_method_info(method, args, kwargs)
        self.operations.append(operation)
        return self
    
    def execute(self) -> List[Any]:
        \"\"\"
        Execute all operations in the batch synchronously
        
        Returns:
            List[Any]: List of results corresponding to each operation
        \"\"\"
        if not self.operations:
            return []
        
        url = f\"{self.client.base_url}/api/v1/bulk\"
        body = []
        
        for op in self.operations:
            operation_data = {
                'path': op['path'],
                'method': op['method'].upper()
            }
            if op.get('body'):
                operation_data['body'] = op['body']
            body.append(operation_data)
        
        headers = {
            'Authorization': f'Bearer {self.client.token}',
            'Content-Type': 'application/json'
        }
        
        response = requests.post(url, json=body, headers=headers)
        response.raise_for_status()
        
        results = response.json()
        return [self.client._transform_response(result) for result in results]
    
    async def execute_async(self) -> List[Any]:
        \"\"\"
        Execute all operations in the batch asynchronously
        
        Returns:
            List[Any]: List of results corresponding to each operation
        \"\"\"
        if not self.operations:
            return []
        
        url = f\"{self.client.base_url}/api/v1/bulk\"
        body = []
        
        for op in self.operations:
            operation_data = {
                'path': op['path'],
                'method': op['method'].upper()
            }
            if op.get('body'):
                operation_data['body'] = op['body']
            body.append(operation_data)
        
        headers = {
            'Authorization': f'Bearer {self.client.token}',
            'Content-Type': 'application/json'
        }
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body, headers=headers) as response:
                response.raise_for_status()
                results = await response.json()
                return [self.client._transform_response(result) for result in results]
    
    def _extract_method_info(self, method, args, kwargs) -> Dict[str, Any]:
        \"\"\"
        Extract method information from a bound method and its arguments
        \"\"\"
        # Find the method in the client resources
        for resource_name in dir(self.client):
            resource = getattr(self.client, resource_name)
            if hasattr(resource, '__class__') and hasattr(resource.__class__, '__name__'):
                if resource.__class__.__name__.endswith('Resource'):
                    for method_name in dir(resource):
                        if not method_name.startswith('_'):
                            bound_method = getattr(resource, method_name)
                            if bound_method == method:
                                return self._build_operation_from_method(
                                    resource_name, method_name, args, kwargs)
        
        raise ValueError('Method not found in client resources')
    
    def _build_operation_from_method(self, resource_name: str, method_name: str, 
                                   args: tuple, kwargs: dict) -> Dict[str, Any]:
        \"\"\"
        Build operation descriptor from method name and arguments
        \"\"\"
        # This is a simplified approach - we simulate the method call
        # to capture the HTTP request details
        return self._simulate_method_call(resource_name, method_name, args, kwargs)
    
    def _simulate_method_call(self, resource_name: str, method_name: str, 
                            args: tuple, kwargs: dict) -> Dict[str, Any]:
        \"\"\"
        Simulate a method call to extract the operation details
        \"\"\"
        # Import the mock library to patch requests/aiohttp
        try:
            from unittest.mock import patch, MagicMock
        except ImportError:
            from mock import patch, MagicMock
        
        captured_operation = None
        
        def capture_request(method, url, **request_kwargs):
            nonlocal captured_operation
            from urllib.parse import urlparse
            parsed_url = urlparse(url)
            
            captured_operation = {
                'path': parsed_url.path,
                'method': method.lower(),
                'body': request_kwargs.get('json')
            }
            
            # Return a mock response
            mock_response = MagicMock()
            mock_response.raise_for_status.return_value = None
            mock_response.json.return_value = {}
            mock_response.text.return_value = ''
            return mock_response
        
        # Patch requests methods
        with patch('requests.get', side_effect=lambda url, **kwargs: capture_request('GET', url, **kwargs)), \\
             patch('requests.post', side_effect=lambda url, **kwargs: capture_request('POST', url, **kwargs)), \\
             patch('requests.put', side_effect=lambda url, **kwargs: capture_request('PUT', url, **kwargs)), \\
             patch('requests.patch', side_effect=lambda url, **kwargs: capture_request('PATCH', url, **kwargs)), \\
             patch('requests.delete', side_effect=lambda url, **kwargs: capture_request('DELETE', url, **kwargs)):
            
            # Get the resource and method
            resource = getattr(self.client, resource_name)
            method = getattr(resource, method_name)
            
            # Call the method to capture the operation
            try:
                method(*args, **kwargs)
            except Exception:
                # Ignore exceptions from the simulated call
                pass
        
        if captured_operation is None:
            raise ValueError(f'Could not capture operation for {resource_name}.{method_name}')
        
        return captured_operation


")

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
    
    def batch(self) -> BatchBuilder:
        \"\"\"
        Create a new batch builder for executing multiple operations
        
        Returns:
            BatchBuilder: New batch builder instance
        \"\"\"
        return BatchBuilder(self)")

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
        
        ;; Generate batch builder class
        batch-builder-class (generate-python-batch-builder-class)
        
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
         batch-builder-class "\n\n"
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
         "        results = client.batch() \\\n"
         "            .add(client.projects.create, name='Project 1') \\\n"
         "            .add(client.projects.create, name='Project 2') \\\n"
         "            .execute()\n"
         "        \n"
         "        # Asynchronous batch\n"
         "        results = await client.batch() \\\n"
         "            .add(client.projects.create, name='Project 1') \\\n"
         "            .add(client.projects.create, name='Project 2') \\\n"
         "            .execute_async()\n"
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