(ns glam.crux.common
  (:require [crux.api :as crux]
            [taoensso.timbre :as log])
  (:import (java.util UUID)))

;; conveniences
(defn uuid []
  (UUID/randomUUID))

;; writes --------------------------------------------------------------------------------
(defn new-record
  "Create a blank record with a UUID in :crux.db/id. If ns is provided,
  will also assoc this id with (keyword ns \"id\"), e.g. :person/id.
  This simplifies queries for use with pathom and fulcro."
  ([] (new-record nil))
  ([ns]
   (let [id (uuid)]
     (if (nil? ns)
       {:crux.db/id id}
       {:crux.db/id       id
        (keyword ns "id") id}))))

(defn put [node doc-or-docs]
  "Put either a single document or a sequence of documents"
  (crux/submit-tx node (->> (if-not (sequential? doc-or-docs)
                              (vector doc-or-docs)
                              doc-or-docs)
                            (map (fn [doc] [:crux.tx/put doc]))
                            vec)))

(defn put-sync [node doc-or-docs]
  (crux/await-tx node (put node doc-or-docs)))

(defmacro deftx [name node bindings & body]
  "Defines a transaction function on the given node."
  (let [kwd-name (keyword (str *ns*) (str name))]
    `(do
       (crux/submit-tx ~node [[:crux.tx/put {:crux.db/id ~kwd-name
                                             :crux.db/fn (quote (fn ~bindings
                                                                  ~@body))}]])
       (defn ~name [& ~'args]
         (crux/submit-tx ~node (log/spy [(into [:crux.tx/fn ~kwd-name] ~'args)]))))))

(defmacro defsetter [name node attr]
  "Shortcut for simple sets on a single attribute"
  `(deftx
     ~name
     ~node
     [ctx# eid# val#]
     (when-let [entity# (crux.api/entity (crux.api/db ctx#) eid#)]
       [[:crux.tx/put (assoc entity# ~attr val#)]])))


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

