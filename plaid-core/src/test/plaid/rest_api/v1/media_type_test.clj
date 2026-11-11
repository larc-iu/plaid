(ns plaid.rest-api.v1.media-type-test
  "What the media route takes as a recording and what it serves it as (SEC-1).
  A writer uploaded a page named talk.mp3, core took it by its name, and on GET
  detected it again from its bytes and served it as text/html from the apps'
  own origin, where its script read the opener's session token. Now an upload
  is judged by its bytes, a GET serves the type of the stored extension and
  never one read from the bytes, and every media response says nosniff and
  sandbox.

  The files under plaid/media/formats/ are one of each container a recording
  comes in: recordings Chromium's MediaRecorder made (rec-*), and files that
  carry their container's real header followed by filler (the rest), which is
  all content detection reads. Each is uploaded under its own name."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    rest-handler with-admin with-test-users
                                    admin-request with-clean-db parse-response-body]]
            [plaid.media.storage :as media]
            [plaid.server.config :as config]
            [plaid.test-helpers :refer [delete-tree! create-test-project create-test-document]])
  (:import [java.io File]
           [java.nio.file Files]
           [java.nio.file.attribute FileAttribute]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private accepted
  "Each recording format, by fixture, and the Content-Type it is served with.
  Every one was accepted and served with this type before SEC-1 too."
  {"aac.m4a" "audio/mp4"
   "dash.mp4" "video/quicktime"
   "frames.mp3" "audio/mpeg"
   "handmade.webm" "video/webm"
   "id3.mp3" "audio/mpeg"
   "isom.mp4" "video/quicktime"
   "mp42.mp4" "video/mp4"
   "mpeg2.mp3" "audio/mpeg"
   "old.mov" "video/quicktime"
   "opus.ogg" "audio/ogg"
   ;; Starts with padding: content detection reads nothing, the name decides.
   "padded.mp3" "audio/mpeg"
   "pcm.wav" "audio/wav"
   "qt.mov" "video/quicktime"
   "rec-audio.m4a" "video/quicktime"
   "rec-audio.webm" "video/webm"
   "rec-opus.m4a" "video/quicktime"
   "rec-pcm.webm" "video/webm"
   "rec-video.mkv" "video/x-matroska"
   "rec-video.mp4" "video/quicktime"
   "rec-vp8.webm" "video/webm"
   "rec-vp9.webm" "video/webm"
   "sample.3g2" "video/3gpp2"
   "sample.3gp" "video/3gpp"
   "sample.aac" "audio/x-aac"
   "sample.ac3" "audio/ac3"
   "sample.aifc" "audio/x-aiff"
   "sample.aiff" "audio/x-aiff"
   "sample.amr" "audio/amr"
   "sample.au" "audio/basic"
   "sample.avi" "video/x-msvideo"
   "sample.awb" "audio/amr-wb"
   "sample.caf" "audio/x-caf"
   "sample.flac" "audio/flac"
   "sample.flv" "video/x-flv"
   "sample.m4v" "video/x-m4v"
   "sample.mkv" "video/x-matroska"
   "sample.mpg" "video/mpeg"
   "sample.wma" "video/x-ms-asf"
   "sample.wmv" "video/x-ms-asf"
   "vorbis.ogg" "audio/ogg"})

(def ^:private refused-before-and-after
  "Recording formats core refused before SEC-1 and still refuses: their bytes
  do not say audio or video and their extension is not one it takes by name."
  ["flac.oga" "opus.opus" "sample.ape" "sample.dts" "sample.mka" "sample.ts" "sample.wv"
   "speex.spx"])

(def ^:private pages
  "Files named like recordings that hold something a browser would run or show."
  {"page.mp3" "<!doctype html><html><body><script>document.title='pwned'</script></body></html>"
   "pic.mp4" (str "<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\">"
                  "<script>alert(document.domain)</script></svg>")
   "plain.webm" "<html><script>alert(1)</script></html>"
   "x.mov" "<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><script>alert(1)</script></body></html>"
   "notes.mp3" "just some text"
   "code.ogg" "alert(1)"})

(defn- upload-file!
  "Upload `source` as a multipart file named `filename`, through a temp file
  named as ring names one, so nothing but the bytes and `filename` reach core."
  [did filename ^File source]
  (let [file (File/createTempFile "ring-multipart-" ".tmp")]
    (.deleteOnExit file)
    (io/copy source file)
    (rest-handler (-> (admin-request :put (str "/api/v1/documents/" did "/media"))
                      (assoc :multipart-params {"file" {:filename filename
                                                        :tempfile file
                                                        :size (.length file)}})))))

(defn- fixture ^File [name]
  (io/file (io/resource (str "plaid/media/formats/" name))))

(defn- close-body! [response]
  (when-let [body (:body response)]
    (when (instance? java.io.Closeable body) (.close ^java.io.Closeable body)))
  response)

(defn- get-media [did & {:keys [headers]}]
  (close-body! (rest-handler (cond-> (admin-request :get (str "/api/v1/documents/" did "/media"))
                               headers (update :headers merge headers)))))

(defmacro ^:private with-media-dir [& body]
  `(let [tmp# (Files/createTempDirectory "plaid-media-type-" (make-array FileAttribute 0))]
     (try
       (with-redefs [config/config {:plaid.server.sql/config {:main-db-path (str (.resolve tmp# "plaid.db"))}
                                    :plaid.media/config {:max-file-size-mb 200}}]
         ~@body)
       (finally (delete-tree! tmp#)))))

(deftest every-recording-format-is-taken-and-served-as-before
  (with-media-dir
    (let [pid (create-test-project admin-request "Media formats")]
      (doseq [[name served] (sort accepted)]
        (let [did (create-test-document admin-request pid name)
              res (upload-file! did name (fixture name))]
          (is (= 201 (:status res)) (str name " " (:body res)))
          (is (= served (get-in (get-media did) [:headers "Content-Type"])) name)))
      (doseq [name refused-before-and-after]
        (let [did (create-test-document admin-request pid name)]
          (is (= 415 (:status (upload-file! did name (fixture name)))) name))))))

(deftest a-page-named-like-a-recording-is-refused
  (with-media-dir
    (let [pid (create-test-project admin-request "Media pages")]
      (doseq [[name content] pages]
        (let [did (create-test-document admin-request pid name)
              source (doto (File/createTempFile "plaid-page-" ".bin") (.deleteOnExit) (spit content))
              res (upload-file! did name source)]
          (is (= 415 (:status res)) name)
          (is (= "Not an audio or video file." (:error (parse-response-body res))) name)
          (is (= 404 (:status (get-media did))) (str name " is not stored")))))))

(deftest a-stored-page-is-served-as-the-type-of-its-extension
  ;; A file already in the media folder (stored before SEC-1, or put there by
  ;; hand) is served as the type its extension names, never as what its bytes
  ;; read as, and an extension that names no recording type is served as bytes.
  (with-media-dir
    (let [pid (create-test-project admin-request "Media stored pages")
          dir (media/ensure-media-dir!)]
      (doseq [[ext served] [["mp3" "audio/mpeg"] ["mp4" "video/mp4"] ["webm" "video/webm"]
                            ["html" "application/octet-stream"] ["svg" "application/octet-stream"]
                            ["xhtml" "application/octet-stream"] ["js" "application/octet-stream"]
                            ["wave" "application/octet-stream"]]]
        (let [did (create-test-document admin-request pid ext)]
          (spit (io/file dir (str did "." ext)) (get pages "page.mp3"))
          (let [res (get-media did)]
            (is (= 200 (:status res)) ext)
            (is (= served (get-in res [:headers "Content-Type"])) ext)))))))

(deftest every-media-response-says-nosniff-and-sandbox
  (with-media-dir
    (let [pid (create-test-project admin-request "Media headers")
          did (create-test-document admin-request pid "headers")
          _ (is (= 201 (:status (upload-file! did "id3.mp3" (fixture "id3.mp3")))))
          whole (get-media did)
          etag (get-in whole [:headers "ETag"])]
      (doseq [[what res] [["200" whole]
                          ["206" (get-media did :headers {"range" "bytes=0-9"})]
                          ["304" (get-media did :headers {"if-none-match" etag})]
                          ["416" (get-media did :headers {"range" "bytes=99999-"})]]]
        (testing what
          (is (= (Long/parseLong what) (:status res)))
          (is (= "nosniff" (get-in res [:headers "X-Content-Type-Options"])))
          (is (= "sandbox" (get-in res [:headers "Content-Security-Policy"]))))))
    (testing "the range answer still says what the players read"
      (let [pid (create-test-project admin-request "Media ranges")
            did (create-test-document admin-request pid "ranges")
            _ (upload-file! did "id3.mp3" (fixture "id3.mp3"))
            res (get-media did :headers {"range" "bytes=0-9"})]
        (is (= "audio/mpeg" (get-in res [:headers "Content-Type"])))
        (is (= "bytes" (get-in res [:headers "Accept-Ranges"])))
        (is (str/starts-with? (get-in res [:headers "Content-Range"]) "bytes 0-9/"))))))
