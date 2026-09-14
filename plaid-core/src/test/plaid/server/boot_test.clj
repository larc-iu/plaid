(ns plaid.server.boot-test
  "Startup used to be a bare `mount/start-with-args`. The states come up in
  dependency order, so a defstate that threw AFTER http-kit had bound the
  port left a process that was dead but still holding the port, the instance
  lock and an unchecked WAL — and the next start refused the port.

  Deliberately requires plaid.server.boot, NOT plaid.server.main: requiring
  main registers every mount defstate (http-server included) in the JVM-wide
  registry and changes what a bare (mount/start) in other tests brings up.
  mount's own fns are redefined here for the same reason — nothing in this
  namespace starts or stops a real state."
  (:require [clojure.test :refer :all]
            [mount.core :as mount]
            [plaid.server.boot :as boot]))

(deftest a-failed-startup-stops-what-started-and-names-an-exit-code
  (let [stops (atom 0)]
    (with-redefs [mount.core/start-with-args (fn [_] (throw (ex-info "port already bound" {})))
                  mount.core/stop (fn [& _] (swap! stops inc))]
      (is (= 1 (boot/start-cleanly! {}))
          "a startup that throws exits non-zero rather than leaving a zombie")
      (is (= 1 @stops)
          "and the states that did start are stopped, which is what returns the port"))))

(deftest a-clean-startup-stops-nothing
  (let [stops (atom 0)
        started (atom nil)]
    (with-redefs [mount.core/start-with-args (fn [args] (reset! started args))
                  mount.core/stop (fn [& _] (swap! stops inc))]
      (is (nil? (boot/start-cleanly! {:config "data/config.toml"}))
          "nil means the process carries on")
      (is (= {:config "data/config.toml"} @started)
          "the parsed command line reaches mount")
      (is (zero? @stops)))))

(deftest a-stop-that-throws-still-exits
  (let [stops (atom 0)]
    (with-redefs [mount.core/start-with-args (fn [_] (throw (Error. "out of memory")))
                  mount.core/stop (fn [& _]
                                    (swap! stops inc)
                                    (throw (ex-info "stop fn hung up" {})))]
      (is (= 1 (boot/start-cleanly! {}))
          "a failure inside the cleanup cannot swallow the exit code")
      (is (= 1 @stops)))))

(deftest an-error-is-caught-as-well-as-an-exception
  ;; A defstate that fails on a missing class or a stack overflow throws an
  ;; Error, and those hold the port exactly as an ExceptionInfo does.
  (with-redefs [mount.core/start-with-args (fn [_] (throw (AssertionError. "bad state")))
                mount.core/stop (fn [& _] nil)]
    (is (= 1 (boot/start-cleanly! {})))))
