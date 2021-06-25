(ns glam.crux.util
  (:import (java.util UUID)))

(defn identize [ids id-attr]
  "Turn a seq of ids into a sorted vec of idents"
  (vec (sort (for [id ids]
               [id-attr id]))))

;; conveniences
(defn new-record
  "Create a blank record with a UUID in :crux.db/id. If ns is provided,
  will also assoc this id with (keyword ns \"id\"), e.g. :person/id.
  If ns and eid are both provided, will use the eid for both keys instead
  of a random UUID. If eid is passed but is nil, will fall back to a UUID."
  ([] (new-record nil))
  ([ns]
   (let [eid (UUID/randomUUID)]
     (new-record ns eid)))
  ([ns eid]
   (cond
     (nil? eid) (new-record ns)
     (nil? ns)  {:crux.db/id eid}
     :else      {:crux.db/id       eid
                 (keyword ns "id") eid})))

(defn remove-id
  "Remove an ID from a to-many join"
  [entity key target-id]
  (let [new-vec (vec (filter #(not= % target-id) (key entity)))]
    (assoc entity key new-vec)))

(defn conj-unique
  "Like conj, but only fires if x is not present"
  [coll x]
  (if (some (hash-set x) coll)
    coll
    (conj coll x)))