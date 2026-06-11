(ns plaid.sql.concurrent-writers-test
  "Regression for #87: 20 concurrent project/create calls all succeed
  under BEGIN IMMEDIATE single-writer serialization. Empirically
  validates that the SQLite + Hikari + busy_timeout stack handles
  contended writers without surfacing SQLITE_BUSY to callers."
  (:require [clojure.test :refer :all]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.sql.common :as psc]
            [plaid.sql.project :as project]
            [plaid.sql.user :as user])
  (:import (java.io File)
           (java.util.concurrent Executors TimeUnit)))

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-concur-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- cleanup! [db-path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str db-path suffix))]
      (when (.exists f) (.delete f))))
  (let [parent (.getParentFile (File. ^String db-path))]
    (when (.exists parent) (.delete parent))))

(deftest twenty-concurrent-project-creates
  (let [db-path (temp-db-path)
        ;; Pool big enough that contention is real (multiple writers
        ;; queueing on the SQLite write lock) without being so small
        ;; that Hikari connectionTimeout fires before BEGIN IMMEDIATE
        ;; can grab the lock.
        ds (psc/build-datasource db-path {:max-pool-size 20})
        n 20]
    (try
      (migratus/migrate {:store :database
                         :migration-dir "migrations"
                         :db {:datasource ds}})
      (let [{:keys [extra]} (user/create ds "concurrent-test-admin@example.com" true "password" nil)
            admin-id extra
            exec (Executors/newFixedThreadPool n)
            results (->> (range n)
                         (mapv (fn [i]
                                 (.submit exec
                                          ^Callable
                                          (fn []
                                            (try
                                              (project/create ds
                                                              {:project/name (str "ConcurrentProj-" i)}
                                                              admin-id)
                                              (catch Throwable t
                                                {:success false :error (.getMessage t)})))))))]
        (.shutdown exec)
        (.awaitTermination exec 60 TimeUnit/SECONDS)
        (let [outcomes (mapv #(.get %) results)
              succeeded (filter :success outcomes)
              failed (remove :success outcomes)]
          (is (= n (count succeeded))
              (str "Expected all " n " concurrent project/create calls to succeed; "
                   "failures: " (vec failed)))
          ;; Cross-check at the SQL layer: exactly n new projects.
          (let [{:keys [c]} (jdbc/execute-one! ds ["SELECT COUNT(*) AS c FROM projects"]
                                               {:builder-fn rs/as-unqualified-maps})]
            (is (= n c)
                (str "Expected " n " projects in the table; got " c)))))
      (finally
        (try (.close ds) (catch Exception _))
        (cleanup! db-path)))))

;; ---------------------------------------------------------------------------
;; Task #107 — same-row contention exercises BEGIN IMMEDIATE serialization
;; ---------------------------------------------------------------------------
;; The original test above touches DISTINCT rows, which the JDBC layer
;; can serialize even with autoCommit; a BEGIN IMMEDIATE regression
;; (e.g. losing the explicit tx + falling back to deferred) wouldn't
;; surface. This second test fires N concurrent updates against the
;; SAME project row. Each must succeed eventually (no SQLITE_BUSY
;; surfaced to the caller); and audit_writes must record N rows for
;; that project, indicating strict serialization (no two writes
;; raced on the same pre-image).

(deftest twenty-concurrent-same-row-updates
  (let [db-path (temp-db-path)
        ds (psc/build-datasource db-path {:max-pool-size 20})
        n 20]
    (try
      (migratus/migrate {:store :database
                         :migration-dir "migrations"
                         :db {:datasource ds}})
      (let [{:keys [extra]} (user/create ds "same-row-admin@example.com" true "password" nil)
            admin-id extra
            ;; One project we'll hammer from N threads.
            {:keys [extra]} (project/create ds {:project/name "ContendedProj"} admin-id)
            project-id extra
            exec (Executors/newFixedThreadPool n)
            results (->> (range n)
                         (mapv (fn [i]
                                 (.submit exec
                                          ^Callable
                                          (fn []
                                            (try
                                              ;; Each call renames the same project
                                              ;; row. Different name strings so audit
                                              ;; pre/post differs and the row is recorded.
                                              (project/merge ds project-id
                                                             {:project/name (str "Contended-" i)}
                                                             admin-id)
                                              (catch Throwable t
                                                {:success false :error (.getMessage t)})))))))]
        (.shutdown exec)
        (.awaitTermination exec 60 TimeUnit/SECONDS)
        (let [outcomes (mapv #(.get %) results)
              succeeded (filter :success outcomes)
              failed (remove :success outcomes)]
          (is (= n (count succeeded))
              (str "Expected all " n " concurrent SAME-ROW updates to succeed "
                   "(BEGIN IMMEDIATE serializes writers, busy_timeout absorbs "
                   "the queueing); failures: " (vec failed)))
          ;; audit_writes must contain exactly n update rows for this
          ;; project — proves the writes serialized (each saw a distinct
          ;; pre-image, none raced and was discarded as a no-op).
          (let [{:keys [c]} (jdbc/execute-one!
                             ds
                             ["SELECT COUNT(*) AS c FROM audit_writes
                               WHERE target_table = 'projects'
                                 AND target_id = ?
                                 AND change_type = 'update'"
                              (str project-id)]
                             {:builder-fn rs/as-unqualified-maps})]
            (is (= n c)
                (str "Expected " n " :update audit_writes rows for the contended "
                     "project; got " c ". A regression where two writes raced "
                     "would show fewer rows (one would be a no-op).")))
          ;; Cross-check: the (op_id, seq) tuples are all distinct, so no
          ;; two writes shared an op. (Single audit row per project_merge
          ;; op since each op only touches one entity.)
          (let [{:keys [op_count]} (jdbc/execute-one!
                                    ds
                                    ["SELECT COUNT(DISTINCT op_id) AS op_count FROM audit_writes
                                      WHERE target_table = 'projects'
                                        AND target_id = ?
                                        AND change_type = 'update'"
                                     (str project-id)]
                                    {:builder-fn rs/as-unqualified-maps})]
            (is (= n op_count)
                (str "Expected " n " distinct op_ids; got " op_count
                     " — two writes ended up under the same op")))))
      (finally
        (try (.close ds) (catch Exception _))
        (cleanup! db-path)))))
