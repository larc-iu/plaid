(ns plaid.sql.idempotency
  "Stored answers to writes sent with an `Idempotency-Key`.

  A row is written in the same transaction as the write it answers, so a
  write and its key commit or roll back together. Only a 2xx answer is
  stored. A lookup ignores a row older than the retention, so correctness
  never depends on the sweep (`plaid.server.idempotency-sweep`) having run.
  The HTTP side is `plaid.rest-api.v1.idempotency`."
  (:require [clojure.data.json :as json]
            [plaid.server.config :refer [config]]
            [plaid.sql.common :as psc])
  (:import (java.time Duration Instant)))

(def default-retention-hours 24)

(defn retention-hours
  "How long a stored answer is replayed, from `[idempotency] retention_hours`."
  []
  (get-in config [:plaid.idempotency :retention-hours] default-retention-hours))

(defn- cutoff
  "The oldest `created_at` still in force, as the column's text."
  ^String []
  (psc/instant->iso (.minus (Instant/now)
                            (Duration/ofMillis (long (* (retention-hours) 3600000))))))

(defn lookup
  "The stored answer to `key` sent by `user-id`, or nil when there is none
  in force. Returns {:fingerprint :method :path :status :headers :body}
  with the headers decoded and the body as the JSON text first sent."
  [db user-id key]
  (when-let [row (psc/q1 db {:select [:fingerprint :method :path :status :headers :body]
                             :from [:idempotency_keys]
                             :where [:and
                                     [:= :user_id user-id]
                                     [:= :key key]
                                     [:>= :created_at (cutoff)]]})]
    (-> row
        (update :headers #(some-> % json/read-str)))))

(defn store!
  "Record the answer to `key`: `headers` a map of the document-version
  headers, `body` the response's JSON text. Runs inside the write's
  transaction. A row past retention under the same key is replaced."
  [tx user-id key {:keys [fingerprint method path status headers body]}]
  (psc/execute! tx {:insert-into :idempotency_keys
                    :values [{:user_id user-id
                              :key key
                              :fingerprint fingerprint
                              :method method
                              :path path
                              :status status
                              :headers (some-> headers psc/write-json)
                              :body body
                              :created_at (psc/now-iso)}]
                    :on-conflict [:user_id :key]
                    :do-update-set [:fingerprint :method :path :status :headers :body :created_at]}))

(def prune-chunk
  "Rows deleted per transaction by `prune!`, so the write lock is never held
  long."
  5000)

(defn prune!
  "Delete the rows older than the retention, `prune-chunk` at a time, each
  chunk in its own short transaction. Returns how many went."
  [db]
  (let [before (cutoff)]
    (loop [total 0]
      (let [n (psc/execute! db {:delete-from :idempotency_keys
                                :where [:in [:composite :user_id :key]
                                        {:select [:user_id :key]
                                         :from [:idempotency_keys]
                                         :where [:< :created_at before]
                                         :order-by [:created_at]
                                         :limit prune-chunk}]})]
        (if (< n prune-chunk)
          (+ total n)
          (recur (+ total n)))))))
