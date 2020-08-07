(ns glam.crux.util)

(defn identize [ids id-attr]
  "Turn a seq of ids into a sorted vec of idents"
  (vec (sort (for [id ids]
               [id-attr id]))))