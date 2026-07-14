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
