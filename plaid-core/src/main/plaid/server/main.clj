(ns plaid.server.main
  (:require [mount.core :as mount]
            [plaid.server.http-server]
            ;; Nightly database backup scheduler. Required here (not from
            ;; http-server or tests) so test JVMs don't register the defstate
            ;; and start spawning backup threads.
            [plaid.server.backup]
            ;; First-run extraction of the bundled Python services. Required
            ;; ONLY here (never from http-server or tests) so test JVMs don't
            ;; register the defstate.
            [plaid.server.services-extract]
            [plaid.server.reexec :as reexec])
  (:gen-class))

(defn- parse-args
  "Pull recognized flags out of the raw command line. Currently just
   `--config <path>`, which points at an operator-supplied TOML config file.
   When absent, the config defstate falls back to PLAID_CONFIG / data/config.toml
   and auto-writes the commented template on first launch."
  [args]
  (loop [a (seq args) m {}]
    (cond
      (nil? a) m
      (= "--config" (first a)) (recur (nnext a) (assoc m :config (second a)))
      :else (recur (next a) m))))

(defn -main [& args]
  (when (and (or (reexec/needs-add-opens?) (reexec/needs-native-access?))
             (not (System/getenv "PLAID_NO_REEXEC")))
    (reexec/re-exec-with-jdk-flags! args))
  ;; Run mount :stop fns on SIGTERM / Ctrl-C so the datasource gets a
  ;; chance to checkpoint the WAL and close cleanly before the JVM exits.
  ;; Bounded: systemd's default TimeoutStopSec and k8s'
  ;; terminationGracePeriodSeconds are both 30s. We give mount/stop 25s
  ;; (leaves 5s for the OS to deliver SIGKILL) and abandon if it hangs
  ;; — better than holding shutdown indefinitely on a stuck stop fn.
  (.addShutdownHook (Runtime/getRuntime)
                    (Thread.
                     ^Runnable
                     (fn []
                       (let [stopper (Thread. ^Runnable
                                      (fn []
                                        (try
                                          (mount/stop)
                                          (catch Throwable t
                                            (binding [*out* *err*]
                                              (println "Error during mount/stop:" (.getMessage t)))))))]
                         (.start stopper)
                         (.join stopper 25000)
                         (when (.isAlive stopper)
                           (binding [*out* *err*]
                             (println "mount/stop did not complete within 25s; abandoning"))
                           (.interrupt stopper))))))
  (mount/start-with-args (parse-args args)))
