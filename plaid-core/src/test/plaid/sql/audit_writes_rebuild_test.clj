(ns plaid.sql.audit-writes-rebuild-test
  "The `audit_writes` rebuild (migration 20260927130000): an integer key, no
  index on `ts` alone, a target index over only the tables read by target,
  and a `vocab_layer_id` column filled in for the rows already there. Also
  that every read of the log is still served by an index under the driver
  the server runs, since a partial index is only used when a query's terms
  match its predicate."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [plaid.test-helpers :refer [create-vocab-layer create-vocab-item
                                        update-vocab-item delete-vocab-item
                                        bulk-create-vocab-items bulk-delete-vocab-items
                                        update-vocab-item-metadata]])
  (:import (java.io File)))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-rebuild-" (System/nanoTime)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- cfg [ds] {:store :database :migration-dir "migrations" :db {:datasource ds}})

(def ^:private ts0 "2026-09-01T00:00:00.000000000Z")

(defn- ts [n] (str/replace ts0 "000000000Z" (format "%09dZ" n)))

(deftest the-rebuild-keeps-every-row-and-fills-in-the-vocabulary
  (let [path (temp-db-path)
        ds (psd/build-datasource path)]
    (try
      (migratus/migrate-until-just-before (cfg ds) 20260927130000)
      (let [vocab "v-1"
            other "v-2"
            item "i-1"
            op! (fn [id n]
                  (jdbc/execute! ds ["INSERT INTO operations (id, op_type, ts) VALUES (?, 'x/y', ?)" id (ts n)]))
            row! (fn [id op-id seq table target change post n doc]
                   (jdbc/execute! ds ["INSERT INTO audit_writes (id, op_id, seq, target_table, target_id, change_type, post_image, ts, document_id) VALUES (?,?,?,?,?,?,?,?,?)"
                                      id op-id seq table target change post (ts n) doc]))]
        (doseq [[i n] [["o1" 1] ["o2" 2] ["o3" 3] ["o4" 4]]] (op! i n))
        (row! "a" "o1" 0 "vocab_layers" vocab "insert" "{\"id\":\"v-1\",\"name\":\"V\"}" 1 nil)
        (row! "b" "o2" 0 "vocab_items" item "insert" "{\"id\":\"i-1\",\"vocab_layer_id\":\"v-1\",\"form\":\"kai\"}" 2 nil)
        (row! "c" "o2" 1 "vocab_layers" vocab "update" "{\"id\":\"v-1\",\"name\":\"V\"}" 2 nil)
        (row! "d" "o3" 0 "documents" "d-1" "insert" "{\"id\":\"d-1\"}" 3 "d-1")
        (row! "e" "o3" 1 "vocab_layers" other "insert" "{\"id\":\"v-2\"}" 3 nil)
        (row! "f" "o4" 0 "vocab_items" item "delete" nil 4 nil)
        (migratus/migrate (cfg ds))
        (let [rows (jdbc/execute! ds ["SELECT * FROM audit_writes ORDER BY id"]
                                  {:builder-fn next.jdbc.result-set/as-unqualified-maps})]
          (testing "every row survives, in the order it was written, under an integer key"
            (is (= [["o1" 0] ["o2" 0] ["o2" 1] ["o3" 0] ["o3" 1] ["o4" 0]]
                   (mapv (juxt :op_id :seq) rows)))
            (is (every? integer? (map :id rows))))
          (testing "a vocabulary row carries its own id, an entry row its vocabulary"
            (is (= ["v-1" "v-1" "v-1" nil "v-2" "v-1"] (mapv :vocab_layer_id rows))))
          (testing "the entry's delete row, which has no image, takes the entry's vocabulary"
            (is (= "v-1" (:vocab_layer_id (last rows)))))
          (testing "the document stamp is untouched"
            (is (= "d-1" (:document_id (nth rows 3))))))
        (testing "the indexes"
          (let [idx (set (map :name (jdbc/execute! ds ["SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_writes'"]
                                                   {:builder-fn next.jdbc.result-set/as-unqualified-maps})))]
            (is (contains? idx "idx_audit_writes_op_seq"))
            (is (contains? idx "idx_audit_writes_document_ts"))
            (is (contains? idx "idx_audit_writes_target"))
            (is (contains? idx "idx_audit_writes_vocab_layer_ts"))
            (is (not (contains? idx "idx_audit_writes_ts")))))
        (testing "(op_id, seq) is still unique"
          (is (thrown? Exception
                       (jdbc/execute! ds ["INSERT INTO audit_writes (op_id, seq, target_table, target_id, change_type, ts) VALUES ('o1', 0, 'x', 'y', 'insert', ?)" (ts 9)])))))
      (finally
        (.close ds)
        (doseq [suffix ["" "-wal" "-shm"]]
          (.delete (File. (str path suffix))))))))

;; ------------------------------------------------------------
;; What the writers stamp
;; ------------------------------------------------------------

(defn- vocab-rows [vocab-id]
  (psc/q db {:select [:target_table :target_id :change_type]
             :from [:audit_writes]
             :where [:= :vocab_layer_id vocab-id]
             :order-by [:ts :seq]}))

(deftest every-vocabulary-write-is-stamped-with-its-vocabulary
  (let [v (-> (create-vocab-layer admin-request "Stamped") :body :id)
        other (-> (create-vocab-layer admin-request "Other") :body :id)
        item (-> (create-vocab-item admin-request v "kai") :body :id)
        _ (update-vocab-item admin-request item "kay")
        _ (update-vocab-item-metadata admin-request item {"gloss" "eat"})
        [b1 b2] (-> (bulk-create-vocab-items admin-request [{:vocab-layer-id v :form "a"}
                                                            {:vocab-layer-id other :form "b"}])
                    :body :ids)
        _ (bulk-delete-vocab-items admin-request [b1 b2])
        _ (delete-vocab-item admin-request item)
        rows (vocab-rows v)
        items (filter #(= "vocab_items" (:target_table %)) rows)]
    (testing "entry rows: create, rename, metadata, and both deletes"
      (is (= [[(str item) "insert"] [(str item) "update"] [(str item) "update"]
              [(str b1) "insert"] [(str b1) "delete"] [(str item) "delete"]]
             (mapv (juxt (comp str :target_id) :change_type) items))))
    (testing "the vocabulary's own rows"
      (is (every? #(= (str v) (str (:target_id %)))
                  (filter #(= "vocab_layers" (:target_table %)) rows))))
    (testing "the other vocabulary's entry is its own"
      (is (= [(str b2) (str b2)]
             (mapv (comp str :target_id)
                   (filter #(= "vocab_items" (:target_table %)) (vocab-rows other))))))
    (testing "nothing else is stamped"
      (is (zero? (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:audit_writes]
                                 :where [:and [:not= :vocab_layer_id nil]
                                         [:not-in :target_table ["vocab_items" "vocab_layers"]]]})))))))

;; ------------------------------------------------------------
;; Plans, under the server's own driver
;; ------------------------------------------------------------

(defn- plan [sql & params]
  (str/join " | " (map :detail (psc/q db (into [(str "EXPLAIN QUERY PLAN " sql)] params)))))

(deftest the-reads-of-the-log-use-its-indexes
  (let [t "2026-09-27T00:00:00.000000000Z"]
    (testing "one layer table, as the as-of read asks for it"
      (is (re-find #"USING INDEX idx_audit_writes_target"
                   (plan "SELECT * FROM audit_writes WHERE target_table = ? AND ts <= ? ORDER BY ts, seq"
                         "span_layers" t))))
    (testing "entries by id"
      (is (re-find #"USING INDEX idx_audit_writes_target"
                   (plan "SELECT * FROM audit_writes WHERE target_table = ? AND target_id IN (?, ?) AND ts <= ? ORDER BY ts, seq"
                         "vocab_items" "a" "b" t))))
    (testing "the document feed's documents rows"
      (is (re-find #"USING INDEX idx_audit_writes_target"
                   (plan "SELECT op_id FROM audit_writes WHERE target_table = ? AND target_id = ?"
                         "documents" "d"))))
    (testing "one vocabulary's history"
      (is (re-find #"USING (COVERING )?INDEX idx_audit_writes_vocab_layer_ts"
                   (plan "SELECT * FROM audit_writes WHERE vocab_layer_id = ? AND ts <= ? ORDER BY ts, seq"
                         "v" t))))
    (testing "the batch clamp's last save at or before a time"
      (is (re-find #"USING (COVERING )?INDEX idx_operations_ts"
                   (plan "SELECT batch_id FROM operations WHERE ts <= ? ORDER BY ts DESC LIMIT 1" t))))))
