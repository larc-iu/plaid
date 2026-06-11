(ns plaid.server.instance-lock-test
  "The single-instance boot lock: a second plaid process against the same
  SQLite file must fail loudly at datasource start (split in-memory
  document locks / SSE registries, and two history tailers on the same
  XTDB local dirs, are all incoherent). In-JVM, a second tryLock on the
  same file raises OverlappingFileLockException, which exercises the
  exact contention branch a second process would hit via a null tryLock."
  (:require [clojure.test :refer :all]
            [plaid.server.sql])
  (:import (java.nio.file Files)))

(def ^:private acquire! #'plaid.server.sql/acquire-instance-lock!)

(defn- temp-db-path []
  (str (Files/createTempFile "instance-lock-test" ".db"
                             (make-array java.nio.file.attribute.FileAttribute 0))))

(deftest second-acquire-fails-loudly
  (let [db-path (temp-db-path)
        held (acquire! db-path)]
    (try
      (is (some? held) "first acquire succeeds for a file-backed db")
      (let [thrown (try (acquire! db-path) nil
                        (catch clojure.lang.ExceptionInfo e e))]
        (is (some? thrown) "second acquire throws")
        (is (re-find #"Another plaid instance" (ex-message thrown))
            "error message names the problem")
        (is (re-find #"PID" (ex-message thrown))
            "error message carries the holder's PID stamp"))
      (finally
        (.release ^java.nio.channels.FileLock (:lock held))
        (.close ^java.nio.channels.FileChannel (:channel held))))
    ;; After release, a fresh acquire succeeds again.
    (let [again (acquire! db-path)]
      (is (some? again) "lock is reacquirable after release")
      (.release ^java.nio.channels.FileLock (:lock again))
      (.close ^java.nio.channels.FileChannel (:channel again)))))

(deftest in-memory-db-skips-the-lock
  (is (nil? (acquire! nil)) "nil path (in-memory) is a no-op")
  (is (nil? (acquire! "")) "empty path (in-memory) is a no-op"))
