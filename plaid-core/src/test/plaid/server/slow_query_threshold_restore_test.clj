(ns plaid.server.slow-query-threshold-restore-test
  "Regression for #112: the datasource :start body installs an
  operator-supplied :slow-query-threshold-ms onto
  `psc/*slow-query-threshold-ms*` via `alter-var-root`. Before the fix,
  :stop never undid that write, so the value bled across mount cycles
  (and into unrelated tests / REPL sessions). This test brackets a
  mount/start → mount/stop with reads of the var and asserts the
  post-stop value equals the pre-start value.

  The mount-driven config supplies an explicit threshold (1234) so the
  install is observably different from the var's default — without that,
  a passing test wouldn't actually distinguish 'restore worked' from
  'install was a no-op'."
  (:require [clojure.test :refer :all]
            [mount.core :as mount]
            [plaid.server.config :as scfg]
            [plaid.server.sql :as ssql]
            [plaid.sql.common :as psc])
  (:import (java.io File)))

(defn- temp-db-path []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-slow-restore-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- cleanup! [db-path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str db-path suffix))]
      (when (.exists f) (.delete f))))
  (let [parent (.getParentFile (File. ^String db-path))]
    (when (.exists parent) (.delete parent))))

(deftest slow-query-threshold-restored-on-stop
  (let [db-path (temp-db-path)
        ;; Snapshot the var BEFORE we touch mount. This is the "original"
        ;; the :stop body promises to restore.
        before (var-get #'psc/*slow-query-threshold-ms*)
        ;; Pick a clearly-distinct install value so a faulty restore
        ;; (e.g. restoring to the *just-installed* root) would fail.
        installed-threshold 1234]
    (with-redefs [ssql/make-admin-user (fn [_ds] nil)]
      (try
        (mount/stop)
        (mount/start-with-states
         {#'scfg/config {:start (fn []
                                  {:plaid.server.sql/config
                                   {:main-db-path db-path
                                    :slow-query-threshold-ms installed-threshold}})
                         :stop  (fn [] nil)}})
        (mount/start #'ssql/datasource)
        ;; After :start the var must reflect what config supplied.
        (let [during (var-get #'psc/*slow-query-threshold-ms*)]
          (is (= installed-threshold during)
              "after mount/start the var must hold the configured threshold"))
        (mount/stop)
        ;; After :stop the var must equal the pre-:start value.
        (let [after (var-get #'psc/*slow-query-threshold-ms*)]
          (is (= before after)
              (str "after mount/stop the slow-query threshold var must be "
                   "restored to its pre-:start value (was " before
                   ", got " after ")")))
        (finally
          (mount/stop)
          (cleanup! db-path))))))
