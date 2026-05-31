(ns plaid.server.jwt-secret-test
  "Regression for #78: ensure PLAID_JWT_SECRET (when set) takes precedence
  over the on-disk secret file, and that the file (when generated) is
  created with 0600 permissions on POSIX systems."
  (:require [clojure.java.io :as io]
            [clojure.test :refer :all]
            [plaid.server.middleware :as mw])
  (:import (java.io File)
           (java.nio.file Files LinkOption)
           (java.nio.file.attribute PosixFilePermission)
           (java.util EnumSet)))

(defn- temp-dir ^File []
  (let [d (File. (System/getProperty "java.io.tmpdir")
                 (str "plaid-jwt-" (System/currentTimeMillis) "-" (rand-int 1000000)))]
    (.mkdirs d)
    d))

(defn- delete-recursively! [^File f]
  (when (.exists f)
    (when (.isDirectory f)
      (doseq [c (.listFiles f)] (delete-recursively! c)))
    (.delete f)))

(deftest env-secret-takes-precedence
  (let [dir (temp-dir)]
    (try
      (let [secret (mw/load-or-generate-secret "env-marker-abcdef" (.getAbsolutePath dir))]
        (is (= "env-marker-abcdef" secret))
        ;; Env override path must not write a file.
        (is (not (.exists (io/file dir "jwt-secret.txt")))))
      (finally (delete-recursively! dir)))))

(deftest blank-env-falls-back-to-file
  (let [dir (temp-dir)]
    (try
      (doseq [env-val [nil "" "   "]]
        (delete-recursively! (io/file dir "jwt-secret.txt"))
        (let [secret (mw/load-or-generate-secret env-val (.getAbsolutePath dir))
              secret-file (io/file dir "jwt-secret.txt")]
          (is (string? secret))
          (is (pos? (count secret)))
          (is (.exists secret-file))
          (is (= secret (slurp secret-file)))))
      (finally (delete-recursively! dir)))))

(deftest existing-file-is-reused
  (let [dir (temp-dir)]
    (try
      (let [first (mw/load-or-generate-secret nil (.getAbsolutePath dir))
            second (mw/load-or-generate-secret nil (.getAbsolutePath dir))]
        (is (= first second) "Second call should reuse the file from the first"))
      (finally (delete-recursively! dir)))))

(deftest generated-file-has-0600-perms-on-posix
  (let [dir (temp-dir)]
    (try
      (mw/load-or-generate-secret nil (.getAbsolutePath dir))
      (let [secret-file (io/file dir "jwt-secret.txt")
            posix? (try
                     (Files/getPosixFilePermissions (.toPath secret-file)
                                                    (into-array LinkOption []))
                     true
                     (catch UnsupportedOperationException _ false))]
        (is (.exists secret-file))
        (when posix?
          (let [perms (Files/getPosixFilePermissions (.toPath secret-file)
                                                     (into-array LinkOption []))]
            (is (= (EnumSet/of PosixFilePermission/OWNER_READ
                               PosixFilePermission/OWNER_WRITE)
                   perms)
                (str "Expected 0600 perms, got " perms)))))
      (finally (delete-recursively! dir)))))
