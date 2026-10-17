(ns plaid.util.canonical
  "Canonical equivalence (Unicode NFC). Core stores all text composed (NFC):
  `compose` composes a text body and says where each position in it goes, so
  token offsets move with it, and `compose-data` composes every string of a
  request. For the query language, text that is canonically equivalent, such
  as `pʰá` typed composed and decomposed (a + U+0301), is the same text to a
  search, an equality as much as a regular expression."
  (:require [clojure.string])
  (:import [java.text Normalizer Normalizer$Form]
           [java.util BitSet]))

(defn nfc
  "`s` in Unicode NFC, without a copy when it already is."
  ^String [^String s]
  (if (Normalizer/isNormalized s Normalizer$Form/NFC)
    s
    (Normalizer/normalize s Normalizer$Form/NFC)))

(defn nfd
  "`s` in Unicode NFD, without a copy when it already is."
  ^String [^String s]
  (if (Normalizer/isNormalized s Normalizer$Form/NFD)
    s
    (Normalizer/normalize s Normalizer$Form/NFD)))

(declare mark?)

(defn holds-mark?
  "Whether `s` holds a combining mark (general category Mn, Mc or Me)."
  [^String s]
  (.anyMatch (.codePoints s) (reify java.util.function.IntPredicate
                               (test [_ cp] (boolean (mark? cp))))))

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

;; ============================================================
;; A pattern that names a combining mark
;; ============================================================

(def ^:private mark-properties
  #{"m" "mn" "mc" "me" "mark" "combiningmark" "nonspacingmark" "spacingmark" "enclosingmark"})

(defn- mark-property?
  "Whether `\\p{name}` names the combining marks: a mark category, or a block
  of combining marks, however Java lets it be spelled."
  [^String name]
  (let [n (-> name (.toLowerCase java.util.Locale/ROOT) (.replace "_" "") (.replace " " "") (.replace "-" ""))
        n (or (some (fn [^String p] (when (.startsWith n p) (subs n (count p))))
                    ["generalcategory=" "gc=" "block=" "blk="])
              n)
        n (if (.startsWith ^String n "is") (subs n 2) n)
        n (if (.startsWith ^String n "in") (subs n 2) n)]
    (or (contains? mark-properties n) (.startsWith ^String n "combining"))))

(defn- index-of
  "The index in `cps` of the code points of `s`, from `from`, or -1."
  ^long [^ints cps ^String s ^long from]
  (let [want (.toArray (.codePoints s))
        k (alength want)
        n (alength cps)]
    (loop [i from]
      (cond
        (> (+ i k) n) -1
        (every? #(== (aget cps (+ i (long %))) (aget want %)) (range k)) i
        :else (recur (inc i))))))

(defn- at
  "The code point at `i`, or -1 past the end."
  ^long [^ints cps ^long i]
  (if (< -1 i (alength cps)) (aget cps i) -1))

(defn- hex-escape
  "At `i` a backslash then x or u: `[code-point next-index]`, or nil."
  [^ints cps ^long i]
  (let [kind (at cps (inc i))
        [from to end] (if (and (== kind (int \x)) (== (at cps (+ i 2)) (int \{)))
                        (let [j (index-of cps "}" (+ i 3))]
                          (if (pos? j) [(+ i 3) j (inc j)] [0 0 0]))
                        (let [w (if (== kind (int \x)) 2 4)]
                          (when (<= (+ i 2 w) (alength cps))
                            [(+ i 2) (+ i 2 w) (+ i 2 w)])))]
    (when (and from (< from to)
               (every? #(let [d (aget cps (long %))]
                          (or (<= (int \0) d (int \9)) (<= (int \a) d (int \f)) (<= (int \A) d (int \F))))
                       (range from to)))
      (let [v (BigInteger. (String. cps (int from) (int (- to from))) 16)]
        (when (<= (.compareTo v (BigInteger/valueOf 0x10FFFF)) 0)
          [(.intValue v) end])))))

(defn- name-escape
  "At `i` a backslash then `N{name}`: `[code-point next-index]` for a name
  Java knows, or nil."
  [^ints cps ^long i]
  (when (== (at cps (+ i 2)) (int \{))
    (let [j (index-of cps "}" (+ i 3))]
      (when (pos? j)
        (try [(Character/codePointOf (String. cps (int (+ i 3)) (int (- j (+ i 3))))) (inc j)]
             (catch IllegalArgumentException _ nil))))))

(defn- ascii-alnum? [^long cp]
  (or (<= (int \0) cp (int \9)) (<= (int \a) cp (int \z)) (<= (int \A) cp (int \Z))))

(defn names-mark?
  "Whether a Java pattern names a combining mark: it holds one, an escape of
  one (`\\x{301}`, `\\u0301`, `\\N{COMBINING ACUTE ACCENT}`), a class range
  between two, or a mark property (`\\p{M}`, `\\p{Mn}`, `\\pM`) on its own or
  in a class of nothing but mark properties, or a negated class of nothing but
  negated ones (`[^\\P{M}]`). Such a pattern also reaches inside
  composed letters (REV7-CORE-4), as one typed with the mark does. `.`, `\\w`
  or `[\\p{L}\\p{M}]` match a mark too, but name none, so `a.` never finds the
  a inside á. The same scan as plaid-agent's `java_regex.names_mark` and
  plaid-ui's `namesMark`, which the clients ask of the pattern they send."
  [^String src]
  (or (holds-mark? src)
      (let [^ints cps (.toArray (.codePoints src))
            n (alength cps)
            bs (int \\)
            range-dash? (fn [^long i] (and (== (at cps i) (int \-))
                                           (not (#{-1 (int \])} (at cps (inc i))))))]
        ;; classes: a vector of [negated mark-property other not-mark-property]
        ;; per open class
        (loop [i 0, classes [], start nil, dash false]
          (if (>= i n)
            false
            (let [c (aget cps i)]
              (cond
                (== c bs)
                (if (>= (inc i) n)
                  false
                  (let [e (aget cps (inc i))]
                    (cond
                      (== e (int \Q))
                      (let [j (index-of cps "\\E" (+ i 2))]
                        (recur (if (neg? j) n (+ j 2)) (if (seq classes) (assoc-in classes [(dec (count classes)) 2] true) classes) nil false))

                      (or (and (or (== e (int \x)) (== e (int \u))) (hex-escape cps i))
                          (and (== e (int \N)) (name-escape cps i)))
                      (let [[cp nxt] (or (and (or (== e (int \x)) (== e (int \u))) (hex-escape cps i))
                                         (name-escape cps i))]
                        (if (empty? classes)
                          (if (mark? cp) true (recur (long nxt) classes nil false))
                          (let [classes (assoc-in classes [(dec (count classes)) 2] true)]
                            (cond
                              dash (if (and (mark? start) (mark? cp)) true (recur (long nxt) classes nil false))
                              (range-dash? nxt) (recur (long nxt) classes cp false)
                              (mark? cp) true
                              :else (recur (long nxt) classes nil false)))))

                      (or (== e (int \p)) (== e (int \P)))
                      (let [[name nxt] (if (== (at cps (+ i 2)) (int \{))
                                         (let [j (index-of cps "}" (+ i 3))]
                                           (if (pos? j)
                                             [(String. cps (int (+ i 3)) (int (- j (+ i 3)))) (inc j)]
                                             ["" n]))
                                         [(if (< (+ i 2) n) (String. cps (int (+ i 2)) 1) "") (+ i 3)])
                            negated (== e (int \P))]
                        (cond
                          (not (mark-property? name))
                          (recur (long nxt) (if (seq classes) (assoc-in classes [(dec (count classes)) 2] true) classes) nil false)
                          (empty? classes) (if negated (recur (long nxt) classes nil false) true)
                          :else (recur (long nxt) (assoc-in classes [(dec (count classes)) (if negated 3 1)] true) nil false)))

                      :else
                      (let [cp (when-not (ascii-alnum? e) e)]
                        (if (empty? classes)
                          (recur (+ i 2) classes nil false)
                          (let [classes (assoc-in classes [(dec (count classes)) 2] true)]
                            (cond
                              (nil? cp) (recur (+ i 2) classes nil false)
                              dash (if (and (mark? start) (mark? cp)) true (recur (+ i 2) classes nil false))
                              (range-dash? (+ i 2)) (recur (+ i 2) classes cp false)
                              (mark? cp) true
                              :else (recur (+ i 2) classes nil false))))))))

                (== c (int \[))
                (let [neg? (== (at cps (inc i)) (int \^))]
                  (recur (if neg? (+ i 2) (inc i)) (conj classes [neg? false false false]) nil false))

                (and (== c (int \])) (seq classes))
                (let [[negated marks other not-marks] (peek classes)
                      classes (pop classes)]
                  (if (and (not other)
                           (if negated
                             (and not-marks (not marks))
                             (and marks (not not-marks))))
                    true
                    (recur (inc i) (if (seq classes) (assoc-in classes [(dec (count classes)) 2] true) classes) nil false)))

                (and (== c (int \-)) (seq classes) start (not dash) (range-dash? i))
                (recur (inc i) classes start true)

                (empty? classes)
                (recur (inc i) classes nil false)

                :else
                (let [classes (assoc-in classes [(dec (count classes)) 2] true)]
                  (cond
                    dash (if (and (mark? start) (mark? c)) true (recur (inc i) classes nil false))
                    (range-dash? (inc i)) (recur (inc i) classes c false)
                    (mark? c) true
                    :else (recur (inc i) classes nil false))))))))))

;; ============================================================
;; A pattern decomposed
;; ============================================================

(defn- quantifier-at?
  "Whether a quantifier starts at `i`: `*`, `+`, `?`, or `{` and a digit."
  [^ints cps ^long i]
  (let [c (at cps i)]
    (or (== c (int \*)) (== c (int \+)) (== c (int \?))
        (and (== c (int \{)) (<= (int \0) (at cps (inc i)) (int \9))))))

(defn- cp-str ^String [^long cp] (String. (Character/toChars (int cp))))

(defn- decomposes? [^long cp] (let [s (cp-str cp)] (not= s (nfd s))))

(defn- escape-end
  "The index after the escape at `i` (a backslash): through the braces of
  `\\x{..}`, `\\p{..}`, `\\P{..}` and `\\N{..}`, the digits of `\\xhh` and
  `\\uhhhh`, else the one character after the backslash."
  ^long [^ints cps ^long i]
  (let [n (alength cps)
        e (at cps (inc i))]
    (cond
      (and (or (== e (int \x)) (== e (int \u))) (hex-escape cps i)) (second (hex-escape cps i))
      (and (or (== e (int \p)) (== e (int \P)) (== e (int \N)) (== e (int \x))) (== (at cps (+ i 2)) (int \{)))
      (let [j (index-of cps "}" (+ i 3))] (if (neg? j) n (inc j)))
      :else (min n (+ i 2)))))

(defn- class-start
  "The index of the first member of the class opening at `i`: after the `[`
  and a `^`, and after a `]` there, which Java reads as itself."
  ^long [^ints cps ^long i]
  (let [k (if (== (at cps (inc i)) (int \^)) (+ i 2) (inc i))]
    (if (== (at cps k) (int \])) (inc k) k)))

(defn- class-end
  "The index after the `]` that closes the class opening at `i`, or the
  pattern's length when none does."
  ^long [^ints cps ^long i]
  (let [n (alength cps)]
    (loop [k (class-start cps i), depth 1]
      (cond
        (>= k n) n
        (and (== (aget cps k) (int \\)) (== (at cps (inc k)) (int \Q)))
        (let [j (index-of cps "\\E" (+ k 2))] (if (neg? j) n (recur (+ j 2) depth)))
        (== (aget cps k) (int \\)) (recur (escape-end cps k) depth)
        (== (aget cps k) (int \[)) (recur (class-start cps k) (inc depth))
        (== (aget cps k) (int \])) (if (== depth 1) (inc k) (recur (inc k) (dec depth)))
        :else (recur (inc k) depth)))))

(defn- nfd-class
  "The class at `[i, j)` with every character in it decomposed, escapes and
  the two ends of a range as written."
  ^String [^ints cps ^long i ^long j]
  (let [sb (StringBuilder.)]
    (loop [k i]
      (if (>= k j)
        (.toString sb)
        (let [c (aget cps k)]
          (cond
            (and (== c (int \\)) (== (at cps (inc k)) (int \Q)))
            (let [e (index-of cps "\\E" (+ k 2))
                  end (if (or (neg? e) (>= e j)) j e)]
              (.append sb "\\Q")
              (.append sb (nfd (cps->str cps (+ k 2) end)))
              (if (< end j)
                (do (.append sb "\\E") (recur (+ end 2)))
                (recur j)))
            (== c (int \\))
            (let [e (min j (escape-end cps k))]
              (.append sb (cps->str cps k e))
              (recur e))
            ;; a range: its ends stay as written
            (and (== (at cps (inc k)) (int \-)) (< (+ k 2) j)
                 (not (#{(int \]) (int \[) (int \\)} (aget cps (+ k 2)))))
            (do (.append sb (cps->str cps k (+ k 3))) (recur (+ k 3)))
            (and (== (at cps (inc k)) (int \-)) (< (+ k 2) j) (== (aget cps (+ k 2)) (int \\)))
            (do (.append sb (cps->str cps k (+ k 2))) (recur (+ k 2)))
            :else (do (.append sb (nfd (cp-str c))) (recur (inc k)))))))))

(defn- class-parts
  "The class at `[i, j)` as it matches a value in NFD: as written, but for a
  negated class inside it, which is decomposed. Also the composed letters it
  holds as members of its own (not a range's end, nor in a class with `&&`),
  each decomposed, or nil when there are none, and whether it holds a class
  or `&&`: `[pulled text nested]`."
  [^ints cps ^long i ^long j]
  (let [negated (== (at cps (inc i)) (int \^))
        sb (StringBuilder. (if negated "[^" "["))
        close (if (and (< (inc i) j) (== (aget cps (dec j)) (int \]))) (dec j) j)
        pulled (java.util.ArrayList.)]
    (loop [k (if negated (+ i 2) (inc i)), expect-dash false, after-dash false, no-pull false, nested false]
      (if (>= k close)
        (do (when (< close j) (.append sb "]"))
            [(when-not (or no-pull (.isEmpty pulled)) (vec pulled)) (.toString sb) (or nested no-pull)])
        (let [c (aget cps k)
              member (fn [cp ^long nxt]
                       (let [start? (and (== (at cps nxt) (int \-))
                                         (not (#{-1 (int \])} (at cps (inc nxt)))))]
                         (when (and cp (not start?) (not after-dash) (decomposes? cp))
                           (.add pulled (nfd (cp-str cp))))
                         start?))]
          (cond
            (and (== c (int \\)) (== (at cps (inc k)) (int \Q)))
            (let [e (index-of cps "\\E" (+ k 2))
                  end (if (or (neg? e) (>= e close)) close e)
                  nxt (if (< end close) (+ end 2) close)]
              (doseq [q (range (+ k 2) end)]
                (when (decomposes? (aget cps q)) (.add pulled (nfd (cp-str (aget cps q))))))
              (.append sb (cps->str cps k nxt))
              (recur (long nxt) false false no-pull nested))

            (== c (int \\))
            (let [e (min close (escape-end cps k))
                  x (at cps (inc k))
                  cp (cond
                       (and (or (== x (int \x)) (== x (int \u))) (hex-escape cps k)) (first (hex-escape cps k))
                       (or (== x -1) (ascii-alnum? x)) nil
                       :else x)]
              (.append sb (cps->str cps k e))
              (if cp
                (recur e (member cp e) false no-pull nested)
                (recur e false false no-pull nested)))

            (== c (int \[))
            (let [e (min close (class-end cps k))]
              (.append sb (if (== (at cps (inc k)) (int \^))
                            (nfd-class cps k e)
                            (second (class-parts cps k e))))
              (recur e false false no-pull true))

            (and (== c (int \&)) (== (at cps (inc k)) (int \&)))
            (do (.append sb "&&") (recur (+ k 2) false false true nested))

            (and (== c (int \-)) expect-dash)
            (do (.append sb "-") (recur (inc k) false true no-pull nested))

            :else
            (do (.appendCodePoint sb c)
                (recur (inc k) (member c (inc k)) false no-pull nested))))))))

(defn decompose-pattern
  "The Java pattern `src` as REGEXP matches it against a value in NFD, when
  `names-mark?` says so: decomposed (NFD) outside its character classes, so a
  mark it names finds the mark inside a composed letter. A composed letter
  under a quantifier is decomposed as a group (`é+` is `(?:e\\u0301)+`).
  A class keeps its composed letters (REV8-CORE-1): `[á\\x{301}]` holds á and
  the acute, never a plain a, and is `(?:a\\u0301|[á\\x{301}])`, so it finds
  á whole and the acute inside `ấ`, but not the a of `ma`. A negated class
  is preceded by a lookahead for its composed letters decomposed, so
  `[^á\\x{301}]` is `(?:(?!a\\u0301)[^á\\x{301}])`: it finds the a of `ma`, never
  the a of á. A negated class holding a class or `&&`, and every negated
  class inside a class, is decomposed whole. An escape stays as written. The
  same rewriting as plaid-agent's `java_regex.decompose_pattern` and
  plaid-ui's `decomposePattern`, which the clients apply to the pattern
  typed."
  ^String [^String src]
  (let [^ints cps (.toArray (.codePoints src))
        n (alength cps)
        out (StringBuilder.)
        run (StringBuilder.)
        bs (int \\)
        flush! (fn [] (.append out (nfd (.toString run))) (.setLength run 0))]
    (loop [i 0]
      (if (>= i n)
        (do (flush!) (.toString out))
        (let [c (aget cps i)]
          (cond
            ;; \Q..\E: its text is literal
            (and (== c bs) (== (at cps (inc i)) (int \Q)))
            (let [j (index-of cps "\\E" (+ i 2))
                  end (if (neg? j) n j)
                  nxt (if (neg? j) n (+ j 2))
                  last-cp (when (< (+ i 2) end) (aget cps (dec end)))]
              (flush!)
              (if (and last-cp (quantifier-at? cps nxt) (decomposes? last-cp))
                (.append out (str "\\Q" (nfd (cps->str cps (+ i 2) (dec end))) "\\E(?:\\Q"
                                  (nfd (cp-str last-cp)) "\\E)"))
                (.append out (str "\\Q" (nfd (cps->str cps (+ i 2) end)) (if (neg? j) "" "\\E"))))
              (recur (long nxt)))

            ;; any other escape stays as written
            (== c bs)
            (let [e (escape-end cps i)]
              (flush!)
              (.append out (cps->str cps i e))
              (recur e))

            (== c (int \[))
            (let [e (class-end cps i)
                  [pulled text nested] (class-parts cps i e)
                  alts (when pulled
                         (clojure.string/join "|" (sort-by #(- (.codePointCount ^String % 0 (count %))) (distinct pulled))))]
              (flush!)
              (.append out ^String (cond
                                     (not (== (at cps (inc i)) (int \^))) (if alts (str "(?:" alts "|" text ")") text)
                                     nested (nfd-class cps i e)
                                     alts (str "(?:(?!" alts ")" text ")")
                                     :else text))
              (recur e))

            ;; a composed letter under a quantifier is decomposed as a group
            (and (quantifier-at? cps i) (pos? (.length run)))
            (let [k (.offsetByCodePoints run (.length run) -1)
                  last-s (.substring run k)
                  d (nfd last-s)]
              (when-not (= d last-s)
                (.setLength run k)
                (flush!)
                (.append out (str "(?:" d ")")))
              (.appendCodePoint run c)
              (recur (inc i)))

            :else
            (do (.appendCodePoint run c)
                (recur (inc i)))))))))
