(ns plaid.server.planner-stats-test
  "The startup ANALYZE must not lock writers out for its whole run.

  SQLite runs each ANALYZE statement in its own write transaction, so a
  whole-database `ANALYZE;` holds the write lock from its first write to
  `sqlite_stat1` until it ends — 108-133 s on the prod database, during
  which every save is refused with 503 (both clients give up retrying a
  503 after about 24 s). `refresh-planner-stats!` therefore analyses ONE
  TABLE PER STATEMENT in autocommit, with a pause between them.

  Both tests here run a real refresh against a populated file-backed
  database while a second connection writes with a short `busy_timeout`.
  The fixture has many small tables so that the whole-database statement
  is many times longer than any single table's; the first test runs the
  old whole-database statement as a control, so the comparison is between
  two measurements of the same fixture rather than one absolute clock."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.server.sql :as server-sql]
            [plaid.sql.datasource :as psd])
  (:import (java.io File)))

;; 400 is `analysis_limit`, so rows beyond it cost ANALYZE nothing; the
;; work that matters is per index, and the ratio that matters is the
;; table count (a whole-database ANALYZE is the sum of all of them).
(def ^:private rows-per-table 500)

;; Short enough that a writer blocked for a whole-database ANALYZE over
;; the fixture is refused, long enough that one table's never refuses it.
(def ^:private writer-busy-timeout-ms 25)

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-analyze-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- populate!
  "`table-count` tables, each with rows and two indexes, so ANALYZE has
  real work to do per table and many tables to do it on."
  [ds table-count]
  (with-open [conn (jdbc/get-connection ds)]
    (.setAutoCommit conn false)
    (dotimes [t table-count]
      (let [table (str "probe_" t)]
        (with-open [stmt (.createStatement conn)]
          (.execute stmt (str "CREATE TABLE " table " (id INTEGER PRIMARY KEY, a TEXT, b INTEGER)")))
        (with-open [ps (.prepareStatement conn (str "INSERT INTO " table " (a, b) VALUES (?, ?)"))]
          (dotimes [r rows-per-table]
            (.setString ps 1 (str "row-" r "-" (mod (* r 7) 13)))
            (.setInt ps 2 (mod r 97))
            (.addBatch ps))
          (.executeBatch ps))
        (with-open [stmt (.createStatement conn)]
          (.execute stmt (str "CREATE INDEX " table "_a ON " table " (a)"))
          (.execute stmt (str "CREATE INDEX " table "_b ON " table " (b, a)")))))
    (.commit conn)
    (.setAutoCommit conn true)))

(defn- write-attempt
  "One autocommit INSERT over a connection whose `busy_timeout` is short.
  Returns :ok, or the failure message."
  [ds]
  (try
    (jdbc/execute! ds ["INSERT INTO probe_0 (a, b) VALUES (?, ?)" "writer" 1])
    :ok
    (catch Exception e
      (or (ex-message e) "unknown failure"))))

(defn- contend
  "Run `analyze-fn` on its own thread while a second connection writes in
  a loop until it finishes. Reports what the writes did, and the longest
  stretch in which not one of them got through — the quantity the fix is
  about, since a single statement over the whole file makes that stretch
  the entire run."
  [ds writer-ds analyze-fn]
  ;; Truncate the WAL first: an auto-checkpoint fired by the writer's own
  ;; inserts would take the same lock and show up as a stretch with no
  ;; write through that has nothing to do with ANALYZE.
  (with-open [conn (.getConnection ds)
              stmt (.createStatement conn)]
    (.execute stmt "PRAGMA wal_checkpoint(TRUNCATE);"))
  (let [done (promise)
        t0 (System/nanoTime)
        _ (doto (Thread. (fn [] (try (analyze-fn) (finally (deliver done true)))))
            (.setDaemon true)
            (.start))
        outcomes (loop [acc []]
                   (if (realized? done)
                     acc
                     (let [outcome (write-attempt writer-ds)
                           at (System/nanoTime)]
                       (Thread/sleep 2)
                       (recur (conj acc [outcome at])))))
        t1 (System/nanoTime)
        ->ms (fn [nanos] (/ (double nanos) 1e6))
        got-through (keep (fn [[outcome at]] (when (= :ok outcome) at)) outcomes)
        marks (concat [t0] got-through [t1])]
    {:refused (remove #{:ok} (map first outcomes))
     :attempts (count outcomes)
     :elapsed-ms (->ms (- t1 t0))
     :longest-shut-out-ms (->ms (apply max (map - (rest marks) marks)))}))

(defn- whole-database-analyze!
  "What `refresh-planner-stats!` used to run: one statement for the file."
  [ds]
  (with-open [conn (.getConnection ds)
              stmt (.createStatement conn)]
    (.execute stmt "PRAGMA analysis_limit=400;")
    (.execute stmt "ANALYZE;")))

(defn- refresh-and-join!
  "The real refresh, waited out."
  [ds]
  (#'server-sql/refresh-planner-stats! ds)
  (.join ^Thread @@#'server-sql/planner-stats-thread 120000))

(defn- with-fixture [table-count f]
  (let [db-path (temp-db-path)
        ds (psd/build-datasource db-path)
        writer-ds (psd/build-datasource db-path {:busy-timeout-ms writer-busy-timeout-ms})]
    (try
      (populate! ds table-count)
      ;; Warm the page cache for both scenarios alike: what is under test
      ;; is lock granularity, not cold I/O.
      (whole-database-analyze! ds)
      (f ds writer-ds)
      (finally
        (try (.close writer-ds) (catch Exception _))
        (try (.close ds) (catch Exception _))
        (doseq [suffix ["" "-wal" "-shm" ".lock"]]
          (let [file (File. (str db-path suffix))]
            (when (.exists file) (.delete file))))
        (.delete (.getParentFile (File. db-path)))))))

(deftest a-writer-is-never-shut-out-for-the-whole-refresh
  ;; 120 tables, and the pause between them cut to 1ms: with the shipped
  ;; 50ms pause this fixture would spend six seconds standing off the
  ;; database, and the pause is not what the comparison below is about —
  ;; the per-statement lock is.
  (with-fixture
    120
    (fn [ds writer-ds]
      (let [control (contend ds writer-ds #(whole-database-analyze! ds))
            refreshed (with-redefs-fn {#'server-sql/analyze-pause-ms 1}
                        (fn [] (contend ds writer-ds #(refresh-and-join! ds))))]
        (is (pos? (:attempts refreshed))
            "the writer must have had the chance to contend at all")
        (is (empty? (:refused refreshed))
            (str "Every write during the background refresh must get the lock; "
                 (count (:refused refreshed)) " of " (:attempts refreshed)
                 " were refused, e.g. " (first (:refused refreshed))))
        ;; Conclusive only when the whole-database statement was long
        ;; enough to measure against: on a machine where it finishes in a
        ;; millisecond, nothing about lock granularity can be read off it
        ;; either way.
        (when (> (:elapsed-ms control) 15.0)
          (is (< (:longest-shut-out-ms refreshed) (/ (:elapsed-ms control) 3))
              (str "No writer may wait out the whole analysis: the longest stretch with no "
                   "write through was " (:longest-shut-out-ms refreshed) "ms, against a "
                   (:elapsed-ms control) "ms whole-database ANALYZE"))
          (is (>= (:longest-shut-out-ms control) (/ (:elapsed-ms control) 2))
              (str "Control: one ANALYZE over the file should shut writers out for its run ("
                   (:elapsed-ms control) "ms), and shut them out for "
                   (:longest-shut-out-ms control) "ms")))))))

(deftest refresh-runs-on-a-daemon-thread-and-covers-every-table
  (with-fixture
    12
    (fn [ds writer-ds]
      ;; Every assertion below runs on this thread: clojure.test's
      ;; counters are thread-local, so an `is` inside the analysis thread
      ;; would be reported nowhere.
      (let [refreshed (contend ds writer-ds #(refresh-and-join! ds))
            ^Thread t @@#'server-sql/planner-stats-thread]
        (is (some? t) "the refresh must be handed to a thread")
        (is (.isDaemon t) "the refresh must never hold up JVM shutdown")
        (is (= "plaid-planner-stats" (.getName t)))
        (is (not (.isAlive t)) "the refresh must finish")
        (is (empty? (:refused refreshed))
            (str "A write with a " writer-busy-timeout-ms
                 "ms busy timeout must survive the refresh; refused: "
                 (first (:refused refreshed)))))
      ;; One statement per table still has to leave statistics for every
      ;; table behind.
      (let [analysed (into #{} (map :sqlite_stat1/tbl)
                           (jdbc/execute! ds ["SELECT DISTINCT tbl FROM sqlite_stat1"]))]
        (is (= 12 (count (filter #(str/starts-with? % "probe_") analysed)))
            "every table must end up in sqlite_stat1")))))

(deftest analyze-statement-is-per-table-and-quoted
  (is (= "ANALYZE \"tokens\";" (#'server-sql/analyze-statement "tokens")))
  (is (= "ANALYZE \"odd\"\"name\";" (#'server-sql/analyze-statement "odd\"name"))
      "a table name is an identifier, not a string to splice"))
