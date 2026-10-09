(ns plaid.util.canonical
  "Canonical equivalence (Unicode NFC). Core stores all text composed (NFC):
  `compose` composes a text body and says where each position in it goes, so
  token offsets move with it, and `compose-data` composes every string of a
  request. For the query language, text that is canonically equivalent, such
  as `pʰá` typed composed and decomposed (a + U+0301), is the same text to a
  search, an equality as much as a regular expression."
  (:import [java.text Normalizer Normalizer$Form]
           [java.util BitSet]))

(defn nfc
  "`s` in Unicode NFC, without a copy when it already is."
  ^String [^String s]
  (if (Normalizer/isNormalized s Normalizer$Form/NFC)
    s
    (Normalizer/normalize s Normalizer$Form/NFC)))

(def ^:private ^BitSet not-alone
  "Code points that let a text have another, canonically equivalent spelling:
  every code point after the first in a canonical decomposition (a combining
  mark, a Hangul vowel or final, a vowel sign that composes), and the one a
  singleton decomposes to (KELVIN SIGN to K, a CJK compatibility ideograph to
  its unified one). Built once, on first use."
  (delay
    (let [bits (BitSet. 0x110000)]
      (doseq [cp (range 0x110000)
              :when (and (Character/isDefined (int cp))
                         (not (<= 0xD800 cp 0xDFFF)))
              :let [s (String. (Character/toChars cp))]
              :when (not (Normalizer/isNormalized s Normalizer$Form/NFD))
              :let [d (.toArray (.codePoints (Normalizer/normalize s Normalizer$Form/NFD)))]]
        (if (= 1 (alength d))
          (.set bits (aget d 0))
          (doseq [i (range 1 (alength d))] (.set bits (aget d i)))))
      bits)))

(def ^:private ^BitSet reorders
  "Code points of a nonzero canonical combining class: two of them side by
  side can be written in either order when their classes differ (Arabic
  shadda and a vowel, a Thai vowel below and a tone mark), and the spellings
  are canonically equivalent. Java has no getter for the class, so it is read
  from what NFD does: a class above 1 moves after U+0334 (class 1), a class
  of 1 moves before U+05B0 (class 10). Built once, on first use."
  (delay
    (let [bits (BitSet. 0x110000)
          moves? (fn [^String t] (not (Normalizer/isNormalized t Normalizer$Form/NFD)))]
      (doseq [cp (range 0x110000)
              :when (and (Character/isDefined (int cp))
                         (not (<= 0xD800 cp 0xDFFF)))
              :let [s (String. (Character/toChars cp))]
              :when (and (Normalizer/isNormalized s Normalizer$Form/NFD)
                         (or (moves? (str s "̴")) (moves? (str "ְ" s))))]
        (.set bits (int cp)))
      bits)))

(defn- marks-reorder?
  "Whether `s` holds two code points of a nonzero combining class side by
  side, whose order another spelling may swap."
  [^String s]
  (let [^BitSet bits @reorders
        cps (.toArray (.codePoints s))]
    (loop [i 1]
      (cond
        (>= i (alength cps)) false
        (and (.get bits (aget cps i)) (.get bits (aget cps (dec i)))) true
        :else (recur (inc i))))))

(defn only-spelling?
  "Whether `s` is the only spelling of its text: no other string is
  canonically equivalent to it, so an equality with it can compare the stored
  text exactly (and use an index). False when `s` is not NFD, when it holds a
  code point that some decomposition makes, and when two of its marks could
  stand in the other order (Arabic shadda and fatha, typed in either order).
  True of almost every ASCII text and of most text in scripts without
  combining marks."
  [^String s]
  (and (Normalizer/isNormalized s Normalizer$Form/NFD)
       (let [^BitSet bits @not-alone]
         (not (.anyMatch (.codePoints s) (reify java.util.function.IntPredicate
                                           (test [_ cp] (.get bits cp))))))
       (not (marks-reorder? s))))

;; ============================================================
;; Composing a body, with its offsets
;; ============================================================

(defn- mark?
  "Whether code point `cp` is a mark (general category Mn, Mc or Me)."
  [cp]
  (let [t (Character/getType (int cp))]
    (or (== t Character/NON_SPACING_MARK)
        (== t Character/COMBINING_SPACING_MARK)
        (== t Character/ENCLOSING_MARK))))

(defn- cps->str ^String [^ints cps ^long from ^long to]
  (String. cps (int from) (int (- to from))))

(defn- pieces
  "`[start end]` code-point ranges cutting `cps` where composing changes
  nothing across the cut: before each code point that is not a mark, except
  that a piece is joined to the one before it when composing the two together
  is not composing each (Hangul jamo, a vowel sign that composes with what
  precedes it). A code point below U+0300 never composes with what precedes
  it, so a piece starting with one is never joined."
  [^ints cps]
  (let [n (alength cps)
        out (java.util.ArrayList.)]
    (loop [i 0 start 0]
      (if (> i n)
        out
        (if (or (== i n) (and (> i start) (not (mark? (aget cps i)))))
          (do (when (< start i)
                (let [k (.size out)
                      ^longs last (when (pos? k) (.get out (dec k)))]
                  (if (and last
                           (>= (aget cps start) 0x300)
                           (let [a (cps->str cps (aget last 0) (aget last 1))
                                 b (cps->str cps start i)]
                             (not= (nfc (str a b)) (str (nfc a) (nfc b)))))
                    (aset last 1 (long i))
                    (.add out (long-array [start i])))))
              (recur (inc i) i))
          (recur (inc i) start))))))

(def ^:private refine-limit
  "The longest piece whose inside positions are each placed where cutting
  there leaves the composed text as it is. A longer one (a long run of marks)
  sends them all to its end, so composing stays linear."
  32)

(defn- refine-inside!
  "Fill `at` for the positions strictly inside the piece `[start, end)`,
  which composed to `c` (`c-len` code points) at `out`. A position where the
  piece can be cut, its two halves composing apart to `c` (between `ẹ` and a
  tone mark that does not compose with it), goes to the end of its composed
  first half, so the mark stays out of the token before it. Any other goes to
  the next such cut, else to the piece's end."
  [^ints at ^ints cps start end out ^String c c-len]
  (let [whole? (> (- end start) refine-limit)]
    (loop [i (dec end) nxt (+ out c-len)]
      (when (> i start)
        (let [nxt (if whole?
                    nxt
                    (let [pre (nfc (cps->str cps start i))]
                      (if (= c (str pre (nfc (cps->str cps i end))))
                        (min nxt (+ out (.codePointCount pre 0 (.length pre))))
                        nxt)))]
          (aset at (int i) (int nxt))
          (recur (dec i) nxt))))))

(defn compose
  "`s` composed (NFC), and where each code-point position of `s` goes in it.

  Returns `{:text composed :at f}`: `(f p)` is the position in `composed` of
  position `p` of `s`, for every p in [0, code-point length of s]. `s` is cut
  into pieces where composing changes nothing across the cut (see `pieces`),
  and each piece composes on its own. A position at a piece's start goes to
  its composed start. A position inside a piece composing changed goes to
  where cutting the piece there composes the same (see `refine-inside!`),
  else to the next such place, at the latest the piece's composed END, so an
  edge between a letter and the mark that composes with it moves to after
  the composed character, which stays with the token that held its letter,
  and a mark that does not compose stays out of it. Inside a piece composing
  left alone a position keeps its place. `f` never reverses two positions,
  so tokens that did not overlap still do not, a partition still tiles and a
  child stays inside its parent.

  `cuts` are the code-point positions of `s` where a token begins or ends
  (Luke, 2026-10-09). A piece with a cut inside it is composed in parts, one
  between each two cuts, so a character whose letter and mark belong to two
  tokens stays decomposed there: each token keeps its own characters, every
  cut goes to the end of its composed part, and composing never leaves a
  token zero-width. The text is then canonically equivalent to `s`, and NFC
  everywhere but at those characters. Composing it again with the cuts moved
  by `f` changes nothing.

  A string already composed comes back as itself with the identity map."
  ([s] (compose s nil))
  ([^String s cuts]
   (if (Normalizer/isNormalized s Normalizer$Form/NFC)
     {:text s :at identity}
     (let [cps (.toArray (.codePoints s))
           n (alength cps)
           ^BitSet cut-at (let [b (BitSet. (inc n))]
                            (doseq [c cuts :when (and (int? c) (< 0 c n))] (.set b (int c)))
                            b)
           at (int-array (inc n))
           sb (StringBuilder.)
           ;; a piece with a cut strictly inside it composes in parts
           parts (fn [^longs p]
                   (let [start (aget p 0) end (aget p 1)
                         inner (loop [i (.nextSetBit cut-at (int (inc start))) acc []]
                                 (if (and (>= i 0) (< i end))
                                   (recur (.nextSetBit cut-at (int (inc i))) (conj acc i))
                                   acc))]
                     (if (empty? inner)
                       [p]
                       (mapv (fn [[a b]] (long-array [a b]))
                             (partition 2 1 (concat [start] inner [end]))))))]
       (loop [ps (seq (mapcat parts (pieces cps))) out 0]
         (if-let [^longs p (first ps)]
           (let [start (aget p 0)
                 end (aget p 1)
                 src (cps->str cps start end)
                 c (nfc src)
                 c-len (.codePointCount c 0 (.length c))]
             (.append sb c)
             (if (identical? c src)
               (doseq [i (range start end)] (aset at (int i) (int (+ out (- i start)))))
               (do (aset at (int start) (int out))
                   (refine-inside! at cps start end out c c-len)))
             (recur (next ps) (+ out c-len)))
           (aset at n (int out))))
       (let [text (.toString sb)]
         ;; The pieces compose apart exactly as the whole does (with cuts,
         ;; to a text canonically equivalent to it). Should that ever not
         ;; hold, nothing is stored on a guess.
         (when-not (if (.isEmpty cut-at) (= text (nfc s)) (= (nfc text) (nfc s)))
           (throw (ex-info "The text could not be composed." {:code 500})))
         {:text text :at (fn [p] (long (aget at (int p))))})))))

(defn nfc-but
  "`s` composed (NFC), except each stretch of it spelled as a stretch `kept`
  holds decomposed: a character a stored body keeps decomposed because a
  token edge falls inside it (see `compose`). A whole body sent back with
  that character as it was read is then no change there. Composed as a
  whole when `kept` is itself composed."
  ^String [^String s ^String kept]
  (if (or (nil? kept) (Normalizer/isNormalized kept Normalizer$Form/NFC))
    (nfc s)
    (let [k (.toArray (.codePoints kept))
          held (into #{}
                     (keep (fn [^longs p]
                             (let [src (cps->str k (aget p 0) (aget p 1))]
                               (when-not (= src (nfc src)) src))))
                     (pieces k))
          cps (.toArray (.codePoints s))
          sb (StringBuilder.)]
      (doseq [^longs p (pieces cps)]
        (let [src (cps->str cps (aget p 0) (aget p 1))]
          (.append sb (if (held src) src (nfc src)))))
      (.toString sb))))

;; ============================================================
;; Composing a request's strings
;; ============================================================

(defn compose-data
  "`v` with every string in it composed, map keys too (a keyword key keeps
  its keyword shape), except the values of map keys for which
  `(raw-key? k)` is true. A key that composes to a key the map already has
  is dropped, and the composed one keeps its value. Shares every part that
  is already composed."
  [v raw-key?]
  (letfn [(walk [x]
            (cond
              (string? x) (nfc x)
              (map? x) (reduce-kv
                        (fn [m k vv]
                          (let [k' (cond
                                     (string? k) (nfc k)
                                     (keyword? k) (let [nm (name k) nm' (nfc nm)]
                                                    (if (identical? nm nm') k (keyword (namespace k) nm')))
                                     :else k)
                                vv' (if (raw-key? k) vv (walk vv))]
                            (cond
                              (and (identical? k k') (identical? vv vv')) m
                              ;; a key that composes to a key the map already
                              ;; has gives way to it
                              (and (not (identical? k k')) (contains? x k')) (dissoc m k)
                              :else (assoc (if (identical? k k') m (dissoc m k)) k' vv'))))
                        x x)
              (vector? x) (let [x' (mapv walk x)]
                            (if (every? true? (map identical? x x')) x x'))
              (sequential? x) (map walk x)
              :else x))]
    (walk v)))
