(ns plaid.xtdb2.common
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [clojure.data.json :as json]
            [taoensso.timbre :as log]
            [plaid.server.config :refer [config]]))

;; Table registry: maps entity id-key to table keyword
(def entity-table
  {:user/id :users
   :project/id :projects
   :document/id :documents
   :text/id :texts
   :token/id :tokens
   :span/id :spans
   :relation/id :relations
   :text-layer/id :text-layers
   :token-layer/id :token-layers
   :span-layer/id :span-layers
   :relation-layer/id :relation-layers
   :vocab/id :vocab-layers
   :vocab-item/id :vocab-items
   :vocab-link/id :vocab-links
   :op/id :operations
   :audit/id :audits
   :batch/id :batch-markers})

;; xt-map helpers ------------------------------------------------------------------

(defn ->node
  "Extracts the XTDB node. Accepts a raw node or {:node node ...} xt-map.
  NOTE: XTDB v2 Node implements IPersistentMap, so we check for :node key,
  not (map? o), to distinguish an xt-map from a raw node."
  [o]
  (if (and (map? o) (contains? o :node))
    (:node o)
    o))

(defn ensure-node
  "For use in write functions. Accepts a plain node or {:node node ...} map.
  Returns a map with at least :node populated.
  NOTE: XTDB v2 Node implements IPersistentMap; check :node key to distinguish."
  [node-or-map]
  (if (and (map? node-or-map) (contains? node-or-map :node))
    node-or-map
    {:node node-or-map}))

(defn snapshot-opts
  "Returns query opts map for snapshot-time if present in xt-map."
  [xt-map]
  (when-let [t (and (map? xt-map) (:snapshot-time xt-map))]
    {:snapshot-time t}))

;; reads ---------------------------------------------------------------------------

(defn- kw->sql-table
  "Convert a table keyword to a SQL table name. :text-layers -> \"text_layers\""
  [kw]
  (str/replace (name kw) "-" "_"))

(defn- kw->sql-col
  "Convert an attribute keyword to a SQL column name.
  :xt/id -> \"_id\", :text-layer/name -> \"text_layer$name\", :foo -> \"foo\""
  [kw]
  (cond
    (= kw :xt/id) "_id"
    (namespace kw) (str (str/replace (namespace kw) "-" "_")
                        "$"
                        (str/replace (name kw) "-" "_"))
    :else (str/replace (name kw) "-" "_")))

(defn entity
  "Get an entity by :xt/id from the given table.
  First arg may be a raw node or {:node node :snapshot-time t} map.
  Returns the entity map (without temporal cols) or nil."
  [node-or-map table id]
  (let [node (->node node-or-map)
        opts (snapshot-opts node-or-map)]
    (first (xt/q node [(str "SELECT * FROM " (kw->sql-table table) " WHERE _id = ?") id] (or opts {})))))

(defn entity-with-sys-from
  "Like entity, but also returns :xt/system-from for use in ASSERT-based concurrency checks."
  [node table id]
  (first (xt/q node [(str "SELECT *, _system_from FROM " (kw->sql-table table) " WHERE _id = ?") id])))

(defn find-entity
  "Find a single entity in table whose attributes match the given map.
  Values of :_ are treated as wildcards (only the key is required to be present).
  First arg may be a raw node or {:node node :snapshot-time t} map.
  Returns the first matching entity or nil."
  [node-or-map table attrs]
  (let [node (->node node-or-map)
        opts (snapshot-opts node-or-map)
        table-name (kw->sql-table table)
        wild (filter (fn [[_ v]] (= v '_)) attrs)
        non-wild (filter (fn [[_ v]] (not= v '_)) attrs)
        where-parts (concat (map (fn [[k _]] (str (kw->sql-col k) " IS NOT NULL")) wild)
                            (map (fn [[k _]] (str (kw->sql-col k) " = ?")) non-wild))
        where-str (when (seq where-parts)
                    (str " WHERE " (str/join " AND " where-parts)))
        params (mapv second non-wild)
        query (into [(str "SELECT * FROM " table-name (or where-str ""))] params)]
    (first (xt/q node query (or opts {})))))

(defn find-entities
  "Like find-entity but returns all matches.
  First arg may be a raw node or {:node node :snapshot-time t} map."
  [node-or-map table attrs]
  (let [node (->node node-or-map)
        opts (snapshot-opts node-or-map)
        table-name (kw->sql-table table)
        wild (filter (fn [[_ v]] (= v '_)) attrs)
        non-wild (filter (fn [[_ v]] (not= v '_)) attrs)
        where-parts (concat (map (fn [[k _]] (str (kw->sql-col k) " IS NOT NULL")) wild)
                            (map (fn [[k _]] (str (kw->sql-col k) " = ?")) non-wild))
        where-str (when (seq where-parts)
                    (str " WHERE " (str/join " AND " where-parts)))
        params (mapv second non-wild)
        query (into [(str "SELECT * FROM " table-name (or where-str ""))] params)]
    (xt/q node query (or opts {}))))

;; config helpers -------------------------------------------------------------------
;; XTDB v2 lowercases nested map keys (like PostgreSQL identifiers).
;; We store :config as a JSON string to preserve case.

(defn serialize-config
  "Serialize a config map to a JSON string for storage in XTDB."
  [config-map]
  (json/write-str (or config-map {})))

(defn parse-config
  "Deserialize a config value. Handles JSON strings (new) and maps (legacy)."
  [config-val]
  (cond
    (string? config-val) (json/read-str config-val)
    (map? config-val) config-val
    :else {}))

(defn deserialize-config
  "If entity has a :config key, deserialize it."
  [entity]
  (if (contains? entity :config)
    (update entity :config parse-config)
    entity))

;; writes --------------------------------------------------------------------------

(defn submit!
  "Wrap xt/execute-tx in standard error handling.
  Returns {:success true} on success, {:success false :error msg :code code} on failure.
  If get-extra is supplied, assocs result of (get-extra tx) into :extra on success."
  ([node tx]
   (submit! node tx nil))
  ([node tx get-extra]
   (try
     (xt/execute-tx node tx)
     (cond-> {:success true}
       get-extra (assoc :extra (get-extra tx)))
     (catch clojure.lang.ExceptionInfo e
       (let [data (ex-data e)]
         (log/warn "Transaction failed: " data)
         {:success false
          :error (ex-message e)
          :code (:code data)}))
     (catch Exception e
       (log/warn "Transaction failed: " (ex-message e))
       {:success false
        :error (ex-message e)}))))

(defn match*
  "Returns a SQL ASSERT op that checks _system_from hasn't changed since the entity was read.
  entity must be a result from entity-with-sys-from (has :xt/system-from key)."
  [table entity]
  [:sql (str "ASSERT (SELECT _system_from FROM " (kw->sql-table table) " WHERE _id = ?) = ?")
   [(:xt/id entity) (:xt/system-from entity)]])

(defn merge*
  "Read-modify-write: reads entity, validates it exists, returns [match-op put-op].
  First arg may be a raw node or {:node node ...} map.
  attrs are merged into the entity (temporal cols stripped before put).
  Optional pre-fetched-entity avoids a redundant DB read when caller already has the entity."
  ([node-or-map table id-key id attrs]
   (merge* node-or-map table id-key id attrs nil))
  ([node-or-map table id-key id attrs pre-fetched-entity]
   (let [e (or pre-fetched-entity
               (entity-with-sys-from (->node node-or-map) table id))]
     (cond
       (nil? e)
       (throw (ex-info (str (namespace id-key) " not found with ID " id)
                       {:id id :code 404}))

       (nil? (id-key e))
       (throw (ex-info (str (namespace id-key) " not found with ID " id)
                       {:id id :code 404}))

       :else
       [(match* table e)
        [:put-docs table (-> e
                             (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                             (clojure.core/merge attrs))]]))))

;; creation helpers ----------------------------------------------------------------

(defn new-record
  ([] (new-record nil))
  ([ns]
   (new-record ns (random-uuid)))
  ([ns eid]
   (cond
     (nil? eid) (new-record ns)
     (nil? ns) {:xt/id eid}
     :else {:xt/id eid
            (keyword ns "id") eid})))

(defn create-record
  "Like new-record but selects only allowed keys from attrs."
  [kw-ns id attrs attr-keys]
  (merge (new-record kw-ns id)
         (select-keys attrs attr-keys)))

;; validation ----------------------------------------------------------------------

(defn err-msg-not-found [kind-of-thing id]
  (str kind-of-thing " not found with id `" id "`"))

(defn err-msg-already-exists [kind-of-thing id]
  (str kind-of-thing " creation failed: record already exists with id `" id "`"))

(defn valid-name? [s]
  (let [name-config (try (::config config) (catch Exception _ nil))
        l (and (string? s) (count s))
        max-l (or (:max-name-length name-config) 500)
        min-l (or (:min-name-length name-config) 1)]
    (cond (not (string? s))
          (throw (ex-info "Name must be a string" {:code 400 :name s}))

          (> l max-l)
          (throw (ex-info (str "Name is too long: maximum is " max-l ", got " l)
                          {:code 400 :length l :max-length max-l}))

          (< l min-l)
          (throw (ex-info (str "Name is too short: minimum is " min-l ", got " l)
                          {:code 400 :length l :min-length min-l}))
          :else
          true)))

;; join helpers --------------------------------------------------------------------

(defn layer? [entity]
  (or (:project/id entity)
      (:text-layer/id entity)
      (:token-layer/id entity)
      (:span-layer/id entity)
      (:relation-layer/id entity)
      (:vocab/id entity)))

(defn conj-unique
  "Like conj, but only fires if x is not present."
  [coll x]
  (if (some (hash-set x) coll)
    coll
    (conj coll x)))

(defn add-id [entity key target-id]
  (update entity key conj-unique target-id))

(defn remove-id
  "Remove an ID from a to-many join."
  [entity key target-id]
  (let [new-vec (vec (filter #(not= % target-id) (key entity)))]
    (assoc entity key new-vec)))

(defn add-to-multi-joins*
  "Joins from e1 to e2 at all keys in join-keys. Idempotent."
  [xt-map e1-table e1-id-key e1-id join-keys e2-table e2-id-key e2-id]
  (let [node (->node xt-map)
        e1 (entity-with-sys-from node e1-table e1-id)
        e2 (entity-with-sys-from node e2-table e2-id)]
    (cond
      (nil? e1)
      (throw (ex-info (str "Record not found with ID " e1-id) {:id e1-id :code 400}))

      (nil? e2)
      (throw (ex-info (str "Record not found with ID " e2-id) {:id e2-id :code 400}))

      (nil? (e1-id-key e1))
      (throw (ex-info (str "Record with ID " e1-id " does not have a key " e1-id-key)
                      {:id e1-id :key e1-id-key :code 400}))

      (nil? (e2-id-key e2))
      (throw (ex-info (str "Record with ID " e2-id " does not have a key " e2-id-key)
                      {:id e2-id :key e2-id-key :code 400}))

      :else
      [(match* e1-table e1)
       (match* e2-table e2)
       [:put-docs e1-table
        (-> (reduce (fn [entity join-key]
                      (-> entity
                          (update join-key conj-unique e2-id)
                          (update join-key vec)))
                    e1
                    join-keys)
            (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to))]])))

(defn add-join*
  "See add-to-multi-joins*."
  [xt-map e1-table e1-id-key e1-id join-key e2-table e2-id-key e2-id]
  (add-to-multi-joins* xt-map e1-table e1-id-key e1-id [join-key] e2-table e2-id-key e2-id))

(defn remove-from-multi-joins*
  "Removes joins from e1 to e2 at all keys in join-keys. Idempotent."
  [xt-map e1-table e1-id-key e1-id join-keys e2-table e2-id-key e2-id]
  (let [node (->node xt-map)
        e1 (entity-with-sys-from node e1-table e1-id)
        e2 (entity-with-sys-from node e2-table e2-id)]
    (cond
      (nil? e1)
      (throw (ex-info (str "Record not found with ID " e1-id) {:code 400}))

      (nil? e2)
      (throw (ex-info (str "Record not found with ID " e2-id) {:code 400}))

      (nil? (e1-id-key e1))
      (throw (ex-info (str "Record with ID " e1-id " does not have a key " e1-id-key)
                      {:id e1-id :key e1-id-key :code 400}))

      (nil? (e2-id-key e2))
      (throw (ex-info (str "Record with ID " e2-id " does not have a key " e2-id-key)
                      {:id e2-id :key e2-id-key :code 400}))

      :else
      [(match* e1-table e1)
       (match* e2-table e2)
       [:put-docs e1-table
        (-> (reduce (fn [entity join-key]
                      (remove-id entity join-key e2-id))
                    e1
                    join-keys)
            (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to))]])))

(defn remove-join*
  "See remove-from-multi-joins*."
  [xt-map e1-table e1-id-key e1-id join-key e2-table e2-id-key e2-id]
  (remove-from-multi-joins* xt-map e1-table e1-id-key e1-id [join-key] e2-table e2-id-key e2-id))

;; Index utilities -----------------------------------------------------------------

(defn indexed
  "Returns lazy seq of [index item] pairs."
  [s]
  (map vector (iterate inc 0) s))

(defn positions
  "Returns lazy seq of positions where pred is true."
  [pred coll]
  (for [[idx elt] (indexed coll) :when (pred elt)] idx))

(defn shift
  "Shift element x in vector xs up or down by one. x must be unique."
  [xs x up?]
  (assert (vector? xs))
  (let [index (first (positions #(= x %) xs))
        new-index (if up?
                    (max (dec index) 0)
                    (min (inc index) (dec (count xs))))]
    (if (= new-index index)
      xs
      (let [x' (clojure.core/get xs new-index)
            left (take (min index new-index) xs)
            right (drop (inc (max index new-index)) xs)]
        (reduce into [] [left
                         (if up? [x x'] [x' x])
                         right])))))

(defn make-shift-layer*
  "Returns a shift-layer* function for a given parent/child relationship.
  parent-ref-key: the attribute on the child entity that stores the parent id."
  [parent-table parent-id-key child-table child-id-key join-key parent-ref-key]
  (fn shift-layer*
    [xt-map child-id up?]
    (let [node (->node xt-map)
          child (entity-with-sys-from node child-table child-id)
          parent-id (parent-ref-key child)
          parent (entity-with-sys-from node parent-table parent-id)
          children (join-key parent)]
      (cond
        (nil? (child-id-key child))
        (throw (ex-info (str child-id-key " " child-id " not found")
                        {child-id-key child-id :code 400}))

        (nil? (parent-id-key parent))
        (throw (ex-info (str parent-id-key " " parent-id " not found")
                        {parent-id-key parent-id :code 400}))

        (not (some #{child-id} children))
        (throw (ex-info (str parent-id-key " " parent-id " not linked to " child-id-key " " child-id)
                        {child-id-key child-id parent-id-key parent-id :code 400}))

        :else
        (let [new-parent (assoc parent join-key (shift children child-id up?))]
          [(match* parent-table parent)
           (match* child-table child)
           [:put-docs parent-table
            (dissoc new-parent :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)]])))))
