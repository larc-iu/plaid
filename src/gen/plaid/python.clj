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
        "string" (if (= format "binary") "Union[BinaryIO, str, Tuple[str, BinaryIO]]" "str")
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
                           (map (fn [{:keys [name original-name type is-file?]}]
                                  (let [param-name (transform-key-name-python name)
                                        py-type (if is-file?
                                                  "Union[BinaryIO, str, Tuple[str, BinaryIO]]"
                                                  (case type
                                                    "string" "str"
                                                    "integer" "int"
                                                    "boolean" "bool"
                                                    "array" "List[Any]"
                                                    "Any"))]
                                    (str param-name ": " py-type)))
                                required-body-params)
                           (map (fn [{:keys [name original-name type is-file?]}]
                                  (let [param-name (transform-key-name-python name)
                                        py-type (if is-file?
                                                  "Union[BinaryIO, str, Tuple[str, BinaryIO]]"
                                                  (case type
                                                    "string" "str"
                                                    "integer" "int"
                                                    "boolean" "bool"
                                                    "array" "List[Any]"
                                                    "Any"))]
                                    (str param-name ": " py-type " = None")))
                                optional-body-params)))

        ;; Query parameters (exclude document-version)
        filtered-query-params (filter #(not= (:name %) "document-version") regular-query-params)
        query-param-strs (map (fn [param]
                                (let [param-name (transform-key-name-python (:name param))
                                      py-type (openapi-type-to-python (:schema param))
                                      optional-marker (if (:required? param) "" " = None")]
                                  (str param-name ": " py-type optional-marker)))
                              filtered-query-params)

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
        ;; Filter out document-version from query params
        filtered-query-params (filter #(not= (:name %) "document-version") regular-query-params)
        all-query-params (concat filtered-query-params (when as-of-param [as-of-param]))

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
  (let [{:keys [method-name ordered-params special-endpoints http-method]} operation
        {:keys [required-body-params optional-body-params]} ordered-params
        {:keys [is-config?]} special-endpoints
        body-params (concat required-body-params optional-body-params)
        has-files? (some :is-file? body-params)]
    (cond
      (and is-config? (= http-method :put))
      "        body_data = config_value"

      ;; Handle multipart/form-data with files
      has-files?
      (let [files-dict-items (map (fn [{:keys [name original-name is-file?]}]
                                    (let [param-name (transform-key-name-python name)]
                                      (str "            '" original-name "': " param-name)))
                                  body-params)]
        (str "        files_dict = {\n"
             (str/join ",\n" files-dict-items) "\n"
             "        }\n"
             "        # Filter out None values\n"
             "        files_data = {k: v for k, v in files_dict.items() if v is not None}\n"))

      (= method-name "send-message")
      (str "        body_data = {'body': body}")

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
  "Generate a Python SSE listen method with enhanced connection management"
  [operation]
  (let [{:keys [bundle-name method-name path path-params summary]} operation
        ;; Extract project ID from path parameters
        project-id-param (first path-params) ; Should be "id" for /projects/{id}/listen
        transformed-method-name (common/transform-method-name method-name :snake_case)]

    (str "    def " transformed-method-name "(self, " (kebab->snake project-id-param) ": str, on_event: Callable[[str, Dict[str, Any]], Optional[bool]]) -> Dict[str, Any]:\n"
         "        \"\"\"\n"
         "        " (transform-parameter-references (or summary "")) " (with enhanced connection management)\n"
         "        \n"
         "        Args:\n"
         "            " (kebab->snake project-id-param) ": The UUID of the project to listen to\n"
         "            on_event: Callback function that receives (event_type: str, data: dict). \n"
         "                     Returns True to stop listening, False/None to continue.\n"
         "                     Heartbeat events are automatically handled.\n"
         "            \n"
         "        Returns:\n"
         "            Dict[str, Any]: Connection statistics and session summary\n"
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
         "        # Add user agent header if set\n"
         "        if self.client.agent_name:\n"
         "            headers['X-Agent-Name'] = self.client.agent_name\n"
         "        \n"
         "        session = requests.Session()\n"
         "        session.headers.update(headers)\n"
         "        \n"
         "        # Connection state tracking (similar to JavaScript implementation)\n"
         "        start_time = time.time()\n"
         "        is_connected = False\n"
         "        is_closed = False\n"
         "        client_id = None\n"
         "        \n"
         "        # Event statistics (comprehensive like JavaScript)\n"
         "        event_stats = {\n"
         "            'audit-log': 0,\n"
         "            'message': 0,\n"
         "            'heartbeat': 0,\n"
         "            'connected': 0,\n"
         "            'other': 0\n"
         "        }\n"
         "        \n"
         "        # Heartbeat tracking\n"
         "        heartbeat_confirmations_sent = 0\n"
         "        last_heartbeat = start_time\n"
         "        \n"
         "        def send_heartbeat_confirmation(client_id: str):\n"
         "            \"\"\"Send heartbeat confirmation to server (thread-safe)\"\"\"\n"
         "            nonlocal heartbeat_confirmations_sent\n"
         "            try:\n"
         "                heartbeat_url = f\"{self.client.base_url}/api/v1/projects/{" (kebab->snake project-id-param) "}/heartbeat\"\n"
         "                heartbeat_response = session.post(\n"
         "                    heartbeat_url,\n"
         "                    json={'client-id': client_id},\n"
         "                    headers={'Content-Type': 'application/json'},\n"
         "                    timeout=5.0  # Short timeout for heartbeat\n"
         "                )\n"
         "                if heartbeat_response.status_code == 200:\n"
         "                    heartbeat_confirmations_sent += 1\n"
         "            except Exception:\n"
         "                # Silently ignore heartbeat confirmation failures\n"
         "                pass\n"
         "        \n"
         "        def get_connection_stats():\n"
         "            \"\"\"Get real-time connection statistics (similar to JavaScript getStats())\"\"\"\n"
         "            return {\n"
         "                'duration_seconds': time.time() - start_time,\n"
         "                'is_connected': is_connected,\n"
         "                'is_closed': is_closed,\n"
         "                'client_id': client_id,\n"
         "                'events': event_stats.copy(),\n"
         "                'heartbeat_confirmations_sent': heartbeat_confirmations_sent,\n"
         "                'last_heartbeat_seconds_ago': time.time() - last_heartbeat if event_stats['heartbeat'] > 0 else None,\n"
         "                'connection_state': 'closed' if is_closed else ('connected' if is_connected else 'connecting')\n"
         "            }\n"
         "        \n"
         "        try:\n"
         "            with session.get(url, stream=True, timeout=None) as response:\n"
         "                response.raise_for_status()\n"
         "                \n"
         "                is_connected = True\n"
         "                \n"
         "                # Parse SSE stream with enhanced error handling\n"
         "                event_type = None\n"
         "                data_buffer = ''\n"
         "                \n"
         "                for line in response.iter_lines(decode_unicode=True, chunk_size=None):\n"
         "                    if is_closed:\n"
         "                        break\n"
         "                    \n"
         "                    if line is not None:  # Handle None lines from iter_lines\n"
         "                        line = line.strip()\n"
         "                        \n"
         "                        if line.startswith('event: '):\n"
         "                            event_type = line[7:].strip()\n"
         "                        elif line.startswith('data: '):\n"
         "                            data_buffer = line[6:].strip()\n"
         "                        elif line == '' and event_type and data_buffer:\n"
         "                            # Complete SSE message received\n"
         "                            try:\n"
         "                                # Track event statistics\n"
         "                                event_stats[event_type] = event_stats.get(event_type, 0) + 1\n"
         "                                if event_type not in event_stats:\n"
         "                                    event_stats['other'] += 1\n"
         "                                \n"
         "                                # Parse JSON data only if it looks like JSON\n"
         "                                if (data_buffer and \n"
         "                                    (data_buffer.startswith('{') or \n"
         "                                     data_buffer.startswith('[') or \n"
         "                                     data_buffer.startswith('\"'))):\n"
         "                                    \n"
         "                                    data = json.loads(data_buffer)\n"
         "                                    \n"
         "                                    # Handle specific event types\n"
         "                                    if event_type == 'connected':\n"
         "                                        client_id = data.get('client-id') or data.get('clientId')\n"
         "                                    elif event_type == 'heartbeat':\n"
         "                                        last_heartbeat = time.time()\n"
         "                                        if client_id:\n"
         "                                            # Send heartbeat confirmation in background thread\n"
         "                                            threading.Thread(\n"
         "                                                target=send_heartbeat_confirmation,\n"
         "                                                args=(client_id,),\n"
         "                                                daemon=True\n"
         "                                            ).start()\n"
         "                                    else:\n"
         "                                        # Pass event to user callback (audit-log, message, etc.)\n"
         "                                        transformed_data = self.client._transform_response(data)\n"
         "                                        try:\n"
         "                                            should_stop = on_event(event_type, transformed_data)\n"
         "                                            if should_stop is True:\n"
         "                                                is_closed = True\n"
         "                                                break\n"
         "                                        except Exception:\n"
         "                                            # Continue listening even if callback fails\n"
         "                                            pass\n"
         "                                else:\n"
         "                                    # Skip non-JSON data or malformed content\n"
         "                                    pass\n"
         "                                    \n"
         "                            except json.JSONDecodeError:\n"
         "                                # Skip malformed JSON data\n"
         "                                pass\n"
         "                            except Exception:\n"
         "                                # Skip any other parsing errors\n"
         "                                pass\n"
         "                            finally:\n"
         "                                # Reset for next message\n"
         "                                event_type = None\n"
         "                                data_buffer = ''\n"
         "        \n"
         "        except requests.exceptions.RequestException:\n"
         "            # Connection errors are expected when closing/timing out\n"
         "            pass\n"
         "        except Exception:\n"
         "            # Any other unexpected errors\n"
         "            pass\n"
         "        finally:\n"
         "            is_connected = False\n"
         "            is_closed = True\n"
         "            session.close()\n"
         "        \n"
         "        # Return comprehensive session summary\n"
         "        return get_connection_stats()\n")))

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

        ;; Check if we have file parameters
        body-params (concat required-body-params optional-body-params)
        has-files? (some :is-file? body-params)

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
                    ;; Query parameters (excluding document-version)
                           (let [{:keys [regular-query-params as-of-param]} ordered-params
                                 all-query-params (concat regular-query-params (when as-of-param [as-of-param]))
                                 filtered-params (filter #(not= (:name %) "document-version") all-query-params)]
                             (map (fn [param]
                                    (str "            " (transform-key-name-python (:name param)) ": "
                                         (if (:required? param) "Required" "Optional") " query parameter"))
                                  filtered-params))))
                "\n"))
         "        \"\"\"\n"
         "        " url-construction "\n"
         (when body-construction (str body-construction "\n"))
         "        \n"
         (if has-files?
           "        headers = {}  # Don't set Content-Type for multipart, let requests handle it\n"
           "        headers = {'Content-Type': 'application/json'}\n")
         "        # Add user agent header if set\n"
         "        if self.client.agent_name:\n"
         "            headers['X-Agent-Name'] = self.client.agent_name\n"
         auth-header
         "        \n"
         "        # Add document-version parameter in strict mode for non-GET requests\n"
         "        if self.client._strict_mode_document_id and '" (str/upper-case (name http-method)) "' != 'GET':\n"
         "            doc_id = self.client._strict_mode_document_id\n"
         "            if doc_id in self.client._document_versions:\n"
         "                if 'params' not in locals():\n"
         "                    params = {}\n"
         "                params['document-version'] = self.client._document_versions[doc_id]\n"
         "                from urllib.parse import urlencode\n"
         "                params = {k: str(v).lower() if isinstance(v, bool) else v for k, v in params.items()}\n"
         "                url += ('&' if '?' in url else '?') + urlencode({'document-version': params['document-version']})\n"
         "        \n"
         "        # Check if we're in batch mode\n"
         "        if self.client._is_batching:\n"
         (if (:is-non-batchable? special-endpoints)
           (str "            raise ValueError('This endpoint cannot be used in batch mode: " path "')\n")
           (str "            operation = {\n"
                "                'path': url.replace(self.client.base_url, ''),\n"
                "                'method': '" (str/upper-case (name http-method)) "'\n"
                (when has-body? "                ,'body': body_data\n")
                "            }\n"
                "            self.client._batch_operations.append(operation)\n"
                "            return {'batched': True}  # Return placeholder\n"))
         "        \n"
         "        \n"
         (if sync?
           ;; Sync version using requests
           (str "        try:\n"
                "            response = requests." (str/lower-case (name http-method))
                "(url"
                (cond
                  (and has-body? has-files?) ", files=files_data"
                  has-body? ", json=body_data"
                  :else "")
                ", headers=headers)\n"
                "            \n"
                "            if not response.ok:\n"
                "                # Parse error response\n"
                "                try:\n"
                "                    error_data = response.json()\n"
                "                except requests.exceptions.JSONDecodeError:\n"
                "                    error_data = {'message': response.text}\n"
                "                \n"
                "                server_message = error_data.get('error') or error_data.get('message') or response.reason\n"
                "                raise PlaidAPIError(\n"
                "                    f'HTTP {response.status_code} {server_message} at {url}',\n"
                "                    response.status_code,\n"
                "                    url,\n"
                "                    '" (str/upper-case (name http-method)) "',\n"
                "                    error_data\n"
                "                )\n"
                "            \n"
                "            # Extract document versions from response headers\n"
                "            self.client._extract_document_versions(dict(response.headers))\n"
                "            \n"
                (if (and (:is-binary-response? special-endpoints) (= http-method :get))
                  "            # Return raw binary content for media downloads\n            return response.content\n"
                  (str "            if 'application/json' in response.headers.get('content-type', '').lower():\n"
                       "                data = " response-json "\n"
                       "                return self.client._transform_response(data)\n"
                       "            return " response-text "\n"))
                "        \n"
                "        except requests.exceptions.RequestException as e:\n"
                "            if hasattr(e, 'status'):\n"
                "                raise e  # Re-raise our custom error\n"
                "            # Handle network errors\n"
                "            raise PlaidAPIError(\n"
                "                f'Network error: {str(e)} at {url}',\n"
                "                0,\n"
                "                url,\n"
                "                '" (str/upper-case (name http-method)) "',\n"
                "                {'original_error': str(e)}\n"
                "            )\n")
           ;; Async version using aiohttp
           (str "        try:\n"
                "            async with aiohttp.ClientSession() as session:\n"
                "                async with session." (str/lower-case (name http-method))
                "(url"
                (cond
                  (and has-body? has-files?) ", data=files_data" ;; aiohttp uses data for files
                  has-body? ", json=body_data"
                  :else "")
                ", headers=headers) as response:\n"
                "                    \n"
                "                    if not response.ok:\n"
                "                        # Parse error response\n"
                "                        try:\n"
                "                            error_data = await response.json()\n"
                "                        except aiohttp.ContentTypeError:\n"
                "                            error_data = {'message': await response.text()}\n"
                "                        \n"
                "                        server_message = error_data.get('error') or error_data.get('message') or response.reason\n"
                "                        raise PlaidAPIError(\n"
                "                            f'HTTP {response.status} {server_message} at {url}',\n"
                "                            response.status,\n"
                "                            url,\n"
                "                            '" (str/upper-case (name http-method)) "',\n"
                "                            error_data\n"
                "                        )\n"
                "                    \n"
                "                    # Extract document versions from response headers\n"
                "                    self.client._extract_document_versions(dict(response.headers))\n"
                "                    \n"
                (if (and (:is-binary-response? special-endpoints) (= http-method :get))
                  "                    # Return raw binary content for media downloads\n                    return await response.read()\n"
                  (str "                    content_type = response.headers.get('content-type', '').lower()\n"
                       "                    if 'application/json' in content_type:\n"
                       "                        data = " response-json "\n"
                       "                        return self.client._transform_response(data)\n"
                       "                    return " response-text "\n"))
                "        \n"
                "        except aiohttp.ClientError as e:\n"
                "            if hasattr(e, 'status'):\n"
                "                raise e  # Re-raise our custom error\n"
                "            # Handle network errors\n"
                "            raise PlaidAPIError(\n"
                "                f'Network error: {str(e)} at {url}',\n"
                "                0,\n"
                "                url,\n"
                "                '" (str/upper-case (name http-method)) "',\n"
                "                {'original_error': str(e)}\n"
                "            )\n")))))

(defn- generate-python-resource-class
  "Generate a Python resource class for a bundle"
  ([bundle-name operations]
   (generate-python-resource-class bundle-name operations ""))
  ([bundle-name operations additions]
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
          (str/join "\n" methods)
          additions))))

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
        Submit all queued batch operations as a single batch request (synchronous).
        
        Returns:
            List[Any]: Array of results corresponding to each operation
        \"\"\"
        if not self._is_batching:
            raise ValueError('No active batch. Call begin_batch() first.')
        
        if not self._batch_operations:
            self._is_batching = False
            return []
        
        try:
            url = f\"{self.base_url}/api/v1/batch\"
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
            
            if not response.ok:
                # Parse error response
                try:
                    error_data = response.json()
                except requests.exceptions.JSONDecodeError:
                    error_data = {'message': response.text}
                
                server_message = error_data.get('error') or error_data.get('message') or response.reason
                raise PlaidAPIError(
                    f'HTTP {response.status_code} {server_message} at {url}',
                    response.status_code,
                    url,
                    'POST',
                    error_data
                )
            
            results = response.json()
            return [self._transform_response(result) for result in results]
        finally:
            self._is_batching = False
            self._batch_operations = []
    
    async def submit_batch_async(self) -> List[Any]:
        \"\"\"
        Submit all queued batch operations as a single batch request (asynchronous).
        
        Returns:
            List[Any]: Array of results corresponding to each operation
        \"\"\"
        if not self._is_batching:
            raise ValueError('No active batch. Call begin_batch() first.')
        
        if not self._batch_operations:
            self._is_batching = False
            return []
        
        try:
            url = f\"{self.base_url}/api/v1/batch\"
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
                    
                    if not response.ok:
                        # Parse error response
                        try:
                            error_data = await response.json()
                        except aiohttp.ContentTypeError:
                            error_data = {'message': await response.text()}
                        
                        server_message = error_data.get('error') or error_data.get('message') or response.reason
                        raise PlaidAPIError(
                            f'HTTP {response.status} {server_message} at {url}',
                            response.status,
                            url,
                            'POST',
                            error_data
                        )
                    
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
    
    def _extract_document_versions(self, response_headers: Dict[str, str]) -> None:
        \"\"\"Extract and update document versions from response headers\"\"\"
        doc_versions_header = response_headers.get('X-Document-Versions')
        if doc_versions_header:
            try:
                versions_map = json.loads(doc_versions_header)
                if isinstance(versions_map, dict):
                    self._document_versions.update(versions_map)
            except (json.JSONDecodeError, TypeError):
                # Ignore malformed header
                pass
    
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
        
        if not response.ok:
            # Parse error response
            try:
                error_data = response.json()
            except requests.exceptions.JSONDecodeError:
                error_data = {'message': response.text}
            
            server_message = error_data.get('error') or error_data.get('message') or response.reason
            raise PlaidAPIError(
                f'HTTP {response.status_code} {server_message} at {base_url}/api/v1/login',
                response.status_code,
                f'{base_url}/api/v1/login',
                'POST',
                error_data
            )
        
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
                
                if not response.ok:
                    # Parse error response
                    try:
                        error_data = await response.json()
                    except aiohttp.ContentTypeError:
                        error_data = {'message': await response.text()}
                    
                    server_message = error_data.get('error') or error_data.get('message') or response.reason
                    raise PlaidAPIError(
                        f'HTTP {response.status} {server_message} at {base_url}/api/v1/login',
                        response.status,
                        f'{base_url}/api/v1/login',
                        'POST',
                        error_data
                    )
                
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


        ;; Generate improved messages resource class with better method discovery
        messages-resource-class-additions (str "    def _generate_request_id(self) -> str:\n"
                                               "        \"\"\"Generate a unique request ID for tracking service coordination\"\"\"\n"
                                               "        import uuid\n"
                                               "        import time\n"
                                               "        return f\"req_{uuid.uuid4().hex[:8]}_{int(time.time() * 1000)}\"\n"
                                               "    \n"
                                               "    def _create_service_message(self, msg_type: str, **data) -> Dict[str, Any]:\n"
                                               "        \"\"\"Create a structured service message with timestamp\"\"\"\n"
                                               "        from datetime import datetime\n"
                                               "        return {\n"
                                               "            'type': msg_type,\n"
                                               "            'timestamp': f\"{datetime.utcnow().isoformat()}Z\",\n"
                                               "            **data\n"
                                               "        }\n"
                                               "    \n"
                                               "    def _is_service_message(self, data: Any) -> bool:\n"
                                               "        \"\"\"Check if data is a structured service message\"\"\"\n"
                                               "        return (isinstance(data, dict) and \n"
                                               "                'type' in data and \n"
                                               "                'timestamp' in data)\n"
                                               "    \n"
                                               "    def discover_services(self, project_id: str, timeout: int = 3000) -> List[Dict[str, Any]]:\n"
                                               "        \"\"\"\n"
                                               "        Discover available services in a project\n"
                                               "        \n"
                                               "        Sends a service discovery request and collects responses from all\n"
                                               "        registered services within the timeout period.\n"
                                               "        \n"
                                               "        Args:\n"
                                               "            project_id: The UUID of the project to query\n"
                                               "            timeout: Timeout in milliseconds (default: 3000)\n"
                                               "            \n"
                                               "        Returns:\n"
                                               "            List of discovered service information dictionaries\n"
                                               "        \"\"\"\n"
                                               "        import threading\n"
                                               "        import time\n"
                                               "        \n"
                                               "        request_id = self._generate_request_id()\n"
                                               "        discovered_services = []\n"
                                               "        discovery_complete = threading.Event()\n"
                                               "        connection_active = threading.Event()\n"
                                               "        \n"
                                               "        def on_event(event_type: str, event_data: Dict[str, Any]) -> Optional[bool]:\n"
                                               "            if event_type == 'message' and self._is_service_message(event_data.get('data')):\n"
                                               "                message = event_data['data']\n"
                                               "                \n"
                                               "                if (message.get('type') == 'service_registration' and \n"
                                               "                    message.get('requestId') == request_id):\n"
                                               "                    discovered_services.append({\n"
                                               "                        'service_id': message.get('serviceId'),\n"
                                               "                        'service_name': message.get('serviceName'),\n"
                                               "                        'description': message.get('description'),\n"
                                               "                        'timestamp': message.get('timestamp')\n"
                                               "                    })\n"
                                               "            \n"
                                               "            # Check if we should stop listening\n"
                                               "            if discovery_complete.is_set():\n"
                                               "                return True\n"
                                               "            return None\n"
                                               "        \n"
                                               "        # Start listening in a separate thread\n"
                                               "        def listen_thread():\n"
                                               "            try:\n"
                                               "                connection_active.set()\n"
                                               "                self.listen(project_id, on_event)\n"
                                               "            except Exception as e:\n"
                                               "                # Connection errors are expected when timing out\n"
                                               "                pass\n"
                                               "        \n"
                                               "        thread = threading.Thread(target=listen_thread, daemon=True)\n"
                                               "        thread.start()\n"
                                               "        \n"
                                               "        # Wait for connection to be established\n"
                                               "        connection_active.wait(timeout=1.0)\n"
                                               "        \n"
                                               "        if connection_active.is_set():\n"
                                               "            # Send discovery request\n"
                                               "            discovery_message = self._create_service_message('service_discovery', requestId=request_id)\n"
                                               "            try:\n"
                                               "                self.send_message(project_id, discovery_message)\n"
                                               "            except Exception as e:\n"
                                               "                # If send fails, mark discovery as complete\n"
                                               "                discovery_complete.set()\n"
                                               "                raise RuntimeError(f'Failed to send discovery message: {str(e)}')\n"
                                               "        else:\n"
                                               "            raise RuntimeError('Failed to establish SSE connection for service discovery')\n"
                                               "        \n"
                                               "        # Wait for timeout\n"
                                               "        time.sleep(timeout / 1000.0)\n"
                                               "        discovery_complete.set()\n"
                                               "        \n"
                                               "        return discovered_services\n"
                                               "    \n"
                                               "    def serve(self, project_id: str, service_info: Dict[str, str], on_service_request: Callable[[Dict[str, Any], Any], None]) -> Dict[str, Any]:\n"
                                               "        \"\"\"\n"
                                               "        Register as a service and handle incoming requests\n"
                                               "        \n"
                                               "        Starts a service that responds to discovery requests and handles\n"
                                               "        service requests with the provided callback function.\n"
                                               "        \n"
                                               "        Args:\n"
                                               "            project_id: The UUID of the project to serve\n"
                                               "            service_info: Dict with serviceId, serviceName, description\n"
                                               "            on_service_request: Callback to handle service requests (data, response_helper)\n"
                                               "            \n"
                                               "        Returns:\n"
                                               "            Service registration object with stop(), is_running(), service_info\n"
                                               "        \"\"\"\n"
                                               "        import threading\n"
                                               "        \n"
                                               "        service_id = service_info['serviceId']\n"
                                               "        service_name = service_info['serviceName']\n"
                                               "        description = service_info['description']\n"
                                               "        \n"
                                               "        is_running = threading.Event()\n"
                                               "        is_running.set()\n"
                                               "        \n"
                                               "        class ResponseHelper:\n"
                                               "            \"\"\"Helper class for sending service responses\"\"\"\n"
                                               "            def __init__(self, request_id: str, messages_client, project_id: str):\n"
                                               "                self.request_id = request_id\n"
                                               "                self.messages_client = messages_client\n"
                                               "                self.project_id = project_id\n"
                                               "            \n"
                                               "            def progress(self, percent: int, message: str):\n"
                                               "                \"\"\"Send progress update\"\"\"\n"
                                               "                progress_msg = self.messages_client._create_service_message('service_response',\n"
                                               "                    requestId=self.request_id,\n"
                                               "                    status='progress',\n"
                                               "                    progress={'percent': percent, 'message': message}\n"
                                               "                )\n"
                                               "                try:\n"
                                               "                    self.messages_client.send_message(self.project_id, progress_msg)\n"
                                               "                except Exception:\n"
                                               "                    # Ignore send failures for progress updates\n"
                                               "                    pass\n"
                                               "            \n"
                                               "            def complete(self, data: Any):\n"
                                               "                \"\"\"Send completion response with result data\"\"\"\n"
                                               "                completion_msg = self.messages_client._create_service_message('service_response',\n"
                                               "                    requestId=self.request_id,\n"
                                               "                    status='completed',\n"
                                               "                    data=data\n"
                                               "                )\n"
                                               "                try:\n"
                                               "                    self.messages_client.send_message(self.project_id, completion_msg)\n"
                                               "                except Exception:\n"
                                               "                    # Ignore send failures for completion\n"
                                               "                    pass\n"
                                               "            \n"
                                               "            def error(self, error: str):\n"
                                               "                \"\"\"Send error response\"\"\"\n"
                                               "                error_msg = self.messages_client._create_service_message('service_response',\n"
                                               "                    requestId=self.request_id,\n"
                                               "                    status='error',\n"
                                               "                    data={'error': error}\n"
                                               "                )\n"
                                               "                try:\n"
                                               "                    self.messages_client.send_message(self.project_id, error_msg)\n"
                                               "                except Exception:\n"
                                               "                    # Ignore send failures for errors\n"
                                               "                    pass\n"
                                               "        \n"
                                               "        def on_event(event_type: str, event_data: Dict[str, Any]) -> Optional[bool]:\n"
                                               "            if not is_running.is_set():\n"
                                               "                return True  # Stop listening\n"
                                               "            \n"
                                               "            if event_type == 'message' and self._is_service_message(event_data.get('data')):\n"
                                               "                message = event_data['data']\n"
                                               "                \n"
                                               "                if message.get('type') == 'service_discovery':\n"
                                               "                    # Respond to service discovery\n"
                                               "                    registration_msg = self._create_service_message('service_registration',\n"
                                               "                        requestId=message.get('requestId'),\n"
                                               "                        serviceId=service_id,\n"
                                               "                        serviceName=service_name,\n"
                                               "                        description=description\n"
                                               "                    )\n"
                                               "                    try:\n"
                                               "                        self.send_message(project_id, registration_msg)\n"
                                               "                    except Exception:\n"
                                               "                        # Ignore send failures during discovery\n"
                                               "                        pass\n"
                                               "                \n"
                                               "                elif (message.get('type') == 'service_request' and \n"
                                               "                      message.get('serviceId') == service_id):\n"
                                               "                    # Handle service request\n"
                                               "                    try:\n"
                                               "                        # Send acknowledgment\n"
                                               "                        ack_msg = self._create_service_message('service_response',\n"
                                               "                            requestId=message.get('requestId'),\n"
                                               "                            status='received'\n"
                                               "                        )\n"
                                               "                        try:\n"
                                               "                            self.send_message(project_id, ack_msg)\n"
                                               "                        except Exception:\n"
                                               "                            # Continue even if ack fails\n"
                                               "                            pass\n"
                                               "                        \n"
                                               "                        # Create response helper\n"
                                               "                        response_helper = ResponseHelper(message.get('requestId'), self, project_id)\n"
                                               "                        \n"
                                               "                        # Call user handler in a separate thread to avoid blocking\n"
                                               "                        def handle_request():\n"
                                               "                            try:\n"
                                               "                                on_service_request(message.get('data'), response_helper)\n"
                                               "                            except Exception as e:\n"
                                               "                                response_helper.error(str(e))\n"
                                               "                        \n"
                                               "                        handler_thread = threading.Thread(target=handle_request, daemon=True)\n"
                                               "                        handler_thread.start()\n"
                                               "                        \n"
                                               "                    except Exception as e:\n"
                                               "                        # Send error response\n"
                                               "                        try:\n"
                                               "                            error_msg = self._create_service_message('service_response',\n"
                                               "                                requestId=message.get('requestId'),\n"
                                               "                                status='error',\n"
                                               "                                data={'error': str(e)}\n"
                                               "                            )\n"
                                               "                            self.send_message(project_id, error_msg)\n"
                                               "                        except Exception:\n"
                                               "                            # Ignore errors when sending error responses\n"
                                               "                            pass\n"
                                               "        \n"
                                               "        # Start service in a separate thread\n"
                                               "        def service_thread():\n"
                                               "            self.listen(project_id, on_event)\n"
                                               "        \n"
                                               "        thread = threading.Thread(target=service_thread, daemon=True)\n"
                                               "        thread.start()\n"
                                               "        \n"
                                               "        service_registration = {\n"
                                               "            'stop': lambda: is_running.clear(),\n"
                                               "            'is_running': lambda: is_running.is_set(),\n"
                                               "            'service_info': {\n"
                                               "                'service_id': service_id, \n"
                                               "                'service_name': service_name, \n"
                                               "                'description': description\n"
                                               "            }\n"
                                               "        }\n"
                                               "        \n"
                                               "        return service_registration\n"
                                               "    \n"
                                               "    def request_service(self, project_id: str, service_id: str, data: Any, timeout: int = 10000) -> Any:\n"
                                               "        \"\"\"\n"
                                               "        Request a service to perform work\n"
                                               "        \n"
                                               "        Sends a service request and waits for completion or error response.\n"
                                               "        Supports progress updates during long-running operations.\n"
                                               "        \n"
                                               "        Args:\n"
                                               "            project_id: The UUID of the project\n"
                                               "            service_id: The ID of the service to request\n"
                                               "            data: The request data to send to the service\n"
                                               "            timeout: Timeout in milliseconds (default: 10000)\n"
                                               "            \n"
                                               "        Returns:\n"
                                               "            The response data from the service\n"
                                               "            \n"
                                               "        Raises:\n"
                                               "            TimeoutError: If the request times out\n"
                                               "            Exception: If the service returns an error\n"
                                               "        \"\"\"\n"
                                               "        import threading\n"
                                               "        import time\n"
                                               "        \n"
                                               "        request_id = self._generate_request_id()\n"
                                               "        response_data = {'result': None, 'error': None, 'completed': False}\n"
                                               "        response_event = threading.Event()\n"
                                               "        connection_active = threading.Event()\n"
                                               "        \n"
                                               "        def on_event(event_type: str, event_data: Dict[str, Any]) -> Optional[bool]:\n"
                                               "            if event_type == 'message' and self._is_service_message(event_data.get('data')):\n"
                                               "                message = event_data['data']\n"
                                               "                \n"
                                               "                if (message.get('type') == 'service_response' and \n"
                                               "                    message.get('requestId') == request_id):\n"
                                               "                    \n"
                                               "                    if message.get('status') == 'completed':\n"
                                               "                        response_data['result'] = message.get('data')\n"
                                               "                        response_data['completed'] = True\n"
                                               "                        response_event.set()\n"
                                               "                        return True  # Stop listening\n"
                                               "                    elif message.get('status') == 'error':\n"
                                               "                        response_data['error'] = message.get('data', {}).get('error', 'Service request failed')\n"
                                               "                        response_data['completed'] = True\n"
                                               "                        response_event.set()\n"
                                               "                        return True  # Stop listening\n"
                                               "                    # Ignore 'received' and 'progress' status messages (continue listening)\n"
                                               "            \n"
                                               "            # Check if we've timed out\n"
                                               "            if response_event.is_set():\n"
                                               "                return True\n"
                                               "            return None\n"
                                               "        \n"
                                               "        # Start listening in a separate thread\n"
                                               "        def listen_thread():\n"
                                               "            try:\n"
                                               "                connection_active.set()\n"
                                               "                self.listen(project_id, on_event)\n"
                                               "            except Exception:\n"
                                               "                # Connection timeouts or errors are expected during request handling\n"
                                               "                pass\n"
                                               "        \n"
                                               "        thread = threading.Thread(target=listen_thread, daemon=True)\n"
                                               "        thread.start()\n"
                                               "        \n"
                                               "        # Wait for connection to be established\n"
                                               "        connection_active.wait(timeout=1.0)\n"
                                               "        \n"
                                               "        if connection_active.is_set():\n"
                                               "            # Send service request\n"
                                               "            request_message = self._create_service_message('service_request',\n"
                                               "                requestId=request_id,\n"
                                               "                serviceId=service_id,\n"
                                               "                data=data\n"
                                               "            )\n"
                                               "            try:\n"
                                               "                self.send_message(project_id, request_message)\n"
                                               "            except Exception as e:\n"
                                               "                raise RuntimeError(f'Failed to send service request: {str(e)}')\n"
                                               "        else:\n"
                                               "            raise RuntimeError('Failed to establish connection for service request')\n"
                                               "        \n"
                                               "        # Wait for response or timeout\n"
                                               "        if response_event.wait(timeout / 1000.0):\n"
                                               "            if response_data['error']:\n"
                                               "                raise Exception(response_data['error'])\n"
                                               "            return response_data['result']\n"
                                               "        else:\n"
                                               "            raise TimeoutError(f'Service request timed out after {timeout}ms')\n")

        ;; Generate resource classes
        resource-classes (->> bundles
                              (map (fn [[bundle-name operations]]
                                     (if (= bundle-name "messages")
                                       (generate-python-resource-class bundle-name operations messages-resource-class-additions)
                                       (generate-python-resource-class bundle-name operations))))
                              (str/join "\n\n"))

        ;; Generate resource initialization including messages
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
         "import json\n"
         "import time\n"
         "from typing import Any, Dict, List, Optional, Union, Callable, Tuple, BinaryIO\n"
         "\n"
         "\n"
         "class PlaidAPIError(Exception):\n"
         "    \"\"\"Custom exception for Plaid API errors with consistent interface\"\"\"\n"
         "    \n"
         "    def __init__(self, message: str, status: int, url: str, method: str, response_data: Any = None):\n"
         "        super().__init__(message)\n"
         "        self.status = status\n"
         "        self.url = url\n"
         "        self.method = method\n"
         "        self.response_data = response_data\n"
         "    \n"
         "    def __str__(self):\n"
         "        return self.args[0] if self.args else f\"HTTP {self.status} at {self.url}\"\n"
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
         "    Service coordination methods:\n"
         "        # Discover services\n"
         "        services = client.messages.discover_services(project_id)\n"
         "        \n"
         "        # Register as a service\n"
         "        service_info = {'serviceId': 'my-service', 'serviceName': 'My Service', 'description': 'What it does'}\n"
         "        registration = client.messages.serve(project_id, service_info, handle_request)\n"
         "        \n"
         "        # Request service work\n"
         "        result = client.messages.request_service(project_id, 'target-service', request_data)\n"
         "    \n"
         "    Batch operations:\n"
         "        # Synchronous batch\n"
         "        client.begin_batch()\n"
         "        client.projects.create(name='Project 1')  # Gets queued\n"
         "        client.projects.create(name='Project 2')  # Gets queued\n"
         "        results = client.submit_batch()  # Executes all as one batch request\n"
         "        \n"
         "        # Asynchronous batch\n"
         "        client.begin_batch()\n"
         "        await client.projects.create_async(name='Project 1')  # Gets queued\n"
         "        await client.projects.create_async(name='Project 2')  # Gets queued\n"
         "        results = await client.submit_batch_async()  # Executes all as one batch request\n"
         "    \n"
         "    Document version tracking:\n"
         "        # Enter strict mode for a specific document\n"
         "        client.enter_strict_mode(document_id)\n"
         "        \n"
         "        # All write operations will now include document version checks\n"
         "        # Operations will fail with 409 error if document has been modified\n"
         "        \n"
         "        # Exit strict mode when done\n"
         "        client.exit_strict_mode()\n"
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
         "        self.agent_name = None  # User agent name for audit logging\n"
         "        \n"
         "        # Initialize batch state\n"
         "        self._is_batching = False\n"
         "        self._batch_operations = []\n"
         "        \n"
         "        # Initialize document version tracking\n"
         "        self._document_versions = {}  # Map of document-id -> version\n"
         "        self._strict_mode_document_id = None  # Document ID for strict mode\n"
         "        \n"
         "        # Initialize resource objects\n"
         resource-init "\n"
         "    \n"
         key-transformations "\n"
         "    \n"
         batch-methods "\n"
         "    \n"
         "    def enter_strict_mode(self, document_id: str) -> None:\n"
         "        \"\"\"\n"
         "        Enter strict mode for a specific document.\n"
         "        \n"
         "        When in strict mode, write operations will automatically include \n"
         "        document-version parameters to prevent concurrent modifications. \n"
         "        Operations on stale documents will fail with HTTP 409 errors.\n"
         "        \n"
         "        Args:\n"
         "            document_id: The ID of the document to track versions for\n"
         "        \"\"\"\n"
         "        self._strict_mode_document_id = document_id\n"
         "    \n"
         "    def exit_strict_mode(self) -> None:\n"
         "        \"\"\"\n"
         "        Exit strict mode and stop tracking document versions for writes.\n"
         "        \"\"\"\n"
         "        self._strict_mode_document_id = None\n"
         "    \n"
         "    def set_agent_name(self, agent_name: str) -> None:\n"
         "        \"\"\"\n"
         "        Set the user agent name for audit logging.\n"
         "        \n"
         "        When set, the client will include an X-Agent-Name header in all requests\n"
         "        to identify non-human clients in the audit log.\n"
         "        \n"
         "        Args:\n"
         "            agent_name: Name to identify this client in audit logs\n"
         "        \"\"\"\n"
         "        self.agent_name = agent_name\n"
         "    \n"
         login-methods "\n")))

(defn generate-python-client-file
  "Generate a Python client from an OpenAPI AST and write it to a file.
  
  This function creates a complete Python client library with the following features:
  - Synchronous and asynchronous HTTP methods for all API endpoints
  - Automatic parameter transformation (kebab-case to snake_case)
  - Structured service coordination system for inter-service communication
  - Batch operations support for efficient bulk API calls
  - Document version tracking for optimistic concurrency control
  - Comprehensive error handling with custom PlaidAPIError exceptions
  - Type annotations for better IDE support and code quality
  
  Args:
    ast: OpenAPI AST containing parsed API specification with bundled operations
    output-file: Path where the generated Python client will be written
    
  Generated client includes:
    - Resource classes for each API bundle (projects, documents, tokens, etc.)
    - MessagesResource for service coordination and real-time messaging
    - PlaidClient main class with configuration and batch management
    - Authentication methods (login/login_async) 
    - Key transformation utilities for API compatibility
    - Document version extraction for concurrent modification detection"
  [ast output-file]
  (let [py-client (generate-python-client ast)]
    (spit output-file py-client)
    (println (str "✅ Python client generated successfully: " output-file))
    (println (str "📊 Generated "
                  (count (:bundles ast))
                  " resource classes with sync and async methods"))))