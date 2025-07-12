(ns plaid.media.storage
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.set :as set]
            [plaid.server.config :refer [config]]
            [taoensso.timbre :as log])
  (:import [java.io File FileInputStream FileOutputStream]
           [java.nio.file Files Paths StandardCopyOption]
           [org.apache.tika Tika]))

(def special-extension-cases
  "Special cases where MIME subtype doesn't match ideal file extension"
  {"audio/mpeg" "mp3"
   "video/quicktime" "mov"
   "audio/mp4" "m4a"})

(defn get-max-file-size
  "Get maximum file size in bytes from config"
  []
  (let [max-mb (-> config :plaid.media/config :max-file-size-mb)]
    (* max-mb 1024 1024)))

(def ^Tika tika-instance
  "Shared Tika instance for content detection"
  (Tika.))

(defn get-media-dir
  "Get the media directory path from config"
  []
  (let [main-db-dir (-> config :plaid.server.xtdb/config :main-db-dir)
        media-dir (str main-db-dir File/separator "media")]
    media-dir))

(defn ensure-media-dir!
  "Ensure the media directory exists"
  []
  (let [media-dir (get-media-dir)
        dir-file (io/file media-dir)]
    (when-not (.exists dir-file)
      (.mkdirs dir-file)
      (log/info "Created media directory:" media-dir))
    media-dir))

(defn detect-content-type
  "Use Apache Tika to detect actual content type from file content"
  [file-path-or-stream]
  (try
    (.detect tika-instance file-path-or-stream)
    (catch Exception e
      (log/warn "Failed to detect content type:" (.getMessage e))
      nil)))

(defn is-media-type?
  "Check if a MIME type is video or audio"
  [mime-type]
  (and mime-type
       (or (.startsWith mime-type "video/")
           (.startsWith mime-type "audio/"))))

(defn mime-to-extension
  "Convert MIME type to file extension, handling special cases"
  [mime-type]
  (or (get special-extension-cases mime-type)
      (when mime-type
        (let [subtype (last (.split mime-type "/"))]
          ;; Handle common variations
          (case subtype
            "x-msvideo" "avi"
            "x-matroska" "mkv"
            subtype)))))

(defn get-extension-from-content-type
  "Extract file extension from MIME type"
  [content-type]
  (when content-type
    (let [mime-type (-> content-type
                        (str/split #";")
                        first
                        str/trim
                        str/lower-case)]
      (mime-to-extension mime-type))))

(defn get-media-file-path
  "Build the full path for a media file"
  [doc-id extension]
  (let [media-dir (get-media-dir)
        filename (str doc-id "." extension)]
    (str media-dir File/separator filename)))

(defn find-existing-media-file
  "Find existing media file for document, return [path extension] or nil"
  [doc-id]
  (let [media-dir (get-media-dir)
        dir-file (io/file media-dir)]
    (when (.exists dir-file)
      (->> (.listFiles dir-file)
           (filter #(.isFile %))
           (map #(.getName %))
           (filter #(str/starts-with? % (str doc-id ".")))
           first
           (#(when %
               (let [extension (last (str/split % #"\."))]
                 [(str media-dir File/separator %) extension])))))))

(defn media-exists?
  "Check if a media file exists for the given document ID"
  [doc-id]
  (some? (find-existing-media-file doc-id)))

(defn get-media-info
  "Get information about a media file (size, extension, content-type)"
  [doc-id]
  (when-let [[file-path extension] (find-existing-media-file doc-id)]
    (let [file (io/file file-path)]
      (when (.exists file)
        {:file-path file-path
         :extension extension
         :content-type (or
                        ;; Try to detect actual content type
                        (detect-content-type file)
                        ;; Fallback to guessing from extension
                        (str (if (contains? #{"mp3" "wav" "aac" "m4a" "ogg" "flac"} extension)
                               "audio/" "video/")
                             extension))
         :size (.length file)
         :last-modified (.lastModified file)}))))

(defn validate-media-file
  "Validate a media file using Tika content detection"
  [temp-file filename]
  (let [detected-type (detect-content-type temp-file)
        filename-ext (when filename (last (str/split filename #"\.")))
        ;; Check if detected type is a media type
        is-detected-media? (is-media-type? detected-type)
        ;; Check if we can determine extension from detected type
        detected-extension (when detected-type (get-extension-from-content-type detected-type))]

    (log/debug "File validation - detected:" detected-type "is-media:" is-detected-media?
               "filename:" filename "ext:" filename-ext)

    (cond
      ;; If Tika detected a media type and we can map it to an extension, use it
      (and is-detected-media? detected-extension)
      {:valid? true :content-type detected-type :method :tika-detection}

      ;; If Tika detected media but we can't map extension, use filename extension
      (and is-detected-media? filename-ext)
      {:valid? true :content-type detected-type :method :tika-with-filename-ext}

      ;; If we have a filename extension and no detection, accept common media extensions
      (and filename-ext (contains? #{"mp4" "mp3" "wav" "mov" "avi" "mkv" "webm" "aac" "m4a" "ogg" "flac"}
                                   (str/lower-case filename-ext)))
      {:valid? true
       :content-type (str (if (contains? #{"mp3" "wav" "aac" "m4a" "ogg" "flac"} (str/lower-case filename-ext))
                            "audio/" "video/")
                          (str/lower-case filename-ext))
       :method :filename-only}

      ;; Otherwise, invalid
      :else
      {:valid? false
       :error "Unsupported media type"
       :detected detected-type
       :filename-ext filename-ext})))

(defn store-media-file!
  "Store a media file for a document. Returns {:success true} or {:success false :error msg}"
  [doc-id temp-file filename]
  (try
    (cond
      (media-exists? doc-id)
      {:success false :error "Media file already exists. Delete existing file first."}

      (> (.length temp-file) (get-max-file-size))
      {:success false :error "File too large"}

      :else
      (let [validation (validate-media-file temp-file filename)]
        (if (:valid? validation)
          (let [content-type (:content-type validation)
                extension (get-extension-from-content-type content-type)]
            (if extension
              (do
                (ensure-media-dir!)
                (let [file-path (get-media-file-path doc-id extension)
                      temp-path (str file-path ".tmp")]
                  ;; Copy to temporary file first
                  (Files/copy (.toPath temp-file)
                              (Paths/get temp-path (into-array String []))
                              (into-array java.nio.file.StandardCopyOption []))
                  ;; Atomically move to final location
                  (Files/move (Paths/get temp-path (into-array String []))
                              (Paths/get file-path (into-array String []))
                              (into-array StandardCopyOption [StandardCopyOption/REPLACE_EXISTING]))
                  (log/info "Stored media file:" file-path "method:" (:method validation))
                  {:success true :file-path file-path :extension extension :content-type content-type}))
              {:success false :error "Could not determine file extension"}))
          {:success false :error (:error validation)})))
    (catch Exception e
      (log/error e "Failed to store media file for document" doc-id)
      {:success false :error (.getMessage e)})))

(defn delete-media-file!
  "Delete a media file for a document. Returns {:success true} or {:success false :error msg}"
  [doc-id]
  (try
    (if-let [[file-path _] (find-existing-media-file doc-id)]
      (let [file (io/file file-path)]
        (if (.delete file)
          (do
            (log/info "Deleted media file:" file-path)
            {:success true})
          {:success false :error "Failed to delete file"}))
      {:success false :error "No media file found"})
    (catch Exception e
      (log/error e "Failed to delete media file for document" doc-id)
      {:success false :error (.getMessage e)})))

(defn get-media-file
  "Get a media file for streaming. Returns {:success true :file file :content-type ct} or error"
  [doc-id]
  (try
    (if-let [info (get-media-info doc-id)]
      {:success true
       :file (io/file (:file-path info))
       :content-type (:content-type info)
       :size (:size info)}
      {:success false :error "Media file not found"})
    (catch Exception e
      (log/error e "Failed to get media file for document" doc-id)
      {:success false :error (.getMessage e)})))