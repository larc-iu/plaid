(ns plaid.xtdb.common
  (:require [xtdb.api :as xt]
            [xtdb.node]
            [xtdb.query]
            [taoensso.timbre :as log]
            [plaid.server.config :refer [config]])
  (:import (xtdb.node XtdbNode)
           (xtdb.query QueryDatasource)))

(defn ensure-db [{:keys [node db] :as xtdb}]
  "For use in write functions. Writes receive a map with keys :node and :db as
  their first argument, with :db being optional. This function ensures that
  the :db key is populated if it was not present. Also tolerates a plain XTDB
  node as an argument."
  (cond
    (not (map? xtdb))
    {:node xtdb :db (xt/db xtdb)}

    :else
    (assoc xtdb :db (or db (xt/db node)))))

(defn ->db [o]
  "For use in read functions. For reads, we allow the first argument to be
  the XTDB node, or an XTDB db, or a map of the two (see ensure-db above).
  This function returns a database regardless of which was passed."
  (cond (instance? XtdbNode o)
        (xt/db o)

        (instance? QueryDatasource o)
        o

        (and (map? o) (:db o))
        (:db o)

        :else
        (throw (ex-info "Not a valid XtdbNode or QueryDatasource or XTDB map."
                        {:value o}))))

(defn layer? [entity]
  (or (:text-layer/id entity)
      (:token-layer/id entity)
      (:span-layer/id entity)
      (:relation-layer/id entity)
      (:vocab-layer/id entity)))

;; queries ----------------------------------------------------------------------
(defn entity [db id]
  "Get an entire entity by :xt/id"
  (xt/entity db id))

(defn entities [db id-vecs]
  "get entities given a seq of 1-tuples of :xt/id"
  (map #(entity db (if (coll? %) (first %) %)) id-vecs))

(defn- find-entity-by-attrs
  "Find an entity by attributes. Options:
    - :id-only? [false] - set to true to return only :xt/id instead of the entire entity
    - :all-results [false] - set to true to return more than just the first entity"
  ([db attrs] (find-entity-by-attrs db attrs {:id-only? false :all-results false}))
  ([db attrs {:keys [id-only? all-results] :as opts}]
   (let [result (xt/q db
                      {:find  ['e]
                       :where (vec (for [[k v] attrs]
                                     ['e k v]))})
         result (if all-results result (ffirst result))
         result (if id-only?
                  result
                  (if (set? result)
                    (entities db result)
                    (entity db result)))]
     result)))

(defn find-entity
  "Given a map of attribute-value pairs, return a single entity that satisfies it, or nil.
  If multiple matches exist, returns one of them without reporting an error without guarantee
  of which one it might be."
  [db attrs]
  (find-entity-by-attrs db attrs {:id-only? false :all-results false}))

(defn find-entities
  "Given a map of attribute-value pairs, return all entities that satisfy it, or nil."
  [db attrs]
  (find-entity-by-attrs db attrs {:id-only? false :all-results true}))

(defn find-entity-id [db attrs] (find-entity-by-attrs db attrs {:id-only? true :all-results false}))
(defn find-entity-ids [db attrs] (find-entity-by-attrs db attrs {:id-only? true :all-results true}))

;; creation ----------------------------------------------------------------------
(defn new-record
  ([] (new-record nil))
  ([ns]
   (let [eid (random-uuid)]
     (new-record ns eid)))
  ([ns eid]
   (cond
     (nil? eid) (new-record ns)
     (nil? ns) {:xt/id eid}
     :else {:xt/id            eid
            (keyword ns "id") eid})))

(defn create-record
  "Wrapper around new-record that guarantees records will not have extraneous keys"
  [kw-ns id attrs attr-keys]
  (merge (new-record kw-ns id)
         (select-keys attrs attr-keys)))

(defmacro submit!
  "Wrap the xtdb transaction submission function in some standard error handling.
  If any write encounters a data model integrity error as it attempts to construct
  a transaction, it should (throw (ex-info ...)) so that this standard mechanism
  will report helpful information about the issue up the call chain. Note that
  this is a macro because we want to defer the evaluation"
  [node tx-expr]
  `(try
     (let [tx# ~tx-expr
           tx-map# (xt/submit-tx ~node tx#)]
       (xt/await-tx ~node tx-map#)
       {:success (xt/tx-committed? ~node tx-map#)})
     (catch clojure.lang.ExceptionInfo e#
       (let [data# (ex-data e#)]
         (log/warn "Transaction failed: " data#)
         {:success false
          :error   (ex-message e#)
          :code    (:code data#)}))))

(defmacro submit-with-extras!
  "Like submit!, but with a callback on the tx vector whose result gets assoced at :extra
  on success."
  [node tx-expr get-extra]
  `(try
     (let [tx# ~tx-expr
           tx-map# (xt/submit-tx ~node tx#)]
       (xt/await-tx ~node tx-map#)
       (cond-> {:success (xt/tx-committed? ~node tx-map#)}
               ~get-extra (assoc :extra (~get-extra tx#))))
     (catch clojure.lang.ExceptionInfo e#
       (let [data# (ex-data e#)]
         (log/warn (str "Transaction failed: " data# ". Full info: " e#))
         {:success false
          :error   (ex-message e#)
          :code    (:code data#)}))))

;; misc --------------------------------------------------------------------------------
(defn match* [xt-map ids]
  (let [{:keys [db] :as xt-map} (ensure-db xt-map)]
    (mapv (fn [id] [::xt/match id (entity db id)])
          ids)))

(defn merge* [xt-map id attrs]
  (let [{:keys [db] :as xt-map} (ensure-db xt-map)
        e (entity db id)]
    (cond
      (nil? e)
      (throw (ex-info (str "Record not found with ID " id) {:id id :code 404}))

      :else
      [[::xt/match id e]
       [::xt/put (merge e attrs)]])))

(defn err-msg-not-found [kind-of-thing id]
  (str kind-of-thing " not found with id `" id "`"))

(defn err-msg-already-exists [kind-of-thing id]
  (str kind-of-thing " creation failed: record already exists with id `" id "`"))

(defn valid-name? [s]
  (let [name-config (::config config)
        l (and (string? s) (count s))
        max-l (:max-name-length name-config)
        min-l (:min-name-length name-config)]
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

;; join helpers --------------------------------------------------------------------------------
(defn conj-unique
  "Like conj, but only fires if x is not present"
  [coll x]
  (if (some (hash-set x) coll)
    coll
    (conj coll x)))

(defn add-id [entity key target-id]
  (update entity key conj-unique target-id))

(defn remove-id
  "Remove an ID from a to-many join"
  [entity key target-id]
  (let [new-vec (vec (filter #(not= % target-id) (key entity)))]
    (assoc entity key new-vec)))

(defn add-to-multi-joins*
  "Joins from e1 to e2 at all keys specified in `join-keys`. This function is idempotent:
  if an e1->e2 join already exists at some join key on e1, nothing will change."
  [xt-map e1-id-key e1-id join-keys e2-id-key e2-id]
  (let [{:keys [db] :as xt-map} (ensure-db xt-map)
        e1 (entity db e1-id)
        e2 (entity db e2-id)]
    (cond
      (nil? e1)
      (throw (ex-info (str "Record not found with ID " e1-id) {:id   e1-id
                                                               :code 400}))

      (nil? e2)
      (throw (ex-info (str "Record not found with ID " e2-id) {:id   e2-id
                                                               :code 400}))

      (nil? (e1-id-key e1))
      (throw (ex-info (str "Record with ID " e1-id " does not have a key " e1-id-key) {:id   e1-id
                                                                                       :key  e1-id-key
                                                                                       :code 400}))

      (nil? (e2-id-key e2))
      (throw (ex-info (str "Record with ID " e2-id " does not have a key " e2-id-key) {:id   e2-id
                                                                                       :key  e2-id-key
                                                                                       :code 400}))

      :else
      [[::xt/match e1-id e1]
       [::xt/match e2-id e2]
       [::xt/put (reduce (fn [entity join-key]
                           (-> entity
                               (update join-key conj-unique e2-id)
                               ;; in case this is the first assoc, turn the list into a vector
                               (update join-key vec)))
                         e1
                         join-keys)]])))

(defn add-join*
  "See `add-to-multi-joins*`."
  [xt-map e1-id-key e1-id join-key e2-id-key e2-id]
  (add-to-multi-joins* xt-map e1-id-key e1-id [join-key] e2-id-key e2-id))

(defn remove-from-multi-joins*
  "Remove joins from e1 to e2 at all keys specified in `join-keys`. This function is
  idempotent: if an e1->e2 join does not exist at some join key on e1, nothing will change."
  [xt-map e1-id-key e1-id join-keys e2-id-key e2-id]
  (let [{:keys [db] :as xt-map} (ensure-db xt-map)
        e1 (entity db e1-id)
        e2 (entity db e2-id)]
    (cond
      (nil? e1)
      (throw (ex-info (str "Record not found with ID " e1-id) {:code 400}))

      (nil? e2)
      (throw (ex-info (str "Record not found with ID " e2-id) {:code 400}))

      (nil? (e1-id-key e1))
      (throw (ex-info (str "Record with ID " e1-id " does not have a key " e1-id-key) {:id   e1-id
                                                                                       :key  e1-id-key
                                                                                       :code 400}))

      (nil? (e2-id-key e2))
      (throw (ex-info (str "Record with ID " e2-id " does not have a key " e2-id-key) {:id   e2-id
                                                                                       :key  e2-id-key
                                                                                       :code 400}))

      :else
      [[::xt/match e1-id e1]
       [::xt/match e2-id e2]
       [::xt/put (reduce (fn [entity join-key]
                           (remove-id entity join-key e2-id))
                         e1
                         join-keys)]])))

(defn remove-join*
  "See `remove-from-multi-joins*`"
  [xt-map e1-id-key e1-id join-key e2-id-key e2-id]
  (remove-from-multi-joins* xt-map e1-id-key e1-id [join-key] e2-id-key e2-id))

;; From https://stackoverflow.com/questions/4830900/how-do-i-find-the-index-of-an-item-in-a-vector
(defn indexed
  "Returns a lazy sequence of [index, item] pairs, where items come
  from 's' and indexes count up from zero.

  (indexed '(a b c d))  =>  ([0 a] [1 b] [2 c] [3 d])"
  [s]
  (map vector (iterate inc 0) s))

;; From https://stackoverflow.com/questions/4830900/how-do-i-find-the-index-of-an-item-in-a-vector
(defn positions
  "Returns a lazy sequence containing the positions at which pred
   is true for items in coll."
  [pred coll]
  (for [[idx elt] (indexed coll) :when (pred elt)] idx))

(defn shift
  "Shift an element in xs up or down by one position. Assumes that
  xs is a vector and that x is unique inside that vector"
  [xs x up?]
  (assert (vector? xs))
  (let [index (first (positions #(= x %) xs))
        new-index (if up?
                    (max (dec index) 0)
                    (min (inc index) (- (count xs) 1)))]
    (if (= new-index index)
      xs
      (let [x' (clojure.core/get xs new-index)
            left (take (min index new-index) xs)
            right (drop (inc (max index new-index)) xs)]
        (reduce into [] [left
                         (if up? [x x'] [x' x])
                         right])))))

(defn make-shift-layer* [parent-id-key child-id-key join-key]
  (fn shift-layer*
    [xt-map parent-id child-id up?]
    (let [{:keys [db] :as xt-map} (ensure-db xt-map)
          parent (entity db parent-id)
          child (entity db child-id)
          children (join-key parent)]
      (cond
        (nil? child)
        (throw (ex-info (str child-id-key " " child-id " not found") {child-id-key child-id :code 400}))

        (nil? parent)
        (throw (ex-info (str parent-id-key " " parent-id " not found") {parent-id-key parent-id :code 400}))

        (not (some #{child-id} children))
        (throw (ex-info (str parent-id-key " " parent-id " not linked to " child-id-key " " child-id)
                        {child-id-key  child-id
                         parent-id-key parent-id
                         :code         400}))

        :else
        (let [new-prj (assoc parent join-key (shift children child-id up?))]
          [[::xt/match (:xt/id parent) parent]
           [::xt/match (:xt/id child) child]
           [::xt/put new-prj]])))))
