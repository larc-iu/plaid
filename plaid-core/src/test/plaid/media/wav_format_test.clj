(ns plaid.media.wav-format-test
  "A WAV is refused by its coding: browsers play only PCM, 32-bit float,
  A-law and mu-law samples, and an IMA ADPCM WAV from ELAN was accepted as audio/wav, stored, and never
  played. Checked on the storage function and through the upload route."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    rest-handler with-admin with-test-users
                                    admin-request with-clean-db parse-response-body]]
            [plaid.media.storage :as media]
            [plaid.server.config :as config]
            [plaid.test-helpers :refer [create-test-project create-test-document]])
  (:import [java.io File]
           [java.nio ByteBuffer ByteOrder]
           [java.nio.file FileVisitOption Files]
           [java.nio.file.attribute FileAttribute]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- chunk-bytes [^String id ^bytes body]
  (let [padded (+ (alength body) (mod (alength body) 2))
        buf (doto (ByteBuffer/allocate (+ 8 padded)) (.order ByteOrder/LITTLE_ENDIAN))]
    (.put buf (.getBytes id "ISO-8859-1"))
    (.putInt buf (alength body))
    (.put buf body)
    (.array buf)))

(defn- fmt-body
  "A fmt chunk body: `tag`, and for WAVE_FORMAT_EXTENSIBLE the subformat."
  [tag & {:keys [subformat bits] :or {bits 4}}]
  (let [buf (doto (ByteBuffer/allocate (if subformat 40 20)) (.order ByteOrder/LITTLE_ENDIAN))]
    (.putShort buf (unchecked-short tag))
    (.putShort buf (short 1))      ; channels
    (.putInt buf 22050)            ; rate
    (.putInt buf 11100)            ; bytes a second
    (.putShort buf (short 512))    ; block align
    (.putShort buf (short bits))   ; bits a sample
    (if subformat
      (do (.putShort buf (short 22))
          (.putShort buf (short 1017))
          (.putInt buf 0)
          (.putShort buf (unchecked-short subformat))
          (.put buf (byte-array [0 0 0 0 0x10 0 (unchecked-byte 0x80) 0 0 (unchecked-byte 0xAA)
                                 0 0x38 (unchecked-byte 0x9B) 0x71])))
      (do (.putShort buf (short 2))
          (.putShort buf (short 1017))))
    (.array buf)))

(defn- wav-bytes
  "A RIFF/WAVE file: `chunks` (each [id body]) after the header."
  ^bytes [& chunks]
  (let [body (apply concat (.getBytes "WAVE" "ISO-8859-1")
                    (map (fn [[id b]] (seq (chunk-bytes id b))) chunks))
        buf (doto (ByteBuffer/allocate (+ 8 (count body))) (.order ByteOrder/LITTLE_ENDIAN))]
    (.put buf (.getBytes "RIFF" "ISO-8859-1"))
    (.putInt buf (count body))
    (.put buf (byte-array body))
    (.array buf)))

(defn- wav-file ^File [^bytes bytes]
  (let [file (File/createTempFile "plaid-wav-" ".wav")]
    (with-open [out (java.io.FileOutputStream. file)] (.write out bytes))
    (.deleteOnExit file)
    file))

(defn- wav [tag & opts]
  (wav-file (wav-bytes ["fmt " (apply fmt-body tag opts)] ["data" (byte-array 512)])))

(deftest wav-format-reads-the-coding
  (is (= 1 (media/wav-format (wav 1))))
  (is (= 3 (media/wav-format (wav 3))))
  (is (= 0x11 (media/wav-format (wav 0x11))))
  (testing "WAVE_FORMAT_EXTENSIBLE is its subformat"
    (is (= 1 (media/wav-format (wav 0xFFFE :subformat 1))))
    (is (= 0x11 (media/wav-format (wav 0xFFFE :subformat 0x11)))))
  (testing "fmt behind another chunk, of odd length"
    (is (= 0x11 (media/wav-format
                 (wav-file (wav-bytes ["LIST" (byte-array 5)]
                                      ["fmt " (fmt-body 0x11)]
                                      ["data" (byte-array 512)]))))))
  (testing "not a WAV, or a WAV cut off before its fmt chunk"
    (let [f (File/createTempFile "plaid-wav-" ".mp3")]
      (spit f "ID3 and then some")
      (.deleteOnExit f)
      (is (nil? (media/wav-format f))))
    (is (nil? (media/wav-format (wav-file (java.util.Arrays/copyOf (wav-bytes ["fmt " (fmt-body 1)]) 14)))))))

(deftest unplayable-wav-error-names-the-coding
  (is (nil? (media/unplayable-wav-error (wav 1))))
  (is (nil? (media/unplayable-wav-error (wav 3))))
  (is (nil? (media/unplayable-wav-error (wav 0xFFFE :subformat 3))))
  (testing "A-law and mu-law, which Chrome and Firefox play"
    (is (nil? (media/unplayable-wav-error (wav 6 :bits 8))))
    (is (nil? (media/unplayable-wav-error (wav 7 :bits 8))))
    (is (nil? (media/unplayable-wav-error (wav 0xFFFE :subformat 7 :bits 8)))))
  (testing "float at 32 bits plays, at 64 it does not"
    (is (nil? (media/unplayable-wav-error (wav 3 :bits 32))))
    (is (= (str "WAV encoded as 64-bit float cannot be played in a browser. "
                "Only PCM, 32-bit float, A-law and mu-law WAV are accepted.")
           (media/unplayable-wav-error (wav 3 :bits 64))))
    (is (str/includes? (media/unplayable-wav-error (wav 0xFFFE :subformat 3 :bits 64))
                       "64-bit float")))
  (is (str/includes? (media/unplayable-wav-error (wav 0x11)) "IMA ADPCM"))
  (is (str/includes? (media/unplayable-wav-error (wav 2)) "MS ADPCM"))
  (is (str/includes? (media/unplayable-wav-error (wav 0x31)) "GSM 6.10"))
  (is (str/includes? (media/unplayable-wav-error (wav 0xFFFE :subformat 0x11)) "IMA ADPCM"))
  (is (str/includes? (media/unplayable-wav-error (wav 0x1234)) "format 4660")))

(defn- delete-tree! [root]
  (when (Files/exists root (make-array java.nio.file.LinkOption 0))
    (with-open [paths (Files/walk root (make-array FileVisitOption 0))]
      (doseq [path (reverse (vec (.toList paths)))]
        (Files/deleteIfExists path)))))

(deftest upload-refuses-a-wav-browsers-cannot-play
  (let [tmp (Files/createTempDirectory "plaid-wav-route-" (make-array FileAttribute 0))
        cfg {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
             :plaid.media/config {:max-file-size-mb 200}}]
    (try
      (with-redefs [config/config cfg]
        (let [pid (create-test-project admin-request "WAV project")
              did (create-test-document admin-request pid "WAV document")
              media-path (str "/api/v1/documents/" did "/media")
              upload! (fn [filename ^File file]
                        (rest-handler (-> (admin-request :put media-path)
                                          (assoc :multipart-params
                                                 {"file" {:filename filename
                                                          :tempfile file
                                                          :size (.length file)}}))))]
          (testing "IMA ADPCM is 415, its coding named, and nothing is stored"
            (let [res (upload! "story.wav" (wav 0x11))
                  body (parse-response-body res)]
              (is (= 415 (:status res)))
              (is (= (str "WAV encoded as IMA ADPCM cannot be played in a browser. "
                          "Only PCM, 32-bit float, A-law and mu-law WAV are accepted.")
                     (:error body)))
              (is (not (media/media-exists? did)))))
          (testing "whatever the file is called"
            (is (= 415 (:status (upload! "story.mp3" (wav 0xFFFE :subformat 0x11))))))
          (testing "a PCM WAV is stored"
            (is (= 201 (:status (upload! "story.wav" (wav 0xFFFE :subformat 1)))))
            (is (media/media-exists? did)))))
      (finally
        (delete-tree! tmp)))))
