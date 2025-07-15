(ns plaid.server.middleware
  (:require [mount.core :as mount]
            [ring.middleware.defaults :refer [wrap-defaults]]
            [ring.middleware.cors :refer [wrap-cors]]
            [ring.util.response :as response]
            [ring.util.mime-type :as mime]
            [xtdb-inspector.core :refer [inspector-handler]]
            [plaid.server.config :refer [config]]
            [plaid.server.xtdb :refer [xtdb-node]]
            [plaid.rest-api.v1.core :refer [rest-handler]]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [taoensso.timbre :as log])
  (:import (java.io File)))

;; Secret key handling
(defn generate-secret-key []
  (let [random-bytes (byte-array 32)]
    (.nextBytes (java.security.SecureRandom.) random-bytes)
    (str/join (map #(format "%02x" %) random-bytes))))

(defn ensure-secret-key-exists []
  (let [secret-path (-> config :plaid.server.xtdb/config :main-db-dir (str File/separator "jwt-secret.txt"))
        secret-file (io/file secret-path)]
    (if (.exists secret-file)
      (slurp secret-file)
      (let [new-secret (generate-secret-key)]
        (spit secret-file new-secret)
        (log/info "Generated new secret key at" secret-path)
        new-secret))))

(mount/defstate secret-key
  :start (ensure-secret-key-exists))

;; Route handling
(defn wrap-rest-routes
  [handler xtdb-node]
  (let [rest-handler (rest-handler xtdb-node secret-key)]
    (fn [{:keys [uri] :as req}]
      (if (str/starts-with? uri "/api/v1/")
        (rest-handler req)
        (handler req)))))

(defn wrap-xtdb-inspector [ring-handler]
  (let [inspector? (-> config :plaid.server.xtdb/config :use-inspector)
        handler (inspector-handler xtdb-node)]
    (fn [request]
      (if (and inspector?
               (map? request)
               (-> request :uri (clojure.string/split #"/") (get 1) (get 0) (= \_)))
        (handler request)
        (ring-handler request)))))

(defn wrap-static-resources
  "Serves static files from a filesystem directory"
  [handler]
  (let [resources-path (or (-> config :plaid.server.middleware/static-resources-path)
                           "resources")]
    (log/info (format "Serving static files from `%s/`" resources-path))
    (fn [{:keys [uri request-method] :as request}]
      (if (and (= :get request-method)
               (not (str/starts-with? uri "/api/"))
               (not (str/starts-with? uri "/_"))
               resources-path)
        (let [file-path (subs uri 1)
              ;; If URI ends with /, try to serve index.html from that directory
              actual-path (if (or (= file-path "")
                                  (nil? file-path)
                                  (str/ends-with? file-path "/"))
                            (str file-path "index.html")
                            file-path)
              file (io/file resources-path actual-path)]
          (if (and (.exists file) 
                   (.isFile file)
                   ;; Security: ensure the file is within our resources directory
                   (str/starts-with? (.getCanonicalPath file) 
                                     (.getCanonicalPath (io/file resources-path))))
            (-> (response/file-response (.getPath file))
                (response/content-type (mime/ext-mime-type (.getName file))))
            (handler request)))
        (handler request)))))

(mount/defstate middleware
  :start
  (let [defaults-config (:ring.middleware/defaults-config config)
        cors-config (or (:plaid.server.middleware/cors-config config)
                         {:access-control-allow-origin ["*"]
                          :access-control-allow-methods [:get :put :post :delete :options]
                          :access-control-allow-headers ["Authorization" "Content-Type"]})]
    (-> (fn [_] {:status 404 :body "Not Found"})
        (wrap-rest-routes xtdb-node)
        wrap-static-resources
        wrap-xtdb-inspector
        (wrap-defaults defaults-config)
        (wrap-cors :access-control-allow-origin (map re-pattern (:access-control-allow-origin cors-config))
                   :access-control-allow-methods (:access-control-allow-methods cors-config)
                   :access-control-allow-headers (:access-control-allow-headers cors-config)))))
