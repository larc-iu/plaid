(ns plaid.sql.uuid-order-test
  "Ids minted in one millisecond keep the order they were minted in.

  Every read is id-ordered, and a bulk create mints all of its ids inside one
  millisecond. With random low bits those rows came back shuffled, so which of
  two annotations on a token the editor showed was a coin flip, and an archive
  round trip changed the gloss a person sees."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]))

(deftest ids-minted-together-sort-in-order
  (let [ids (mapv (fn [_] (psc/uuid-str (psc/new-uuid))) (range 5000))]
    (is (= ids (sort ids)) "ids must sort in the order they were minted")
    (is (= (count ids) (count (distinct ids))) "and must not repeat")))

(deftest ids-are-version-7-and-random
  (let [ids (repeatedly 100 psc/new-uuid)]
    (doseq [^java.util.UUID id ids]
      (is (= 7 (.version id)) "version 7")
      (is (= 2 (.variant id)) "RFC 4122 variant"))
    ;; The 62 low bits stay random, so an id is not guessable from its neighbour.
    (is (= 100 (count (distinct (map #(.getLeastSignificantBits ^java.util.UUID %) ids)))))))
