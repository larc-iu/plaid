(ns plaid.sql.user-data
  "Private per-user key/value storage: small JSON documents an app keeps for
  one user across devices and sessions (assistant conversations, drafts, UI
  preferences). Keys are client-chosen and namespaced by convention
  (`<app>:<feature>:...`); values are arbitrary JSON stored verbatim.

  Writes are deliberately UNAUDITED (not routed through `submit-operation!`):
  this is per-user application state, not annotation data, and it churns
  (every chat turn). Rows cascade away with their user."
  (:require [clojure.data.json :as json]
            [plaid.sql.common :as psc]
            [plaid.sql.pagination :as psp])
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
  "The user's entries ({:key :updated-at}, plus :value when `include-values?`),
  ordered by key.

  Two independent narrowings, ANDed when both are given:
    :prefix   the literal head of a key (nil = all)
    :pattern  a GLOB over the whole key (`*` any run, `?` one character)

  `pattern` is what a key convention of `<app>:<feature>:<scope>:<kind>:<id>`
  actually needs: the part worth listing is often identified by a segment in
  the MIDDLE. `igt:assistant:*:meta:*` is every assistant conversation's small
  sidebar entry across every project, and not one transcript, which no prefix
  can express because the project sits before the kind. Selecting those with a
  prefix instead would drag down a megabyte of transcript per conversation.

  Neither narrowing can use an index: `prefix` compares a substr of the key, so
  it scans the same as the glob does. That is affordable because the table holds
  per-user app state, not annotation data."
  [db user-id {:keys [prefix pattern include-values?]}]
  (->> (psc/q db {:select (if include-values? [:key :value :updated_at] [:key :updated_at])
                  :from :user_data
                  :where (cond-> [:and [:= :user_id user-id]]
                           ;; substr, not LIKE: keys routinely contain `_`,
                           ;; which LIKE would treat as a wildcard.
                           (seq prefix) (conj [:= [:substr :key 1 (count prefix)] prefix])
                           ;; glob(X, Y) is SQLite's function spelling of
                           ;; `Y GLOB X`, so the pattern is the first argument.
                           (seq pattern) (conj [:glob pattern :key]))
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

(defn list-all
  "Every user's entries, for an admin-side read across accounts. Keyset
  paginated by (user-id, key) — both are TEXT NOT NULL and together the
  primary key, so the page order is total and walking it is index-backed.

  Takes the same two narrowings as the per-user `list`, ANDed when both are
  given: `:prefix` (the literal head of a key) and `:pattern` (a GLOB over the
  whole key). See that docstring for what the glob is for and what it costs."
  [db {:keys [prefix pattern include-values? limit cursor-vals]}]
  (let [clauses (cond-> []
                  (seq prefix) (conj [:= [:substr :key 1 (count prefix)] prefix])
                  ;; glob(X, Y) is SQLite's function spelling of `Y GLOB X`,
                  ;; so the pattern is the first argument.
                  (seq pattern) (conj [:glob pattern :key]))]
    (psp/paginate db {:select (if include-values?
                                [:user_id :key :value :updated_at]
                                [:user_id :key :updated_at])
                      :from :user_data
                      :base-where (when (seq clauses) (into [:and] clauses))
                      :order-by [:user_id :key]
                      :limit limit
                      :cursor-vals cursor-vals
                      :row->entity (fn [row]
                                     (assoc (row->entry row include-values?)
                                            :user-id (:user_id row)))})))
