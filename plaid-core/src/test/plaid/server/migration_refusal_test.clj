(ns plaid.server.migration-refusal-test
  "The server starts only on a database whose migrations have all run
  (`plaid.server.sql/run-migrations!`). Before, a start stopped during a
  migration left migratus' reservation row behind, every later start ran no
  migration and logged \"Migrations complete.\", and a database file the
  server could not write skipped them the same way. The vocabulary
  migration's own resume is in `plaid.sql.vocab-home-migration-test`."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.server.sql :as server-sql]
            [plaid.sql.datasource :as psd]
            [plaid.test-helpers :refer [temp-db-path]])
  (:import (java.io File)))

(defn- cfg [ds] {:store :database :migration-dir "migrations" :db {:datasource ds}})

(defn- q [ds sql & args]
  (jdbc/execute! ds (into [sql] args) {:builder-fn rs/as-unqualified-maps}))

(defn- remove-db! [path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str path suffix))]
      (.setWritable f true)
      (.delete f)))
  (.delete (.getParentFile (File. path))))

(defn- with-db-before
  "Run `(f ds path)` on a new database file migrated up to just before
  `migration`."
  [migration f]
  (let [path (temp-db-path)
        ds (psd/build-datasource path)]
    (try
      (migratus/migrate-until-just-before (cfg ds) migration)
      (f ds path)
      (finally
        (.close ds)
        (remove-db! path)))))

(defn- refusal [ds opts]
  (try (server-sql/run-migrations! ds opts) nil
       (catch Exception e (ex-message e))))

(deftest a-stopped-sql-migration-is-refused-with-the-step-to-take
  (with-db-before
    20261024120000
    (fn [ds path]
      (q ds "INSERT INTO schema_migrations (id) VALUES (-1)")
      (let [before (q ds "SELECT id FROM schema_migrations ORDER BY id")]
        (is (= (server-sql/interrupted-refusal path {:id 20261024120000 :name "service-claims"})
               (refusal ds {:db-path path :lock-held? true}))
            "an SQL migration is never resumed by the server, lock or not")
        (is (= before (q ds "SELECT id FROM schema_migrations ORDER BY id")) "nothing ran")
        (testing "the step the message gives lets the next start run"
          (q ds "DELETE FROM schema_migrations WHERE id = -1")
          (server-sql/run-migrations! ds {:db-path path :lock-held? true})
          (is (empty? (migratus/pending-list (cfg ds)))))))))

(deftest a-mark-left-after-every-migration-ran-is-removed
  (let [path (temp-db-path)
        ds (psd/build-datasource path)]
    (try
      (migratus/migrate (cfg ds))
      (q ds "INSERT INTO schema_migrations (id) VALUES (-1)")
      (server-sql/run-migrations! ds {:db-path path :lock-held? false})
      (is (empty? (q ds "SELECT id FROM schema_migrations WHERE id = -1")))
      (finally
        (.close ds)
        (remove-db! path)))))

(deftest a-database-the-server-cannot-write-is-refused
  (let [path (temp-db-path)]
    (try
      (let [ds (psd/build-datasource path)]
        (migratus/migrate-until-just-before (cfg ds) 20261024120000)
        (.close ds))
      (.setWritable (File. path) false)
      (let [ds (psd/build-datasource path)]
        (try
          (let [msg (refusal ds {:db-path path :lock-held? true})]
            (is (some? msg) "the start is refused")
            (is (str/starts-with? (str msg) (str "The database was not migrated: " path " cannot be written (")) msg)
            (is (str/ends-with? (str msg) "Make the file and its folder writable by the server and start again.") msg))
          (finally (.close ds))))
      (finally (remove-db! path)))))

(deftest a-failed-migration-is-refused
  (with-db-before
    20261024120000
    (fn [ds path]
      ;; A table the migration creates, already there: its CREATE fails.
      (q ds "CREATE TABLE service_claims (x INTEGER)")
      (let [msg (refusal ds {:db-path path :lock-held? true})]
        (is (some? msg) "the start is refused")
        (is (empty? (q ds "SELECT id FROM schema_migrations WHERE id = -1")))))))
