(ns plaid.rest-api.v1.media
  (:require [clojure.string :as str]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.media.storage :as media]
            [plaid.sql.document :as doc]
            [ring.util.response :as response]
            [taoensso.timbre :as log])
  (:import [java.io FileInputStream InputStream]))

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
                          {:status 404
                           :body {:error (:error result)}})))}

     :put {:summary "Upload a media file for a document. Uses Apache Tika for content validation."
           :middleware [[pra/wrap-writer-required get-project-id-from-document]]
           :parameters {:path [:map [:document-id :uuid]]}
           :openapi {:requestBody {:content {"multipart/form-data"
                                             {:schema {:type "object"
                                                       :properties {:file {:type "string"
                                                                           :format "binary"
                                                                           :description "Media file to upload (audio or video)"}}
                                                       :required ["file"]}}}}}
           :handler (fn [{{{:keys [document-id]} :path} :parameters :as request}]
                      (let [multipart-params (:multipart-params request)
                            file (get multipart-params "file")]
                        (log/debug "Request keys:" (keys request))
                        (log/debug "File data:" file)
                        (if file
                          (let [filename (:filename file)
                                temp-file (:tempfile file)]
                            (log/debug "File details - filename:" filename "temp-file exists:" (some? temp-file))
                            (if temp-file
                              (let [result (media/store-media-file! document-id temp-file filename)]
                                (if (:success result)
                                  {:status 201
                                   :body {:message "Media file uploaded successfully"
                                          :extension (:extension result)
                                          :content-type (:content-type result)}}
                                  (let [error-msg (:error result)
                                        status (cond
                                                 (= error-msg "Unsupported media type") 415
                                                 (= error-msg "File too large") 413
                                                 (and error-msg (.contains error-msg "already exists")) 409
                                                 :else 400)]
                                    {:status status
                                     :body {:error error-msg}})))
                              {:status 400
                               :body {:error "Invalid file upload - no temp file"}}))
                          {:status 400
                           :body {:error "No file provided in multipart upload"}})))}

     :delete {:summary "Delete media file for a document"
              :middleware [[pra/wrap-writer-required get-project-id-from-document]]
              :handler (fn [{{{:keys [document-id]} :path} :parameters}]
                         (let [result (media/delete-media-file! document-id)]
                           (if (:success result)
                             {:status 204}
                             {:status 404
                              :body {:error (:error result)}})))}}]])
