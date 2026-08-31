(ns plaid.sql.user-data
  "Private per-user key/value storage: small JSON documents an app keeps for
  one user across devices and sessions (assistant conversations, drafts, UI
  preferences). Keys are client-chosen and namespaced by convention
  (`<app>:<feature>:...`); values are arbitrary JSON stored verbatim.

  Writes are deliberately UNAUDITED (not routed through `submit-operation!`):
  this is per-user application state, not annotation data, and it churns
  (every chat turn). Rows cascade away with their user."
  (:require [clojure.data.json :as json]
            [plaid.sql.common :as psc])
  (:refer-clojure :exclude [get list]))

(def max-value-bytes
  "Upper bound on one stored value's JSON text, in bytes (UTF-8). Generous for
  a long conversation, small enough that the store cannot become a file
  dump; media has its own endpoints."
  1000000)

(defn- row->entry [row include-value?]
  (when row
    (cond-> {:key (:key row)
             :updated-at (:updated_at row)}
      include-value? (assoc :value (json/read-str (:value row))))))

(defn get
  "The entry {:key :updated-at :value} for `user-id`/`key`, or nil."
  [db user-id key]
  (row->entry (first (psc/q db {:select [:key :value :updated_at]
                                :from :user_data
                                :where [:and [:= :user_id user-id] [:= :key key]]}))
              true))

(defn list
  "The user's entries ({:key :updated-at}, plus :value when `include-values?`)
  whose key starts with `prefix` (nil = all), ordered by key."
  [db user-id {:keys [prefix include-values?]}]
  (->> (psc/q db {:select (if include-values? [:key :value :updated_at] [:key :updated_at])
                  :from :user_data
                  :where (cond-> [:and [:= :user_id user-id]]
                           ;; substr, not LIKE: keys routinely contain `_`,
                           ;; which LIKE would treat as a wildcard. The two
                           ;; offsets are INLINED, not bound: a bound Clojure
                           ;; long arrives at Postgres as `bigint`, and there is
                           ;; no `substr(text, bigint, bigint)`, so the literals
                           ;; type-resolve to `integer` and pick the real one.
                           (seq prefix) (conj [:= [:substr :key
                                                   [:inline 1]
                                                   [:inline (count prefix)]]
                                               prefix]))
                  :order-by [:key]})
       (mapv #(row->entry % include-values?))))

(defn put!
  "Upsert `value` (any JSON-able Clojure data) under `key`. Returns
  {:key :updated-at}, or {:error :too-large} when the JSON exceeds
  `max-value-bytes`."
  [db user-id key value]
  (let [text (json/write-str value)]
    (if (> (count (.getBytes ^String text "UTF-8")) max-value-bytes)
      {:error :too-large}
      (let [now (psc/now-iso)]
        (psc/execute! db {:insert-into :user_data
                          :values [{:user_id user-id :key key :value text :updated_at now}]
                          :on-conflict [:user_id :key]
                          :do-update-set [:value :updated_at]})
        {:key key :updated-at now}))))

(defn delete!
  "Remove an entry. Returns the number of rows deleted (0 or 1)."
  [db user-id key]
  (psc/execute! db {:delete-from :user_data
                    :where [:and [:= :user_id user-id] [:= :key key]]}))
