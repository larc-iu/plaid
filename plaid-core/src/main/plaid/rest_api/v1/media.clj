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
  "Create a streaming response for a file with RFC-style single-range support."
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
            (response/header "Accept-Ranges" "bytes")
            (response/header "Cache-Control" "private, max-age=3600")))
      {:status 416
       :headers {"Content-Range" (str "bytes */" size)
                 "Accept-Ranges" "bytes"
                 "Cache-Control" "private, max-age=3600"}
       :body ""})
    (-> (response/response (FileInputStream. file))
        (response/header "Content-Type" content-type)
        (response/header "Content-Length" (str size))
        (response/header "Accept-Ranges" "bytes")
        (response/header "Cache-Control" "private, max-age=3600"))))

(def media-routes
  ["/media"
   {:parameters {:path [:map [:document-id :uuid]]}}

   [""
    {:get {:summary "Get media file for a document"
           :middleware [[pra/wrap-reader-required get-project-id-from-document]]
           :handler (fn [{{{:keys [document-id]} :path} :parameters headers :headers}]
                      (let [result (media/get-media-file document-id)
                            range-header (get headers "range")]
                        (if (:success result)
                          (stream-file-response
                           (:file result)
                           (:content-type result)
                           (:size result)
                           range-header)
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
