(ns plaid.rest-api.v1.media
  (:require [clojure.string :as str]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.media.storage :as media]
            [plaid.sql.document :as doc]
            [plaid.sql.operation :as op]
            [ring.util.response :as response]
            [taoensso.timbre :as log])
  (:import [java.io FileInputStream InputStream]))

(def ^:private error-status
  "HTTP status for each `:error-kind` `plaid.media.storage` reports. Reading
  the kind rather than the message is the point: the status used to be
  guessed by matching on the message text, which meant a filesystem failure
  answered 400 with an absolute server path in the body."
  {:unsupported 415
   :too-large   413
   :exists      409
   :not-found   404
   :io          500})

(defn- error-response
  "Turn a storage failure into a response. An unknown kind is a server fault,
  which is what a failure with no kind at all means too."
  [result]
  {:status (get error-status (:error-kind result) 500)
   :body (merge {:error (:error result)}
                (select-keys result [:max-bytes :size]))})

(defn- refused!
  "Throw a storage failure out of an operation's body, so the operation is
  rolled back and answers with the failure's status and fields."
  [result]
  (throw (ex-info (:error result)
                  {:code (get error-status (:error-kind result) 500)
                   :plaid/body (select-keys result [:max-bytes :size])})))

(defn upload!
  "Store `temp-file` as the media of `document-id`, and record it as one
  operation in the audit log (`:media/upload`), so History and Activity say
  who added a recording and when, and the document's version moves, which
  tells a page holding the document that it changed. The file is stored
  before the operation, so the write lock is not held while hundreds of
  megabytes are copied, and taken back out when the operation is refused."
  [db document-id temp-file filename user-id]
  (let [stored (media/store-media-file! document-id temp-file filename)]
    (if-not (:success stored)
      {:success false
       :code (get error-status (:error-kind stored) 500)
       :error (:error stored)
       :error-body (select-keys stored [:max-bytes :size])}
      (let [result (op/submit-operation!
                    [_tx db {:type :media/upload
                             :project (doc/project-id db document-id)
                             :document document-id
                             :description (str "Upload media file \"" filename "\" to document " document-id)
                             :user user-id}]
                    (select-keys stored [:extension :content-type]))]
        (when-not (:success result)
          (media/delete-media-file! document-id))
        result))))

(defn- deleting-in-this-batch?
  "Whether an earlier delete in the same atomic batch already took this
  document's recording. Its file waits for the commit, so it is still on
  disk, but the recording is gone for the rest of the batch."
  [document-id]
  (some #(= document-id (::deletes (meta %)))
        (some-> op/*deferred-files* deref)))

(defn delete!
  "Delete the media of `document-id`, as one operation in the audit log
  (`:media/delete`). The file goes once the operation is durable: in an
  atomic batch a later failure rolls the batch back, and nothing brings a
  file back. A second delete of it in the same batch is refused 404, as a
  delete of anything already gone is.

  `media-version`, when given, names the recording the caller means: the
  `?v=` of the `media-url` it holds. A delete is refused 409 when the stored
  recording is another one (replaced since the caller read the document), and
  the refusal carries the current `media-url`. Without it the delete takes
  whatever is stored. An upload takes no such check: one made over a stale
  page is refused as `:exists` already."
  ([db document-id user-id] (delete! db document-id user-id nil))
  ([db document-id user-id media-version]
   (let [result (op/submit-operation!
                 [_tx db {:type :media/delete
                          :project (doc/project-id db document-id)
                          :document document-id
                          :description (str "Delete media file of document " document-id)
                          :user user-id}]
                 (when (or (not (media/media-exists? document-id))
                           (deleting-in-this-batch? document-id))
                   (refused! {:error-kind :not-found :error "No media file found"}))
                 (when (and (some? media-version)
                            (not= media-version (media/media-version document-id)))
                   (throw (ex-info "The recording changed"
                                   {:code 409
                                    :plaid/body {:media-changed true
                                                 :media-url (media/media-url document-id)}})))
                 nil)]
     (when (:success result)
       (op/after-commit! (with-meta (fn [] (media/delete-media-file! document-id))
                           {::deletes document-id})))
     result)))

(defn get-project-id-from-document
  "Get project ID from document ID for auth middleware"
  [{db :db params :parameters :as request}]
  (let [doc-id (or (-> params :path :document-id)
                   (-> request :path-params (get "document-id")))]
    (when doc-id
      (let [doc-uuid (if (uuid? doc-id) doc-id (java.util.UUID/fromString doc-id))]
        (-> (doc/get db doc-uuid) :document/project)))))

(defn get-document-id
  "Extract document ID from request parameters"
  [{params :parameters :as request}]
  (or (-> params :path :document-id)
      (-> request :path-params (get "document-id"))))

(defn- parse-byte-range [range-header size]
  (when-let [[_ start-str end-str]
             (and (not (str/includes? range-header ","))
                  (re-matches #"bytes=(\d*)-(\d*)" range-header))]
    (try
      (cond
        (zero? size) nil

        ;; Suffix range: bytes=-N means the final N bytes.
        (empty? start-str)
        (let [suffix (Long/parseLong end-str)]
          (when (pos? suffix)
            {:start (max 0 (- size suffix))
             :end (dec size)}))

        :else
        (let [start (Long/parseLong start-str)
              end (if (empty? end-str)
                    (dec size)
                    (min (Long/parseLong end-str) (dec size)))]
          (when (and (< start size) (<= start end))
            {:start start :end end})))
      (catch NumberFormatException _
        nil))))

(defn- bounded-input-stream
  "Expose at most `length` bytes from `input`, closing the underlying stream."
  ^InputStream [^InputStream input length]
  (let [remaining (atom (long length))]
    (proxy [InputStream] []
      (read
        ([]
         (if (zero? @remaining)
           -1
           (let [value (.read input)]
             (when-not (= -1 value) (swap! remaining dec))
             value)))
        ;; read(byte[]) is what servers (http-kit) actually call when
        ;; streaming a body; without this arity every Range request 500'd
        ;; ("Wrong number of args (2)") and browsers, which always ask for
        ;; `bytes=0-`, could never play media.
        ([buffer]
         (let [^bytes b buffer]
           (.read ^InputStream this b 0 (alength b))))
        ([buffer offset requested]
         (if (zero? @remaining)
           -1
           (let [allowed (int (min (long requested) @remaining))
                 n (.read input buffer offset allowed)]
             (when (pos? n) (swap! remaining - n))
             n))))
      (available []
        (int (min (long (.available input)) @remaining Integer/MAX_VALUE)))
      (skip [requested]
        (let [n (.skip input (min (long requested) @remaining))]
          (swap! remaining - n)
          n))
      (close [] (.close input)))))

(defn stream-file-response
  "Create a streaming response for a file with RFC-style single-range support.
  Cache headers are the handler's business (see `media-cache-headers`)."
  [file content-type size range-header]
  (if range-header
    (if-let [{:keys [start end]} (parse-byte-range range-header size)]
      (let [length (inc (- end start))
            file-stream (FileInputStream. file)
            _ (.position (.getChannel file-stream) start)
            input-stream (bounded-input-stream file-stream length)]
        (-> (response/response input-stream)
            (response/status 206)
            (response/header "Content-Type" content-type)
            (response/header "Content-Length" (str length))
            (response/header "Content-Range" (str "bytes " start "-" end "/" size))
            (response/header "Accept-Ranges" "bytes")))
      {:status 416
       :headers {"Content-Range" (str "bytes */" size)
                 "Accept-Ranges" "bytes"}
       :body ""})
    (-> (response/response (FileInputStream. file))
        (response/header "Content-Type" content-type)
        (response/header "Content-Length" (str size))
        (response/header "Accept-Ranges" "bytes"))))

(defn media-cache-headers
  "The path `/documents/:id/media` never changes across a delete and re-upload,
  and a browser that cached the bytes under it kept serving the deleted file
  for the old hour-long max-age. Same contract as profile pictures now: a
  request naming the file's version (`?v=`, as the document's `media-url`
  carries it) can never go stale and is cached for a year; a bare request must
  revalidate every time, which the ETag turns into a 304 while nothing changed."
  [versioned?]
  {"Cache-Control" (if versioned?
                     "private, max-age=31536000, immutable"
                     "private, no-cache")})

(defn media-etag
  "The same version the document's `media-url` carries, as a validator."
  [{:keys [last-modified size]}]
  (str "\"" last-modified "-" size "\""))

(def media-routes
  ["/media"
   {:parameters {:path [:map [:document-id :uuid]]}}

   [""
    {:get {:summary (str "Get media file for a document. Fetch it through the document's "
                         "<body>media-url</body>, whose <body>?v=</body> names the file's version: that "
                         "response may be cached for a year and still changes the moment the file is "
                         "replaced. A bare request is served with an ETag and must revalidate.")
           :middleware [[pra/wrap-reader-required get-project-id-from-document]]
           :handler (fn [{{{:keys [document-id]} :path} :parameters headers :headers
                          query-params :query-params}]
                      (let [result (media/get-media-file document-id)
                            range-header (get headers "range")]
                        (if (:success result)
                          (let [etag (media-etag result)
                                ;; Blank counts as absent: `?v=` with nothing after
                                ;; it names no particular file.
                                cache (media-cache-headers
                                       (not (str/blank? (get query-params "v"))))]
                            (if (= (get headers "if-none-match") etag)
                              {:status 304 :headers (assoc cache "ETag" etag) :body ""}
                              (-> (stream-file-response
                                   (:file result)
                                   (:content-type result)
                                   (:size result)
                                   range-header)
                                  (update :headers merge cache {"ETag" etag}))))
                          (error-response result))))}

     :put {:plaid/idempotency false
           :summary "Upload a media file for a document. Uses Apache Tika for content validation."
           :middleware [[pra/wrap-writer-required get-project-id-from-document]]
           :parameters {:path [:map [:document-id :uuid]]}
           :openapi {:requestBody {:content {"multipart/form-data"
                                             {:schema {:type "object"
                                                       :properties {:file {:type "string"
                                                                           :format "binary"
                                                                           :description "Media file to upload (audio or video)"}}
                                                       :required ["file"]}}}}}
           :handler (fn [{{{:keys [document-id]} :path} :parameters db :db user-id :user/id :as request}]
                      (let [multipart-params (:multipart-params request)
                            file (get multipart-params "file")]
                        (log/debug "Request keys:" (keys request))
                        (log/debug "File data:" file)
                        (if file
                          (let [filename (:filename file)
                                temp-file (:tempfile file)]
                            (log/debug "File details - filename:" filename "temp-file exists:" (some? temp-file))
                            (if temp-file
                              (let [result (upload! db document-id temp-file filename user-id)]
                                (if (:success result)
                                  (prm/assoc-document-version-in-header
                                   {:status 201
                                    :body (merge {:message "Media file uploaded successfully"}
                                                 (:extra result))}
                                   db document-id)
                                  {:status (:code result 500)
                                   :body (prm/error-body result)}))
                              {:status 400
                               :body {:error "Invalid file upload - no temp file"}}))
                          {:status 400
                           :body {:error "No file provided in multipart upload"}})))}

     :delete {:summary (str "Delete media file for a document. <body>media-version</body> names the "
                            "recording meant, the <body>?v=</body> of the document's "
                            "<body>media-url</body>: when the stored recording is another one, the "
                            "delete is refused 409 with <body>media-changed</body> and the current "
                            "<body>media-url</body>. Without it the stored recording is deleted.")
              :middleware [[pra/wrap-writer-required get-project-id-from-document]]
              :parameters {:query [:map [:media-version {:optional true} [:string {:min 1}]]]}
              :handler (fn [{{{:keys [document-id]} :path {:keys [media-version]} :query} :parameters
                             db :db user-id :user/id}]
                         (let [result (delete! db document-id user-id media-version)]
                           (if (:success result)
                             (prm/assoc-document-version-in-header {:status 204} db document-id)
                             {:status (:code result 500)
                              :body (prm/error-body result)})))}}]])
