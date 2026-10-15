(ns plaid.media.duration-test
  "A recording's length, read from its header at upload and stored: the
  header readers on synthetic files, then the length through the routes that
  write and read it (upload, read, as-of read, copy, delete) and the one-off
  backfill for files uploaded before."
  (:require [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [next.jdbc :as jdbc]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    rest-handler with-admin with-test-users db
                                    admin-request with-clean-db parse-response-body]]
            [plaid.media.backfill :as backfill]
            [plaid.media.duration :as duration]
            [plaid.server.config :as config]
            [plaid.test-helpers :refer [delete-tree! create-test-project create-test-document]])
  (:import [java.io File]
           [java.nio ByteBuffer ByteOrder]
           [java.nio.file Files]
           [java.nio.file.attribute FileAttribute]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; --- synthetic files -----------------------------------------------------------

(defn- bytes-of [& parts]
  (let [out (java.io.ByteArrayOutputStream.)]
    (doseq [p parts]
      (.write out ^bytes (if (string? p) (.getBytes ^String p "ISO-8859-1") p)))
    (.toByteArray out)))

(defn- le [n width]
  (let [b (ByteBuffer/allocate width)]
    (.order b ByteOrder/LITTLE_ENDIAN)
    (case width 2 (.putShort b (short n)) 4 (.putInt b (unchecked-int n)))
    (.array b)))

(defn- be [n width]
  (let [b (ByteBuffer/allocate width)]
    (case width 4 (.putInt b (unchecked-int n)) 8 (.putLong b (long n)))
    (.array b)))

(defn wav-bytes
  "A mono 16-bit PCM WAV of `seconds` of silence at `rate`."
  ([seconds] (wav-bytes seconds 8000))
  ([seconds rate]
   (let [data (byte-array (* 2 (long (* rate seconds))))]
     (bytes-of "RIFF" (le (+ 36 (alength data)) 4) "WAVE"
               "fmt " (le 16 4) (le 1 2) (le 1 2) (le rate 4) (le (* 2 rate) 4) (le 2 2) (le 16 2)
               "data" (le (alength data) 4) data))))

(defn- box [kind body] (bytes-of (be (+ 8 (alength ^bytes body)) 4) kind body))

(defn- file-of ^File [^bytes data ext]
  (let [f (File/createTempFile "plaid-duration-" (str "." ext))]
    (.deleteOnExit f)
    (Files/write (.toPath f) data (make-array java.nio.file.OpenOption 0))
    f))

(defn- secs [data ext] (duration/seconds (file-of data ext) ext))

(defn- near? [a b] (and a (< (Math/abs (- (double a) (double b))) 1e-6)))

(deftest the-headers-say-the-length
  (testing "a WAV by its fmt byte rate and data chunk"
    (is (near? (secs (wav-bytes 2.5) "wav") 2.5)))
  (testing "an MP4 by its mvhd, a version 0 and a version 1 box, after a large mdat"
    (let [v0 (bytes-of (byte-array 4) (be 0 4) (be 0 4) (be 1000 4) (be 83500 4) (byte-array 80))
          v1 (bytes-of (byte-array [1 0 0 0]) (be 0 8) (be 0 8) (be 600 4) (be (* 600 90) 8) (byte-array 80))
          mp4 (fn [mvhd] (bytes-of (box "ftyp" (bytes-of "isom" (byte-array [0 0 2 0])))
                                   (box "mdat" (byte-array 200000))
                                   (box "moov" (box "mvhd" mvhd))))]
      (is (near? (secs (mp4 v0) "mp4") 83.5))
      (is (near? (secs (mp4 v1) "m4a") 90))
      (is (near? (secs (mp4 v0) "mov") 83.5))
      (testing "an M4V, stored as x-m4v, is an MP4"
        (is (near? (secs (mp4 v0) "x-m4v") 83.5)))))
  (testing "a FLAC by its STREAMINFO"
    (let [info (byte-array 34)
          rate 16000
          samples (* 16000 7)]
      (aset-byte info 10 (unchecked-byte (bit-shift-right rate 12)))
      (aset-byte info 11 (unchecked-byte (bit-and (bit-shift-right rate 4) 0xFF)))
      (aset-byte info 12 (unchecked-byte (bit-shift-left (bit-and rate 0x0F) 4)))
      (System/arraycopy (be samples 4) 0 info 14 4)
      (is (near? (secs (bytes-of "fLaC" (byte-array [0 0 0 34]) info (byte-array 100)) "flac") 7))))
  (testing "an MP3 by its Xing frame count, or its bit rate over its size"
    (let [sync (byte-array (map unchecked-byte [0xFF 0xFB 0x90 0x00]))
          xing (bytes-of sync (byte-array 32) "Xing" (be 1 4) (be 100 4) (byte-array 400))]
      (is (near? (secs (bytes-of "ID3" (byte-array [3 0 0 0 0 0 0]) xing) "mp3") (/ (* 100 1152) 44100.0)))
      (testing "a constant bit rate only when the next frame follows the first"
        (let [frame (bytes-of sync (byte-array (- 417 4)))
              frames (byte-array (take 16000 (cycle frame)))]
          (is (near? (secs frames "mp3") (/ (* 16000 8) 128000.0))))
        (is (nil? (secs (bytes-of sync (byte-array (- 16000 4))) "mp3")) "one frame header, then nothing")
        (is (nil? (duration/seconds (io/file (io/resource "plaid/media/garbage.mp3")) "mp3"))
            "3 KB of noise that opens with FF FB (REV-UI)"))))
  (testing "another format or a broken header is of unknown length"
    (is (nil? (secs (bytes-of "OggS" (byte-array 200)) "ogg")))
    (is (nil? (secs (bytes-of (byte-array (map unchecked-byte [0x1A 0x45 0xDF 0xA3])) (byte-array 200)) "webm")))
    (is (nil? (secs (byte-array 0) "wav")))
    (is (nil? (secs (bytes-of "RIFF" (byte-array 8)) "wav")))
    (is (nil? (secs (bytes-of "RIFF" (le 100 4) "WAVE" "data" (le 50 4)) "wav")) "no fmt chunk")
    (testing "an MP3 is read only when stored as one, having no magic number"
      (is (nil? (secs (bytes-of (byte-array (map unchecked-byte [0xFF 0xFB 0x90 0x00])) (byte-array 16000)) "ogg"))))))

;; --- through the routes --------------------------------------------------------

(defn- with-media-dir [f]
  (let [tmp (Files/createTempDirectory "plaid-duration-" (make-array FileAttribute 0))]
    (try
      (with-redefs [config/config {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
                                   :plaid.media/config {:max-file-size-mb 200}}]
        (f tmp))
      (finally (delete-tree! tmp)))))

(defn- upload! [did name ^bytes data]
  (let [file (file-of data "upload")]
    (rest-handler (-> (admin-request :put (str "/api/v1/documents/" did "/media"))
                      (assoc :multipart-params {"file" {:filename name :tempfile file :size (.length file)}})))))

(defn- read-doc
  ([did] (read-doc did nil))
  ([did as-of]
   (parse-response-body
    (rest-handler (admin-request :get (str "/api/v1/documents/" did (when as-of (str "?as-of=" as-of))))))))

(defn- length-of [body] (some body [:document/media-duration :media-duration]))

(deftest the-length-is-stored-at-upload-and-read-beside-the-media-url
  (with-media-dir
    (fn [_]
      (let [pid (create-test-project admin-request "Duration project")
            did (create-test-document admin-request pid "Recorded")]
        (testing "no recording, no length"
          (is (nil? (length-of (read-doc did)))))
        (is (= 201 (:status (upload! did "talk.wav" (wav-bytes 3.5)))))
        (let [body (read-doc did)]
          (is (some body [:document/media-url :media-url]))
          (is (near? (length-of body) 3.5)))
        (testing "an as-of read names the current recording's length, as it names its media-url"
          (Thread/sleep 5)
          (is (near? (length-of (read-doc did (str (java.time.Instant/now)))) 3.5)))
        (testing "a copy carries the recording and its length"
          (let [res (parse-response-body
                     (rest-handler (-> (admin-request :post (str "/api/v1/documents/" did "/copy"))
                                       (assoc :body-params {:name "Copy"}))))
                copy-id (some res [:id :document/id])]
            (is copy-id)
            (is (near? (length-of (read-doc copy-id)) 3.5))
            (testing "unless the copy leaves the recording behind"
              (let [res (parse-response-body
                         (rest-handler (-> (admin-request :post (str "/api/v1/documents/" did "/copy"))
                                           (assoc :body-params {:name "Bare" :include-media false}))))]
                (is (nil? (length-of (read-doc (some res [:id :document/id])))))))))
        (testing "a delete takes the length with the recording"
          (is (= 204 (:status (rest-handler (admin-request :delete (str "/api/v1/documents/" did "/media"))))))
          (is (nil? (duration/stored db did)))
          (is (nil? (length-of (read-doc did)))))
        (testing "a recording of a format not read here has a media-url and no length"
          (is (= 201 (:status (upload! did "talk.ogg" (bytes-of "OggS" (byte-array 400)))))))
        (let [body (read-doc did)]
          (when (some body [:document/media-url :media-url])
            (is (nil? (length-of body)))))))))

(deftest the-backfill-stores-what-was-uploaded-before-and-only-that
  (with-media-dir
    (fn [tmp]
      (let [pid (create-test-project admin-request "Backfill project")
            old (create-test-document admin-request pid "Uploaded before")
            new (create-test-document admin-request pid "Uploaded since")
            media-dir (.toFile (.resolve tmp "media"))]
        (is (= 201 (:status (upload! old "old.wav" (wav-bytes 2.0)))))
        (is (= 201 (:status (upload! new "new.wav" (wav-bytes 1.0)))))
        ;; As a core before 2026-10-15 left it: the file, no length.
        (jdbc/execute! db ["DELETE FROM document_media WHERE document_id = ?" (str old)])
        (Files/write (.toPath (File. media-dir (str (random-uuid) ".wav")))
                     ^bytes (wav-bytes 1.0) (make-array java.nio.file.OpenOption 0))
        (Files/write (.toPath (File. media-dir (str (random-uuid) ".webm")))
                     (byte-array 10) (make-array java.nio.file.OpenOption 0))
        (Files/write (.toPath (File. media-dir (str old ".12345.upload")))
                     ^bytes (wav-bytes 1.0) (make-array java.nio.file.OpenOption 0))
        (Files/write (.toPath (File. media-dir (str old ".678.copy")))
                     ^bytes (wav-bytes 1.0) (make-array java.nio.file.OpenOption 0))
        (with-open [conn (jdbc/get-connection db)]
          (testing "a dry run counts and writes nothing"
            (let [counts (backfill/backfill! conn media-dir false)]
              (is (= {:files 4 :already-stored 1 :to-store 1 :no-document 2 :unknown-format {}}
                     (dissoc counts :seconds)))
              (is (nil? (duration/stored db old)))))
          (testing "--apply stores the missing length, and a second run finds nothing"
            (is (= 1 (:stored (backfill/backfill! conn media-dir true))))
            (is (near? (duration/stored db old) 2.0))
            (is (near? (duration/stored db new) 1.0))
            (is (= 0 (:stored (backfill/backfill! conn media-dir true))))))))))

(deftest an-m4v-upload-gets-its-length
  (with-media-dir
    (fn [tmp]
      (let [pid (create-test-project admin-request "M4V project")
            did (create-test-document admin-request pid "M4V")
            mvhd (bytes-of (byte-array 4) (be 0 4) (be 0 4) (be 1000 4) (be 12345 4) (byte-array 80))
            m4v (bytes-of (box "ftyp" (bytes-of "M4V " (byte-array [0 0 2 0]) "M4V " "isom"))
                          (box "moov" (box "mvhd" mvhd))
                          (box "mdat" (byte-array 2000)))]
        (is (= 201 (:status (upload! did "clip.m4v" m4v))))
        (let [body (read-doc did)]
          (is (= [(str did ".x-m4v")] (vec (.list (.toFile (.resolve tmp "media"))))))
          (is (near? (length-of body) 12.345)))))))

(deftest the-backfill-stores-no-length-for-a-file-replaced-while-it-was-read
  (with-media-dir
    (fn [tmp]
      (let [pid (create-test-project admin-request "Backfill race project")
            did (create-test-document admin-request pid "Replaced")
            media-dir (.toFile (.resolve tmp "media"))
            read-header duration/seconds
            replaced (atom false)]
        (is (= 201 (:status (upload! did "old.wav" (wav-bytes 99.0)))))
        (jdbc/execute! db ["DELETE FROM document_media WHERE document_id = ?" (str did)])
        ;; While the backfill reads the WAV's header, the recording is
        ;; deleted and a WebM, a format of no stored length, takes its place.
        (with-redefs [duration/seconds
                      (fn [f ext]
                        (let [secs (read-header f ext)]
                          (when (compare-and-set! replaced false true)
                            (is (= 204 (:status (rest-handler (admin-request :delete (str "/api/v1/documents/" did "/media"))))))
                            (is (= 201 (:status (upload! did "new.webm"
                                                         (bytes-of (byte-array (map unchecked-byte [0x1A 0x45 0xDF 0xA3]))
                                                                   (byte-array 4000)))))))
                          secs))]
          (with-open [conn (jdbc/get-connection db)]
            (let [counts (backfill/backfill! conn media-dir true)]
              (is @replaced)
              (is (= 0 (:stored counts)))
              (is (= 1 (:changed counts))))))
        (is (nil? (duration/stored db did)))
        (is (nil? (length-of (read-doc did))))))))

(deftest a-staged-upload-or-copy-is-not-the-recording
  ;; REV-UI-2: while an upload or a copy is staged in the media directory as
  ;; `<id>.<n>.upload` or `<id>.<n>.copy`, the document has no recording yet.
  (with-media-dir
    (fn [tmp]
      (let [pid (create-test-project admin-request "Staged project")
            did (create-test-document admin-request pid "Staged")
            media-dir (.toFile (.resolve tmp "media"))
            _ (.mkdirs media-dir)
            staged (vec (for [n ["123.upload" "456.copy"]]
                          (doto (File. media-dir (str did "." n))
                            (-> .toPath (Files/write ^bytes (wav-bytes 1.0) (make-array java.nio.file.OpenOption 0))))))]
        (testing "a read names no recording"
          (is (nil? (some (read-doc did) [:document/media-url :media-url])))
          (is (= 404 (:status (rest-handler (admin-request :get (str "/api/v1/documents/" did "/media")))))))
        (testing "a delete finds nothing to delete and leaves the staged files"
          (is (= 404 (:status (rest-handler (admin-request :delete (str "/api/v1/documents/" did "/media"))))))
          (is (every? #(.exists ^File %) staged)))
        (testing "a copy carries no recording"
          (let [res (parse-response-body
                     (rest-handler (-> (admin-request :post (str "/api/v1/documents/" did "/copy"))
                                       (assoc :body-params {:name "Copy"}))))
                copy-id (some res [:id :document/id])]
            (is copy-id)
            (is (nil? (some (read-doc copy-id) [:document/media-url :media-url])))
            (is (empty? (filter #(.startsWith ^String % (str copy-id)) (.list media-dir))))))
        (testing "an upload is not refused as if a recording were there"
          (is (= 201 (:status (upload! did "talk.wav" (wav-bytes 2.0)))))
          (is (near? (length-of (read-doc did)) 2.0)))))))
