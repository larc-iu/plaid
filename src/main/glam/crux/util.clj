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
  This simplifies queries for use with pathom and fulcro."
  ([] (new-record nil))
  ([ns]
   (let [eid (UUID/randomUUID)]
     (if (nil? ns)
       {:crux.db/id eid}
       {:crux.db/id       eid
        (keyword ns "id") eid}))))
