(ns plaid.sql.purge-lock-hold-test
  "The history purge of a deleted project must never hold the write lock long
  enough for a save to time out.

  Each chunk of `prj/purge-deleted-project-history!` is one autocommit DELETE,
  and a DELETE on `operations` runs an FK cascade into `audit_writes` per row.
  On stale planner statistics (a table analysed while nearly empty) SQLite
  plans that cascade as a scan of `audit_writes` per deleted row, and one
  5000-row chunk held the lock for 34 to 138 s while every save answered 503.
  The fixture below builds exactly that: statistics saying one row, a large
  `audit_writes` of a surviving project, and a deleted project's history."
  (:require [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [plaid.sql.project :as prj])
  (:import (java.io File)))

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-purgelock-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- cleanup! [db-path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str db-path suffix))]
      (when (.exists f) (.delete f))))
  (let [parent (.getParentFile (File. ^String db-path))]
    (when (.exists parent) (.delete parent))))

(defn- build-history!
  "The three tables the purge touches, cut down to the columns it reads,
  statistics taken while each held one row, then `gone` ops for the deleted
  project and `kept` audit rows under a surviving one."
  [db-path gone kept]
  (with-open [c (jdbc/get-connection (str "jdbc:sqlite:" db-path))]
    (doseq [sql ["PRAGMA journal_mode=WAL"
                 "PRAGMA foreign_keys=ON"
                 "CREATE TABLE operations (id TEXT PRIMARY KEY, op_type TEXT, project_id TEXT, group_id TEXT)"
                 "CREATE INDEX idx_operations_project ON operations(project_id)"
                 (str "CREATE TABLE audit_writes (id INTEGER PRIMARY KEY, "
                      "op_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE, seq INTEGER)")
                 "CREATE UNIQUE INDEX idx_audit_writes_op_seq ON audit_writes(op_id, seq)"
                 "CREATE TABLE operation_groups (id TEXT PRIMARY KEY)"
                 "CREATE TABLE saves (id INTEGER PRIMARY KEY, v TEXT)"
                 "INSERT INTO operations VALUES ('seed', 'x', 'kept', NULL)"
                 "INSERT INTO audit_writes (op_id, seq) VALUES ('seed', 0)"
                 "ANALYZE"
                 "BEGIN"
                 (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < " gone ") "
                      "INSERT INTO operations SELECT 'gone-' || i, 'x', 'gone', NULL FROM n")
                 (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) "
                      "INSERT INTO operations SELECT 'kept-' || i, 'x', 'kept', NULL FROM n")
                 (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < " kept ") "
                      "INSERT INTO audit_writes (op_id, seq) SELECT 'kept-' || (1 + i % 20000), i FROM n")
                 "INSERT INTO audit_writes (op_id, seq) SELECT id, 0 FROM operations WHERE project_id = 'gone'"
                 "COMMIT"]]
      (jdbc/execute! c [sql]))))

(defn- count-ops [ds pid]
  (:n (psc/q1 ds ["SELECT count(*) AS n FROM operations WHERE project_id = ?" pid])))

(deftest a-chunk-is-sized-by-the-time-the-last-took
  (let [{:keys [max-rows]} prj/purge-chunking]
    (testing "a fast chunk grows, at most twofold"
      (is (= 100 (prj/next-purge-chunk 50 1)))
      (is (= max-rows (prj/next-purge-chunk max-rows 1)) "never past the cap"))
    (testing "a slow chunk shrinks to what fits the budget"
      (is (= 25 (prj/next-purge-chunk 50 200)))
      (is (= 1 (prj/next-purge-chunk 5 100000)) "never below one row"))))

(deftest saves-keep-landing-while-a-purge-runs
  (let [db-path (temp-db-path)
        gone 300]
    (try
      (build-history! db-path gone 100000)
      ;; A save that waits out busy_timeout is a 503. One second here, five
      ;; on a running server.
      (let [ds (psd/build-datasource db-path {:busy-timeout-ms 1000 :max-pool-size 4})
            purging (atom true)]
        (try
          (let [saves (future
                        (loop [i 0 out []]
                          (if (and @purging (< i 2000))
                            (let [r (try (psd/with-tx [tx ds]
                                           (jdbc/execute! tx ["INSERT INTO saves (v) VALUES (?)" (str i)]))
                                         :ok
                                         (catch Exception e
                                           (if (psd/sqlite-busy? e) :busy (.getMessage e))))]
                              (Thread/sleep 10)
                              (recur (inc i) (conj out r)))
                            out)))
                purge (try (prj/purge-deleted-project-history! ds "gone" {:pause-ms 150})
                           (finally (reset! purging false)))
                outcomes @saves]
            (is (= gone (:operations purge)) "the deleted project's history is gone")
            (is (zero? (count-ops ds "gone")))
            (is (= 20001 (count-ops ds "kept")) "the survivor's is not")
            (is (< (:longest-ms purge) 1000) "no chunk held the lock past busy_timeout")
            (is (pos? (count outcomes)))
            (is (every? #{:ok} outcomes) "every save during the purge landed"))
          (finally
            (.close ds))))
      (finally
        (cleanup! db-path)))))
