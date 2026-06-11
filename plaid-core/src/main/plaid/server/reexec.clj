(ns plaid.server.reexec
  "The JDK-module-flag re-exec, split out of plaid.server.main so it can
  be required (and tested) WITHOUT loading the full server graph:
  requiring plaid.server.main transitively registers every mount
  defstate (http-server, datasource, ...) in the JVM-wide
  registry, which silently changes what a bare (mount/start) in any
  other test brings up — the full-mount lifecycle tests started
  exploding on the real http-server the first time a test ns required
  main for these fns. This ns requires nothing stateful."
  (:require [clojure.java.io :as io]
            [clojure.string]
            [taoensso.timbre :as log]))

(defn resolve-java-binary
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

(defn needs-add-opens?
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

(defn needs-native-access?
  "Check whether the JVM's restricted-native-method gate is open.
   Originally needed for XTDB's Arrow/Netty (now removed), but KEPT:
   sqlite-jdbc is JNI, and JDK 24+ (JEP 472) gates JNI behind the same
   `--enable-native-access` flag — without it the driver will warn per
   restricted call and hard-fail on a future JDK.

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

(defn find-jar-path
  "When launched via `java -jar foo.jar`, the JVM sets java.class.path
   to exactly that jar path. We use this to re-exec with the JDK module-
   access flags."
  []
  (let [cp (System/getProperty "java.class.path")]
    (when (and cp (.endsWith cp ".jar"))
      cp)))

(def reexec-jdk-flags
  ["--add-opens=java.base/java.nio=ALL-UNNAMED"
   "--enable-native-access=ALL-UNNAMED"])

(defn inherited-jvm-args
  "JVM arguments of the CURRENT process (-Xmx, -D system properties, GC
   flags, ...), to be passed through to the re-exec'd child. Without
   this, `java -Xmx8g -jar plaid.jar` silently re-exec'd at the default
   heap — the child's command line was built from scratch and every
   operator JVM arg was dropped. Only the EXACT canonical flags we
   re-add ourselves are filtered (a prefix filter would eat an
   operator's unrelated --add-opens)."
  []
  (->> (some-> (java.lang.management.ManagementFactory/getRuntimeMXBean)
               (.getInputArguments))
       (remove (set reexec-jdk-flags))
       (vec)))

(defn build-reexec-cmd
  "Child command line: java binary, the parent's own JVM args, the two
   JDK module flags, then the jar + program args. Pure — split out so
   the arg-preservation contract is testable without forking a JVM."
  [java-bin jvm-args jar-path args]
  (-> [java-bin]
      (into jvm-args)
      (into reexec-jdk-flags)
      (into ["-jar" jar-path])
      (into args)))

(defn re-exec-with-jdk-flags!
  "Re-launch this JVM with both `--add-opens=java.base/java.nio=ALL-UNNAMED`
   (required by SQLite's reflective access to `java.nio.Buffer`) and
   `--enable-native-access=ALL-UNNAMED` (future-proofing for sqlite-jdbc's
   JNI under JDK 24+'s JEP 472 gating). We re-add both unconditionally rather
   than only the missing one: the cost is two extra JVM args, and the
   child process is wholly defined by this command line so there's no
   way for one flag to be present while the other is missing."
  [args]
  (if-let [jar-path (find-jar-path)]
    (let [cmd (build-reexec-cmd (resolve-java-binary) (inherited-jvm-args) jar-path args)
          pb  (ProcessBuilder. ^java.util.List cmd)
          env (.environment pb)]
      (binding [*out* *err*]
        (println "Re-executing with JDK module flags (operator JVM args preserved):")
        (println " " (clojure.string/join " " cmd)))
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
