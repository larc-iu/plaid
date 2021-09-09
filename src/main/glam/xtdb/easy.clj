(ns glam.xtdb.easy
  "A set of convenience functions for transactions with only one part and other common xtdb operations.
  Functions that end in * return a vector that can be used to build transactions incrementally."
  (:require [xtdb.api :as xt]
            [clojure.pprint :as pprint]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [set update merge]))

;; reads ---------------------------------------------------------------------------------
(defn entity [node id]
  "Get an entire entity by :xt/id"
  (xt/entity (xt/db node) id))

(defn entities [node id-vecs]
  "get entities given a seq of 1-tuples of :xt/id"
  (map #(entity node (first %)) id-vecs))

(defn q [node query]
  (xt/q (xt/db node) query))

(defn- find-entity-by-attrs
  "Find an entity by attributes. Options:
    - :id-only? [false] - set to true to return only :xt/id instead of the entire entity
    - :all-results [false] - set to true to return more than just the first entity"
  ([node attrs] (find-entity-by-attrs node attrs {:id-only? false :all-results false}))
  ([node attrs {:keys [id-only? all-results] :as opts}]
   (let [result (xt/q (xt/db node)
                      {:find  ['e]
                       :where (vec (for [[k v] attrs]
                                     ['e k v]))})
         result (if all-results result (ffirst result))
         result (if id-only?
                  result
                  (if (set? result)
                    (entities node result)
                    (entity node result)))]
     result)))

(defn find-entity-id [node attrs] (find-entity-by-attrs node attrs {:id-only? true :all-results false}))
(defn find-entity-ids [node attrs] (find-entity-by-attrs node attrs {:id-only? true :all-results true}))
(defn find-entity [node attrs] (find-entity-by-attrs node attrs {:id-only? false :all-results false}))
(defn find-entities [node attrs] (find-entity-by-attrs node attrs {:id-only? false :all-results true}))

;; match --------------------------------------------------------------------------------
(defn match*
  ([eid doc]
   [:xtdb.api/match eid doc])
  ([eid doc valid-time]
   [:xtdb.api/match eid doc valid-time]))

;; tx functions for mutations ------------------------------------------------------------
(def ^:private merge-tx-fn-id ::merge)
(def ^:private merge-tx-fn '(fn [ctx eid m]
                              (let [db (xtdb.api/db ctx)
                                    entity (xtdb.api/entity db eid)]
                                [[:xtdb.api/put (merge entity m)]])))

(def ^:private update-tx-fn-id ::update)
(def ^:private update-tx-fn '(fn [ctx eid k f-symbol & args]
                               (let [db (xtdb.api/db ctx)
                                     entity (xtdb.api/entity db eid)
                                     ;; namespace qualify f with clojure.core if there is none
                                     qualified-f-symbol (if (nil? (namespace f-symbol))
                                                          (symbol "clojure.core" (str f-symbol))
                                                          f-symbol)
                                     f-lambda (-> qualified-f-symbol find-var var-get)]
                                 [[:xtdb.api/put (apply update (into [entity k f-lambda] args))]])))

(defn install-tx-fns! [node]
  "Call this on your xtdb node whenever you start it"
  (let [tx-fn (fn [eid fn] {:xt/id eid :xt/fn fn})
        put* (fn [doc] [:xtdb.api/put doc])]
    (when-not (entity node merge-tx-fn-id)
      (log/info "Installing merge transaction function")
      (xt/submit-tx node [(match* merge-tx-fn-id nil)
                          (put* (tx-fn merge-tx-fn-id merge-tx-fn))]))
    (when-not (entity node update-tx-fn-id)
      (log/info "Installing update transaction function")
      (xt/submit-tx node [(match* update-tx-fn-id nil)
                          (put* (tx-fn update-tx-fn-id update-tx-fn))]))))

;; mutations --------------------------------------------------------------------------------
(defn submit-tx-sync [node tx]
  (let [tx-map (xt/submit-tx node tx)]
    (xt/await-tx node tx-map)
    (xt/tx-committed? node tx-map)))
(def submit! submit-tx-sync)

;; vanilla xtdb mutations
(defn put* [doc]
  [:xtdb.api/put doc])
(defn put [node doc]
  (submit-tx-sync node [(put* doc)]))

(defn delete* [eid]
  [:xtdb.api/delete eid])
(defn delete [node eid]
  (submit-tx-sync node [(delete* eid)]))

(defn evict* [eid]
  [:xtdb.api/evict eid])
(defn evict [node eid]
  (submit-tx-sync node [(evict* eid)]))

;; additional mutations api enabled by our tx-fns
(defn merge*
  "Merges m with some entity identified by eid in a transaction function"
  [eid m]
  [:xtdb.api/fn merge-tx-fn-id eid m])
(defn merge
  "Merges m with some entity identified by eid in a transaction function"
  [node eid m]
  (submit-tx-sync node [(merge* eid m)]))

(defmacro update*
  "Updates some entity identified by eid in a transaction function. f can be any function"
  [eid k f & args]
  `(let [f-symbol# (-> ~f var symbol)]
     [:xtdb.api/fn ~update-tx-fn-id ~eid ~k f-symbol# ~@args]))
(defmacro update
  "Updates some entity identified by eid in a transaction function. f can be any function"
  [node eid k f & args]
  `(submit-tx-sync ~node [(update* ~eid ~k ~f ~@args)]))
