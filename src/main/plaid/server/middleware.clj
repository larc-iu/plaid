(ns plaid.server.middleware
  (:require [mount.core :as mount]
            [ring.middleware.defaults :refer [wrap-defaults]]
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
  [xtdb-node]
  (let [rest-handler (rest-handler xtdb-node secret-key)]
    (fn [{:keys [uri] :as req}]
      (cond
        (re-matches #"^/api/v1/" uri)
        (rest-handler req)

        :else
        (rest-handler req)))))

(defn wrap-xtdb-inspector [ring-handler]
  (let [inspector? (-> config :plaid.server.xtdb/config :use-inspector)
        handler (inspector-handler xtdb-node)]
    (fn [request]
      (if (and inspector?
               (map? request)
               (-> request :uri (clojure.string/split #"/") (get 1) (get 0) (= \_)))
        (handler request)
        (ring-handler request)))))

(mount/defstate middleware
  :start
  (let [defaults-config (:ring.middleware/defaults-config config)]
    (-> (wrap-rest-routes xtdb-node)
        wrap-xtdb-inspector
        (wrap-defaults defaults-config))))
