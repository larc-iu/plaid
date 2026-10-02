(ns plaid.server.backup-test
  (:require [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db]]
            [plaid.server.backup :as backup])
  (:import [java.nio.file Files]
           [java.nio.file.attribute FileAttribute]
           [java.util.zip ZipFile]))

(use-fixtures :once with-db)

(defn- with-temp-directory [f]
  (let [dir (.toFile (Files/createTempDirectory "plaid-backup-test"
                                                (make-array FileAttribute 0)))]
    (try
      (f dir)
      (finally
        (doseq [file (reverse (file-seq dir))]
          (io/delete-file file true))))))

(deftest backup-is-validated-before-publication
  (with-temp-directory
    (fn [dir]
      (let [zip (backup/backup-once! db dir 2)]
        (is (some? zip))
        (is (.exists zip))
        (with-open [archive (ZipFile. zip)]
          (is (= 1 (count (enumeration-seq (.entries archive))))))
        (is (= [(.getName zip)] (mapv #(.getName %) (.listFiles dir)))
            "No snapshot or temporary zip remains after success")))))

(deftest failed-zip-is-never-published
  (with-temp-directory
    (fn [dir]
      (testing "partial temporary output is cleaned up"
        (with-redefs-fn {#'backup/zip-file!
                         (fn [_ zip]
                           (spit zip "partial")
                           (throw (ex-info "simulated zip failure" {})))}
          #(is (nil? (backup/backup-once! db dir 2))))
        (is (empty? (.listFiles dir)))))))

(defn- while-a-backup-is-written
  "Run `f` while a backup into `dir` is held between its snapshot and its zip."
  [dir f]
  (let [entered (promise)
        release (promise)
        zip-file! @#'backup/zip-file!]
    (with-redefs-fn {#'backup/zip-file! (fn [src zip]
                                          (deliver entered true)
                                          @release
                                          (zip-file! src zip))}
      (fn []
        (let [first-run (future (backup/backup-once! db dir 2))]
          (try
            (is (deref entered 30000 false) "the first backup started")
            (f)
            (finally
              (deliver release true)))
          (is (some? @first-run) "the first backup is written"))))))

(deftest one-backup-at-a-time
  ;; H7-CORE-OPS-2: a second "Back up now" ran beside the first, 2.3 times
  ;; the database in disk at its peak.
  (with-temp-directory
    (fn [dir]
      (while-a-backup-is-written
       dir
       (fn []
         (testing "a second one is not started"
           (is (= ::backup/running (backup/backup-once! db dir 2))))
         (testing "one asked for by hand is refused with 409"
           (let [e (try (backup/run-now! db) nil (catch clojure.lang.ExceptionInfo e e))]
             (is (= 409 (:code (ex-data e))))
             (is (= "A backup is already being written. It is listed here when it is done."
                    (ex-message e)))))
         (testing "the report says one is running"
           (is (string? (:running (backup/status)))))))
      (testing "and once it is written, the next one runs"
        (is (nil? (:running (backup/status))))
        (Thread/sleep 1100)
        (is (instance? java.io.File (backup/backup-once! db dir 2)))))))
