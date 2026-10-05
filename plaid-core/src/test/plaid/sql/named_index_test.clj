(ns plaid.sql.named-index-test
  "Every index the code names (`INDEXED BY`) exists in the migrated schema
  and leads with the column the code reads it by. A migration that renamed,
  dropped or reshaped one would otherwise turn every delete on that path
  into a 500 (`no such index`, `no query solution`). The names are read from
  the source, so a new one is checked without listing it here."
  (:require [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.fixtures :refer [db with-db]]))

(use-fixtures :once with-db)

(defn- sources []
  (->> (file-seq (io/file "src/main"))
       (filter #(.endsWith (.getName ^java.io.File %) ".clj"))
       (map (fn [f] [(str f) (slurp f)]))))

(defn- leading-column [index]
  (:name (psc/q1 db ["SELECT name FROM pragma_index_info(?) WHERE seqno = 0" index])))

(defn- index-table [index]
  (:tbl_name (psc/q1 db ["SELECT tbl_name FROM sqlite_schema WHERE type = 'index' AND name = ?" index])))

(deftest every-index-read-through-select-in-leads-with-its-column
  (let [calls (for [[f src] (sources)
                    [_ table col index] (re-seq #"crud/select-in\s+\w+\s+:(\w+)\s+\"[^\"]*\"\s+:(\w+)\s+\"(\w+)\"" src)]
                [f table col index])]
    (is (< 15 (count calls)) "the pattern still finds the calls")
    (doseq [[f table col index] calls]
      (testing (str f " " index)
        (is (= table (index-table index)) "the index is on the table the code reads")
        (is (= col (leading-column index)) "the index leads with the column the code reads by")))))

(deftest every-index-named-in-sql-exists
  (let [names (for [[f src] (sources)
                    [_ index] (re-seq #"INDEXED BY (idx_\w+)" src)]
                [f index])]
    (is (seq names))
    (doseq [[f index] names]
      (testing (str f " " index)
        (is (some? (index-table index)))))))

(deftest every-table-deleted-by-id-has-a-primary-key-index-on-id
  (let [tables (distinct (for [[_ src] (sources)
                               [_ table] (re-seq #"(?:crud/delete-ids!|crud/rows-by-id)\s+\w+\s+:(\w+)" src)]
                           table))]
    (is (< 5 (count tables)) "the pattern still finds the calls")
    (doseq [table tables]
      (testing table
        (is (= "id" (leading-column (crud/pk-index db table))))))
    (testing "the tables read by their primary key under another name"
      (is (= "span_id" (leading-column (crud/pk-index db :span_tokens))))
      (is (= "vocab_link_id" (leading-column (crud/pk-index db :vocab_link_tokens))))
      (is (= "entity_type" (leading-column (crud/pk-index db :entity_metadata))))
      (is (= "entity_id" (:name (psc/q1 db ["SELECT name FROM pragma_index_info(?) WHERE seqno = 1"
                                            (crud/pk-index db :entity_metadata)])))))))
