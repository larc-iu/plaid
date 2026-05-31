(ns plaid.olap.mount-lifecycle-test
  "Smoke test for the OLAP defstate chain — `plaid.olap.core/node` AND
  `plaid.olap.tailer/tailer` must reach :start when mount runs with
  `:plaid.olap/config :enabled? true`.

  Why this test exists: the integration suite drives the tailer
  directly via `#'tailer/run-loop!` (so the per-test in-memory XTDB
  node gets its own go-loop), which bypasses mount's defstate
  registration entirely. A removal of the side-effect
  `[plaid.olap.tailer]` require from the production startup graph
  would leave the integration tests green AND let the tailer defstate
  never reach `:start` in production — the OLAP node would replicate
  exactly nothing, and every `?as-of=` GET would 425 forever with no
  test failure to surface it.

  This test stands up mount with a temp on-disk OLAP store so the
  node defstate has somewhere to land, drives `(mount/start)`, and
  asserts both defstates registered. The temp dir is cleaned up on
  teardown so we don't leak files across CI runs.

  NB: the test deliberately does NOT use the `with-test-olap-node`
  fixture — that fixture exists exactly to bypass mount. The point
  here is to exercise the production lifecycle the rest of the suite
  intentionally avoids."
  (:require [clojure.test :refer :all]
            [mount.core :as mount]
            ;; Side-effect require: brings the tailer defstate into the
            ;; mount registry. The whole point of this test is that
            ;; removing this require silently breaks the OLAP. Resolving
            ;; via `requiring-resolve` after `(mount/start)` would NOT
            ;; catch the regression — mount only sees defstates whose
            ;; ns has been loaded by the time `start` runs.
            [plaid.olap.core :as olap]
            [plaid.olap.tailer :as tailer]
            [plaid.server.config :as scfg]
            [plaid.server.sql :as ssql])
  (:import (java.io File)
           (java.nio.file Files)))

(defn- temp-dir
  "Create a fresh temp directory and return its absolute path. Caller is
  responsible for `cleanup!`-ing."
  []
  (let [path (Files/createTempDirectory
              "plaid-olap-mount-"
              (make-array java.nio.file.attribute.FileAttribute 0))]
    (.toAbsolutePath path)
    (str path)))

(defn- delete-recursively!
  "Walk and delete every file under `dir`, then the dir itself. Tolerates
  a missing dir."
  [^String dir]
  (let [f (File. dir)]
    (when (.exists f)
      (doseq [^File child (reverse (file-seq f))]
        (.delete child)))))

(defn- temp-db-path
  "DB file path under a fresh temp directory. The directory is created
  here so the SQLite WAL files have somewhere to land on first open."
  []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-mount-db-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn- cleanup-db! [^String db-path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str db-path suffix))]
      (when (.exists f) (.delete f))))
  (let [parent (.getParentFile (File. db-path))]
    (when (.exists parent) (.delete parent))))

(deftest olap-mount-defstate-registered-when-ns-loaded
  ;; The BUG-1 shape: `plaid.olap.tailer` is never required from the
  ;; production startup graph (`plaid.server.main` / `http_server`), so
  ;; mount doesn't know the `tailer` defstate exists and silently skips
  ;; it. This regression is invisible to the integration test suite,
  ;; which spawns the run-loop directly through `#'tailer/run-loop!`
  ;; — mount lifecycle is never exercised.
  ;;
  ;; The check we want is "is `tailer/tailer` registered with mount?".
  ;; Mount's `find-all-states` exposes the registry as the list of var
  ;; names (formatted "#'ns/name" — see `mount.core/var-to-str`); if
  ;; the namespace hasn't been loaded into the JVM, mount can't see the
  ;; var (defstate only registers on its own evaluation). Loading the ns
  ;; is necessary AND verifying mount sees the var is sufficient.
  ;;
  ;; Registration alone catches the "require was dropped" regression
  ;; cheaply; `olap-tailer-defstate-starts-and-runs-under-mount` below
  ;; exercises the actual :start lifecycle.
  (let [states (set (mount/find-all-states))]
    (is (contains? states "#'plaid.olap.core/node")
        "plaid.olap.core/node is registered with mount")
    (is (contains? states "#'plaid.olap.tailer/tailer")
        (str "plaid.olap.tailer/tailer is registered with mount — if this fails, "
             "the side-effect require of [plaid.olap.tailer] is missing from "
             "the production startup graph and the tailer never starts (BUG-1)"))))

(deftest olap-tailer-defstate-starts-and-runs-under-mount
  ;; The full production lifecycle the integration suite bypasses: start
  ;; the REAL tailer defstate through mount and confirm its :start body
  ;; runs without throwing and the loop is alive.
  ;;
  ;; This is the regression guard for the `@datasource` bug: the tailer
  ;; :start does `(run-loop! datasource olap/node cfg)`, where mount
  ;; root-binds `datasource` to the raw HikariDataSource (NOT a
  ;; derefable). An earlier `@datasource` deref threw ClassCastException
  ;; here — invisible to the integration tests, which pass the datasource
  ;; explicitly to `#'run-loop!`. If anyone reintroduces the deref, this
  ;; test fails at mount/start.
  (let [olap-dir (temp-dir)
        log-dir (temp-dir)
        db-path (temp-db-path)
        cfg {:plaid.server.sql/config {:main-db-path db-path}
             :plaid.olap/config {:enabled? true
                                 :storage-path olap-dir
                                 :log-path log-dir
                                 ;; Long heartbeat so the loop parks on
                                 ;; the timeout rather than busy-polling
                                 ;; during the test window.
                                 :tailer {:poll-interval-ms 60000
                                          :batch-size 500}}}]
    (with-redefs [ssql/make-admin-user (fn [_ds] nil)]
      (try
        (mount/stop)
        (mount/start-with-states
         {#'scfg/config {:start (fn [] cfg) :stop (fn [] nil)}})
        ;; Start the real datasource, node, AND tailer defstates — no subs.
        (mount/start #'ssql/datasource #'olap/node #'tailer/tailer)
        (is (some? olap/node)
            "node defstate reached :start with :enabled? + on-disk paths")
        (is (some? tailer/tailer)
            "tailer defstate reached :start without throwing (datasource fix)")
        ;; The loop wrote a seed cursor on its first poll against the
        ;; empty OLTP — status should reflect a running, caught-up tailer.
        (let [st (tailer/status)]
          (is (= 0 (:lag-rows st))
              "tailer is caught up against the empty audit log"))
        (finally
          (mount/stop)
          (delete-recursively! olap-dir)
          (delete-recursively! log-dir)
          (cleanup-db! db-path))))))
