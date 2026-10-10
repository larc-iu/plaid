(ns plaid.sql.migration-idempotency-test
  "Regression for #87: running `migratus/migrate` twice on a populated DB
  must be a no-op, not an error. Operators should be able to (re-)apply
  migrations during boot without fear of partial failure when nothing
  has changed."
  (:require [clojure.test :refer :all]
            [plaid.test-helpers :refer [cleanup! temp-db-path]]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [plaid.sql.datasource :as psd])
  (:import (java.io File)))

(defn- migr-cfg [ds]
  {:store :database
   :migration-dir "migrations"
   :db {:datasource ds}})

(deftest migrate-twice-against-populated-db
  (let [db-path (temp-db-path)
        ds (psd/build-datasource db-path)]
    (try
      ;; First migrate: fresh DB → all migrations applied.
      (is (nil? (migratus/migrate (migr-cfg ds)))
          "first migrate should succeed silently")

      ;; Populate to be sure we're not just exercising the empty path.
      (dotimes [i 10]
        (jdbc/execute! ds ["INSERT INTO users (id, username, password_hash, is_admin) VALUES (?,?,?,?)"
                           (str (java.util.UUID/randomUUID))
                           (str "idem-user-" i "-" (System/nanoTime))
                           "x"
                           0]))

      ;; Second migrate: should be a no-op. Migratus checks
      ;; schema_migrations and skips already-applied ids; this must
      ;; succeed without touching the populated tables.
      (is (nil? (migratus/migrate (migr-cfg ds)))
          "second migrate must be a no-op on a populated DB")

      ;; And user rows are still there.
      (let [n (-> (jdbc/execute-one! ds ["SELECT COUNT(*) AS c FROM users"])
                  :c)]
        (is (= 10 n) "populated rows must survive idempotent re-migrate"))

      (finally
        (try (.close ds) (catch Exception _))
        (cleanup! db-path)))))
