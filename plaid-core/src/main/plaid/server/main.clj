(ns plaid.server.main
  (:require [clojure.java.io :as io]
            [mount.core :as mount]
            [plaid.server.http-server]
            [taoensso.timbre :as log])
  (:gen-class))

(defn- resolve-java-binary
  "Prefer $JAVA_HOME/bin/java so re-exec doesn't depend on PATH having a
   `java` symlink. Falls back to the literal \"java\" (and warns) if the
   resolved path is missing — e.g. weird embedded JREs."
  []
  (let [home (System/getProperty "java.home")
        candidate (when home (io/file home "bin" "java"))]
    (if (and candidate (.exists ^java.io.File candidate))
      (.getAbsolutePath ^java.io.File candidate)
      (do (log/warn "Could not find java binary under java.home; falling back to PATH lookup of 'java'")
          "java"))))

(defn- needs-add-opens?
  "Check whether java.base/java.nio is open to us by attempting
   reflective access to a private field. Without --add-opens, this
   throws InaccessibleObjectException."
  []
  (try
    (doto (.getDeclaredField java.nio.Buffer "capacity")
      (.setAccessible true))
    false
    (catch Exception _
      true)))

(defn- needs-native-access?
  "Check whether the JVM's restricted-native-method gate is open. Without
   `--enable-native-access=ALL-UNNAMED`, XTDB v2.2's Arrow / Netty calls
   emit a `WARNING: A restricted method ... has been called` line per
   invocation on JDK 21+ and will hard-fail on a future JDK.

   The probe walks the runtime-arg list rather than calling a restricted
   method itself — Module#isNativeAccessEnabled is JDK-internal API we
   don't want to depend on, and any concrete restricted call (e.g.
   `MemorySegment/ofAddress`) varies by JDK. The arg-list check covers
   both the `--enable-native-access=ALL-UNNAMED` and `=java.base` forms
   that operators are likely to ship."
  []
  (let [args (some-> (java.lang.management.ManagementFactory/getRuntimeMXBean)
                     (.getInputArguments))]
    (not (some (fn [^String a] (.startsWith a "--enable-native-access"))
               (or args [])))))

(defn- find-jar-path
  "When launched via `java -jar foo.jar`, the JVM sets java.class.path
   to exactly that jar path. We use this to re-exec with the JDK module-
   access flags."
  []
  (let [cp (System/getProperty "java.class.path")]
    (when (and cp (.endsWith cp ".jar"))
      cp)))

(defn- re-exec-with-jdk-flags!
  "Re-launch this JVM with both `--add-opens=java.base/java.nio=ALL-UNNAMED`
   (required by SQLite's reflective access to `java.nio.Buffer`) and
   `--enable-native-access=ALL-UNNAMED` (required by XTDB v2.2's Arrow /
   Netty restricted-method calls). We re-add both unconditionally rather
   than only the missing one: the cost is two extra JVM args, and the
   child process is wholly defined by this command line so there's no
   way for one flag to be present while the other is missing."
  [args]
  (if-let [jar-path (find-jar-path)]
    (let [cmd (into [(resolve-java-binary)
                     "--add-opens=java.base/java.nio=ALL-UNNAMED"
                     "--enable-native-access=ALL-UNNAMED"
                     "-jar" jar-path]
                    args)
          pb  (ProcessBuilder. ^java.util.List cmd)
          env (.environment pb)]
      (.put env "PLAID_NO_REEXEC" "1")
      (.inheritIO pb)
      (System/exit (.waitFor (.start pb))))
    (do
      (binding [*out* *err*]
        (println "WARNING: Could not determine jar path for re-exec.")
        (println "Please run with: java --add-opens=java.base/java.nio=ALL-UNNAMED \\")
        (println "                       --enable-native-access=ALL-UNNAMED \\")
        (println "                       -jar <path-to-jar>"))
      (System/exit 1))))

(defn -main [& args]
  (when (and (or (needs-add-opens?) (needs-native-access?))
             (not (System/getenv "PLAID_NO_REEXEC")))
    (re-exec-with-jdk-flags! args))
  ;; Run mount :stop fns on SIGTERM / Ctrl-C so the datasource gets a
  ;; chance to checkpoint the WAL and close cleanly before the JVM exits.
  ;; Bounded: systemd's default TimeoutStopSec and k8s'
  ;; terminationGracePeriodSeconds are both 30s. We give mount/stop 25s
  ;; (leaves 5s for the OS to deliver SIGKILL) and abandon if it hangs
  ;; — better than holding shutdown indefinitely on a stuck XTDB tx.
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
  (mount/start-with-args {:config "config/prod.edn"}))
