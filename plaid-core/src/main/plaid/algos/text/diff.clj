(ns plaid.algos.text.diff
  "The diff of two bodies of text as code-point edit ops, independent of the
  tokens over them (see `diff`)."
  (:require [editscript.core :as e]
            [plaid.algos.text.chars :refer [cps->str space?]]
            [plaid.algos.text.ops :refer [delete-op insert-op]]))

(defn- editscript-diff
  "Use editscript to get a character-level diff and convert it into the same format used
  by the fast-diff javascript library, which `diff` below is expecting. (We originally used
  this library in glam.)"
  [old new]
  (let [[[_ _ ops]] (e/get-edits (e/diff old new {:algo :a-star
                                                  :str-diff :character
                                                  :str-change-limit 0.9999999
                                                  ;; Editscript gives up after 1,000 ms by
                                                  ;; default and returns the new string
                                                  ;; whole, which would replace the stretch
                                                  ;; on a busy server and not on a quiet
                                                  ;; one. `diff` hands it only stretches
                                                  ;; small enough to finish, so it never
                                                  ;; gives up.
                                                  :vec-timeout Long/MAX_VALUE}))]
    (if (string? ops)
      ;; The two strings share no character: replace the one by the other
      (vector [-1 old]
              [1 new])
      ;; Edit of the existing string
      (loop [head (first ops)
             tail (rest ops)
             ops []
             i 0]
        (cond
          (nil? head)
          ops

          (number? head)
          (recur (first tail)
                 (rest tail)
                 (conj ops [0 (subs old i (+ i head))])
                 (+ i head))

          ;; Replacement
          (= (first head) :r)
          (recur (first tail)
                 (rest tail)
                 (-> ops
                     (conj [-1 (subs old i (+ i (count (second head))))])
                     (conj [1 (second head)]))
                 (+ i (count (second head))))

          ;; Deletion
          (= (first head) :-)
          (recur (first tail)
                 (rest tail)
                 (conj ops [-1 (subs old i (+ i (second head)))])
                 (+ i (second head)))

          ;; Addition
          (= (first head) :+)
          (recur (first tail)
                 (rest tail)
                 (conj ops [1 (second head)])
                 i)

          :else
          (throw (ex-info "Unknown op!" {:op head :code 500})))))))

(defn- surrogate? [cp] (<= 0xD800 (long cp) 0xDFFF))

(defn- codepoint-proxy
  "Build a per-call bijection between the Unicode code points present in `old`
  and `new` and single non-surrogate BMP proxy chars, then return the proxy
  encodings of both strings plus a `decode` fn (proxy substring -> real string).

  Why: `editscript` diffs Java *chars* (UTF-16 code units), so a char-level diff
  of astral text can cut INSIDE a surrogate pair — producing an edit op whose
  boundary falls mid-code-point. Diffing the proxy strings instead (one BMP char
  per code point) makes the diff CODE-POINT granular: op boundaries always land
  on code-point boundaries, so offsets/token shifts are correct and the body
  reconstructs exactly. `middle-diff` hands it at most `hunk-limit` code points,
  so the pool always holds one proxy for each."
  [^String old ^String new]
  (let [ocps (vec (.toArray (.codePoints old)))
        ncps (vec (.toArray (.codePoints new)))
        dcps (vec (distinct (concat ocps ncps)))
        n (count dcps)
        pool (->> (range 1 0x10000) (remove surrogate?) (take n) vec)
        pchars (mapv char pool)
        cp->px (zipmap dcps pchars)
        px->cp (zipmap pchars dcps)
        ->px (fn [cps] (apply str (map cp->px cps)))
        decode (fn [^String s]
                 (apply str (map #(String. (Character/toChars (int (px->cp %)))) s)))]
    {:old* (->px ocps) :new* (->px ncps) :decode decode}))

(declare middle-diff)

;; ---------------------------------------------------------------------------
;; Diff
;;
;; Editscript's character diff finds a shortest edit script, but its search
;; grows with the square of the stretch when the two sides differ throughout,
;; and it used to give up after 1,000 ms and return the new text whole. A save
;; that changed every word of a text from about 2,000 words up, or respelled a
;; word in every sentence of a long one, then deleted the whole body and
;; inserted the new one: every token, span, relation and vocabulary link went,
;; and the request answered 200. Whether it gave up depended on how busy the
;; server was.
;;
;; So a long stretch is split before the character diff sees it: by lines
;; first, then by words, and only the changed stretches between the units the
;; two sides share go to editscript, each short enough to finish. A changed
;; stretch that is still too long pairs its units in order when both sides
;; have as many, and otherwise goes down a level. Every bound below counts
;; work, never time, so the same save gives the same result on any server,
;; and nothing falls back to replacing the whole body.

(def ^:private hunk-limit
  "The most code points, old and new together, a changed stretch may have for
  editscript's character diff. Where the two sides differ throughout it takes
  about 60 ms at 1,000 code points and 2 s at 8,000."
  1000)

(def ^:private myers-work
  "How many cells the line and word diff may visit before it stops and pairs
  the units another way."
  20000000)

(def ^:private myers-max-d
  "The most edits the line and word diff searches for. Its trace grows with the
  square of this."
  2000)

(def ^:private band-cells
  "The most cells of the banded alignment, the last resort for a long stretch
  whose units mostly changed and whose unit counts differ."
  4000000)

(defn- sub-cps ^ints [^ints a s e]
  (java.util.Arrays/copyOfRange a (int s) (int e)))

(defn- unit-bounds
  "The start of each unit of `cps` at `level`, then its length. A line runs
  through its line break, and a word is a run of letters or a run of spaces."
  ^ints [^ints cps level]
  (let [n (alength cps)
        out (java.util.ArrayList.)]
    (.add out (int 0))
    (case level
      :line (dotimes [i (dec n)]
              (when (= 10 (aget cps i)) (.add out (int (inc i)))))
      :word (dotimes [i (dec n)]
              (when-not (= (boolean (space? (aget cps i)))
                           (boolean (space? (aget cps (inc i)))))
                (.add out (int (inc i))))))
    (.add out (int n))
    (int-array out)))

(defn- unit-ids
  "One number per unit of `a` and of `b`, the same for units of the same text."
  [^ints a ^ints a-bounds ^ints b ^ints b-bounds]
  (let [seen (java.util.HashMap.)
        ids (fn [^ints cps ^ints bounds]
              (let [k (dec (alength bounds))
                    out (int-array k)]
                (dotimes [i k]
                  (let [s (aget bounds i)
                        u (String. cps s (int (- (aget bounds (inc i)) s)))
                        id (or (.get seen u)
                               (let [id (int (.size seen))] (.put seen u id) id))]
                    (aset out i (int id))))
                out))]
    [(ids a a-bounds) (ids b b-bounds)]))

(defn- myers
  "The elements a shortest edit script from `a` to `b` keeps, as two arrays of
  indices, or nil when that script takes more than `max-d` edits. Myers'
  forward search, keeping each round's furthest points to trace the path back."
  [^ints a ^ints b max-d]
  (let [n (alength a)
        m (alength b)
        max-d (long max-d)
        off (inc max-d)
        v (int-array (+ 2 (* 2 off)))
        trace (java.util.ArrayList.)
        from-below? (fn [^ints vd ^long base ^long d ^long k]
                      (or (= k (- d))
                          (and (not= k d)
                               (< (aget vd (+ base k -1)) (aget vd (+ base k 1))))))
        done (loop [d 0]
               (when (<= d max-d)
                 (.add trace (java.util.Arrays/copyOfRange v (int (- off d 1)) (int (+ off d 2))))
                 (if (loop [k (- d)]
                       (when (<= k d)
                         (let [x (if (from-below? v off d k)
                                   (aget v (+ off k 1))
                                   (inc (aget v (+ off k -1))))
                               x (loop [x x]
                                   (let [y (- x k)]
                                     (if (and (< x n) (< -1 y m) (= (aget a x) (aget b y)))
                                       (recur (inc x))
                                       x)))]
                           (aset v (+ off k) (int x))
                           (if (and (>= x n) (>= (- x k) m))
                             true
                             (recur (+ k 2))))))
                   d
                   (recur (inc d)))))]
    (when done
      (let [ma (java.util.ArrayList.)
            mb (java.util.ArrayList.)]
        (loop [d (long done) x (long n) y (long m)]
          (let [^ints vd (.get trace d)
                k (- x y)
                pk (if (from-below? vd (inc d) d k) (inc k) (dec k))
                px (long (aget vd (+ d 1 pk)))
                py (- px pk)
                [x y] (loop [x x y y]
                        (if (and (> x px) (> y py) (> x 0) (> y 0))
                          (do (.add ma (int (dec x))) (.add mb (int (dec y)))
                              (recur (dec x) (dec y)))
                          [x y]))]
            (when (pos? d) (recur (dec d) px py))))
        [(int-array (reverse ma)) (int-array (reverse mb))]))))

(defn- band-matches
  "The elements a longest common subsequence of `a` and `b` keeps, as two arrays
  of indices, searched only near the diagonal that runs from the start of both
  to the end of both, `band-cells` cells in all. Every place in the band can
  be reached, so this always gives an edit script, if not always a shortest."
  [^ints a ^ints b]
  (let [n (alength a)
        m (alength b)
        q (quot (+ m n -1) n)
        w (max 1 (quot (- (quot band-cells (inc n)) q 1) 2))
        lo (fn ^long [^long i] (max 0 (- (quot (* i m) n) w)))
        hi (fn ^long [^long i] (min m (+ (quot (* i m) n) q w)))
        starts (long-array (+ n 2))
        _ (loop [i 0 s 0]
            (aset starts i (long s))
            (when (<= i n) (recur (inc i) (+ s (inc (- (hi i) (lo i)))))))
        dir (byte-array (aget starts (inc n)))
        prev (int-array (inc m))
        cur (int-array (inc m))]
    (loop [j (lo 0)]
      (when (<= j (hi 0))
        (aset cur j 0)
        (when (pos? j) (aset dir (+ (aget starts 0) (- j (lo 0))) (byte 2)))
        (recur (inc j))))
    (loop [i 1 ^ints before cur ^ints scratch prev]
      (when (<= i n)
        (let [^ints prev before
              ^ints cur scratch
              plo (lo (dec i)) phi (hi (dec i))
              l (lo i) h (hi i)
              ai (aget a (dec i))
              base (- (aget starts i) l)]
          (loop [j l]
            (when (<= j h)
              (let [dg (if (and (<= plo (dec j) phi) (= ai (aget b (dec j))))
                         (inc (aget prev (dec j)))
                         -1)
                    up (if (<= plo j phi) (aget prev j) -1)
                    lf (if (< l j) (aget cur (dec j)) -1)
                    [best d] (cond (and (>= dg up) (>= dg lf)) [dg 3]
                                   (>= up lf) [up 1]
                                   :else [lf 2])]
                (aset cur j (int best))
                (aset dir (+ base j) (byte d))
                (recur (inc j)))))
          (recur (inc i) cur prev))))
    (let [ma (java.util.ArrayList.)
          mb (java.util.ArrayList.)]
      (loop [i n j m]
        (when (or (pos? i) (pos? j))
          (case (long (aget dir (+ (- (aget starts i) (lo i)) j)))
            3 (do (.add ma (int (dec i))) (.add mb (int (dec j))) (recur (dec i) (dec j)))
            1 (recur (dec i) j)
            2 (recur i (dec j)))))
      [(int-array (reverse ma)) (int-array (reverse mb))])))

(declare local-diff)

(def ^:private next-level {:line :word :word :char})

(defn- unit-diff
  "`local-diff` of `o` and `n`, too long for the character diff, by `level`'s
  units. The changed stretches between the units a shortest edit script keeps
  are each diffed on their own, a level down. When that script is too long to
  find, units are paired in order if both sides have as many, and otherwise by
  `band-matches`. Characters are the last level, where a changed stretch is
  deleted and typed whole."
  [^ints o ^ints n level]
  (let [chars? (= level :char)
        ob (when-not chars? (unit-bounds o level))
        nb (when-not chars? (unit-bounds n level))
        [^ints ia ^ints ib] (if chars? [o n] (unit-ids o ob n nb))
        at-o (if chars? identity (fn [i] (aget ^ints ob (int i))))
        at-n (if chars? identity (fn [i] (aget ^ints nb (int i))))
        na (alength ia)
        nn (alength ib)
        matches (or (myers ia ib (min myers-max-d (max 16 (quot myers-work (+ na nn)))))
                    (when (and (not chars?) (= na nn)) :in-order)
                    (band-matches ia ib))
        hunks (if (= matches :in-order)
                (for [i (range na) :when (not= (aget ia i) (aget ib i))] [i (inc i) i (inc i)])
                (let [[^ints ma ^ints mb] matches
                      k (alength ma)]
                  (loop [t 0 pa 0 pb 0 out []]
                    (let [ea (if (< t k) (aget ma t) na)
                          eb (if (< t k) (aget mb t) nn)
                          out (if (or (< pa ea) (< pb eb)) (conj out [pa ea pb eb]) out)]
                      (if (< t k) (recur (inc t) (inc ea) (inc eb) out) out)))))
        ;; Two changed stretches with only a space kept between them are
        ;; diffed as one, when the character diff can take them. `a b` to
        ;; `ab` keeps a space either side of `b` by words, and keeping the
        ;; one after `a` reads `b` as deleted and typed again after `a`,
        ;; which deleted `b`'s token and everything on it.
        hunks (if (= level :word)
                (reduce (fn [out [os oe ns ne :as h]]
                          (let [[pos poe pns] (peek out)]
                            (if (and pos (= (inc poe) os)
                                     (space? (aget o (int (at-o poe))))
                                     (<= (+ (- (at-o oe) (at-o pos)) (- (at-n ne) (at-n pns))) hunk-limit))
                              (conj (pop out) [pos oe pns ne])
                              (conj out h))))
                        [] hunks)
                hunks)
        down (fn [os oe ns ne]
               (local-diff (sub-cps o (at-o os) (at-o oe)) (sub-cps n (at-n ns) (at-n ne))
                           (next-level level)))
        shift (fn [ops by] (map #(update % :index + by) ops))]
    (into []
          (mapcat
           (fn [[os oe ns ne]]
             (shift
              (cond
                chars?
                (cond-> []
                  (< os oe) (conj (delete-op 0 (- oe os)))
                  (< ns ne) (conj (insert-op 0 (cps->str (sub-cps n ns ne)))))

                (and (= (- oe os) (- ne ns))
                     (< hunk-limit (+ (- (at-o oe) (at-o os)) (- (at-n ne) (at-n ns)))))
                (mapcat (fn [i]
                          (when (not= (aget ia (+ os i)) (aget ib (+ ns i)))
                            (shift (down (+ os i) (+ os i 1) (+ ns i) (+ ns i 1))
                                   (- (at-n (+ ns i)) (at-n ns)))))
                        (range (- oe os)))

                :else (down os oe ns ne))
              (at-n ns))))
          hunks)))

(defn- local-diff
  "`diff` of the code points `o` and `n`, starting at `level`: the text they
  share at the start and at the end set aside, the rest by editscript when it
  is short enough and by `unit-diff` when it is not."
  [^ints o ^ints n level]
  (let [no (alength o)
        nn (alength n)
        shorter (min no nn)
        prefix (loop [i 0]
                 (if (and (< i shorter) (= (aget o i) (aget n i))) (recur (inc i)) i))
        suffix (loop [i 0]
                 (if (and (< i (- shorter prefix))
                          (= (aget o (- no 1 i)) (aget n (- nn 1 i))))
                   (recur (inc i))
                   i))
        lo (- no prefix suffix)
        ln (- nn prefix suffix)
        o-mid (sub-cps o prefix (- no suffix))
        n-mid (sub-cps n prefix (- nn suffix))]
    (mapv #(update % :index + prefix)
          (cond
            (and (zero? lo) (zero? ln)) []
            (zero? lo) [(insert-op 0 (cps->str n-mid))]
            (zero? ln) [(delete-op 0 lo)]
            (<= (+ lo ln) hunk-limit) (middle-diff (cps->str o-mid) (cps->str n-mid))
            :else (unit-diff o-mid n-mid level)))))

(defn diff
  "Diff `old` -> `new` into a vector of insert/delete edit-ops. Op `:index` and
  the `:delete` `:value` count are **Unicode code-point** positions, matching the
  canonical token-offset unit; insert `:value` is the literal inserted string.
  Applying the ops to `old` reconstructs `new` exactly, including astral text.

  The text the two share at the start and at the end is set aside first, and
  only what lies between is diffed. Editscript's search picks any one of the
  edit scripts of least cost, and among them some scatter one edit into the
  shared text around it: deleting `mat` from `kai tat mat at a` came out as a
  delete inside `mat` and another inside `at`, which moved `at`'s tokens onto
  `a` and deleted the tokens of `a`. Trimming is by code point, so it never
  cuts a surrogate pair. It can end between a letter and a combining mark on
  it, as any diff by code point can, and a token boundary there is one the
  offsets already allow. Which of several equal places an edit takes is
  `slide-to-tokens`' business, since only the tokens can tell.

  What lies between goes to editscript whole when it is at most `hunk-limit`
  code points, and is split by lines, then words, when it is longer (see
  `unit-diff`), so no save depends on the clock and none replaces the whole
  body unless the two share nothing.

  The character diff runs at code-point granularity (via `codepoint-proxy`) so
  an edit boundary never splits a surrogate pair — otherwise a char-level diff
  of e.g. an interior emoji deletion would mis-shift the surrounding tokens."
  [^String old ^String new]
  (local-diff (.toArray (.codePoints old)) (.toArray (.codePoints new)) :line))

(defn- middle-diff
  "Editscript's diff of two strings of at most `hunk-limit` code points."
  [old new]
  (let [{:keys [old* new* decode]} (codepoint-proxy old new)
        results (editscript-diff old* new*)]
    (loop [head (first results)
           tail (rest results)
           ops []
           i 0]
      (let [code (if-not (nil? head) (first head))
            value (if-not (nil? head) (second head))]
        (cond
          (nil? head)
          ops

          ;; equality (value is a proxy substring; only its length matters)
          (= 0 code)
          (recur (first tail) (rest tail) ops (+ i (count value)))

          ;; insertion — decode the proxy value back to the real string
          (= 1 code)
          (recur (first tail) (rest tail)
                 (conj ops (insert-op i (decode value)))
                 (+ i (count value)))

          ;; deletion (count is in code points = proxy chars)
          (= -1 code)
          (recur (first tail) (rest tail)
                 (conj ops (delete-op i (count value)))
                 i)

          :else
          (throw (ex-info "Unknown diff op code" {:code 500 :op-code code})))))))
