(ns plaid.rest-api.v1.media
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.media.storage :as media]
            [plaid.xtdb.document :as doc]
            [ring.util.response :as response]
            [taoensso.timbre :as log])
  (:import [java.io FileInputStream]))

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

(defn stream-file-response
  "Create a streaming response for a file"
  [file content-type size]
  (-> (response/response (FileInputStream. file))
      (response/header "Content-Type" content-type)
      (response/header "Content-Length" (str size))
      (response/header "Cache-Control" "public, max-age=3600")))

(def media-routes
  ["/media"
   {:parameters {:path [:map [:document-id :uuid]]}}

   [""
    {:get {:summary "Get media file for a document"
           :openapi {:x-client-method "get-media"}
           :middleware [[pra/wrap-reader-required get-project-id-from-document]]
           :handler (fn [{{{:keys [document-id]} :path} :parameters db :db}]
                      (let [result (media/get-media-file document-id)]
                        (if (:success result)
                          (stream-file-response
                           (:file result)
                           (:content-type result)
                           (:size result))
                          {:status 404
                           :body {:error (:error result)}})))}

     :put {:summary "Upload a media file for a document. Uses Apache Tika for content validation."
           :middleware [[pra/wrap-writer-required get-project-id-from-document]]
           :parameters {:path [:map [:document-id :uuid]]}
           :openapi {:x-client-method "upload-media"
                     :requestBody {:content {"multipart/form-data"
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
              :openapi {:x-client-method "delete-media"}
              :middleware [[pra/wrap-writer-required get-project-id-from-document]]
              :handler (fn [{{{:keys [document-id]} :path} :parameters}]
                         (let [result (media/delete-media-file! document-id)]
                           (if (:success result)
                             {:status 204}
                             {:status 404
                              :body {:error (:error result)}})))}}]])