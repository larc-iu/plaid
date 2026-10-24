(ns plaid.sql.metadata-key-order-test
  "Metadata is read in key order, whatever order its rows were written in, so
  two reads of the same metadata give the same map and an export of it is the
  same bytes (ROUNDTRIP-PROD class 9: the order of a span's metadata keys
  changed between two exports of one project). Once the table has statistics
  (ANALYZE, which a project removal runs), SQLite reads a long id list by
  scanning the table in row order, so without an ORDER BY a key written later
  comes out later."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [next.jdbc :as jdbc]
            [plaid.fixtures :as fx :refer [with-db with-clean-db]]
            [plaid.sql.document-rows :as drows]
            [plaid.sql.metadata :as psm]))

(use-fixtures :once with-db)
(use-fixtures :each with-clean-db)

(def ^:private ids (mapv #(str "s" %) (range 400)))

(defn- insert! [id k]
  (jdbc/execute! fx/db ["INSERT INTO entity_metadata (entity_type, entity_id, key, value) VALUES (?, ?, ?, ?)"
                        "span" id k "1"]))

(deftest metadata-reads-in-key-order
  ;; Every entity's "zeta" row is written before its "alpha" row.
  (doseq [id ids] (insert! id "zeta"))
  (doseq [id ids] (insert! id "alpha"))
  (jdbc/execute! fx/db ["ANALYZE"])
  (testing "one entity"
    (is (= ["alpha" "zeta"] (vec (keys (psm/get-metadata fx/db "span" "s1"))))))
  (testing "many entities at once, as a document read takes them"
    (let [m (psm/metadata-of fx/db "span" ids)]
      (is (every? #(= ["alpha" "zeta"] (vec (keys (get m %)))) ids))))
  (testing "a document read's rows"
    (let [rows (drows/with-metadata fx/db "span" (mapv (fn [id] {:id id}) ids))]
      (is (every? #(= ["alpha" "zeta"] (vec (keys (:metadata %)))) rows)))))
