(ns plaid.server.planner-stats-test
  "The startup ANALYZE must not lock writers out for its whole run.

  SQLite runs each ANALYZE statement in its own write transaction, so a
  whole-database `ANALYZE;` holds the write lock from its first write to
  `sqlite_stat1` until it ends — 108-133 s on the prod database, during
  which every save is refused with 503 (both clients give up retrying a
  503 after about 24 s). `refresh-planner-stats!` therefore analyses ONE
  TABLE PER STATEMENT in autocommit, with a pause between them.

  The claim is checked STRUCTURALLY rather than against the clock, because
  a threshold in milliseconds is a promise about the machine and not about
  the code. Each `ANALYZE <table>` COMMITS the rows it wrote, so a second
  connection can watch the statistics being built up table by table; one
  statement over the whole file takes them from none to all at its single
  commit, and nothing outside can ever observe a part of it. So: a write
  that succeeds while `sqlite_stat1` holds some but not all of the
  fixture's tables is a write that got the lock BETWEEN two of the
  refresh's statements, which is exactly what the fix is for and what the
  shape it replaced cannot produce."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [next.jdbc :as jdbc]
            [plaid.server.sql :as server-sql]
            [plaid.sql.datasource :as psd])
  (:import (java.io File)))

;; Enough tables that the refresh spends real time standing off the
;; database between statements (`analyze-pause-ms` each), few enough that
;; the whole test is a second or so.
(def ^:private table-count 24)

;; 400 is `analysis_limit`, so rows past it cost ANALYZE nothing; what
;; matters is that each table has indexes to walk.
(def ^:private rows-per-table 500)

;; Short by any standard (the pool's own default is 5000), and two orders
;; of magnitude longer than one of this fixture's tables takes to analyse.
(def ^:private writer-busy-timeout-ms 100)

;; A backstop on every wait in this file: a refresh thread that dies
;; without running its `finally` must fail the test, not hang the suite.
(def ^:private deadline-ms 60000)

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-analyze-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- populate!
  "`table-count` tables, each with rows and two indexes, so ANALYZE has
  real work to do per table and many tables to do it on."
  [ds]
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

(defn- statement! [ds sql]
  (with-open [conn (.getConnection ds)
              stmt (.createStatement conn)]
    (.execute stmt sql)))

(defn- tables-with-statistics
  "How many of the fixture's tables `sqlite_stat1` holds statistics for
  right now, as a reader outside the analysis sees it."
  [ds]
  (-> (jdbc/execute-one! ds ["SELECT COUNT(DISTINCT tbl) AS n FROM sqlite_stat1"]) :n))

(defn- statistics-under
  "How many rows `sqlite_stat1` holds under this name."
  [ds tbl]
  (-> (jdbc/execute-one! ds ["SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl = ?" tbl]) :n))

(defn- orphan-statistics
  "Every name `sqlite_stat1` holds statistics under that the schema does
  not know."
  [ds]
  (into #{} (map :sqlite_stat1/tbl)
        (jdbc/execute! ds [(str "SELECT DISTINCT tbl FROM sqlite_stat1 WHERE tbl NOT IN "
                                "(SELECT name FROM sqlite_master)")])))

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
  a loop until it finishes, reading after each write that got through how
  much of the analysis is committed. Reports what the writes did and the
  set of those readings.

  Bounded by `deadline-ms`: the loop ends on the deadline whether or not
  the analysis said it was done, so a thread that dies without delivering
  fails the test rather than hanging the suite."
  [ds writer-ds analyze-fn]
  ;; Start from no statistics, so progress through the file is visible,
  ;; and from a truncated WAL, so an auto-checkpoint fired by the writer's
  ;; own inserts does not take the lock for reasons of its own.
  (statement! ds "DELETE FROM sqlite_stat1;")
  (statement! ds "PRAGMA wal_checkpoint(TRUNCATE);")
  (let [done (promise)
        t0 (System/nanoTime)
        deadline (+ t0 (* deadline-ms 1000000))
        _ (doto (Thread. (fn [] (try (analyze-fn) (finally (deliver done true)))))
            (.setDaemon true)
            (.start))
        [outcomes progress timed-out?]
        (loop [outcomes [] progress #{}]
          (cond
            (realized? done) [outcomes progress false]
            (> (System/nanoTime) deadline) [outcomes progress true]
            :else
            (let [outcome (write-attempt writer-ds)
                  seen (when (= :ok outcome) (tables-with-statistics writer-ds))]
              (Thread/sleep 2)
              (recur (conj outcomes outcome)
                     (cond-> progress seen (conj seen))))))]
    {:refused (remove #{:ok} outcomes)
     :attempts (count outcomes)
     :timed-out? timed-out?
     ;; The readings taken right after a write got through. A reading
     ;; strictly between 0 and `table-count` is the one that matters.
     :progress-seen progress
     :got-in-mid-analysis (count (filter #(< 0 % table-count) progress))
     :elapsed-ms (quot (- (System/nanoTime) t0) 1000000)}))

(defn- whole-database-analyze!
  "What `refresh-planner-stats!` used to run: one statement for the file."
  [ds]
  (with-open [conn (.getConnection ds)
              stmt (.createStatement conn)]
    (.execute stmt "PRAGMA analysis_limit=400;")
    (.execute stmt "ANALYZE;")))

(defn- refresh-and-join!
  "The real refresh, waited out. Bounded, and tolerant of a refresh that
  never named a thread — the test asserts on that separately."
  [ds]
  (#'server-sql/refresh-planner-stats! ds)
  (when-let [^Thread t @@#'server-sql/planner-stats-thread]
    (.join t deadline-ms)))

(defn- with-fixture [f]
  (let [db-path (temp-db-path)
        ds (psd/build-datasource db-path)
        writer-ds (psd/build-datasource db-path {:busy-timeout-ms writer-busy-timeout-ms})]
    (try
      (populate! ds)
      ;; One analysis up front: it creates `sqlite_stat1` (which `contend`
      ;; then empties) and warms the page cache, so neither run below pays
      ;; for cold I/O the other does not.
      (whole-database-analyze! ds)
      (f ds writer-ds)
      (finally
        (try (.close writer-ds) (catch Exception _))
        (try (.close ds) (catch Exception _))
        (doseq [suffix ["" "-wal" "-shm" ".lock"]]
          (let [file (File. (str db-path suffix))]
            (when (.exists file) (.delete file))))
        (.delete (.getParentFile (File. db-path)))))))

(deftest a-writer-gets-in-between-two-tables-of-the-refresh
  (with-fixture
    (fn [ds writer-ds]
      (let [;; The shape the fix replaced, run the same way. Nothing here
            ;; is asserted: it is a number to read when the assertions
            ;; below fail, not a threshold to compare against.
            control (contend ds writer-ds #(whole-database-analyze! ds))
            refreshed (contend ds writer-ds #(refresh-and-join! ds))
            note (str "(refresh: " (:attempts refreshed) " writes in "
                      (:elapsed-ms refreshed) "ms, readings "
                      (sort (:progress-seen refreshed))
                      "; one whole-database ANALYZE over the same fixture: "
                      (:attempts control) " writes in " (:elapsed-ms control)
                      "ms, readings " (sort (:progress-seen control)) ")")]
        (is (not (:timed-out? refreshed))
            (str "the refresh must finish well inside " deadline-ms "ms " note))
        (is (pos? (:attempts refreshed))
            "the writer must have had the chance to contend at all")
        (is (empty? (:refused refreshed))
            (str "Every write during the background refresh must get the lock; "
                 (count (:refused refreshed)) " of " (:attempts refreshed)
                 " were refused, e.g. " (first (:refused refreshed)) " " note))
        ;; The structural claim. A writer that lands while the statistics
        ;; are partly built landed between two of the refresh's statements.
        ;; One statement over the whole file commits once, so no reader
        ;; outside it can ever see a part of its work: on the old shape
        ;; this count is necessarily zero.
        (is (pos? (:got-in-mid-analysis refreshed))
            (str "A write must get through while the analysis is part done — "
                 "that is what one statement per table is for " note))))))

(deftest refresh-runs-on-a-daemon-thread-and-covers-every-table
  (with-fixture
    (fn [ds writer-ds]
      (let [refreshed (contend ds writer-ds #(refresh-and-join! ds))
            ^Thread t @@#'server-sql/planner-stats-thread]
        (is (not (:timed-out? refreshed)) "the refresh must finish")
        (is (some? t) "the refresh must be handed to a thread")
        (is (.isDaemon t) "the refresh must never hold up JVM shutdown")
        (is (= "plaid-planner-stats" (.getName t)))
        (is (not (.isAlive t)) "the refresh must finish"))
      ;; One statement per table still has to leave statistics for every
      ;; table behind.
      (let [analysed (into #{} (map :sqlite_stat1/tbl)
                           (jdbc/execute! ds ["SELECT DISTINCT tbl FROM sqlite_stat1"]))]
        (is (= table-count (count (filter #(str/starts-with? % "probe_") analysed)))
            "every table must end up in sqlite_stat1")))))

;; `ANALYZE <table>` replaces the rows of the table it names and no others, so
;; the per-table pass cannot reach the statistics of a table that has since
;; left the schema: the whole-database statement it replaced rebuilt
;; `sqlite_stat1` from empty every time and swept them as a side effect.
;;
;; SQLite clears them itself when a table is DROPped (asserted below, so the
;; day it stops doing that is a day this test says so) but NOT when one is
;; RENAMEd, and renaming is how a table is rebuilt here, since SQLite cannot
;; relax a NOT NULL in place (`20260905130000-comments-vocab-anchor.up.sql`:
;; create the new shape, copy, drop, rename). Those rows stay under the OLD
;; name, which a later migration may hand to a different table, and then the
;; planner is reading statistics measured on a table that no longer exists.
(deftest a-table-taken-out-of-the-schema-leaves-no-statistics-behind
  (with-fixture
    (fn [ds writer-ds]
      (refresh-and-join! ds)
      (is (pos? (statistics-under ds "probe_1")) "analysed, so it has statistics to lose")
      (is (pos? (statistics-under ds "probe_2")))
      (statement! ds "DROP TABLE probe_1;")
      (statement! ds "ALTER TABLE probe_2 RENAME TO probe_2_rebuilt;")
      (refresh-and-join! ds)
      (is (zero? (statistics-under ds "probe_1"))
          "a dropped table's statistics must not outlive it")
      (is (zero? (statistics-under ds "probe_2"))
          "nor a renamed table's, under the name it no longer answers to")
      (is (empty? (orphan-statistics ds))
          "no row of sqlite_stat1 may name something the schema does not hold")
      (is (pos? (statistics-under ds "probe_2_rebuilt"))
          "and the table under its new name is analysed like any other"))))

(deftest analyze-statement-is-per-table-and-quoted
  (is (= "ANALYZE \"tokens\";" (#'server-sql/analyze-statement "tokens")))
  (is (= "ANALYZE \"odd\"\"name\";" (#'server-sql/analyze-statement "odd\"name"))
      "a table name is an identifier, not a string to splice"))
