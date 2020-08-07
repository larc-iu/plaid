(ns glam.crux.easy
  "A set of convenience functions for transactions with only one part and other common crux operations."
  (:require [crux.api :as crux]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [set update])
  (:import (java.util UUID)))

;; conveniences
(defn uuid []
  (UUID/randomUUID))

(defn new-record
  "Create a blank record with a UUID in :crux.db/id. If ns is provided,
  will also assoc this id with (keyword ns \"id\"), e.g. :person/id.
  This simplifies queries for use with pathom and fulcro."
  ([] (new-record nil))
  ([ns]
   (let [eid (uuid)]
     (if (nil? ns)
       {:crux.db/id eid}
       {:crux.db/id       eid
        (keyword ns "id") eid}))))

;; reads ---------------------------------------------------------------------------------
(defn entity [node id]
  "Get an entire entity by :crux.db/id"
  (crux/entity (crux/db node) id))

(defn entities [node id-vecs]
  "get entities given a seq of 1-tuples of :crux.db/id"
  (map #(entity node (first %)) id-vecs))

(defn q [node query]
  (crux/q (crux/db node) query))

(defn- find-entity-by-attrs
  "Find an entity by attributes. Options:
    - :id-only? [false] - set to true to return only :crux.db/id instead of the entire entity
    - :all-results [false] - set to true to return more than just the first entity"
  ([node attrs] (find-entity-by-attrs node attrs {:id-only? false :all-results false}))
  ([node attrs {:keys [id-only? all-results] :as opts}]
   (let [result (crux/q (crux/db node)
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

;; mutations --------------------------------------------------------------------------------
(defn- put-async [node doc-or-docs]
  (crux/submit-tx node (->> (if-not (sequential? doc-or-docs)
                              (vector doc-or-docs)
                              doc-or-docs)
                            (map (fn [doc] [:crux.tx/put doc]))
                            vec)))
(defn put [node doc-or-docs]
  "Put either a single document or a sequence of documents. NOTE: only use
  this if you are creating a new document. Otherwise, prefer `update`"
  (crux/await-tx node (put-async node doc-or-docs)))

(defn- update-async [node eid f & args]
  (locking eid
    (let [ent (entity node eid)]
      (put-async node (apply f (into [ent] args))))))
(defn update [node eid f & args]
  "Apply f and its arguments to the document identified by eid, (apply f [ent a1 a2 a3 ...]).
  E.g.: (cce/update node :birthday-boy update :age inc)
  This function LOCKS the entity id using the clojure `locking` macro to avoid race conditions
  (https://clojurians-log.clojureverse.org/crux/2020-03-24). If you need to avoid this perf penalty
  or use a more sophisticated coordination technique, don't use this function."
  (crux/await-tx node (apply update-async (into [node eid f] args))))

(defn- delete-async [node eid]
  (crux/submit-tx node [[:crux.tx/delete eid]]))
(defn delete [node eid]
  "Delete a document by eid."
  (crux/await-tx node (delete-async node eid)))

(defn- evict-async [node eid]
  (crux/submit-tx node [[:crux.tx/evict eid]]))
(defn evict [node eid]
  "Evict a document by eid."
  (crux/await-tx node (evict-async node eid)))

;; deftx --------------------------------------------------------------------------------
;; macro for transactions to avoid race conditions: https://clojurians-log.clojureverse.org/crux/2020-03-24
;; The installation of tx functions makes this a little more complicated than the one used by `update` above
;; which simply locks the entity ID. On the other hand, this approach is more powerful. For now, I'm ignoring
;; this approach in favor of just using `update`.
(defmacro deftx [name bindings & body]
  "Defines a function used for mutations that uses a Crux transaction function under the hood.
  body must return a valid Crux transaction vector, with any non-clojure.core variables fully
  qualified. `install-tx-fns` must be called on namespaces where deftx is used for the function
  to work."
  (let [kwd-name (keyword (str *ns*) (str name))
        symbol-name (symbol (str name))]
    `(def
       ~(vary-meta
          symbol-name
          assoc
          :crux-tx-fn
          `(fn [node#]
             (crux/submit-tx node# [[:crux.tx/put {:crux.db/id ~kwd-name
                                                   :crux.db/fn (quote (fn ~bindings
                                                                        ~@body))}]])))
       (fn ~symbol-name [node# & ~'args]
         (crux/await-tx
           node#
           (crux/submit-tx node# (log/spy [(into [:crux.tx/fn ~kwd-name] ~'args)])))))))

(defn install-tx-fns [node namespaces]
  "Given a node and a seq of namespace symbols, scan all public vars
  and use any :crux-tx-fn in their metadata to install the tx-fn on
  the node"
  (doseq [ns-symbol namespaces]
    (when-let [ns (the-ns ns-symbol)]
      (doseq [[vname v] (ns-publics ns)]
        (when-let [tx-install-fn (some-> v meta :crux-tx-fn)]
          ;; evict any already-existing entities with the tx-fn's id
          (evict node (keyword (str ns) (str vname)))
          (tx-install-fn node))))))

(defmacro defsetter [name attr]
    "Shortcut for simple sets on a single attribute"
    `(deftx
       ~name
       [ctx# eid# val#]
       (when-let [entity# (crux.api/entity (crux.api/db ctx#) eid#)]
         [[:crux.tx/put (assoc entity# ~attr val#)]])))

