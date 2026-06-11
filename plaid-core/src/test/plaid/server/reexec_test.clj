(ns plaid.server.reexec-test
  "Pins the JDK-flag re-exec's arg-preservation contract (a7510e0): the
  child command line must carry the parent's operator JVM args (-Xmx,
  -D..., GC flags), and they must appear BEFORE -jar — anything after
  -jar is a program argument, so an ordering regression would silently
  downgrade `java -Xmx8g -jar plaid.jar` to the default heap. Pure-fn
  tests; no JVM is forked.

  Deliberately requires plaid.server.reexec, NOT plaid.server.main:
  requiring main registers every mount defstate (http-server included)
  in the JVM-wide registry and changes what a bare (mount/start) in
  other tests brings up."
  (:require [clojure.test :refer :all]
            [plaid.server.reexec :as reexec]))

(deftest reexec-preserves-operator-jvm-args-before-the-jar
  (let [cmd (reexec/build-reexec-cmd "/usr/bin/java"
                                     ["-Xmx8g" "-Dplaid.foo=bar" "-XX:+UseZGC"]
                                     "/srv/plaid.jar"
                                     ["--config" "/etc/plaid.toml"])]
    (is (= "/usr/bin/java" (first cmd)))
    (is (= ["-Xmx8g" "-Dplaid.foo=bar" "-XX:+UseZGC"] (subvec cmd 1 4))
        "operator JVM args ride right after the binary — before -jar")
    (is (= reexec/reexec-jdk-flags (subvec cmd 4 6))
        "the two canonical module flags follow")
    (is (= ["-jar" "/srv/plaid.jar" "--config" "/etc/plaid.toml"] (subvec cmd 6))
        "jar + program args close the command line")))

(deftest inherited-jvm-args-never-duplicate-the-canonical-flags
  ;; inherited-jvm-args reads the live RuntimeMXBean, so the exact list
  ;; varies by environment — but the contract that build-reexec-cmd
  ;; re-adds the canonical flags itself (and would double them if the
  ;; filter broke) holds everywhere.
  (let [args (reexec/inherited-jvm-args)]
    (is (vector? args))
    (is (empty? (filter (set reexec/reexec-jdk-flags) args))
        "the exact canonical flags are filtered out (everything else passes through)")))
