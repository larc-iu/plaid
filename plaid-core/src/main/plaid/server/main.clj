(ns plaid.server.main
  (:require [mount.core :as mount]
            [plaid.server.http-server])
  (:gen-class))

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

(defn- find-jar-path
  "When launched via `java -jar foo.jar`, the JVM sets java.class.path
   to exactly that jar path. We use this to re-exec with --add-opens."
  []
  (let [cp (System/getProperty "java.class.path")]
    (when (and cp (.endsWith cp ".jar"))
      cp)))

(defn- re-exec-with-opens!
  "Re-launch this JVM with --add-opens and forward the exit code."
  [args]
  (if-let [jar-path (find-jar-path)]
    (let [cmd (into ["java"
                     "--add-opens=java.base/java.nio=ALL-UNNAMED"
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
        (println "Please run with: java --add-opens=java.base/java.nio=ALL-UNNAMED -jar <path-to-jar>"))
      (System/exit 1))))

(defn -main [& args]
  (when (and (needs-add-opens?)
             (not (System/getenv "PLAID_NO_REEXEC")))
    (re-exec-with-opens! args))
  (mount/start-with-args {:config "config/prod.edn"}))
