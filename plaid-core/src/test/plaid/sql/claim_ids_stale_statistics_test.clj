(ns plaid.sql.claim-ids-stale-statistics-test
  "`psc/claim-ids!` runs inside every create that names its ids, so while
  the write lock is held, and it looks each id up among the audit log's
  delete rows (the partial index `idx_audit_writes_deleted`). SQLite's
  staleness test watches a table's row count, not a partial index's, so on a
  young install the index keeps the statistics it was analysed with while
  it held a handful of rows, and SQLite then seeks it by table alone and
  reads every delete row of each table for each 500 ids. Delete rows are
  kept for good (a vocabulary delete audits every link it takes), so each
  create held the lock longer the more had ever been deleted: 100 ms more
  per 500 tokens on a private core after about 90 project and vocabulary
  deletes, 190 ms per check at a million delete rows. The bound compares a
  million delete rows with 2000 on the same machine. The fixture is that
  shape, cut down to the columns the check reads."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.test-helpers :refer [cleanup! temp-db-path]]
            [next.jdbc :as jdbc]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]))

(def ^:private id-tables
  ["projects" "documents" "texts" "text_layers" "token_layers" "span_layers"
   "relation_layers" "vocab_layers" "tokens" "spans" "relations" "vocab_items"
   "vocab_links" "guidelines" "comments"])

(defn- build!
  "The tables a claim reads, analysed while the audit log held 13 delete
  rows, then `deleted` delete rows of vocabulary links added."
  [db-path deleted]
  (with-open [c (jdbc/get-connection (str "jdbc:sqlite:" db-path))]
    (doseq [sql (concat
                 ["PRAGMA journal_mode=WAL"]
                 (for [t id-tables] (str "CREATE TABLE " t " (id TEXT PRIMARY KEY)"))
                 [(str "CREATE TABLE audit_writes (id INTEGER PRIMARY KEY, target_table TEXT NOT NULL, "
                       "target_id TEXT NOT NULL, change_type TEXT NOT NULL, post_image TEXT)")
                  "CREATE INDEX idx_audit_writes_target ON audit_writes (target_table, target_id)"
                  (str "CREATE INDEX idx_audit_writes_deleted ON audit_writes (target_table, target_id) "
                       "WHERE change_type = 'delete'")
                  (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) "
                       "INSERT INTO audit_writes (target_table, target_id, change_type, post_image) "
                       "SELECT 'spans', 'u' || i, 'update', '{}' FROM n")
                  (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 13) "
                       "INSERT INTO audit_writes (target_table, target_id, change_type) "
                       "SELECT 'vocab_links', 'seed' || i, 'delete' FROM n")
                  "ANALYZE"
                  (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < " deleted ") "
                       "INSERT INTO audit_writes (target_table, target_id, change_type) "
                       "SELECT 'vocab_links', 'gone' || i, 'delete' FROM n")])]
      (jdbc/execute! c [sql]))))

(defn- claim-ms
  "How long `reps` claims of 500 new ids take on a database of `deleted`
  delete rows, and whether one of a deleted row's id is still refused."
  [deleted reps]
  (let [db-path (temp-db-path)]
    (try
      (build! db-path deleted)
      (let [ds (psd/build-datasource db-path {:max-pool-size 1})]
        (try
          (let [gone (psc/new-uuid)
                _ (jdbc/execute! ds ["INSERT INTO audit_writes (target_table, target_id, change_type) VALUES ('vocab_links', ?, 'delete')"
                                     (str gone)])
                refused (try (psd/with-tx [tx ds] (psc/claim-ids! tx :tokens "token" [(psc/new-uuid) gone]))
                             false
                             (catch clojure.lang.ExceptionInfo e (= 409 (:code (ex-data e)))))
                ;; Warm the connection's statement cache and statistics first.
                _ (psd/with-tx [tx ds] (psc/claim-ids! tx :tokens "token" (repeatedly 500 psc/new-uuid)))
                t0 (System/nanoTime)]
            (dotimes [_ reps]
              (psd/with-tx [tx ds] (psc/claim-ids! tx :tokens "token" (repeatedly 500 psc/new-uuid))))
            {:ms (/ (- (System/nanoTime) t0) 1e6) :refused refused})
          (finally (.close ds))))
      (finally (cleanup! db-path)))))

(deftest a-claim-costs-the-same-however-many-rows-were-ever-deleted
  ;; Idle on larc: before the fix about 260 ms against 2100 ms (eight
  ;; times, and growing with the delete rows), after it about 250 ms on both.
  (let [small (claim-ms 2000 20)
        big (claim-ms 1000000 20)]
    (testing "an id a deleted row held is still taken"
      (is (:refused small))
      (is (:refused big)))
    (is (< (:ms big) (* 3 (:ms small)))
        (str "20 claims of 500 ids: " (:ms big) " ms over a million delete rows, "
             (:ms small) " ms over 2000"))))
