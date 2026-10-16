(ns plaid.media.duration
  "A recording's length in seconds, read from its header when it is stored,
  so every client reads one number rather than each fetching the file.

  Formats: WAV (the `fmt ` byte rate over the `data` chunk), MP4, M4A and
  MOV (the `mvhd` box, the box chain walked so a `moov` after a large `mdat`
  costs a few small reads), FLAC (`STREAMINFO`) and MP3 (a Xing, Info or
  VBRI frame count, else the first frame's bit rate over the file's size).
  Anything else (WebM, Ogg, AVI, ...) is of unknown length: nil, and nothing
  is stored. Only headers are read, never the samples.

  The length lives in `document_media`, one row a document whose length was
  read, outside the audit log as the file is (see its migration). The upload
  and delete operations write it in their transactions, a copy takes it
  along, and a read names it only beside the `media-url` of a file that is
  there."
  (:require [clojure.string :as str]
            [plaid.sql.common :as psc]
            [taoensso.timbre :as log])
  (:import [java.io File RandomAccessFile]))

(def ^:private head-bytes
  "The most bytes read from the start of a file at once."
  (* 64 1024))

(defn- u8 ^long [^bytes b i] (bit-and (long (aget b (int i))) 0xFF))

(defn- le32 ^long [b i]
  (bit-or (u8 b i) (bit-shift-left (u8 b (+ i 1)) 8)
          (bit-shift-left (u8 b (+ i 2)) 16) (bit-shift-left (u8 b (+ i 3)) 24)))

(defn- be32 ^long [b i]
  (bit-or (bit-shift-left (u8 b i) 24) (bit-shift-left (u8 b (+ i 1)) 16)
          (bit-shift-left (u8 b (+ i 2)) 8) (u8 b (+ i 3))))

(defn- be64 ^long [b i]
  (bit-or (bit-shift-left (be32 b i) 32) (be32 b (+ i 4))))

(defn- tag [^bytes b i]
  (when (<= (+ i 4) (alength b))
    (String. b (int i) 4 "ISO-8859-1")))

(defn- wav [^bytes head read size]
  (when (and (= "RIFF" (tag head 0)) (= "WAVE" (tag head 8)))
    (loop [at 12 byte-rate nil]
      (when (<= (+ at 8) size)
        (let [chunk (read at (+ at 8))
              id (tag chunk 0)
              n (le32 chunk 4)
              next-at (+ at 8 n (bit-and n 1))]
          (case id
            "fmt " (recur next-at (le32 (read (+ at 8) (+ at 24)) 8))
            ;; A streamed WAV may say 0xFFFFFFFF: the file's end bounds it.
            "data" (when (and byte-rate (pos? byte-rate))
                     (/ (double (min n (- size at 8))) byte-rate))
            (recur next-at byte-rate)))))))

(def ^:private mp4-first-boxes #{"ftyp" "moov" "mdat" "free" "wide" "skip"})

(defn- find-box
  "`[body-start box-end]` of the first box named `wanted` between `start`
  and `end`, or nil."
  [read start end wanted]
  (loop [at start]
    (when (<= (+ at 8) end)
      (let [box (read at (+ at 16))
            n (be32 box 0)
            [n body] (case n
                       1 [(be64 box 8) (+ at 16)]
                       0 [(- end at) (+ at 8)]
                       [n (+ at 8)])]
        (when (>= n 8)
          (if (= wanted (tag box 4))
            [body (+ at n)]
            (recur (+ at n))))))))

(defn- mp4 [^bytes head read size]
  (when (contains? mp4-first-boxes (tag head 4))
    (when-let [[moov-body moov-end] (find-box read 0 size "moov")]
      (when-let [[mvhd _] (find-box read moov-body moov-end "mvhd")]
        (let [box (read mvhd (+ mvhd 32))
              [scale length] (if (= 1 (u8 box 0))
                               [(be32 box 20) (be64 box 24)]
                               [(be32 box 12) (be32 box 16)])]
          (when (and (pos? scale) (pos? length) (not= length 0xFFFFFFFF))
            (/ (double length) scale)))))))

(defn- flac [^bytes head _read _size]
  (when (and (= "fLaC" (tag head 0)) (zero? (bit-and (u8 head 4) 0x7F)))
    (let [i 8
          rate (bit-or (bit-shift-left (u8 head (+ i 10)) 12)
                       (bit-shift-left (u8 head (+ i 11)) 4)
                       (bit-shift-right (u8 head (+ i 12)) 4))
          samples (bit-or (bit-shift-left (bit-and (u8 head (+ i 13)) 0x0F) 32)
                          (be32 head (+ i 14)))]
      (when (and (pos? rate) (pos? samples))
        (/ (double samples) rate)))))

(def ^:private mp3-rates
  "Sample rates by MPEG version bits, then index."
  {3 [44100 48000 32000] 2 [22050 24000 16000] 0 [11025 12000 8000]})

(def ^:private mp3-kbps
  "Bit rates by [MPEG-1? layer bits], then index."
  {[true 1] [0 32 40 48 56 64 80 96 112 128 160 192 224 256 320]
   [true 2] [0 32 48 56 64 80 96 112 128 160 192 224 256 320 384]
   [true 3] [0 32 64 96 128 160 192 224 256 288 320 352 384 416 448]
   [false 1] [0 8 16 24 32 40 48 56 64 80 96 112 128 144 160]
   [false 2] [0 8 16 24 32 40 48 56 64 80 96 112 128 144 160]
   [false 3] [0 32 48 56 64 80 96 112 128 144 160 176 192 224 256]})

(defn- mp3 [^bytes head read size]
  (let [at (if (= "ID3" (some-> (tag head 0) (subs 0 3)))
             (cond-> (+ 10 (bit-or (bit-shift-left (bit-and (u8 head 6) 0x7F) 21)
                                   (bit-shift-left (bit-and (u8 head 7) 0x7F) 14)
                                   (bit-shift-left (bit-and (u8 head 8) 0x7F) 7)
                                   (bit-and (u8 head 9) 0x7F)))
               (pos? (bit-and (u8 head 5) 0x10)) (+ 10))
             0)
        ^bytes frame (read at (+ at 256))
        ;; The first frame sync within a little way of where it should be.
        skip (first (filter #(and (= 0xFF (u8 frame %))
                                  (= 0xE0 (bit-and (u8 frame (inc %)) 0xE0)))
                            (range 0 (min (- (alength frame) 4) 64))))]
    (when skip
      (let [at (+ at skip)
            ^bytes frame (java.util.Arrays/copyOfRange frame (int skip) (alength frame))
            b1 (u8 frame 1) b2 (u8 frame 2) b3 (u8 frame 3)
            version (bit-and (bit-shift-right b1 3) 3)
            layer (bit-and (bit-shift-right b1 1) 3)]
        (when-not (or (= version 1) (zero? layer))
          (let [mpeg1? (= version 3)
                kbps (if (< (bit-shift-right b2 4) 15)
                       (nth (mp3-kbps [mpeg1? layer]) (bit-shift-right b2 4))
                       0)
                rate-i (bit-and (bit-shift-right b2 2) 3)
                rate (if (< rate-i 3) (nth (mp3-rates version) rate-i) 0)]
            (when (pos? rate)
              (let [per-frame (cond (= layer 3) 384 (or mpeg1? (= layer 2)) 1152 :else 576)
                    mono? (= 3 (bit-shift-right b3 6))
                    side (if mpeg1? (if mono? 17 32) (if mono? 9 17))
                    from-tag (some (fn [off]
                                     (case (tag frame off)
                                       ("Xing" "Info") (when (pos? (bit-and (u8 frame (+ off 7)) 1))
                                                         (/ (* (be32 frame (+ off 8)) per-frame) (double rate)))
                                       "VBRI" (/ (* (be32 frame (+ off 14)) per-frame) (double rate))
                                       nil))
                                   [(+ 4 side) 36])]
                (or from-tag
                    ;; With no Xing, Info or VBRI header the length is the
                    ;; size over the bit rate, and only when the next frame's
                    ;; header follows where this frame ends: two bytes FF Ex
                    ;; alone are as likely noise as a frame (REV-UI).
                    (when (pos? kbps)
                      (let [bits (* kbps 1000)
                            pad (bit-and (bit-shift-right b2 1) 1)
                            length (cond
                                     (= layer 3) (* 4 (+ (quot (* 12 bits) rate) pad))
                                     (and (= layer 1) (not mpeg1?)) (+ (quot (* 72 bits) rate) pad)
                                     :else (+ (quot (* 144 bits) rate) pad))
                            ^bytes next (read (+ at length) (+ at length 4))]
                        (when (and (= 4 (alength next))
                                   (= 0xFF (u8 next 0))
                                   (= (bit-and b1 0xFE) (bit-and (u8 next 1) 0xFE))
                                   (= (bit-and b2 0x0C) (bit-and (u8 next 2) 0x0C))
                                   (< 0 (bit-shift-right (u8 next 2) 4) 15))
                          (/ (* (- size at) 8.0) bits)))))))))))))

(def ^:private readers-by-extension
  "Which header each stored extension is read as. An MP3 has no magic number
  of its own (any two bytes FF Ex pass for a frame sync), so it is read only
  when the file is stored as one."
  {"wav" wav
   "mp4" mp4 "m4a" mp4 "mov" mp4 "x-m4a" mp4 "x-m4v" mp4 "3gpp" mp4 "3gpp2" mp4
   "flac" flac
   "mp3" mp3 "mpeg" mp3})

(defn reads-extension?
  "Whether a recording stored under `extension` has a header reader here, so
  that a nil from `seconds` means the file did not say, not that its format is
  never read."
  [extension]
  (contains? readers-by-extension (some-> extension str/lower-case)))

(defn seconds
  "The length in seconds of the recording in `file`, stored under
  `extension` (as `plaid.media.storage` names it), or nil when the format is
  not one read here or its header does not say. Never throws."
  [^File file extension]
  (when-let [reader (readers-by-extension (some-> extension str/lower-case))]
    (try
      (with-open [raf (RandomAccessFile. file "r")]
        (let [size (.length raf)
              read (fn [start end]
                     (let [start (max 0 (long start))
                           end (min (long end) size)]
                       (if (<= end start)
                         (byte-array 0)
                         (let [b (byte-array (- end start))]
                           (.seek raf start)
                           (.readFully raf b)
                           b))))]
          (when (>= size 12)
            (let [got (reader (read 0 head-bytes) read size)]
              (when (and got (pos? got) (Double/isFinite got))
                got)))))
      (catch IndexOutOfBoundsException _ nil)
      (catch Exception e
        (log/warn "Could not read a recording's length:" (.getMessage e))
        nil))))

;; ------------------------------------------------------------------
;; Stored
;; ------------------------------------------------------------------

(defn stored
  "The stored length of `doc-id`'s recording in seconds, or nil."
  [db doc-id]
  (:duration (psc/q1 db {:select [:duration]
                         :from :document_media
                         :where [:= :document_id doc-id]})))

(defn store!
  "Keep `secs` as the length of `doc-id`'s recording, or forget any length
  when `secs` is nil (a format not read here). Inside the write's
  transaction."
  [tx doc-id secs]
  (if secs
    (psc/execute! tx {:insert-into :document_media
                      :values [{:document_id doc-id :duration (double secs)}]
                      :on-conflict :document_id
                      :do-update-set [:duration]})
    (psc/execute! tx {:delete-from :document_media :where [:= :document_id doc-id]})))

(defn copy!
  "Give `dst-id` the stored length of `src-id`'s recording, if it has one."
  [tx src-id dst-id]
  (store! tx dst-id (stored tx src-id)))
