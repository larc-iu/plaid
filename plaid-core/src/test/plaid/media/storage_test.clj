(ns plaid.media.storage-test
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is use-fixtures]]
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

(deftest concurrent-uploads-cannot-overwrite-one-another
  (let [tmp (Files/createTempDirectory "plaid-media-upload-" (make-array FileAttribute 0))
        source-a (.resolve tmp "a.tmp")
        source-b (.resolve tmp "b.tmp")
        doc-id (psc/new-uuid)
        cfg {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
             :plaid.media/config {:max-file-size-mb 200}}]
    (try
      (Files/writeString source-a "first" (make-array java.nio.file.OpenOption 0))
      (Files/writeString source-b "second" (make-array java.nio.file.OpenOption 0))
      (with-redefs [config/config cfg
                    media/validate-media-file (fn [_ _]
                                                {:valid? true
                                                 :content-type "audio/mpeg"
                                                 :method :test})]
        (let [start (promise)
              upload (fn [source]
                       (future
                         @start
                         (media/store-media-file! doc-id (.toFile source) "audio.mp3")))
              first-upload (upload source-a)
              second-upload (upload source-b)]
          (deliver start true)
          (let [results [@first-upload @second-upload]
                media-files (->> (.listFiles (java.io.File. (media/get-media-dir)))
                                 (filter #(.isFile %))
                                 vec)]
            (is (= 1 (count (filter :success results))))
            (is (= 1 (count (remove :success results))))
            (is (= 1 (count media-files)))
            (is (not (str/ends-with? (.getName (first media-files)) ".upload"))))))
      (finally
        (delete-tree! tmp)))))

(deftest canonicalize-content-type-maps-browser-hostile-mimes
  ;; Tika reports WAV as "audio/vnd.wave", which browser <audio>/<video>
  ;; elements refuse to play (canPlayType => ""). Serving/storing must
  ;; normalize it (and a few siblings) to the canonical playable spelling,
  ;; case-insensitively and after stripping parameters, while passing
  ;; already-canonical and unknown types through untouched.
  (is (= "audio/wav" (media/canonicalize-content-type "audio/vnd.wave")))
  (is (= "audio/wav" (media/canonicalize-content-type "audio/wave")))
  (is (= "audio/wav" (media/canonicalize-content-type "audio/x-wav")))
  (is (= "audio/wav" (media/canonicalize-content-type "AUDIO/VND.WAVE; charset=binary")))
  (is (= "audio/ogg" (media/canonicalize-content-type "audio/vorbis")))
  (is (= "audio/flac" (media/canonicalize-content-type "audio/x-flac")))
  (is (= "audio/mpeg" (media/canonicalize-content-type "audio/mpeg")))
  (is (= "video/mp4" (media/canonicalize-content-type "video/mp4")))
  (is (nil? (media/canonicalize-content-type nil)))
  ;; The canonical WAV type must also map to a sane on-disk extension.
  (is (= "wav" (media/get-extension-from-content-type "audio/wav"))))
