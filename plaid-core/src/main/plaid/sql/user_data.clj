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
            [plaid.sql.pagination :as psp]
            [plaid.util.codepoint :as cp])
  (:refer-clojure :exclude [get list]))

(def max-value-bytes
  "Upper bound on one stored value's JSON text, in bytes (UTF-8). Sized for a
  long assistant conversation, whose record is mostly what the reader sees
  (plan cards, citations) rather than what the model is sent: at 1MB a
  working session filled it in a morning. Small enough that the store cannot
  become a file dump (media has its own endpoints), and well under the 10MB
  JSON body limit a write has to pass first."
  5000000)

(defn- row->entry [row include-value?]
  (when row
    (cond-> {:key (:key row)
             :updated-at (:updated_at row)
             :version (:version row)}
      include-value? (assoc :value (json/read-str (:value row))))))

(defn get
  "The entry {:key :updated-at :version :value} for `user-id`/`key`, or nil."
  [db user-id key]
  (row->entry (first (psc/q db {:select [:key :value :updated_at :version]
                                :from :user_data
                                :where [:and [:= :user_id user-id] [:= :key key]]}))
              true))

(defn- key-clauses
  "The two key narrowings as HoneySQL predicates, in the order they are ANDed.
  Shared by the per-user `list` and the admin-side `list-all` so one read
  cannot drift from the other."
  [prefix pattern]
  (cond-> []
    ;; substr, not LIKE: keys routinely contain `_`, which LIKE would treat
    ;; as a wildcard. SQLite's substr counts code points, so the length has
    ;; to as well: `count` is UTF-16, and a prefix holding one astral
    ;; character asked for one code point too many and matched nothing.
    (seq prefix) (conj [:= [:substr :key 1 (cp/cp-count prefix)] prefix])
    ;; glob(X, Y) is SQLite's function spelling of `Y GLOB X`, so the
    ;; pattern is the first argument.
    (seq pattern) (conj [:glob pattern :key])))

(def ^:private select-cols
  {true [:user_id :key :value :updated_at :version]
   false [:user_id :key :updated_at :version]})

(defn list
  "One page of the user's entries ({:key :updated-at :version}, plus :value when
  `include-values?`), ordered by key. Keyset paginated by (user-id, key), the
  table's primary key: both columns are TEXT NOT NULL, so the page order is
  total and walking it is index-backed. The same order and the same cursor
  shape as `list-all`.

  Paginated because a value runs to `max-value-bytes`, so `include-values?`
  over a whole store is a request with no upper bound on its response.

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
  [db user-id {:keys [prefix pattern include-values? limit cursor-vals]}]
  (psp/paginate db {:select (select-cols (boolean include-values?))
                    :from :user_data
                    :base-where (into [:and [:= :user_id user-id]] (key-clauses prefix pattern))
                    :order-by [:user_id :key]
                    :limit limit
                    :cursor-vals cursor-vals
                    :row->entity #(row->entry % include-values?)}))

(defn- current
  "{:version :updated-at} of the entry as it is stored, version 0 when there
  is none."
  [db user-id key]
  (let [row (first (psc/q db {:select [:version :updated_at]
                              :from :user_data
                              :where [:and [:= :user_id user-id] [:= :key key]]}))]
    {:version (or (:version row) 0) :updated-at (:updated_at row)}))

(defn put!
  "Upsert `value` (any JSON-able Clojure data) under `key`. Returns
  {:key :updated-at :version}, or {:error :too-large} when the JSON exceeds
  `max-value-bytes`.

  Every write bumps the entry's `version` (a new entry is 1). With
  `expected-version` the write lands only when the entry is at that version
  (0: only when there is no entry yet), checked by the statement that writes
  it, and otherwise answers {:error :version-mismatch :current {:version
  :updated-at}}: the version as it is stored, 0 when there is no entry."
  ([db user-id key value] (put! db user-id key value nil))
  ([db user-id key value expected-version]
   (let [text (json/write-str value)]
     (if (> (count (.getBytes ^String text "UTF-8")) max-value-bytes)
       {:error :too-large}
       (let [now (psc/now-iso)
             fresh {:user_id user-id :key key :value text :updated_at now :version 1}
             row (psc/execute-returning-one!
                  db
                  (cond
                    (nil? expected-version)
                    {:insert-into :user_data
                     :values [fresh]
                     :on-conflict [:user_id :key]
                     :do-update-set {:value :excluded.value
                                     :updated_at :excluded.updated_at
                                     :version [:+ :user_data.version 1]}
                     :returning [:version]}

                    (zero? expected-version)
                    {:insert-into :user_data
                     :values [fresh]
                     :on-conflict [:user_id :key]
                     :do-nothing []
                     :returning [:version]}

                    :else
                    {:update :user_data
                     :set {:value text :updated_at now :version [:+ :version 1]}
                     :where [:and [:= :user_id user-id] [:= :key key] [:= :version expected-version]]
                     :returning [:version]}))]
         (if row
           {:key key :updated-at now :version (:version row)}
           {:error :version-mismatch :current (current db user-id key)}))))))

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
  (let [clauses (key-clauses prefix pattern)]
    (psp/paginate db {:select (select-cols (boolean include-values?))
                      :from :user_data
                      :base-where (when (seq clauses) (into [:and] clauses))
                      :order-by [:user_id :key]
                      :limit limit
                      :cursor-vals cursor-vals
                      :row->entity (fn [row]
                                     (assoc (row->entry row include-values?)
                                            :user-id (:user_id row)))})))
