(ns plaid.sql.cascade-statistics-test
  "`cascade-statistics/prepare!` on a private database whose statistics were
  taken while the cascade's child table held one row, the shape a young
  install or an earlier test leaves. SQLite then plans the cascade of every
  deleted parent as a scan of the whole child table."
  (:require [clojure.test :refer [deftest is testing]]
            [next.jdbc :as jdbc]
            [plaid.sql.cascade-statistics :as cascade-stats]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd])
  (:import (java.io File)))

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-cascadestats-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- cleanup! [db-path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str db-path suffix))]
      (when (.exists f) (.delete f))))
  (let [parent (.getParentFile (File. ^String db-path))]
    (when (.exists parent) (.delete parent))))

(def ^:private n-parents 4000)
(def ^:private children 40000)

(defn- build!
  "Spans and the relations on them, cut down to their keys, analysed while
  `relations` held one row, then grown. `notes` has an index but no cascade."
  [db-path]
  (with-open [c (jdbc/get-connection (str "jdbc:sqlite:" db-path))]
    (doseq [sql ["PRAGMA journal_mode=WAL"
                 "CREATE TABLE spans (id TEXT PRIMARY KEY)"
                 (str "CREATE TABLE relations (id TEXT PRIMARY KEY,"
                      " source_span_id TEXT NOT NULL REFERENCES spans(id) ON DELETE CASCADE)")
                 "CREATE INDEX idx_relations_source ON relations(source_span_id)"
                 "CREATE TABLE notes (id TEXT PRIMARY KEY, v TEXT)"
                 "INSERT INTO spans VALUES ('seed')"
                 "INSERT INTO relations VALUES ('seed', 'seed')"
                 "INSERT INTO notes VALUES ('seed', 'x')"
                 "ANALYZE"
                 "BEGIN"
                 (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < " n-parents ") "
                      "INSERT INTO spans SELECT 's' || i FROM n")
                 (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < " children ") "
                      "INSERT INTO relations SELECT 'r' || i, 'seed' FROM n")
                 (str "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < " children ") "
                      "INSERT INTO notes SELECT 'n' || i, 'x' FROM n")
                 "COMMIT"]]
      (jdbc/execute! c [sql]))))

(defn- stat-rows [ds table]
  (:n (psc/q1 ds ["SELECT count(*) AS n FROM sqlite_stat1 WHERE tbl = ?" table])))

(defn- delete-parents-ms
  "Delete every span but the seed in one transaction, after `prepare?`
  decides whether `prepare!` runs first, and roll back. Returns the ms the
  DELETE took."
  [ds prepare?]
  (let [spent (atom nil)]
    (try
      (psd/with-tx [tx ds]
        (when prepare? (cascade-stats/prepare! tx))
        (let [t (System/nanoTime)]
          (psc/execute! tx ["DELETE FROM spans WHERE id <> 'seed'"])
          (reset! spent (/ (- (System/nanoTime) t) 1e6)))
        (throw (ex-info "roll back" {::rollback true})))
      (catch clojure.lang.ExceptionInfo e
        (when-not (::rollback (ex-data e)) (throw e))))
    @spent))

(deftest a-delete-cascades-by-the-index-on-statistics-of-a-near-empty-table
  (let [db-path (temp-db-path)]
    (try
      (build! db-path)
      (let [ds (psd/build-datasource db-path {:max-pool-size 2})]
        (try
          (testing "the statistics say `relations` holds one row"
            (is (= "1 1" (:stat (psc/q1 ds ["SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_relations_source'"])))))
          (let [dropped (psd/with-tx [tx ds] (cascade-stats/prepare! tx))]
            (testing "prepare! drops the statistics of the stale cascade child, and only those"
              (is (= ["relations"] dropped))
              (is (zero? (stat-rows ds "relations")))
              (is (pos? (stat-rows ds "spans")) "a parent's statistics are kept")
              (is (pos? (stat-rows ds "notes")) "a table no cascade reaches is left alone")))
          (testing "the connection that ran it plans the cascade by the index"
            ;; 4000 parents each scanning 40,000 children is 160 million
            ;; rows, many seconds. Seeking the index takes milliseconds.
            (is (< (delete-parents-ms ds true) 1000)))
          (finally (.close ds))))
      (finally (cleanup! db-path)))))

(deftest a-stale-connection-is-reloaded-when-another-dropped-the-statistics
  (let [db-path (temp-db-path)]
    (try
      (build! db-path)
      (let [ds (psd/build-datasource db-path {:max-pool-size 2})]
        (try
          ;; Two connections that loaded the stale statistics.
          (with-open [a (jdbc/get-connection ds)
                      b (jdbc/get-connection ds)]
            (psc/q a ["SELECT count(*) FROM relations"])
            (psc/q b ["SELECT count(*) FROM relations"])
            ;; `a` drops them (its own transaction, committed).
            (jdbc/execute! a ["BEGIN IMMEDIATE"])
            (is (= ["relations"] (cascade-stats/prepare! a)))
            (jdbc/execute! a ["COMMIT"])
            (is (zero? (stat-rows a "relations")))
            ;; `b` still plans with what it loaded. prepare! reloads it.
            (jdbc/execute! b ["BEGIN IMMEDIATE"])
            (try
              (is (= ["relations"] (cascade-stats/prepare! b))
                  "the statistics `b` loaded are stale whatever sqlite_stat1 holds now")
              (let [t (System/nanoTime)]
                (psc/execute! b ["DELETE FROM spans WHERE id <> 'seed'"])
                (is (< (/ (- (System/nanoTime) t) 1e6) 1000)))
              (finally (jdbc/execute! b ["ROLLBACK"]))))
          (finally (.close ds))))
      (finally (cleanup! db-path)))))

(deftest nothing-happens-on-fresh-statistics
  (let [db-path (temp-db-path)]
    (try
      (build! db-path)
      (with-open [c (jdbc/get-connection (str "jdbc:sqlite:" db-path))]
        (jdbc/execute! c ["ANALYZE"]))
      (let [ds (psd/build-datasource db-path {:max-pool-size 2})]
        (try
          (is (= [] (psd/with-tx [tx ds] (cascade-stats/prepare! tx))))
          (is (pos? (stat-rows ds "relations")))
          (finally (.close ds))))
      (finally (cleanup! db-path)))))

(deftest statistics-a-refresh-wrote-since-are-kept
  (let [db-path (temp-db-path)]
    (try
      (build! db-path)
      (let [ds (psd/build-datasource db-path {:max-pool-size 2})]
        (try
          (with-open [p (jdbc/get-connection ds)
                      r (jdbc/get-connection ds)]
            ;; `p` loaded the statistics of one row.
            (psc/q p ["SELECT count(*) FROM relations"])
            ;; `r` runs the refresh's statement for the table.
            (jdbc/execute! r ["PRAGMA analysis_limit=400"])
            (jdbc/execute! r ["ANALYZE \"main\".\"relations\""])
            (let [fresh (:stat (psc/q1 r ["SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_relations_source'"]))]
              (is (not= "1 1" fresh))
              (jdbc/execute! p ["BEGIN IMMEDIATE"])
              (try
                (testing "p reloads, finds the table fresh and drops nothing"
                  (is (= [] (cascade-stats/prepare! p)))
                  (is (= fresh (:stat (psc/q1 p ["SELECT stat FROM sqlite_stat1 WHERE idx = 'idx_relations_source'"])))))
                (testing "and its cascade seeks by the fresh statistics"
                  (let [t (System/nanoTime)]
                    (psc/execute! p ["DELETE FROM spans WHERE id <> 'seed'"])
                    (is (< (/ (- (System/nanoTime) t) 1e6) 1000))))
                (finally (jdbc/execute! p ["ROLLBACK"])))))
          (finally (.close ds))))
      (finally (cleanup! db-path)))))
