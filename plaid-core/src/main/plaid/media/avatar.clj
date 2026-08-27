(ns plaid.media.avatar
  "Profile-picture normalization.

  Every uploaded picture is decoded, center-cropped to a square, scaled to one
  configured edge length, and re-encoded on the SERVER before it is stored. The
  browser could do this with a canvas, but then the guarantee would only hold
  for the browser: the JS and Python clients (and anything hitting the REST API
  directly) would be free to store whatever passed a type-and-size check. Doing
  it here means the stored bytes are canonical no matter who uploaded them, EXIF
  orientation is applied rather than carried, and camera metadata (which
  includes GPS coordinates on phone photos) is dropped rather than served back
  out to every other user in the deployment.

  Output format tracks the source: PNG when the source has an alpha channel so
  transparency survives, JPEG otherwise, which is what keeps a 512x512 photo at
  tens of kilobytes instead of half a megabyte."
  (:require [plaid.media.storage :as storage]
            [plaid.server.config :refer [config]]
            [taoensso.timbre :as log])
  (:import [java.awt.image BufferedImage]
           [java.io ByteArrayOutputStream File]
           [java.security MessageDigest]
           [javax.imageio ImageIO]
           [net.coobird.thumbnailator Thumbnails]
           [net.coobird.thumbnailator.geometry Positions]))

(def default-size-px 512)
(def default-max-upload-mb 5)

(def accepted-content-types
  "What a client may upload. Narrower than \"anything ImageIO can decode\":
  these four cover every realistic source (phone photo, screenshot, saved web
  image) and each has a reader we know is registered: the first three from the
  JDK, WebP from the TwelveMonkeys plugin on the classpath."
  #{"image/png" "image/jpeg" "image/webp" "image/gif"})

(defn size-px
  "Edge length of the stored square, from config."
  []
  (or (-> config :plaid.media/config :avatar-size-px) default-size-px))

(defn max-upload-bytes
  "Largest upload accepted, in bytes, from config. This bounds the file that
  arrives, not the file that is stored. Normalization shrinks nearly every real
  upload well below it."
  []
  (* (or (-> config :plaid.media/config :avatar-max-upload-mb) default-max-upload-mb)
     1024 1024))

(defn- sha256-hex
  "Hex SHA-256 of `ba`. This is the avatar's cache key: it goes on the user row,
  rides in the image URL as `?v=`, and doubles as the ETag, so a picture can be
  cached indefinitely yet update the instant it changes."
  [^bytes ba]
  (let [digest (.digest (MessageDigest/getInstance "SHA-256") ba)]
    (apply str (map #(format "%02x" %) digest))))

(defn- probe
  "Decode `file` far enough to confirm a registered ImageIO reader can handle it
  and to learn whether it carries an alpha channel. Returns `{:alpha?}`, or nil
  when nothing can decode it (Tika sniffs the container, which does not prove a
  reader exists or that the bytes past the header are intact)."
  [^File file]
  (try
    (when-let [^BufferedImage img (ImageIO/read file)]
      {:alpha? (.hasAlpha (.getColorModel img))})
    (catch Exception e
      (log/debug e "Avatar upload could not be decoded by ImageIO")
      nil)))

(defn- render
  "Center-crop to a square, scale to `edge`, and encode. Reads from the File
  (not a BufferedImage) so Thumbnailator applies EXIF orientation, which is what
  stores a portrait phone photo upright rather than on its side."
  ^bytes [^File file edge alpha?]
  (let [out (ByteArrayOutputStream.)
        builder (-> (Thumbnails/of (into-array File [file]))
                    (.size (int edge) (int edge))
                    (.crop Positions/CENTER))]
    (if alpha?
      (.outputFormat builder "png")
      (doto builder
        (.outputFormat "jpg")
        ;; 0.85 is the usual visual break-even for photographs: artifacts are
        ;; not visible at avatar sizes and the file is a fraction of PNG's.
        (.outputQuality (double 0.85))))
    (.toOutputStream builder out)
    (.toByteArray out)))

(defn normalize
  "Turn an uploaded temp file into the canonical avatar to store.

  Returns `{:success true :bytes <byte-array> :content-type <mime> :hash <hex>}`,
  or `{:success false :error <msg> :code <http-status>}`."
  [^File temp-file]
  (try
    (let [detected (storage/detect-content-type temp-file)]
      (cond
        (> (.length temp-file) (max-upload-bytes))
        {:success false
         :code 413
         :error (str "Image is larger than the " (quot (max-upload-bytes) (* 1024 1024))
                     "MB upload limit")}

        (not (contains? accepted-content-types detected))
        {:success false
         :code 415
         :error (str "Unsupported image type"
                     (when detected (str " (" detected ")"))
                     ". Accepted: PNG, JPEG, WebP, GIF.")}

        :else
        (if-let [{:keys [alpha?]} (probe temp-file)]
          (let [bytes (render temp-file (size-px) alpha?)]
            {:success true
             :bytes bytes
             :content-type (if alpha? "image/png" "image/jpeg")
             :hash (sha256-hex bytes)})
          {:success false
           :code 400
           :error "Image could not be decoded. The file may be truncated or corrupt."})))
    (catch Exception e
      (log/error e "Failed to normalize avatar upload")
      {:success false :code 400 :error (str "Could not process image: " (.getMessage e))})))
