(ns glam.server.session-store
  (:require [mount.core :as mount]
            [xtdb.api :as xt]
            [taoensso.timbre :as log]
            [glam.xtdb.easy :as gxe]
            [glam.server.xtdb :refer [xtdb-session-node]])
  (:import (ring.middleware.session.store SessionStore)
           (java.util UUID)))
;; Replace the default in-memory session store with this. Makes it so you don't need to log in every time
;; you restart your server.

;; see: https://ring-clojure.github.io/ring-anti-forgery/ring.middleware.anti-forgery.html
(defn make-session-data
  [key data]
  (-> data
      (assoc :xt/id key
             ::session? true)))

(deftype XtdbSessionStore [xtdb-node]
  SessionStore

  (read-session [this key]
    (if (some? key)
      (try
        (xt/entity (xt/db xtdb-node) (UUID/fromString key))
        (catch Exception e
          (log/error "Invalid session. Error reading xt/entity for key: " key)
          {}))
      {}))

  (write-session [_ key data]
    (let [key (try (cond-> key (some? key) UUID/fromString)
                   (catch Exception e (UUID/randomUUID)))
          key (or key (UUID/randomUUID))
          tx-data (make-session-data key data)]
      (gxe/put xtdb-node tx-data)
      key))

  (delete-session [_ key]
    (gxe/delete xtdb-node key)
    nil))

(defn xtdb-session-store [xtdb-node]
  (XtdbSessionStore. xtdb-node))

(mount/defstate session-store
  :start (xtdb-session-store xtdb-session-node))
