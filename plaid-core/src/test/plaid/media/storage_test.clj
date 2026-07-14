(ns plaid.media.storage-test
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.fixtures :refer [db with-clean-db with-db]]
            [plaid.media.storage :as media]
            [plaid.server.config :as config]
            [plaid.sql.common :as psc])
  (:import [java.nio.file FileVisitOption Files]
           [java.nio.file.attribute FileAttribute]))

(use-fixtures :once with-db)
(use-fixtures :each with-clean-db)

(defn- delete-tree! [root]
  (when (Files/exists root (make-array java.nio.file.LinkOption 0))
    (with-open [paths (Files/walk root (make-array FileVisitOption 0))]
      (doseq [path (reverse (vec (.toList paths)))]
        (Files/deleteIfExists path)))))

(deftest lifecycle-sweep-removes-only-orphaned-media
  (let [tmp (Files/createTempDirectory "plaid-media-sweep-" (make-array FileAttribute 0))
        pid (psc/new-uuid)
        live-id (psc/new-uuid)
        orphan-id (psc/new-uuid)
        cfg {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
             :plaid.media/config {:max-file-size-mb 200}}]
    (try
      (psc/execute! db {:insert-into :projects
                        :values [{:id pid :name "Sweep Project"}]})
      (let [now (psc/now-iso)]
        (psc/execute! db {:insert-into :documents
                          :values [{:id live-id
                                    :project_id pid
                                    :name "Live"
                                    :created_at now
                                    :modified_at now}]}))
      (with-redefs [config/config cfg]
        (let [media-dir (Files/createDirectories
                         (.toPath (java.io.File. (media/get-media-dir)))
                         (make-array FileAttribute 0))
              live-file (.resolve media-dir (str live-id ".mp3"))
              orphan-file (.resolve media-dir (str orphan-id ".mp3"))
              unrelated-file (.resolve media-dir "README.txt")]
          (doseq [path [live-file orphan-file unrelated-file]]
            (Files/writeString path "x" (make-array java.nio.file.OpenOption 0)))
          (is (= {:found 1 :deleted 1 :failed 0}
                 (media/sweep-orphaned-media! db :test)))
          (is (Files/exists live-file (make-array java.nio.file.LinkOption 0)))
          (is (not (Files/exists orphan-file (make-array java.nio.file.LinkOption 0))))
          (is (Files/exists unrelated-file (make-array java.nio.file.LinkOption 0)))))
      (finally
        (delete-tree! tmp)))))
