(ns plaid.algos.text
  (:require [clojure.set :as set]
            [editscript.core :as e]
            [plaid.util.codepoint :as cp]))

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

(defn delete-op [index value]
  {:type  :delete
   :index index
   :value value})

(defn insert-op [index value]
  {:type  :insert
   :index index
   :value value})

(defn replace-op [index length value]
  {:type   :replace
   :index  index
   :length length
   :value  value})

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
  reconstructs exactly. Returns nil when there are more distinct code points than
  the BMP proxy pool can hold (caller falls back) — unreachable for real text."
  [^String old ^String new]
  (let [ocps (vec (.toArray (.codePoints old)))
        ncps (vec (.toArray (.codePoints new)))
        dcps (vec (distinct (concat ocps ncps)))
        n (count dcps)
        pool (->> (range 1 0x10000) (remove surrogate?) (take n) vec)]
    (when (= n (count pool))
      (let [pchars (mapv char pool)
            cp->px (zipmap dcps pchars)
            px->cp (zipmap pchars dcps)
            ->px (fn [cps] (apply str (map cp->px cps)))
            decode (fn [^String s]
                     (apply str (map #(String. (Character/toChars (int (px->cp %)))) s)))]
        {:old* (->px ocps) :new* (->px ncps) :decode decode}))))

(defn- cps->str [cps]
  (let [sb (StringBuilder.)]
    (doseq [c cps] (.appendCodePoint sb (int c)))
    (.toString sb)))

(declare middle-diff space?)

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

;; i is a code-point index, v a code-point count / inserted string.
(defn- insert-str [s i v]
  (str (cp/cp-subs s 0 i) v (cp/cp-subs s i)))

(defn- delete-str [s i v]
  (str (cp/cp-subs s 0 i) (cp/cp-subs s (+ i v))))

(defn- combining-mark?
  "A code point of Unicode category Mn, Mc or Me: a mark that belongs to the
  letter before it."
  [c]
  (let [t (Character/getType (int c))]
    (or (= t Character/NON_SPACING_MARK)
        (= t Character/COMBINING_SPACING_MARK)
        (= t Character/ENCLOSING_MARK))))

(defn- leading-marks
  "How many code points at the start of `s` are combining marks."
  [^String s]
  (let [cps (.toArray (.codePoints s))]
    (loop [i 0]
      (if (and (< i (alength cps)) (combining-mark? (aget cps i))) (recur (inc i)) i))))

(defn- op-type [type]
  (or (and (keyword? type) type)
      (and (string? type) (keyword type))
      type))

(defn- check-op!
  "The 400s `apply-text-edit` throws, for `op` applied to a text of `len`
  code points."
  [op len]
  (let [{:keys [index value length]} op
        type (op-type (:type op))]
    (when-not (or (and (= type :insert) (int? index) (string? value))
                  (and (= type :delete) (int? index) (int? value))
                  (and (= type :replace) (int? index) (int? length) (string? value)))
      (throw (ex-info (str "Malformed text edit operation: " (pr-str op)
                           " — expected {type: \"insert\", index: int, value: string},"
                           " {type: \"delete\", index: int, value: int}"
                           " or {type: \"replace\", index: int, length: int, value: string}")
                      {:code 400 :op op})))
    (when-not (contains? #{nil "before" "after" :before :after} (:side op))
      (throw (ex-info (str "A text edit's side is \"before\" or \"after\": " (pr-str op))
                      {:code 400 :op op})))
    (when-not (case type
                :insert (<= 0 index len)
                :delete (and (<= 0 index) (<= 0 value) (<= (+ index value) len))
                :replace (and (<= 0 index) (<= 0 length) (<= (+ index length) len)))
      (throw (ex-info (str "Text edit operation out of bounds: " (pr-str op)
                           " (text length is " len " code points)")
                      {:code 400 :op op :text-length len})))
    type))

(defn apply-text-edit
  "Given an operation, a text and tokens, shift :token/begin and :token/end on a list
  of tokens as appropriate. Operations are maps, with :type of :delete, :insert or
  :replace, :index indicating the position in the string, and :value for the value
  being inserted or the number of tokens to be deleted.

  :index and the :delete :value count are **Unicode code-point** positions — the
  same unit as the :token/begin/:token/end of the `tokens` passed in, and as the
  ops produced by `diff`. (Slicing the body uses plaid.util.codepoint, so astral
  text shifts correctly.)

  Op examples:

    {:type :insert    {:type :delete    {:type :replace
     :index 3          :index 4          :index 4
     :value \"is \"}   :value 3}         :length 3
                                         :value \"new\"}

  :replace swaps the :length code points at :index for :value. It differs from
  an equivalent delete+insert in ONE way: a token that covers the whole replaced
  range keeps it (the token is resized by the length difference) instead of
  collapsing when the range is its entire extent. That is what a bulk
  orthography rewrite needs — `kat` -> `cat` must keep the word token and
  everything hanging off it (morphemes, spans, links).
  Tokens that only partially overlap the range are handled exactly as
  delete+insert (clipped to the outside; the replacement belongs to no token),
  as are zero-width tokens. An empty :value is a delete; a zero :length is an
  insert.

  Text typed at a token's end stays outside it (`cat` to `cats` leaves the
  token on `cat`), except the combining marks (Unicode Mn, Mc, Me) it starts
  with: those belong to the letter before them, so a token ending there takes
  them, and a zero-width token there moves past them. An accent typed as a
  separate mark after `cafe` makes the token read `café`, as a precomposed é
  does. A replace whose new text starts with marks is those marks inserted,
  then the rest replacing the range.

  Returns a map:
   - :text contains the new text map
   - :tokens contains the modified tokens that still exist
   - :deleted contains the ids of tokens that were deleted because they had zero width

  Example return map:

    {:text {:text/body \"good dog\", ...}
     :tokens ({:token/begin 0, :token/end 4, ...}, {:token/begin 5, :token/end 8, ...})
     :deleted ()}
  "
  [{:keys [index value length] :as op} text tokens]
  ;; Client-supplied edit directives reach here unvalidated (the PATCH
  ;; body schema is `any?`), so a malformed or out-of-bounds op is a
  ;; structured 400 (see `check-op!`), thrown inside the operation tx body
  ;; so submit-operation* projects it cleanly.
  (let [type (check-op! op (cp/cp-count (:text/body text)))]
    (do
      (case type
        :replace
        (cond
          (zero? length) (apply-text-edit (insert-op index value) text tokens)
          (= value "") (apply-text-edit (delete-op index length) text tokens)

          (and (pos? index) (pos? (leading-marks value)))
          (let [k (leading-marks value)
                marks (cp/cp-subs value 0 k)
                {text* :text tokens* :tokens deleted :deleted}
                (apply-text-edit (insert-op index marks) text tokens)
                rest-op (replace-op (+ index k) length (cp/cp-subs value k))
                {text** :text tokens** :tokens deleted* :deleted}
                (apply-text-edit rest-op text* tokens*)]
            {:text text** :tokens tokens** :deleted (into deleted deleted*)})

          :else
          (let [end-index (+ index length)
                delta (- (cp/cp-count value) length)
                covers? (fn [{:token/keys [begin end]}]
                          (and (< begin end) (<= begin index) (>= end end-index)))
                ;; A zero-width token at the end of the range stands at the
                ;; end of what is replaced, as the covering tokens' ends do.
                ;; Delete-then-insert would pull it back to the range's
                ;; start, which on a non-overlapping layer puts it strictly
                ;; inside the word the range belongs to, a place the layer
                ;; refuses and a restore of that moment cannot rebuild.
                at-end? (fn [{:token/keys [begin end]}]
                          (and (= begin end) (= end end-index)))
                covering (filterv covers? tokens)
                trailing (filterv at-end? tokens)
                others (filterv #(not (or (covers? %) (at-end? %))) tokens)
                ;; Everything that doesn't cover the range behaves as if the
                ;; range were deleted and the value inserted in its place.
                {text* :text tokens* :tokens deleted :deleted}
                (apply-text-edit (delete-op index length) text others)
                {text** :text tokens** :tokens}
                (apply-text-edit (insert-op index value) text* tokens*)]
            {:text text**
             :tokens (-> tokens**
                         (into (map #(update % :token/end + delta) covering))
                         (into (map #(-> %
                                         (update :token/begin + delta)
                                         (update :token/end + delta))
                                    trailing)))
             :deleted deleted}))

        ;; three cases:
        ;; - token opens and closes before index (no changes)
        ;; - token opens before index but closes later (expand the token)
        ;; - token opens and closes after index (add offset to both indices)
        ;; - a token ending at index takes the combining marks the value
        ;;   starts with, and a zero-width one there moves past them
        :insert
        (let [offset (cp/cp-count value)
              marks (if (pos? index) (leading-marks value) 0)
              unaffected-tokens (filterv #(or (< (:token/end %) index)
                                              (and (= (:token/end %) index) (zero? marks)))
                                         tokens)
              affected-tokens (filterv #(or (> (:token/end %) index)
                                            (and (= (:token/end %) index) (pos? marks)))
                                       tokens)]
          {:text (update text :text/body insert-str index value)
           :tokens (into unaffected-tokens
                         (map (fn [{:token/keys [begin end] :as token}]
                                (cond
                                  (and (> index begin) (< index end))
                                  (update token :token/end + offset)

                                  (and (< begin index) (= end index))
                                  (update token :token/end + marks)

                                  (= begin end index)
                                  (-> token
                                      (update :token/begin + marks)
                                      (update :token/end + marks))

                                  :else
                                  (-> token
                                      (update :token/begin + offset)
                                      (update :token/end + offset))))
                              affected-tokens))
           :deleted []})

        :delete
        (let [end-index (+ index value)
              zero-width? (fn [{:token/keys [begin end]}] (= begin end))
              unaffected? (fn [{:token/keys [begin end] :as token}]
                            (if (zero-width? token)
                              ;; Zero-width tokens are pinned at position p:
                              ;; they're unaffected iff the deletion range
                              ;; starts at or after p (so no characters
                              ;; before p are touched). Mirrors the insert
                              ;; side which keeps a zero-width token at p
                              ;; pinned when inserting at p.
                              (<= end index)
                              (and (< begin index)
                                   (<= end index))))
              contained? (fn [{:token/keys [begin end] :as token}]
                           (if (zero-width? token)
                             ;; Zero-width tokens: STRICT containment on
                             ;; both sides. A delete range that begins or
                             ;; ends at p does NOT delete the zero-width
                             ;; token at p (insert-symmetry).
                             (and (< index begin)
                                  (> end-index end))
                             (and (>= begin index)
                                  (<= end end-index))))
              ;; token opens and closes within deletion range--delete it
              deleted-tokens (filterv contained? tokens)
              ;; token opens and closes before index (no changes)
              unaffected-tokens (filterv unaffected? tokens)
              affected-tokens (filterv #(not (or (contained? %) (unaffected? %))) tokens)]
          {:text (update text :text/body delete-str index value)
           :tokens (into unaffected-tokens
                         (mapv (fn [{:token/keys [begin end] :as token}]
                                 (cond
                                   ;; token opens and closes after deletion range--token is same but indices shrink
                                   (and (>= begin end-index)
                                        (>= end end-index))
                                   (-> token
                                       (update :token/begin #(- % value))
                                       (update :token/end #(- % value)))

                                   ;; token opens before index and closes within deletion range--shrink the token
                                   (and (< begin index)
                                        (<= end end-index))
                                   (-> token
                                       (assoc :token/end index))

                                   ;; token opens within deletion range and closes outside--set token/begin to index and shrink
                                   (and (>= begin index)
                                        (> end end-index))
                                   (-> token
                                       (assoc :token/begin index)
                                       (update :token/end #(- % (- end-index (min begin index)))))

                                   ;; deletion range is contained inside token
                                   :else
                                   (-> token
                                       (update :token/end #(- % value)))))
                               affected-tokens))
           :deleted (mapv :token/id deleted-tokens)})))))

;; ---------------------------------------------------------------------------
;; Delete normalization
;;
;; The diff is a minimal edit script over characters and knows nothing about
;; tokens, so when a deleted stretch is followed by text that repeats its
;; edge it may keep the "wrong" copy: deleting `¿Qué? ` from `¿Qué? ? dog's`
;; can come out as delete `¿Qué`, keep `?`, delete ` ?` — same resulting
;; string, but the kept `?` is the tail of the `¿Qué?` token, which survives
;; as a one-character sliver (with its annotations and links) while the real
;; `?` token is deleted. When two deletes straddle a kept run that equals an
;; edge of the neighbouring deleted text, the pair is equivalent to ONE
;; contiguous delete; prefer that form whenever it cuts fewer tokens.

(defn- ops->edits
  "Sequential running-coordinate ops -> edits in OLD-body coordinates:
  {:kind :delete :start s :end e} / {:kind :insert :at a :value v} /
  {:kind :replace :start s :end e :value v}."
  [ops]
  (loop [ops ops del 0 ins 0 out []]
    (if-let [{:keys [type index value length]} (first ops)]
      (let [type (if (keyword? type) type (keyword type))
            old-pos (+ index del (- ins))]
        (case type
          :delete (recur (rest ops) (+ del value) ins
                         (conj out {:kind :delete :start old-pos :end (+ old-pos value)}))
          :insert (recur (rest ops) del (+ ins (cp/cp-count value))
                         (conj out {:kind :insert :at old-pos :value value}))
          :replace (recur (rest ops) (+ del length) (+ ins (cp/cp-count value))
                          (conj out {:kind :replace :start old-pos :end (+ old-pos length)
                                     :value value}))))
      out)))

(defn- edits->ops
  "Old-coordinate edits, in their original (position-monotone) order ->
  sequential running-coordinate ops. An edit at old position p is shifted by
  the inserts before it and by the deletes that START strictly before p (a
  delete starting AT p removes text after p and doesn't move p). Linear:
  the deletes are summed as the edits pass them, and only those starting at
  the current position wait."
  [edits]
  (loop [edits edits del-before 0 waiting [] ins 0 out []]
    (if-let [e (first edits)]
      (let [p (or (:start e) (:at e))
            passed (filter #(< (first %) p) waiting)
            del-before (+ del-before (reduce + 0 (map second passed)))
            waiting (if (seq passed) (filterv #(>= (first %) p) waiting) waiting)
            running (+ p (- del-before) ins)]
        (case (:kind e)
          :delete (let [n (- (:end e) (:start e))]
                    (recur (rest edits) del-before (conj waiting [(:start e) n]) ins
                           (conj out (delete-op running n))))
          :insert (recur (rest edits) del-before waiting (+ ins (cp/cp-count (:value e)))
                         (conj out (insert-op running (:value e))))
          :replace (let [n (- (:end e) (:start e))]
                     (recur (rest edits) del-before (conj waiting [(:start e) n])
                            (+ ins (cp/cp-count (:value e)))
                            (conj out (replace-op running n (:value e)))))))
      out)))

;; ---------------------------------------------------------------------------
;; Sliding an edit to the tokens
;;
;; A delete or an insert that has the same letters on one side as at its far
;; end can stand in several places for the same resulting string. The trim in
;; `diff` takes the shared start as far as it goes, so it always picks the
;; last of them, and that cuts words: deleting `cat` from `the cat cow` shares
;; `the c` at the start, the delete falls on `at c`, and `cat`'s tokens are
;; left on `c` and `cow`'s on `ow`. Deleting `cat ` instead gives the same
;; body and leaves `cow` whole. Editscript's own choices inside a changed
;; stretch have the same freedom.

(defn- space?
  "Whether code point `c` separates words, as the apps' tokenizers take it
  (JavaScript's `\\s`): Java's whitespace, and also the no-break spaces
  (U+00A0, U+2007, U+202F) and U+FEFF, which Java counts as letters, but not
  the information separators (U+001C to U+001F), which only Java counts."
  [c]
  (let [c (int c)]
    (and (not (<= 0x1C c 0x1F))
         (or (Character/isWhitespace c) (Character/isSpaceChar c) (= c 0xFEFF)))))

(def ^:private slide-reach
  "How far an edit is moved at most, in code points each way. A word edit's
  equivalent places lie within about a word of each other, and the bound
  keeps a long run of one repeated letter from costing a scan per place."
  64)

(defn- slide-cost
  "How many of `tokens` an edit at this place would disturb. It cuts a token
  a delete takes part of, one a delete swallows while it stands at a single
  point, and one an insert falls strictly inside of. It also disturbs a token
  whose neighbouring letter it changes: inserting `t ta` after the `ta` of
  `cat ta bad` leaves that token on the start of the new `tat`, where
  inserting `tat ` before it leaves it between the same two spaces. An
  insert where two tokens of one layer meet disturbs at least one of them,
  even with the same letters either side: an `a` typed at the end of `aa`,
  glossed as `a` + `a`, would otherwise go between the two morphemes, inside
  the word but in neither. A zero-width token where a token begins and no
  token of a layer that is not a partition ends marks that token's start, and
  text inserted there comes between the two, whatever its first letter:
  `a ` typed before `abc` leaves the marker on the new `a`, where ` a` typed
  after the word before leaves it on `abc`. It counts half, so it settles
  ties and never outweighs a token the text would go inside.

  A layer in `partitioning` has no gaps, so text inserted where two of its
  tokens meet goes into the one that ends there (and at the start of the
  text into the first). That token counts as disturbed there, as it does for
  an insert inside it, and the one beginning there when its letter before
  changes. Doubling the `a` of `tat! a. tat` before the `a` gives it to the
  sentence before and puts the sentence boundary inside `aa`, where doubling
  it after the `a` keeps both sentences on their words.

  A delete that cuts a token at one end and leaves it ending (or beginning)
  on a space it did not have there counts that token half again, so of the
  two ways to delete a word at the edge of a token over several words (a
  UMR node), the one taking the space on the far side wins."
  [^ints o tokens partitioning edit]
  (let [n (alength o)
        ;; The edge of the text and a space both only separate, so a word
        ;; that comes to stand at the start of the text keeps its place.
        at (fn [i] (if (< -1 i n)
                     (let [c (aget o i)] (if (space? c) :apart c))
                     :apart))
        apart (fn [c] (if (space? c) :apart c))]
    (if (= :delete (:kind edit))
      (let [{s :start e :end} edit
            sp? (fn [i] (space? (aget o i)))]
        (+ (count (filter (fn [{:token/keys [begin end]}]
                            (cond
                              (= begin end) (< s begin e)
                              (and (< s end) (> e begin)) (not (and (<= s begin) (<= end e)))
                              (= end s) (not= (at s) (at e))
                              (= begin e) (not= (at (dec e)) (at (dec s)))
                              :else false))
                          tokens))
           ;; A token the delete cuts at one end, and leaves ending (or
           ;; beginning) on a space it did not have there, counts half
           ;; again: a UMR node over `tatu the` keeps `tatu` when ` the` is
           ;; deleted, and `tatu ` when `the ` is.
           (/ (count (filter (fn [{:token/keys [begin end]}]
                               (or (and (< begin s) (< s end) (<= end e)
                                        (sp? (dec s)) (not (sp? (dec end))))
                                   (and (<= s begin) (< begin e) (< e end)
                                        (sp? e) (not (sp? begin)))))
                             tokens))
              2)))
      (let [a (:at edit)
            v (.toArray (.codePoints ^String (:value edit)))
            ;; A token ending at `a` gets a new letter after it, one
            ;; beginning there a new letter before it.
            new-after? (not= (at a) (apart (aget v 0)))
            new-before? (not= (at (dec a)) (apart (aget v (dec (alength v)))))
            ;; Two tokens of one layer that meet between two letters are
            ;; pulled apart by whatever is put between them, even the letters
            ;; they already had beside them, so the pair counts once when
            ;; neither letter changes. Once, and not once each: the start of
            ;; the word would then cost less, and a letter doubled in `a` +
            ;; `b` would leave the word. (Where a space or the edge of the
            ;; text is on one side, as between two sentences of a partition,
            ;; the neighbouring letters tell.)
            layers-at (fn [k] (into #{} (comp (filter #(and (< (:token/begin %) (:token/end %))
                                                            (= a (k %))
                                                            (not (partitioning (:token/layer %)))))
                                              (map :token/layer))
                                    tokens))
            ;; A zero-width token where a token begins and none ends (a
            ;; partition's always does) marks that token's start.
            start-mark? (and (some #(and (< (:token/begin %) (:token/end %)) (= a (:token/begin %))) tokens)
                             (not-any? #(and (< (:token/begin %) (:token/end %)) (= a (:token/end %))
                                             (not (partitioning (:token/layer %))))
                                       tokens))
            met (if (or new-after? new-before? (= :apart (at (dec a))) (= :apart (at a)))
                  #{}
                  (set/intersection (layers-at :token/end) (layers-at :token/begin)))]
        (+ (count met)
           ;; A zero-width token stays in front of text inserted where it
           ;; stands, which parts it from the token it marks the start of. It
           ;; counts half, so it settles a tie and never puts the text inside
           ;; a word instead: at the start of the text nothing can go in front
           ;; of a word but after its marker.
           (/ (count (filter (fn [{:token/keys [begin end]}] (and (= begin end a) start-mark?)) tokens)) 2)
           (count (filter (fn [{:token/keys [begin end layer]}]
                            (cond
                              (= begin end) false
                              (< begin a end) true
                              (partitioning layer) (cond
                                                     (= end a) true
                                                     (= begin a) (or (zero? a) new-before?)
                                                     :else false)
                              (= end a) new-after?
                              (= begin a) new-before?
                              :else false))
                          tokens)))))))

(defn- slide-cuts
  "How many of `tokens` a delete at this place takes part of (none for an
  insert). Among the places that disturb equally (see `slide-cost`), the one
  cutting fewest wins, since a token whose neighbouring letter changes keeps
  its letters and a cut one does not. Deleting `atut` from `tatuthe`,
  glossed `t` + `he`, cuts `tatu` and `the` and takes the whole `t`, and
  deleting `tatu` changes only the letter before `the` and its `t`: both
  disturb two tokens. Inserts keep their ties as `slide-cost` settles them."
  [tokens edit]
  (if (= :delete (:kind edit))
    (let [{s :start e :end} edit]
      (count (filter (fn [{:token/keys [begin end]}]
                       (and (< begin end) (< s end) (> e begin)
                            (not (and (<= s begin) (<= end e)))))
                     tokens)))
    0))

(defn- slide-places
  "Every place `edit` (old-body coordinates, over the code points `o`) could
  stand for the same resulting string without reaching `lo` or `hi`, the
  nearest first on each side, with the edit itself at the head."
  [^ints o edit lo hi]
  (let [cps->s (fn [xs] (let [sb (StringBuilder.)]
                          (doseq [c xs] (.appendCodePoint sb (int c)))
                          (.toString sb)))]
    (if (= :delete (:kind edit))
      (let [left (->> edit
                      (iterate (fn [{s :start e :end :as d}]
                                 (when (and d (> s lo) (= (aget o (dec s)) (aget o (dec e))))
                                   (assoc d :start (dec s) :end (dec e)))))
                      (drop 1) (take-while some?) (take slide-reach))
            right (->> edit
                       (iterate (fn [{s :start e :end :as d}]
                                  (when (and d (< e hi) (= (aget o s) (aget o e)))
                                    (assoc d :start (inc s) :end (inc e)))))
                       (drop 1) (take-while some?) (take slide-reach))]
        (concat [edit] left right))
      (let [v (vec (.toArray (.codePoints ^String (:value edit))))
            step-left (fn [[a v]]
                        (when (and v (> a lo) (= (aget o (dec a)) (peek v)))
                          [(dec a) (into [(aget o (dec a))] (pop v))]))
            step-right (fn [[a v]]
                         (when (and v (< a hi) (= (aget o a) (first v)))
                           [(inc a) (conj (subvec v 1) (aget o a))]))
            places (fn [step] (->> [(:at edit) v] (iterate step) (drop 1)
                                   (take-while some?) (take slide-reach)
                                   (map (fn [[a v]] (assoc edit :at a :value (cps->s v))))))]
        (concat [edit] (places step-left) (places step-right))))))

(defn- tokens-near
  "A function of `lo` and `hi` giving the tokens that begin or end within
  [lo, hi]. The others do not change which of an edit's places in that
  stretch is best: one wholly outside is disturbed by none of them, and one
  reaching past both ends is cut by every one of them alike. For more than
  a few `lookups` the tokens are indexed by position first, so a body update
  with many edits over a long text does not scan every token once per edit."
  [tokens lookups]
  (if (< lookups 16)
    (fn [lo hi]
      (filterv (fn [{:token/keys [begin end]}] (or (<= lo begin hi) (<= lo end hi)))
               tokens))
    (let [by-begin (vec (sort-by :token/begin tokens))
          by-end (vec (sort-by :token/end tokens))
          begins (long-array (map :token/begin by-begin))
          ends (long-array (map :token/end by-end))
          ;; the first index whose value is at least x
          lower (fn [^longs xs x]
                  (loop [a 0 b (alength xs)]
                    (if (< a b)
                      (let [m (quot (+ a b) 2)]
                        (if (< (aget xs m) (long x)) (recur (inc m) b) (recur a m)))
                      a)))]
      (fn [lo hi]
        (-> []
            (into (subvec by-begin (lower begins lo) (lower begins (inc hi))))
            (into (filter #(< (:token/begin %) lo))
                  (subvec by-end (lower ends lo) (lower ends (inc hi)))))))))

(defn- join-at-token-edges
  "`edits` (old-body coordinates over the code points `o`) with each delete
  that stands after an insert at a token's start, the kept letters between
  them repeating the delete's end, moved back onto the insert, and each
  delete that stands before an insert at a token's end moved up to it the
  same way, when the token holds the letters then deleted. The diff can keep
  a word's letters from a different place than the one that was respelled:
  `kaki é` to `QЖki` came out as `QЖ` typed before `kaki`, its `ak` deleted
  and ` é` deleted, which leaves the typed letters out of the word, where
  `ka` deleted with them is one respelling of it that the word's token
  holds. When the delete cannot move so, the kept letters may be the last
  of the token instead, and the letters before them are deleted: `tat on`
  to `Zڤt` keeps the last `t` of `tat` (and the first of a token ending at
  the insert, in the mirror case). Only letters typed without a space, since
  a new word typed in front of a word stays out of it, and only edits apart
  from the others, since edits that touch are one stretch. `near` gives the
  tokens that begin or end in a stretch (see `tokens-near`)."
  [^ints o near edits]
  (let [blank? (fn [^String v] (.anyMatch (.codePoints v) (reify java.util.function.IntPredicate
                                                            (test [_ c] (space? c)))))
        ;; [s e) slid by k code points, left when k is negative, when each
        ;; step keeps the resulting string
        slid (fn [s e k]
               (if (neg? k)
                 (loop [s s e e k k]
                   (cond (zero? k) [s e]
                         (and (pos? s) (= (aget o (dec s)) (aget o (dec e)))) (recur (dec s) (dec e) (inc k))
                         :else nil))
                 (loop [s s e e k k]
                   (cond (zero? k) [s e]
                         (and (< e (alength o)) (= (aget o s) (aget o e))) (recur (inc s) (inc e) (dec k))
                         :else nil))))
        width? (fn [{:token/keys [begin end]}] (< begin end))
        reach (fn [e] (or (:end e) (:at e)))
        start (fn [e] (or (:start e) (:at e)))]
    (loop [i 0 out []]
      (if (< i (count edits))
        (let [x (edits i)
              y (get edits (inc i))]
          (cond
            ;; insert at a, kept [a s), delete [s e)
            (and (= :insert (:kind x)) (= :delete (:kind y)) (< (:at x) (:start y))
                 (not (blank? (:value x)))
                 ;; edits touching the edit before or after are part of
                 ;; its stretch, and stay with it
                 (not (some-> (peek out) reach (>= (:at x))))
                 (not (some-> (get edits (+ i 2)) start (<= (:end y)))))
            (let [a (:at x)
                  {s :start e :end} y
                  d (- e s)
                  k (- s a)
                  to (slid s e (- k))
                  ;; Or the kept letters are the last of a token beginning
                  ;; at a, and the letters before them deleted: `tat on`
                  ;; to `Zڤt` keeps the last `t` of `tat`, not its first.
                  q (when-not to
                      (->> (near a a)
                           (keep (fn [{:token/keys [begin end]}]
                                   (when (and (= a begin) (< (+ a k) end) (<= end e)
                                              (java.util.Arrays/equals (java.util.Arrays/copyOfRange o (int (- end k)) (int end))
                                                                       (java.util.Arrays/copyOfRange o (int a) (int s))))
                                     end)))
                           sort first))]
              (cond
                (and to (some #(and (width? %) (= a (:token/begin %)) (<= (+ a d) (:token/end %)))
                              (near a a)))
                (recur (+ i 2) (conj out x (assoc y :start (first to) :end (second to))))

                q
                (recur (+ i 2) (cond-> (conj out x {:kind :delete :start a :end (- q k)})
                                 (< q e) (conj {:kind :delete :start q :end e})))

                :else (recur (inc i) (conj out x))))

            ;; delete [s e), kept [e b), insert at b
            (and (= :delete (:kind x)) (= :insert (:kind y)) (< (:end x) (:at y))
                 (not (blank? (:value y)))
                 (not (some-> (peek out) reach (>= (:start x))))
                 (not (some-> (get edits (+ i 2)) start (<= (:at y)))))
            (let [b (:at y)
                  {s :start e :end} x
                  d (- e s)
                  k (- b e)
                  to (slid s e k)
                  ;; or the kept letters are the first of a token ending at b
                  p (when-not to
                      (->> (near b b)
                           (keep (fn [{:token/keys [begin end]}]
                                   (when (and (= b end) (<= s begin) (< (+ begin k) b)
                                              (java.util.Arrays/equals (java.util.Arrays/copyOfRange o (int begin) (int (+ begin k)))
                                                                       (java.util.Arrays/copyOfRange o (int e) (int b))))
                                     begin)))
                           sort last))]
              (cond
                (and to (some #(and (width? %) (= b (:token/end %)) (<= (:token/begin %) (- b d)))
                              (near b b)))
                (recur (+ i 2) (conj out (assoc x :start (first to) :end (second to)) y))

                p
                (recur (+ i 2) (-> out
                                   (cond-> (< s p) (conj {:kind :delete :start s :end p}))
                                   (conj {:kind :delete :start (+ p k) :end b} y)))

                :else (recur (inc i) (conj out x))))

            :else (recur (inc i) (conj out x))))
        out))))

;; ---------------------------------------------------------------------------
;; Aligning a changed stretch word by word
;;
;; The diff is a minimal edit script over letters, and where several are
;; minimal it may keep a letter from a word that was deleted: `sat tat` to
;; `tX` keeps the `t` of `sat` and deletes ` ta`, which leaves the token of
;; `sat` on `t` and `X` outside every word, where deleting `sat ` and
;; respelling `tat` gives the same text and leaves one token on `tX`.

(def ^:private align-limit
  "The longest stretch, in code points of either body, that
  `align-to-words` aligns again. A word edit's stretch is a few words long,
  and the alignment costs the product of the two lengths."
  64)

;; An alignment is a path of steps: :m keeps an old letter as the next new
;; one, :d deletes an old letter, :i inserts a new one. The steps between
;; two kept letters are a run, and a run is judged when it ends. The state
;; while walking one has six parts: `D` what the run has deleted (0
;; nothing, 1 letters of one word, 2 more than that or a space), `F`
;; whether its first deleted letter is in the word of the kept letter
;; before the run, `P` whether that kept letter ends its word at a space
;; or the text's end, `L` whether a letter was typed in the run before any
;; space typed in it, `S` whether a space was typed in it, `R` whether a
;; letter was typed after the last space typed in it.

(defn- run-state [d f p l s r] (+ (* 32 d) (* 16 f) (* 8 p) (* 4 l) (* 2 s) r))

(defn- run-end
  "[orphans touched] for the run ending in `state` before a kept letter.
  `next?` is whether that letter is not a space, `first?` whether it begins
  its word, and `spaced?` whether a space or the text's start is before it.
  Letters typed in the run are held by a word when the run deleted letters
  of that word only (a respelling), when its deletes reach into the kept
  word they touch (the replace is cut at that word's edge), or when they
  are typed between two letters of one word. Otherwise the letters typed
  against a kept word's edge at a space are outside every word's token,
  one orphan for each side they touch. Against an edge between two words
  without a space they may be a new word, which the text cannot tell. A
  space or line break typed between two kept letters of one word counts
  one too, since the word's token stays over it."
  [state next? first? spaced?]
  (let [d (quot state 32) f (bit-and (quot state 16) 1) p (bit-and (quot state 8) 1)
        l (bit-and (quot state 4) 1) s (bit-and (quot state 2) 1) r (bit-and state 1)
        inside? (and next? (not first?))
        held-left? (or (= f 1) (and (zero? d) inside?))
        right? (and next? first? spaced?)]
    (update (cond
              (and (zero? l) (zero? r)) [0 0]
              (= d 1) [0 0]
              (zero? s) [(if (and (or (= p 1) right?) (not (or held-left? inside?))) 1 0)
                         (if (and (zero? d) inside?) 1 0)]
              :else [(+ (if (and (= l 1) (= p 1) (not held-left?)) 1 0)
                        (if (and (= r 1) right?) 1 0))
                     0])
            ;; a space or line break typed between two kept letters of one
            ;; word leaves the word's token over it
            0 + (if (and (= s 1) inside? (or (zero? d) (and (= d 1) (= f 1)))) 1 0))))

(defn- run-step
  "[state' touched] after deleting an old letter (`kind` :d) or typing a new
  one (:i). `sp` is whether the letter is a space, `first?` whether an old
  one begins its word. A letter deleted from a word the run had not yet
  deleted from touches that word."
  [state kind sp first?]
  (let [d (quot state 32) f (bit-and (quot state 16) 1) p (bit-and (quot state 8) 1)
        l (bit-and (quot state 4) 1) s (bit-and (quot state 2) 1) r (bit-and state 1)]
    (case kind
      :d (let [f (if (zero? d) (if (or sp first?) 0 1) f)]
           (if sp
             [(run-state 2 f p l s r) 0]
             [(run-state (cond (zero? d) 1 (and (= d 1) (not first?)) 1 :else 2) f p l s r)
              (if (or (zero? d) first?) 1 0)]))
      :i [(cond sp (run-state d f p l 1 0)
                (zero? s) (run-state d f p 1 s r)
                :else (run-state d f p l s 1))
          0])))

(declare align-to-words*)

(defn align-to-words
  "Rewrite `ops` (as produced by `diff` for `old`, after `normalize-deletes`)
  so that each changed stretch, taken with the word before and after it, is
  aligned word by word where the diff kept a letter of a deleted word in
  place of the respelled word's own. Among the alignments of fewest edits,
  one is preferred that leaves fewer letters typed against a kept word's
  edge at a space or at the punctuation after a word written with spaces,
  where its token does not take them, types no space inside a kept word,
  and joins fewer old words into one new word. Where those tie, the one touching fewer words is
  preferred, and between words without a space only when the diff keeps a
  word by letters from its middle alone and the other alignment types no
  more letters between two such words where it deletes nothing (see
  `edge-typed`): there, which of two words kept a letter is otherwise not
  for the text to say. `sat tat` to `tX` then
  deletes `sat ` and respells `tat`, `a ab` to `aX` deletes `a ` and
  respells `ab`, `café é` to `caЖé` respells `café` and deletes ` é`, and
  `thesattatu` to `taЖ`, three words without spaces, deletes `the` and
  `sat` and respells `tatu`. The diff stays wherever its alignment is as
  good, and so does a stretch longer than `align-limit`. The reconstructed
  string is unchanged.

  Words are the runs between spaces, cut at the edges of the tokens of
  `word-layers` that no such token holds strictly inside it (two words of a
  script without spaces, a word and punctuation left out of it). Without
  `word-layers`, or with none, nothing tells the words, and the ops are
  left as they are."
  ([ops old tokens] (align-to-words ops old tokens nil))
  ([ops old tokens word-layers]
   (if (empty? word-layers)
     ops
     (align-to-words* ops old tokens word-layers))))

(defn- align-to-words*
  [ops old tokens word-layers]
  (let [edits (vec (ops->edits ops))
        ^ints o (.toArray (.codePoints ^String old))
        n (alength o)
        near (tokens-near tokens (count edits))
        sp? (fn [i] (space? (aget o (int i))))
        start-of (fn [e] (or (:start e) (:at e)))
        reach-of (fn [e] (or (:end e) (:at e)))
         ;; the edges between two words without a space, near [lo hi]: the
         ;; ends of the word tokens there that none of them holds strictly
         ;; inside it. By a sweep, since one long delete reaches every word.
        edges (fn [lo hi]
                (let [ws (sort-by :token/begin
                                  (filter (fn [{:token/keys [begin end layer]}]
                                            (and (< begin end) (contains? word-layers layer)))
                                          (near lo hi)))
                      begins (long-array (map :token/begin ws))
                      ;; the furthest end among the first i+1 tokens
                      ;; (none when no word token is near)
                      reach (long-array (rest (reductions max Long/MIN_VALUE (map :token/end ws))))
                      inside? (fn [p]
                                (let [c (loop [x 0 y (alength begins)]
                                          (if (< x y)
                                            (let [h (quot (+ x y) 2)]
                                              (if (< (aget begins h) (long p)) (recur (inc h) y) (recur x h)))
                                            x))]
                                  (and (pos? c) (> (aget reach (dec c)) (long p)))))]
                  (into #{}
                        (comp (mapcat (juxt :token/begin :token/end))
                              (remove inside?))
                        ws)))
         ;; [a b edits] for each stretch, a and b at word edges one word
         ;; beyond its edits each way
        windows
        (reduce
         (fn [ws e]
           (let [lo (max 0 (- (start-of e) align-limit))
                 hi (min n (+ (reach-of e) align-limit))
                 eg (edges lo hi)
                 bound? (fn [p] (or (<= p 0) (>= p n) (sp? (dec p)) (sp? p) (eg p)))
                 ustart (fn [p] (loop [p p] (if (or (<= p lo) (bound? p)) p (recur (dec p)))))
                 uend (fn [p] (loop [p p] (if (or (>= p hi) (bound? p)) p (recur (inc p)))))
                 a (let [k (loop [k (ustart (start-of e))] (if (and (> k lo) (sp? (dec k))) (recur (dec k)) k))]
                     (if (> k lo) (ustart (dec k)) k))
                 b (let [k (loop [k (uend (reach-of e))] (if (and (< k hi) (sp? k)) (recur (inc k)) k))]
                     (if (< k hi) (uend (inc k)) k))
                 [pa pb pes] (peek ws)]
             (if (and pb (<= a pb))
               (conj (pop ws) [pa (max pb b) (conj pes e)])
               (conj ws [a b [e]]))))
         []
         edits)
        ;; the alignment's tables, shared by the windows (see `realign`)
        tables (atom nil)
        window (volatile! 0)
        realign
        (fn [[a b es]]
          (let [eg (edges (max 0 (dec a)) (min n (inc b)))
                bound? (fn [p] (or (<= p 0) (>= p n) (sp? (dec p)) (sp? p) (eg p)))
                m (- b a)
                N (let [sb (StringBuilder.)]
                    (loop [p a es es]
                      (if-let [x (first es)]
                        (do (.append sb (String. o (int p) (int (- (start-of x) p))))
                            (when (= :insert (:kind x)) (.append sb ^String (:value x)))
                            (recur (reach-of x) (rest es)))
                        (.append sb (String. o (int p) (int (- b p))))))
                    (.toArray (.codePoints (str sb))))
                k (alength N)
                first? (fn [i] (bound? (+ a i)))
                 ;; whether the old code point i of the window is a letter a
                 ;; word's token holds (punctuation, in a token of its own or
                 ;; left out of the words, is not)
                letter? (fn [i] (let [c (aget o (int (+ a i)))]
                                  (or (Character/isLetterOrDigit (int c)) (combining-mark? c))))
                in-word? (let [held (boolean-array (inc m))]
                           (doseq [{:token/keys [begin end layer]} (near a (min n (inc b)))
                                   :when (and (< begin end) (contains? word-layers layer))
                                   p (range (max a begin) (min (inc b) end))]
                             (aset held (- p a) true))
                           (fn [i] (and (aget held i) (letter? i))))
                osp (fn [i] (sp? (+ a i)))
                nsp (fn [j] (space? (aget N (int j))))
                lt? (fn [q] (let [c (aget o (int q))] (or (Character/isLetterOrDigit (int c)) (combining-mark? c))))
                 ;; whether the letter at p ends a word written with spaces
                 ;; before punctuation that a space or the text's end
                 ;; follows: `a` in `a! ab`, where letters typed after it
                 ;; are outside its token as at a space
                before-punct? (fn [p]
                                (and (lt? p) (< (inc p) n) (not (lt? (inc p))) (not (sp? (inc p)))
                                     (loop [q (inc p)] (cond (= q n) true (sp? q) true (lt? q) false :else (recur (inc q))))
                                     ;; back to the word's start, then over
                                     ;; punctuation to a space or the text's
                                     ;; start, and not another word's letter
                                     (let [q (loop [q p] (if (and (pos? q) (lt? (dec q)) (not (bound? q))) (recur (dec q)) (dec q)))]
                                       (loop [q q] (cond (< q 0) true (sp? q) true (lt? q) false :else (recur (dec q)))))))
                 ;; whether the old letter at p is not a space and ends its
                 ;; word at a space, the text's end or such punctuation
                spaced-end? (fn [p] (and (not (sp? p)) (or (= (inc p) n) (sp? (inc p)) (before-punct? p))))
                 ;; the same for each letter of the window, looked up in the
                 ;; alignment's inner loop
                window-end (let [xs (boolean-array (max m 1))]
                             (dotimes [i m] (aset xs i (boolean (spaced-end? (+ a i)))))
                             xs)
                spaced-start? (fn [p] (or (zero? p) (sp? (dec p))))
                 ;; Every word of the window ends at a space. Between two
                 ;; words without one, which of them kept a letter is not
                 ;; for the text to say, and the fewest words touched is no
                 ;; better a guess than the diff's.
                spaced? (not-any? (fn [p] (and (< a p b) (not (sp? (dec p))) (not (sp? p)))) eg)
                 ;; A state is a run's (see `run-state`) and a third part
                 ;; `W`: 0 the new word being written holds no kept letter
                 ;; yet, 1 it does, 2 it does and an old space was deleted
                 ;; since. A kept letter then joins two old words in one.
                RS 96
                S (* 3 RS)
                ->w (fn [s] (quot s RS))
                ->r (fn [s] (rem s RS))
                s0 (+ (run-state 0 0 (if (and (pos? a) (spaced-end? (dec a))) 1 0) 0 0 0)
                      (* RS (if (and (pos? a) (not (sp? (dec a)))) 1 0)))
                 ;; [state' bad touched] for each step
                step (fn [s kind i j]
                       (let [w (->w s) r (->r s)]
                         (case kind
                           :m (if (osp i)
                                (let [[x y] (run-end r false false false)]
                                  [(run-state 0 0 0 0 0 0) x y])
                                (let [[x y] (run-end r true (first? i) (spaced-start? (+ a i)))]
                                   ;; A join is left to the replace cut at a
                                   ;; word's edge when the new word reaches into
                                   ;; both old words (see `split-at-token-edges`),
                                   ;; and not when it takes one's first or last
                                   ;; letter.
                                  [(+ (run-state 0 0 (if (aget window-end i) 1 0) 0 0 0) RS)
                                   (+ x (if (and (= w 2) (in-word? i) (or (first? i) (= 1 (bit-and (quot r 8) 1)))) 1 0)) y]))
                           :d (let [[r' y] (run-step r :d (osp i) (first? i))]
                                [(+ r' (* RS (if (and (osp i) (= w 1)) 2 w))) 0 y])
                           :i (let [[r' y] (run-step r :i (nsp j) false)]
                                [(+ r' (* RS (if (nsp j) 0 w))) 0 y]))))
                 ;; a run at the window's end ends before the letter after it
                end-at (fn [s]
                         (let [nx? (and (< b n) (not (sp? b)))
                               [x y] (run-end (->r s) nx? (bound? b) (spaced-start? b))]
                           [(+ x (if (and nx? (= 2 (->w s)) (in-word? m)) 1 0)) y]))
                diff-steps (loop [p a es es out []]
                             (if-let [x (first es)]
                               (let [out (into out (repeat (- (start-of x) p) :m))
                                     out (case (:kind x)
                                           :delete (into out (repeat (- (:end x) (:start x)) :d))
                                           :insert (into out (repeat (cp/cp-count (:value x)) :i)))]
                                 (recur (reach-of x) (rest es) out))
                               (into out (repeat (- b p) :m))))
                key-of (fn [steps]
                         (loop [steps steps i 0 j 0 s s0 c 0 x 0 y 0]
                           (if-let [st (first steps)]
                             (let [[s' dx dy] (step s st i j)]
                               (recur (rest steps) (if (= st :i) i (inc i)) (if (= st :d) j (inc j))
                                      s' (if (= st :m) c (inc c)) (+ x dx) (+ y dy)))
                             (let [[dx dy] (end-at s)] [c (+ x dx) (+ y dy)]))))
                pack (fn [c x y] (+ (* c 1048576) (* x 1024) y))
                 ;; How many old words `steps` keep only by letters from their
                 ;; middle, their first and last letters deleted: `sat`
                 ;; kept as its `a`.
                middles (fn [steps]
                          (loop [steps steps i 0 lost-first? false kept? false out 0]
                            (if-let [st (first steps)]
                              (if (= st :i)
                                (recur (rest steps) i lost-first? kept? out)
                                (let [lost-first? (if (first? i) (= st :d) lost-first?)
                                      kept? (if (first? i) (= st :m) (or kept? (= st :m)))
                                      whole-end? (and (not (osp i)) (bound? (+ a i 1)))]
                                  (recur (rest steps) (inc i) lost-first? kept?
                                         (if (and whole-end? lost-first? kept? (= st :d)) (inc out) out))))
                              out)))
                 ;; How many letters `steps` type between two old words
                 ;; written without a space, in a run that deletes nothing
                 ;; and types no space: a new word, or the end of one of them
                 ;; or the start of the other, which the text cannot tell. No
                 ;; token takes them, where the fold puts the letters typed
                 ;; in a word the diff kept by its middle on that word:
                 ;; `thekaitat` to `theaek` keeps `kai` by its `a`, and the
                 ;; fold gives it `aek`, where keeping it by its `k` left
                 ;; `ae` in no word.
                edge-typed (fn [steps]
                             (loop [steps steps i 0 j 0 dels? false spaced? false typed 0 out 0]
                               (let [st (first steps)]
                                 (if (or (nil? st) (= st :m))
                                   (let [p (+ a i)
                                         out (if (and (pos? typed) (not dels?) (not spaced?) (< 0 p n)
                                                      (lt? (dec p)) (lt? p) (eg p))
                                               (+ out typed)
                                               out)]
                                     (if st
                                       (recur (rest steps) (inc i) (inc j) false false 0 out)
                                       out))
                                   (cond
                                     (= st :d) (recur (rest steps) (inc i) j true spaced? typed out)
                                     (nsp j) (recur (rest steps) i (inc j) dels? true typed out)
                                     ;; combining marks a run starts with join
                                     ;; the letter before them, as an insert
                                     ;; gives them to the token ending there:
                                     ;; `ña` to `ä` beside a deleted word keeps
                                     ;; its `a` and types the mark after it
                                     (and (zero? typed) (combining-mark? (aget N (int j))))
                                     (recur (rest steps) i (inc j) dels? spaced? typed out)
                                     :else (recur (rest steps) i (inc j) dels? spaced? (inc typed) out))))))]
            ;; A stretch of typed text alone deletes no word whose letters
            ;; the diff could have kept, and where it stands is the slide's
            ;; business (text typed at a word's edge stays outside it).
            (when (and (<= m align-limit) (<= k align-limit) (some :end es))
              (let [inf Long/MAX_VALUE
                    ^ints N N
                    a (long a)
                    m (long m)
                    k (long k)
                    k1 (inc k)
                    idx (fn ^long [^long i ^long j ^long s] (+ (* (+ (* i k1) j) S) s))
                    ;; The tables are kept for the next window, and an entry
                    ;; counts only when stamped with this window's number, so
                    ;; no window allocates or fills its own. Each cell lists
                    ;; the states reached in it, so a cell costs what it
                    ;; holds and not all `S` states.
                    cells (* (inc m) k1)
                    size (* cells S)
                    [^longs dp ^ints back ^ints stamp ^ints reached ^ints cell-stamp ^ints cell-count]
                    (let [[_ _ st _ cs :as ts] @tables]
                      (if (and st (<= size (alength ^ints st)) (<= cells (alength ^ints cs)))
                        ts
                        (reset! tables [(long-array size) (int-array size) (int-array size)
                                        (int-array size) (int-array cells) (int-array cells)])))
                    g (int (vswap! window inc))
                    ;; Each step's outcome depends on the state and on the
                    ;; letter it reads alone (an old one for :m and :d, a
                    ;; new one for :i), so it is worked out once for each and
                    ;; kept as one long: the cost to add, shifted past the
                    ;; state after it. A vector built for every step of every
                    ;; cell, and a scan of all `S` states in each, took
                    ;; 2 to 3 s on a find-and-replace over 10,000 words.
                    m-kept (long-array (* (max m 1) S) -1)
                    d-kept (long-array (* (max m 1) S) -1)
                    i-kept (long-array (* (max k 1) S) -1)
                    keep! (fn [^longs kept kind p s]
                            (let [[s' dx dy] (if (= kind :i) (step s kind 0 p) (step s kind p 0))
                                  t (+ (bit-shift-left (long (pack (if (= kind :m) 0 1) dx dy)) 9) (long s'))]
                              (aset kept (+ (* (long p) S) (long s)) t)
                              t))]
                (let [c (idx 0 0 0)
                      x (+ c s0)]
                  (aset cell-stamp c g)
                  (aset cell-count c 1)
                  (aset reached c (int s0))
                  (aset stamp x g)
                  (aset dp x 0)
                  (aset back x -1))
                (dotimes [i (inc m)]
                  (let [oi (if (< i m) (long (aget o (+ a i))) -1)]
                    (dotimes [j k1]
                      (let [cell (+ (* i k1) j)
                            base (* cell S)
                            n (if (== (aget cell-stamp cell) g) (long (aget cell-count cell)) 0)]
                        ;; in the order of the states, as a scan of all of
                        ;; them would take them, so ties go as they did
                        (java.util.Arrays/sort reached (int base) (int (+ base n)))
                        (dotimes [r n]
                          (let [s (long (aget reached (+ base r)))
                                v (aget dp (+ base s))]
                            (when (and (< i m) (< j k) (== oi (aget N j)))
                              (let [t (aget m-kept (+ (* i S) s))
                                    t (if (neg? t) (long (keep! m-kept :m i s)) t)
                                    c (+ (* (inc i) k1) (inc j))
                                    s' (bit-and t 511)
                                    x (+ (* c S) s')
                                    w (+ v (bit-shift-right t 9))]
                                (if (== (aget stamp x) g)
                                  (when (< w (aget dp x))
                                    (aset dp x w)
                                    (aset back x (int (+ (* s 4) 2))))
                                  (let [n (if (== (aget cell-stamp c) g) (long (aget cell-count c)) 0)]
                                    (aset cell-stamp c g)
                                    (aset cell-count c (inc n))
                                    (aset reached (+ (* c S) n) (int s'))
                                    (aset stamp x g)
                                    (aset dp x w)
                                    (aset back x (int (+ (* s 4) 2)))))))
                            (when (< i m)
                              (let [t (aget d-kept (+ (* i S) s))
                                    t (if (neg? t) (long (keep! d-kept :d i s)) t)
                                    c (+ (* (inc i) k1) j)
                                    s' (bit-and t 511)
                                    x (+ (* c S) s')
                                    w (+ v (bit-shift-right t 9))]
                                (if (== (aget stamp x) g)
                                  (when (< w (aget dp x))
                                    (aset dp x w)
                                    (aset back x (int (* s 4))))
                                  (let [n (if (== (aget cell-stamp c) g) (long (aget cell-count c)) 0)]
                                    (aset cell-stamp c g)
                                    (aset cell-count c (inc n))
                                    (aset reached (+ (* c S) n) (int s'))
                                    (aset stamp x g)
                                    (aset dp x w)
                                    (aset back x (int (* s 4)))))))
                            (when (< j k)
                              (let [t (aget i-kept (+ (* j S) s))
                                    t (if (neg? t) (long (keep! i-kept :i j s)) t)
                                    c (+ (* i k1) (inc j))
                                    s' (bit-and t 511)
                                    x (+ (* c S) s')
                                    w (+ v (bit-shift-right t 9))]
                                (if (== (aget stamp x) g)
                                  (when (< w (aget dp x))
                                    (aset dp x w)
                                    (aset back x (int (+ (* s 4) 1))))
                                  (let [n (if (== (aget cell-stamp c) g) (long (aget cell-count c)) 0)]
                                    (aset cell-stamp c g)
                                    (aset cell-count c (inc n))
                                    (aset reached (+ (* c S) n) (int s'))
                                    (aset stamp x g)
                                    (aset dp x w)
                                    (aset back x (int (+ (* s 4) 1)))))))))))))
                (let [total (fn [s] (let [x (idx m k s) v (if (== (aget stamp x) g) (aget dp x) inf)]
                                      (if (< v inf) (+ v (let [[x y] (end-at s)] (pack 0 x y))) inf)))
                      best (reduce (fn [b s] (if (< (total s) (total b)) s b)) 0 (range S))
                      steps (loop [i m j k s best out ()]
                              (if (and (zero? i) (zero? j))
                                (vec out)
                                (let [x (aget back (idx i j s))
                                      op (rem x 4)
                                      ps (quot x 4)]
                                  (case op
                                    0 (recur (dec i) j ps (conj out :d))
                                    1 (recur i (dec j) ps (conj out :i))
                                    2 (recur (dec i) (dec j) ps (conj out :m))))))
                      [dc dx dy] (key-of diff-steps)
                      [bc bx by] (key-of steps)]
                  (when (and (= bc dc)
                             (or (< bx dx)
                                 (and (= bx dx) (< by dy)
                                      (or spaced?
                                          (and (< (middles steps) (middles diff-steps))
                                               (<= (edge-typed steps) (edge-typed diff-steps)))))))
                     ;; each run of the steps as one delete and one insert
                    (loop [steps steps i 0 j 0 out []]
                      (if (empty? steps)
                        out
                        (if (= :m (first steps))
                          (recur (rest steps) (inc i) (inc j) out)
                          (let [run (take-while #(not= :m %) steps)
                                dn (count (filter #{:d} run))
                                in (count (filter #{:i} run))]
                            (recur (drop (count run) steps) (+ i dn) (+ j in)
                                   (cond-> out
                                     (pos? dn) (conj {:kind :delete :start (+ a i) :end (+ a i dn)})
                                     (pos? in) (conj {:kind :insert :at (+ a i dn)
                                                      :value (String. N (int j) (int in))})))))))))))))
        ;; a window longer than the aligner looks is left as it is before
        ;; any work on it
        out (reduce (fn [out [a b es :as w]]
                      (into out (or (when (<= (- b a) align-limit) (realign w)) es)))
                    [] windows)]
    (if (= out edits) ops (edits->ops out))))

(defn slide-to-tokens
  "Rewrite `ops` (as produced by `diff` for `old`) so that each delete or
  insert that stands apart from the others, and could stand elsewhere for the
  same resulting string, stands where it disturbs the fewest of `tokens`
  (old-body code-point offsets, see `slide-cost`). Among several such
  places the one that cuts fewest of them wins (see `slide-cuts`), then the
  nearest, so an edit already at such a place stays there. Edits that touch
  stay together, since they are one gap (see `plain-body-gaps`). The
  reconstructed string is unchanged. `partitioning` is the set of the
  tokens' layers that are partitions (see `slide-cost`)."
  ([ops old tokens] (slide-to-tokens ops old tokens #{}))
  ([ops old tokens partitioning]
   (let [partitioning (set partitioning)
         edits (vec (ops->edits ops))
         ^ints o (.toArray (.codePoints ^String old))
         n (alength o)
         reach-of (fn [e] (if (= :delete (:kind e)) (:end e) (:at e)))
         start-of (fn [e] (if (= :delete (:kind e)) (:start e) (:at e)))
         near (tokens-near tokens (count edits))
         moved (reduce
                (fn [moved e]
                  (let [i (count moved)
                        prev (get edits (dec i))
                        nxt (get edits (inc i))
                        ;; A neighbour this edit touches makes the two one
                        ;; stretch, and a place that touches one would too.
                        ;; The edit before may already have moved, towards
                        ;; this one or away from it, and the two must not
                        ;; meet where it now stands.
                        lo (if prev (inc (reach-of (peek moved))) 0)
                        hi (if nxt (dec (start-of nxt)) n)]
                    (conj moved
                          (if (or (< (start-of e) lo) (> (reach-of e) hi))
                            e
                            (let [places (slide-places o e lo hi)
                                  near (near (reduce min (map start-of places))
                                             (reduce max (map reach-of places)))
                                  cost #(slide-cost o near partitioning %)
                                  here (cost e)]
                              (if (zero? here)
                                e
                                ;; The fewest disturbed, then the fewest cut, then
                                ;; the nearest place. The sort is stable and
                                ;; `places` starts with the edit itself.
                                (first (sort-by (juxt cost
                                                      #(slide-cuts near %)
                                                      #(Math/abs (long (- (start-of %) (start-of e)))))
                                                places))))))))
                []
                edits)]
     (if (= edits moved) ops (edits->ops moved)))))

(defn normalize-deletes
  "Rewrite `ops` (as produced by `diff` for `old`) so that two deletes
  separated by a kept run equal to an edge of the adjacent deleted text
  become one contiguous delete when that cuts fewer of `tokens` (old-body
  code-point offsets), and a delete that keeps a word's letters from the
  wrong place beside letters typed at the word's edge is moved onto them
  (see `join-at-token-edges`). The reconstructed string is unchanged."
  [ops old tokens]
  (let [edits (ops->edits ops)
        near (tokens-near tokens (count edits))
        ^ints o (.toArray (.codePoints ^String old))
        ;; whether the code points from s1 to e1 are those from s2 on
        same? (fn [s1 e1 s2]
                (loop [i 0]
                  (cond (= (+ s1 i) e1) true
                        (= (aget o (+ s1 i)) (aget o (+ s2 i))) (recur (inc i))
                        :else false)))
        ;; Whether the delete ranges `rs` (sorted, apart) overlap token `t`
        ;; only partly.
        cut? (fn [rs {:token/keys [begin end]}]
               (and (< begin end)
                    (let [n (count rs)
                          ;; the first range ending after the token begins
                          k (loop [x 0 y n]
                              (if (< x y)
                                (let [h (quot (+ x y) 2)]
                                  (if (> (second (rs h)) begin) (recur x h) (recur (inc h) y)))
                                x))]
                      (loop [k k]
                        (if (and (< k n) (< (first (rs k)) end))
                          (let [[s e] (rs k)]
                            (if (not (and (<= s begin) (<= end e))) true (recur (inc k))))
                          false)))))
        ;; How many tokens `rs` cut, counted over the tokens that begin or
        ;; end in [lo, hi] only. Merging two deletes changes the ranges
        ;; within that stretch alone, so a token wholly outside it is cut
        ;; alike before and after, and so is one reaching past both ends:
        ;; the comparison is the same as over every token. Counting every
        ;; token for every pair of deletes took 12 s on a find-and-replace
        ;; over 10,000 words, under the write lock.
        cuts (fn [rs ts] (count (filter #(cut? rs %) ts)))
        ;; The delete ranges of `v` that can meet the tokens `ts` near the
        ;; pair at i, with the pair replaced by `c` when one is given: those
        ;; reaching into [from, to), found by position, since collecting
        ;; every range for every pair took 20 s on a long text pasted over
        ;; by another. `cut?` reads only the ranges meeting the token.
        ranges-near (fn [v i c ts lo hi]
                      (let [from (reduce min lo (map :token/begin ts))
                            to (reduce max hi (map :token/end ts))
                            start-of #(or (:start %) (:at %))
                            j (loop [x 0 y (count v)]
                                (if (< x y)
                                  (let [h (quot (+ x y) 2)]
                                    (if (< (start-of (v h)) from) (recur (inc h) y) (recur x h)))
                                  x))
                            j (if (and (pos? j) (:end (v (dec j))) (> (:end (v (dec j))) from)) (dec j) j)]
                        (loop [j j out (transient [])]
                          (if (and (< j (count v)) (< (start-of (v j)) to))
                            (let [e (v j)]
                              (cond
                                (and c (= j i)) (recur (+ j 2) (conj! out [(:start c) (:end c)]))
                                (= (:kind e) :delete) (recur (inc j) (conj! out [(:start e) (:end e)]))
                                :else (recur (inc j) out)))
                            (persistent! out)))))
        step (fn [edits]
               (let [v (vec edits)]
                 (loop [i 0]
                   (when (< (inc i) (count v))
                     (let [a (v i) b (v (inc i))]
                       (if (and (= (:kind a) :delete) (= (:kind b) :delete)
                                (< (:end a) (:start b)))
                         (let [m (- (:start b) (:end a))
                               candidates
                               (cond-> []
                                 ;; kept run == tail of the second delete: delete [a.start, b.end-m)
                                 (and (<= m (- (:end b) (:start b)))
                                      (same? (:end a) (:start b) (- (:end b) m)))
                                 (conj {:kind :delete :start (:start a) :end (- (:end b) m)})
                                 ;; kept run == head of the first delete: delete [a.start+m, b.end)
                                 (and (<= m (- (:end a) (:start a)))
                                      (same? (:end a) (:start b) (:start a)))
                                 (conj {:kind :delete :start (+ (:start a) m) :end (:end b)}))
                               best (when (seq candidates)
                                      (let [lo (:start a)
                                            hi (:end b)
                                            ts (near lo hi)
                                            before (cuts (ranges-near v i nil ts lo hi) ts)]
                                        (->> candidates
                                             (map (fn [c] [(cuts (ranges-near v i c ts lo hi) ts) c]))
                                             (filter (fn [[n _]] (< n before)))
                                             (sort-by first)
                                             first)))]
                           (if best
                             (into (subvec v 0 i) (into [(second best)] (subvec v (+ i 2))))
                             (recur (inc i))))
                         (recur (inc i))))))))]
    (loop [edits edits merged? false]
      (if-let [next (step edits)]
        (recur (vec (remove nil? next)) true)
        ;; Untouched input when nothing merged: the caller's ops are already
        ;; valid, so don't risk a lossy round trip.
        (let [joined (join-at-token-edges o near (vec edits))]
          (if (or merged? (not= joined edits)) (edits->ops joined) ops))))))

(declare apply-text-edits*)

(defn- ops-body
  "The text `ops` make of `old`, or nil when one of them does not fit it.
  Through a gap buffer, so ops in nearly their order cost the text they
  move. Applying them in turn copies the whole text for each op out of
  order, which took seconds on a long text pasted over by another."
  [ops ^String old]
  (let [^ints o (.toArray (.codePoints old))
        n (alength o)
        typed (reduce + 0 (keep #(when (string? (:value %)) (cp/cp-count (:value %))) ops))
        cap (+ n typed)
        buf (int-array cap)]
    (System/arraycopy o 0 buf (- cap n) n)
    (loop [ops (seq ops) gs 0 ge (- cap n)]
      (if-let [{:keys [index value length] :as op} (first ops)]
        (let [type (op-type (:type op))
              len (+ gs (- cap ge))
              cut (case type :delete value :replace length :insert 0 nil)
              typed (when (#{:insert :replace} type) value)]
          (when (and (int? index) (<= 0 index len) (int? cut) (<= 0 cut (- len index))
                     (or (= type :delete) (string? typed)))
            ;; the gap to index
            (let [[gs ge] (cond
                            (< index gs) (let [k (- gs index)]
                                           (System/arraycopy buf index buf (- ge k) k)
                                           [index (- ge k)])
                            (> index gs) (let [k (- index gs)]
                                           (System/arraycopy buf ge buf gs k)
                                           [index (+ ge k)])
                            :else [gs ge])
                  ge (+ ge cut)
                  gs (if typed
                       (let [^ints v (.toArray (.codePoints ^String typed))]
                         (System/arraycopy v 0 buf gs (alength v))
                         (+ gs (alength v)))
                       gs)]
              (recur (next ops) gs ge))))
        (str (String. buf 0 (int gs)) (String. buf (int ge) (int (- cap ge))))))))

(defn- token-edit
  "A function of one token giving what `op` (valid, its type a keyword) does
  to it, the rules of `apply-text-edit`: the token moved or resized, or nil
  when the op deletes it."
  [{:keys [type index value length]}]
  (let [shift (fn [t d] (-> t (update :token/begin + d) (update :token/end + d)))]
    (case type
      :insert
      (let [offset (cp/cp-count value)
            marks (if (pos? index) (leading-marks value) 0)]
        (fn [{:token/keys [begin end] :as t}]
          (cond
            (< end index) t
            (= end index) (cond (zero? marks) t
                                (< begin index) (update t :token/end + marks)
                                :else (shift t marks))
            (< begin index) (update t :token/end + offset)
            :else (shift t offset))))

      :delete
      (let [ei (+ index value)]
        (fn [{:token/keys [begin end] :as t}]
          (if (= begin end)
            (cond (<= end index) t
                  (< index begin ei) nil
                  :else (shift t (- value)))
            (cond (and (<= index begin) (<= end ei)) nil
                  (<= end index) t
                  (<= ei begin) (shift t (- value))
                  (< begin index) (if (<= end ei)
                                    (assoc t :token/end index)
                                    (update t :token/end - value))
                  :else (-> t (assoc :token/begin index) (update :token/end - value))))))

      :replace
      (cond
        (zero? length) (token-edit (insert-op index value))
        (= value "") (token-edit (delete-op index length))
        (and (pos? index) (pos? (leading-marks value)))
        (let [k (leading-marks value)
              f (token-edit (insert-op index (cp/cp-subs value 0 k)))
              g (token-edit (replace-op (+ index k) length (cp/cp-subs value k)))]
          (fn [t] (some-> t f g)))
        :else
        (let [ei (+ index length)
              delta (- (cp/cp-count value) length)
              del (token-edit (delete-op index length))
              ins (token-edit (insert-op index value))]
          (fn [{:token/keys [begin end] :as t}]
            (cond
              (and (< begin end) (<= begin index) (<= ei end)) (update t :token/end + delta)
              (and (= begin end) (= end ei)) (shift t delta)
              :else (some-> t del ins))))))))

(defn- apply-text-edits-in-turn
  "`apply-text-edits` one op after another, each over the whole text and
  every token."
  [ops text tokens]
  (loop [accum {:deleted [] :text text :tokens tokens}
         op (first ops)
         ops (rest ops)]
    (if (nil? op)
      accum
      (let [result (apply-text-edit op (:text accum) (:tokens accum))
            new-accum (-> accum
                          (assoc :text (:text result))
                          (assoc :tokens (:tokens result))
                          (update :deleted into (:deleted result)))]
        (recur new-accum (first ops) (rest ops))))))

(defn apply-text-edits
  "Apply `ops` one after another to `text` and `tokens`, as `apply-text-edit`
  does each (same result, same 400s). Returns {:text :tokens :deleted}, as
  `apply-text-edit` does, the tokens and ids in no promised order.

  Ops that each stand at or after where the one before left off (every op
  list `diff` and the steps after it give, and most a client sends) are
  applied in one pass: the body is built once, and each token is put through
  only the ops that reach it, after the shift of those before it. Applying
  each op over the whole text and every token cost seconds for a thousand
  edits over a long text, with the write lock held. Other op lists are
  applied a run of such ops at a time: one op out of that order among the
  7,000 a long line retyped gave cost a minute applied in turn."
  [ops text tokens]
  (apply-text-edits* ops text tokens))

(defn- apply-text-edits*
  [ops text tokens]
  (let [ops (vec (take-while some? ops))
        ^String body (:text/body text)
        ^ints o (.toArray (.codePoints body))
        n (alength o)
        ;; Validate as the ops come, and place each in the old body: an op
        ;; at running index i stands at old position i - shift. `edits` is
        ;; nil once an op stands before where the previous one left off,
        ;; which is op `break`.
        {:keys [edits break]}
        (reduce (fn [{:keys [len shift reach edits break] :as acc} op]
                  (let [type (check-op! op len)
                        {:keys [index value length]} op
                        [del ins] (case type
                                    :insert [0 (cp/cp-count value)]
                                    :delete [value 0]
                                    :replace [length (cp/cp-count value)])
                        s (- index shift)
                        t (+ s del)]
                    (assoc acc
                           :len (+ len (- ins del))
                           :shift (+ shift (- ins del))
                           :reach t
                           :edits (when (and edits (<= reach s))
                                    (conj edits {:op (assoc op :type type) :start s :end t
                                                 :delta (- ins del)
                                                 :value (if (= type :delete) "" value)}))
                           :break (or break (when (and edits (< s reach)) (count edits))))))
                {:len n :shift 0 :reach 0 :edits []}
                ops)]
    (if-not edits
      ;; The ops before `break` stand in order, and so do the first run of
      ;; those from it on: each run in one pass, over what the one before
      ;; made, is the ops applied in turn.
      (loop [ops ops j break text text tokens tokens deleted []]
        (let [{t :text ts :tokens d :deleted} (apply-text-edits (subvec ops 0 j) text tokens)
              ops (subvec ops j)
              deleted (into deleted d)]
          (if (empty? ops)
            {:text t :tokens ts :deleted deleted}
            ;; how many of the rest stand in order
            (recur ops
                   (loop [i 0 shift 0 reach 0]
                     (if (< i (count ops))
                       (let [{:keys [type index value length]} (ops i)
                             [del ins] (case (op-type type)
                                         :insert [0 (cp/cp-count value)]
                                         :delete [value 0]
                                         :replace [length (cp/cp-count value)])
                             s (- index shift)]
                         (if (< s reach) i (recur (inc i) (+ shift (- ins del)) (+ s del))))
                       i))
                   t ts deleted))))
      (let [k (count edits)
            new-body (let [sb (StringBuilder.)]
                       (loop [p 0 es edits]
                         (if-let [{:keys [start end value]} (first es)]
                           (do (.append sb (String. o (int p) (int (- start p))))
                               (.append sb ^String value)
                               (recur end (rest es)))
                           (.append sb (String. o (int p) (int (- n p))))))
                       (str sb))
            ends (long-array (map :end edits))
            ;; where each op stands when it is applied
            at (long-array (map (comp :index :op) edits))
            ;; the shift of the edits before each
            before (long-array (reductions + 0 (map :delta edits)))
            fns (mapv (comp token-edit :op) edits)
            ;; the first index in xs whose value is at least x
            lower (fn [^longs xs x]
                    (loop [a 0 b (alength xs)]
                      (if (< a b)
                        (let [m (quot (+ a b) 2)]
                          (if (< (aget xs m) (long x)) (recur (inc m) b) (recur a m)))
                        a)))
            edit-token (fn [{:token/keys [begin] :as t}]
                         ;; The edits that end before it only shift it. From
                         ;; the first that reaches it, each op stands at or
                         ;; after where the one before stood, so once one
                         ;; stands past the token's end, none of the rest
                         ;; touches it.
                         (let [lo (lower ends begin)
                               d (aget before lo)
                               t (if (zero? d)
                                   t
                                   (-> t (update :token/begin + d) (update :token/end + d)))]
                           (loop [i lo t t]
                             (if (and t (< i k) (<= (aget at i) (long (:token/end t))))
                               (recur (inc i) ((fns i) t))
                               t))))
            results (mapv (fn [t] [t (edit-token t)]) tokens)]
        {:text (assoc text :text/body new-body)
         :tokens (into [] (keep second) results)
         :deleted (into [] (keep (fn [[t t']] (when-not t' (:token/id t)))) results)}))))

;; ---------------------------------------------------------------------------
;; Edits from the caret
;;
;; An editor that knows where each change was made sends the changes as ops
;; (`PATCH /texts/:id` with `edits`). Nothing is guessed about where they
;; stand: the caret said. The ops are composed into their net change, gaps of
;; old text and what stands there now, which the plain rule below then reads.

(defn compose-edits
  "The net change `ops` make to `old`, as gaps in old-body code points,
  `[{:start a :end b :value v}]`: between two runs of old text that came
  through, [a b) of `old` went and `v` stands there now. In old-body order,
  never touching, each an insert (a = b), a delete (v empty) or both. A gap
  whose `v` is the text it took is left out (a letter deleted and typed
  back).

  `ops` are running-coordinate ops, applied in order (each op's index is in
  the body the ops before it left), as `apply-text-edits` takes them. Each
  is checked against that body, and a malformed or out-of-bounds one throws
  the 400 `apply-text-edit` would. Old text an op deletes is gone even when
  the same letters are typed back later, so the gaps depend only on what
  came through, never on the order or the grouping of the keystrokes. So a
  zero-width token strictly inside a stretch deleted a letter at a time is
  deleted as it is by one delete of the stretch: two words joined by
  deleting the letters and the space between them are one word, and a
  marker of the edge of either has no edge left to mark."
  [ops ^String old]
  (let [n (cp/cp-count old)
        ;; the new text as segments: [:old a b] for old text that came
        ;; through, [:new s k] for k typed code points
        seg-len (fn [[kind x y]] (if (= kind :old) (- y x) y))
        cut (fn [[kind x y side :as seg] k]
              ;; the segment's first k code points and the rest
              (if (= kind :old)
                [[:old x (+ x k)] [:old (+ x k) y]]
                [[:new (cp/cp-subs x 0 k) k side] [:new (cp/cp-subs x k) (- y k) side]]))
        ;; A finger over the segments: `left` (a vector) before it, `right`
        ;; (a list) after it, `pos` its place in the new text and `len` the
        ;; new text's length. Each op moves the finger to its index, cutting a
        ;; segment there, drops what it deletes from `right` and puts what it
        ;; types on `left`, so ops near each other (typing, a paste split into
        ;; many ops) cost what the finger moves, not the whole text.
        segs (loop [ops (seq ops)
                    left []
                    right (if (pos? n) (list [:old 0 n]) ())
                    pos 0
                    len n]
               (if-let [op (first ops)]
                 (let [type (check-op! op len)
                       {:keys [index value length]} op
                       k (case type :insert 0 :delete value :replace length)
                       v (if (= type :delete) "" value)
                       vn (cp/cp-count v)
                       ;; the finger to `index`
                       [left right] (loop [left left right right pos pos]
                                      (cond
                                        (< index pos)
                                        (let [seg (peek left) l (seg-len seg)]
                                          (if (<= (- pos l) index)
                                            (let [[x y] (cut seg (- index (- pos l)))]
                                              [(conj (pop left) x) (conj right y)])
                                            (recur (pop left) (conj right seg) (- pos l))))
                                        (> index pos)
                                        (let [seg (first right) l (seg-len seg)]
                                          (if (<= index (+ pos l))
                                            (let [[x y] (cut seg (- index pos))]
                                              [(conj left x) (conj (rest right) y)])
                                            (recur (conj left seg) (rest right) (+ pos l))))
                                        :else [left right]))
                       ;; `k` code points dropped after it
                       right (loop [right right k k]
                               (if (pos? k)
                                 (let [seg (first right) l (seg-len seg)]
                                   (if (<= l k)
                                     (recur (rest right) (- k l))
                                     (conj (rest right) (second (cut seg k)))))
                                 right))]
                   (recur (next ops) (conj left [:new v vn (some-> (:side op) keyword)]) right (+ index vn) (+ (- len k) vn)))
                 ;; runs of typed or kept text next to each other are read
                 ;; as one below
                 (into [] (remove #(zero? (seg-len %))) (concat left right))))
        ;; the gaps between the runs of old text that came through
        ;; A gap's `:side` is the side its typed text was typed on where two
        ;; tokens meet (`side` on an op, :before or :after), when its ops say
        ;; one and only one.
        gaps (loop [segs segs pos 0 typed (StringBuilder.) sides #{} out []]
               (let [[kind x y side :as seg] (first segs)
                     flush (fn [a]
                             (let [v (str typed)]
                               (if (or (< pos a) (pos? (count v)))
                                 (conj out (cond-> {:start pos :end a :value v}
                                             (= 1 (count sides)) (assoc :side (first sides))))
                                 out)))]
                 (cond
                   (nil? seg) (flush n)
                   (= kind :new) (recur (rest segs) pos (.append typed ^String x)
                                        (cond-> sides (and side (pos? y)) (conj side)) out)
                   :else (recur (rest segs) y (StringBuilder.) #{} (flush x)))))
        same? (fn [{:keys [start end value]}]
                (and (< start end) (= value (cp/cp-subs old start end))))]
    (into [] (remove same?) gaps)))

(defn edit-ops-body
  "The text `ops` (running coordinates, applied in turn) make of `old`, or
  nil when one does not fit it."
  [ops ^String old]
  (ops-body ops old))

(defn gap-ops
  "Running ops for `gaps` (old-body order, never touching, see
  `compose-edits`): an insert, a delete, or a replace each."
  [gaps]
  (loop [gaps gaps shift 0 out []]
    (if-let [{:keys [start end value]} (first gaps)]
      (let [i (+ start shift)
            k (- end start)
            n (cp/cp-count value)]
        (recur (rest gaps) (+ shift (- n k))
               (conj out (cond
                           (zero? k) (insert-op i value)
                           (zero? n) (delete-op i k)
                           :else (replace-op i k value)))))
      out)))

;; ---------------------------------------------------------------------------
;; Plain edits
;;
;; Every token layer takes a text edit the plain way, the one rule set of a
;; body save: an edit inside a token, or touching its edge with no whitespace
;; between, grows or shrinks the token, and nothing else happens to it. A
;; token is never split by a typed space (unless a layer of the text sets
;; `splitOnSpace`), never joined to its neighbour by a deleted one, never
;; folded onto another word, and loses nothing hanging off it. Only a token
;; whose whole text is deleted goes. A word can hold a space (a FLEx phrase),
;; and its analysis is the app's business, not the core's.

(defn- trim-gap
  "`gap` without the text its new value shares with the old at either end,
  or nil when nothing is left of it."
  [^ints o {:keys [start end value] :as gap}]
  (let [^ints v (.toArray (.codePoints ^String value))
        n (alength v)
        k (- end start)
        p (loop [p 0] (if (and (< p n) (< p k) (= (aget v p) (aget o (+ start p)))) (recur (inc p)) p))
        s (loop [s 0] (if (and (< s (- n p)) (< s (- k p)) (= (aget v (- n 1 s)) (aget o (- end 1 s))))
                        (recur (inc s))
                        s))]
    (cond
      (and (zero? p) (zero? s)) gap
      (and (= (+ p s) n) (= (+ p s) k)) nil
      :else (assoc gap :start (+ start p) :end (- end s) :value (String. v (int p) (int (- n p s)))))))

;; A stretch of several words typed over as words of its own is each word
;; typed over: `不 大` to `x y` is `不` typed over as `x` and `大` as `y`,
;; so each word keeps its token and what hangs off it (Luke, 2026-09-21: a
;; replaced word keeps its annotations). Where there are more old words than
;; new, the last new word goes to the old word left that shares the most
;; letters with it, the first on a tie (`cat eel` to `one` keeps `eel`), and
;; the other old words are deleted. Where there are more new words than old,
;; the last old word goes the same way to a new word, and the others are in
;; no word.
;; A replace over several words is not read this way on the edits path: it
;; is read as a whole-body save reads it (see `plain-edit-gaps`).

(defn- cp-runs
  "The runs of `cs` from `from` to `to`, each `[b e ws?]`, whitespace or not."
  [^ints cs from to]
  (loop [i from out []]
    (if (< i to)
      (let [w (space? (aget cs i))
            e (loop [j (inc i)] (if (and (< j to) (= w (space? (aget cs j)))) (recur (inc j)) j))]
        (recur e (conj out [i e w])))
      out)))

(defn- shared-letters
  "How many letters `cs`[b, e) and `vs`[x, y) have in common, counted with
  repeats."
  [^ints cs b e ^ints vs x y]
  (let [f (frequencies (map #(aget vs %) (range x y)))]
    (first (reduce (fn [[n f] i]
                     (let [c (aget cs i) k (get f c 0)]
                       (if (pos? k) [(inc n) (assoc f c (dec k))] [n f])))
                   [0 f] (range b e)))))

(defn- letter?
  "Whether code point `c` is part of a word's text: a letter, a digit or a
  combining mark, not punctuation."
  [c]
  (or (Character/isLetterOrDigit (int c)) (combining-mark? c)))

(defn- pair-words
  "Pieces `[old-b old-e new-b new-e keep]`, in order, for old [`a`, `b`)
  holding the words `ow` typed over as new [`x`, `y`) holding the words
  `vw` (extents in `o` and `v`), none of them the same on both sides: old
  word i is typed over as new word i. Where there are more old words than
  new, the last new word goes to the old word left that the stretch
  reaches into at its start or end (a letter of it beside the stretch, as
  the plain rule gives it), else the one sharing most letters with it, the
  first on a tie, and the other old words go. Where there are more new
  words than old, the last old word goes the same way to the new word left
  it reaches into or shares most letters with, and the other new words are
  typed apart from every word."
  [^ints o ^ints v ow vw a b x y]
  (let [m (count ow)
        n (count vw)]
    (if (or (zero? m) (zero? n))
      [[a b x y nil]]
      (let [ob (fn [i] (first (ow i))) oe (fn [i] (second (ow i)))
            vb (fn [i] (first (vw i))) ve (fn [i] (second (vw i)))
            most (fn [score from to] (reduce (fn [a i] (if (> (score i) (score a)) i a)) from (range (inc from) to)))
            at-start? (fn [i] (and (pos? a) (= a (ob i)) (letter? (aget o (dec a)))))
            at-end? (fn [i] (and (< b (alength o)) (= b (oe i)) (letter? (aget o b))))
            typed (fn [i j] [(ob i) (oe i) (vb j) (ve j) [(ob i) (oe i)]])
            words (if (<= n m)
                    (let [l (dec n)
                          best (cond
                                 (at-start? l) l
                                 (at-end? (dec m)) (dec m)
                                 :else (most #(shared-letters o (ob %) (oe %) v (vb l) (ve l)) l m))]
                      (conj (mapv #(typed % %) (range l))
                            [(ob l) (oe (dec m)) (vb l) (ve l) [(ob best) (oe best)]]))
                    (let [l (dec m)
                          best (cond
                                 (at-end? l) (dec n)
                                 (at-start? l) l
                                 :else (most #(shared-letters o (ob l) (oe l) v (vb %) (ve %)) l n))]
                      (conj (mapv #(typed % %) (range l)) (typed l best))))]
        (concat [[a (nth (first words) 0) x (nth (first words) 2) nil] (first words)]
                (mapcat (fn [p q] [[(p 1) (q 0) (p 3) (q 2) nil] q]) words (rest words))
                [[(nth (peek words) 1) b (nth (peek words) 3) y nil]])))))

(defn- cut-at-words
  "`gap` (see `compose-edits`) cut where its old and new text are words with
  whitespace between, typed over word by word (see `pair-words`). The
  pieces whose old and new text are the same are left out. Pieces that touch
  stay one gap, which then carries `:keeps`, each `[b e off len]`: the token
  over exactly old [b, e) goes on the gap's new text from `off` for `len`. A
  gap with fewer than two old words, or no new word, is left whole."
  [^ints o {:keys [start end value] :as gap}]
  (let [^ints v (.toArray (.codePoints ^String value))
        ow (filterv #(not (nth % 2)) (cp-runs o start end))
        vw (filterv #(not (nth % 2)) (cp-runs v 0 (alength v)))]
    (if (or (< (count ow) 2) (empty? vw))
      [gap]
      (let [;; [old-b old-e new-b new-e keep], in order
            pieces (pair-words o v ow vw start end 0 (alength v))
            same? (fn [[a b x y]] (and (= (- b a) (- y x))
                                       (every? #(= (aget o (+ a %)) (aget v (+ x %))) (range (- b a)))))
            changed (remove same? pieces)
            ;; pieces that touch are one gap
            groups (reduce (fn [out [a :as p]]
                             (if (and (seq out) (= a (second (peek (peek out)))))
                               (conj (pop out) (conj (peek out) p))
                               (conj out [p])))
                           [] changed)]
        (mapv (fn [ps]
                (let [[a _ x] (first ps)
                      [_ b _ y] (peek ps)
                      keeps (vec (keep (fn [[_ _ px py kp]] (when kp [(first kp) (second kp) (- px x) (- py px)])) ps))]
                  (cond-> {:start a :end b :value (String. v (int x) (int (- y x)))}
                    (:side gap) (assoc :side (:side gap))
                    (seq keeps) (assoc :keeps keeps))))
              groups)))))

(defn- edits->gaps
  "Old-coordinate edits in position order (see `ops->edits`) as gaps: edits
  that touch are one gap."
  [edits]
  (reduce (fn [out e]
            (let [s (or (:start e) (:at e))
                  t (or (:end e) (:at e))
                  v (or (when (string? (:value e)) (:value e)) "")
                  prev (peek out)]
              (if (and prev (= (:end prev) s))
                (conj (pop out) (assoc prev :end t :value (str (:value prev) v)))
                (conj out {:start s :end t :value v}))))
          []
          edits))

(defn- gaps-body
  [^String old gaps]
  (let [^ints o (.toArray (.codePoints old))
        sb (StringBuilder.)
        copy! (fn [from to] (loop [i from] (when (< i to) (.appendCodePoint sb (aget o i)) (recur (inc i)))))]
    (loop [gaps gaps at 0]
      (if-let [{:keys [start end value]} (first gaps)]
        (do (copy! at start)
            (.append sb ^String value)
            (recur (rest gaps) end))
        (copy! at (alength o))))
    (str sb)))

(defn- pin-points-to-edges
  "`points` (zero-width tokens as a text edit left them) with each one that a
  token of its own layer now holds strictly inside, though the point stood
  outside it (at its edge, or apart from it: a segment that follows its
  sentence can take the whitespace and text before a point), moved to that
  token's edge on the side it stood: its end when it stood at or after the
  end, its begin when at or before the begin."
  [old-tokens kept points]
  (let [was (into {} (map (juxt :token/id identity)) old-tokens)]
    (mapv (fn [{:token/keys [id layer begin] :as z}]
            (let [p (:token/begin (was id))
                  t (some (fn [t] (when (and (= layer (:token/layer t)) (< (:token/begin t) begin (:token/end t))) t)) kept)
                  w (some-> t :token/id was)]
              (cond
                (or (nil? t) (nil? w) (nil? p)) z
                (>= p (:token/end w)) (assoc z :token/begin (:token/end t) :token/end (:token/end t))
                (<= p (:token/begin w)) (assoc z :token/begin (:token/begin t) :token/end (:token/begin t))
                :else z)))
          points)))

(defn follow-sentences
  "`kept` (tokens as a text edit left them) with each follower (`follower?`)
  whose old extent was a sentence's (a token of a layer in `partitioning`),
  less the whitespace at the sentence's edges, set to that sentence's extent
  as the partition's gap-fill will leave it (see
  `compensate-partition-layers!`), less the whitespace at its edges,
  whatever text the sentence took. A time-alignment segment over its
  sentence keeps covering it. `heads` are the sentences to be made at the
  start of the text (see `apply-plain-gaps`), `nw` the new text's code
  points."
  [^ints o old-tokens kept heads ^ints nw partitioning follower?]
  (let [n (alength nw)
        trim (fn [^ints cs [b e]]
               (let [b (loop [x b] (if (and (< x e) (space? (aget cs x))) (recur (inc x)) x))
                     e (loop [x e] (if (and (> x b) (space? (aget cs (dec x)))) (recur (dec x)) x))]
                 [b e]))
        was (into {} (map (juxt :token/id identity)) old-tokens)
        now (into {} (map (juxt :token/id identity)) kept)
        parts (filter #(partitioning (:token/layer %)) old-tokens)
        ;; each surviving partition token's extent after the gap-fill
        filled (into {}
                     (mapcat (fn [[layer ts]]
                               (let [head? (some #(= layer (:token/layer %)) heads)
                                     live (vec (sort-by :token/begin (keep #(now (:token/id %)) ts)))
                                     c (count live)]
                                 (map-indexed (fn [i t]
                                                [(:token/id t)
                                                 [(if (and (zero? i) (not head?)) 0 (:token/begin t))
                                                  (if (= i (dec c)) n (:token/begin (live (inc i))))]])
                                              live))))
                     (group-by :token/layer parts))
        by-extent (group-by #(trim o [(:token/begin %) (:token/end %)]) parts)]
    (mapv (fn [{:token/keys [id] :as t}]
            (let [{:token/keys [begin end]} (was id)
                  sentence (when (and begin (< begin end) (follower? t))
                             (some #(filled (:token/id %)) (by-extent [begin end])))]
              (if-let [[b e] (some->> sentence (trim nw))]
                (if (< b e) (assoc t :token/begin b :token/end e) t)
                t)))
          kept)))

(defn- split-spaced-words
  "`{:placed :made}`: `placed` (the tokens `apply-plain-gaps` placed,
  `::gone` marking the deleted) with each word (`word?`) that the edit typed
  whitespace inside split there, and `made`, the new tokens the split
  makes (Luke, 2026-10-02: ud splits a word a space is typed in). A word is
  cut only at the runs of whitespace holding typed whitespace, never at
  spaces it had. It stays on the part holding the most of its old letters
  (the first on a tie), with what hangs off it, and each other part holding
  one of its old letters is a new token of its layer (a part of typed text
  alone is text typed apart from the word, in no word). The tokens under the word (`child?`) as long as
  it go one to each part, in order of precedence, when there are as many
  of a layer as parts (a multi-word token `can't`, `ca` + `n't`, typed as
  `ca n't` leaves each word on its own part). Otherwise they stay with the
  word, and each new part gets a new token of that layer as long as it. A
  token that stood strictly inside the word goes to the part holding most
  of its kept letters, cut to it, and is deleted when it holds nothing of
  any. Another token as long as the word stays with it, and one over
  several words that began or ended with it begins or ends where it does
  now. `typed?` says whether a new-body position holds typed text."
  [^ints nw old-tokens placed word? part? typed? child?]
  (let [was (into {} (map (juxt :token/id identity)) old-tokens)
        letter-at? (fn [i] (and (not (typed? i)) (not (space? (aget nw i)))))
        ;; the old letters kept, by new position
        kept (fn [x y] (count (filter letter-at? (range x y))))
        ;; old extent -> {:keep [x y] :pieces [[x y] ...] :layer}
        splits (into {}
                     (keep (fn [{:token/keys [id begin end layer] :as t}]
                             (let [{ob :token/begin oe :token/end} (was id)]
                               (when (and (word? t) (not (::gone t)) ob)
                                 ;; the whitespace runs holding typed whitespace
                                 (let [cuts (loop [i begin out [] run nil]
                                              (if (< i end)
                                                (if (space? (aget nw i))
                                                  (recur (inc i) out (let [[x t?] (or run [i false])] [x (or t? (typed? i))]))
                                                  (recur (inc i) (if (and run (second run)) (conj out [(first run) i]) out) nil))
                                                out))]
                                   (when (seq cuts)
                                     (let [pieces (mapv vector (cons begin (map second cuts)) (concat (map first cuts) [end]))
                                           best (reduce max (map #(apply kept %) pieces))
                                           kp (first (filter #(= best (apply kept %)) pieces))]
                                       ;; a part with none of its old letters is
                                       ;; text typed apart from it, in no word
                                       [[ob oe] {:keep kp
                                                 :pieces (or (not-empty (filterv #(pos? (apply kept %)) pieces)) [kp])
                                                 :layer layer}])))))))
                     placed)
        live? (fn [t] (and (not (::gone t)) (was (:token/id t)) (not (part? t)) (not (word? t))))
        ;; the tokens under a split word as long as it, by word and layer
        under (group-by (fn [t] (let [{ob :token/begin oe :token/end} (was (:token/id t))]
                                  [[ob oe] (:token/layer t)]))
                        (filter #(and (live? %) (child? %)
                                      (let [{ob :token/begin oe :token/end} (was (:token/id %))]
                                        (splits [ob oe])))
                                placed))
        ;; those that go one to each part: id -> part
        shared (into {}
                     (mapcat (fn [[[w _] ts]]
                               (let [pieces (:pieces (splits w))]
                                 (when (= (count ts) (count pieces))
                                   (map vector
                                        (map :token/id (sort-by #(or (:token/precedence (was (:token/id %))) 0) ts))
                                        pieces)))))
                     under)
        made (into []
                   (mapcat (fn [[w {kp :keep :keys [pieces layer]}]]
                             (for [p pieces
                                   :when (not= p kp)
                                   t (cons {:token/layer layer :token/begin (first p) :token/end (second p)}
                                           (keep (fn [[[w2 l] ts]]
                                                   (when (and (= w2 w) (not (shared (:token/id (first ts)))))
                                                     {:token/layer l :token/begin (first p) :token/end (second p)}))
                                                 under))]
                               t)))
                   splits)
        edge-moves (into {} (map (fn [[[ob _] {[x y] :keep}]] [ob [x y]])) splits)
        end-moves (into {} (map (fn [[[_ oe] {[x y] :keep}]] [oe [x y]])) splits)]
    (if (empty? splits)
      {:placed placed :made []}
      {:placed
       (mapv (fn [{:token/keys [id begin end] :as t}]
               (let [{ob :token/begin oe :token/end} (was id)
                     inside (when ob (some (fn [[[wb we] s]] (when (and (<= wb ob) (<= oe we) (not (and (= wb ob) (= oe we)))) s)) splits))]
                 (cond
                   (or (::gone t) (nil? ob) (part? t)) t
                   (shared id) (let [[x y] (shared id)] (assoc t :token/begin x :token/end y))
                   (splits [ob oe]) (let [[x y] (:keep (splits [ob oe]))] (assoc t :token/begin x :token/end y))
                   ;; inside a split word: to the part holding most of it
                   inside
                   (let [in (fn [[x y]] [(max begin x) (min end y)])
                         score (fn [p] (let [[b e] (in p)] [(kept b e) (- e b)]))
                         best (reduce (fn [a p] (if (pos? (compare (score p) (score a))) p a)) (:pieces inside))
                         [b e] (in best)]
                     (if (< b e) (assoc t :token/begin b :token/end e) (assoc t ::gone true)))
                   ;; over several words: an edge at a split word's edge follows it
                   :else (let [b (if-let [[x _] (edge-moves ob)] x begin)
                               e (if-let [[_ y] (end-moves oe)] y end)]
                           (if (< b e) (assoc t :token/begin b :token/end e) t)))))
             placed)
       :made made})))

(defn apply-plain-gaps
  "What `gaps` (old-body code points, in order, never touching, each
  `{:start a :end b :value v}`, see `compose-edits`) do to `old` and to
  `tokens` taken the plain way. Returns `{:text :tokens :deleted}` as
  `apply-text-edits` does, with `:heads`, the sentences made over a line
  typed before the first one, and with `split-on-space`, `:made`, the new
  tokens of the words a typed space split (see `split-spaced-words`), each
  `{:token/layer :token/begin :token/end}`, a word before the tokens under
  it.

  For a token with text, [B, E):
  - A gap inside it, or reaching one of its ends from inside, grows or
    shrinks it (a space typed inside is inside it).
  - A gap that takes its last letters, or stands right after it, gives it
    the letters the new text starts with, up to the first whitespace, when
    its last letter kept is not whitespace. Likewise a gap that takes its
    first letters or stands right before it gives it the letters the new
    text ends with, after the last whitespace, when its first letter kept is
    not whitespace. New text with no whitespace between two such tokens
    goes to the word holding the gap at that end, else the first. A gap
    that is exactly a token's text (a word, a sentence with its separator,
    a segment) goes to that token alone, which keeps its place on it.
  - Where new text goes is decided by the words, the tokens on a layer in
    `word-layers` (else every token on no layer in `partitioning`), and the
    other tokens follow them, so a sentence or a time-alignment segment
    keeps to the words' edges and no two tokens of a layer overlap.
  - A gap that takes all of it, and more, deletes it.
  - The new text between the letters given to the tokens either side
    belongs to neither.
  - A token left beginning or ending on whitespace it did not begin or end
    on is moved off it onto its letters (`ki` deleted from `thung ki` leaves
    the word on `thung`), and one left with only whitespace is deleted.

  A zero-width token is moved as `apply-text-edits` moves it."
  ([old tokens gaps partitioning word-layers]
   (apply-plain-gaps old tokens gaps partitioning word-layers nil))
  ([^String old tokens gaps partitioning word-layers {:keys [caret split-on-space children exclusive head-layers]}]
   (let [^ints o (.toArray (.codePoints old))
         len (alength o)
         partitioning (set partitioning)
         word-layers (set word-layers)
         gaps (vec gaps)
         k (count gaps)
         ws? (fn [c] (space? c))
         info (mapv (fn [{:keys [start end value]}]
                      (let [^ints v (.toArray (.codePoints ^String value))
                            n (alength v)
                            run (fn [idx] (loop [i 0] (if (and (< i n) (not (ws? (aget v (int (idx i)))))) (recur (inc i)) i)))
                            lead (run identity)
                            trail (run #(- n 1 %))]
                        {:a start :b end :n n :delta (- n (- end start))
                         :lead lead :trail trail :word? (= lead n)
                         :before-ok (and (pos? lead) (pos? start) (not (ws? (aget o (dec start)))))
                         :after-ok (and (pos? trail) (< end len) (not (ws? (aget o end))))}))
                    gaps)
         new-body (gaps-body old gaps)
         ^ints nw (.toArray (.codePoints ^String new-body))
        ;; shift[i]: what the gaps before gap i add to a position
         shift (long-array (inc k))
         _ (dotimes [i k] (aset shift (inc i) (+ (aget shift i) (long (:delta (info i))))))
         starts (long-array (map :start gaps))
        ;; the last gap starting at or before x, or -1
         at-or-before (fn [x]
                        (loop [lo 0 hi k]
                          (if (< lo hi)
                            (let [m (quot (+ lo hi) 2)]
                              (if (<= (aget starts m) (long x)) (recur (inc m) hi) (recur lo m)))
                            (dec lo))))
         wide (filterv #(< (:token/begin %) (:token/end %)) tokens)

         zero (filterv #(= (:token/begin %) (:token/end %)) tokens)
        ;; The tokens that decide where new text goes: the words, those on a
        ;; layer in `word-layers`, else every token on no partition. The
        ;; others (sentences, time-alignment segments) follow them.
         deciders (let [ws (filterv #(word-layers (:token/layer %)) wide)]
                    (if (seq ws) ws (filterv #(not (partitioning (:token/layer %))) wide)))
         decider-layers (into #{} (map :token/layer) deciders)
        ;; the tokens whose text is one of a gap's words typed over (see
        ;; `cut-at-words`), a word's: old extent to [gap offset length]. Its
        ;; morphemes as long as it and its nodes go with it.
         keep-at (let [extents (into #{} (map (juxt :token/begin :token/end)) deciders)]
                   (into {} (mapcat (fn [g] (keep (fn [[b e off len]] (when (extents [b e]) [[b e] [g off len]])) (:keeps (gaps g)))))
                         (range k)))
        ;; What the words have at each gap: one
        ;; ending at its start or inside it, one beginning inside it or at its
        ;; end, one holding it at its end or at its start (the gap reaches
        ;; that end of the token from inside), one it is exactly.
         flags (let [f (object-array k)
                     mark! (fn [g x] (aset f g (conj (or (aget f g) #{}) x)))]
                 (doseq [{:token/keys [begin end]} deciders]
                   (let [g (at-or-before end)]
                     (when (>= g 0)
                       (let [{:keys [a b]} (info g)]
                         (if (< a b)
                           (cond
                             (and (< begin a) (<= a end) (< end b)) (mark! g :before)
                             (and (<= begin a) (= end b)) (mark! g :holds-end))
                           (when (and (= end a) (< begin a)) (mark! g :before))))))
                   (let [g (at-or-before begin)]
                     (when (>= g 0)
                       (let [{:keys [a b]} (info g)]
                         (if (< a b)
                           (cond
                             (and (< a begin) (<= begin b) (< b end)) (mark! g :after)
                             (and (= begin a) (<= b end)) (mark! g :holds-start))
                           (when (and (= begin a) (< a end)) (mark! g :after)))))))
                ;; A gap that is exactly a token's text (a word, a sentence
                ;; with its separator, a segment) is that token typed over.
                 (doseq [{:token/keys [begin end]} wide]
                   (let [g (at-or-before begin)]
                     (when (>= g 0)
                       (let [{:keys [a b]} (info g)]
                         (when (and (< a b) (= begin a) (= end b)) (mark! g :exact))))))
                 f)
         flag? (fn [g x] (contains? (aget ^objects flags g) x))
        ;; an insert's `side`, where two words, two sentences or two rows
        ;; (tokens of a layer that forbids overlap beside the words, the words
        ;; leaving out punctuation) meet at it with no whitespace between,
        ;; else none
         row? (fn [l] (and (contains? exclusive l) (not (partitioning l))
                           (not (decider-layers l)) (not (contains? children l))))
         row-ends (into #{} (comp (filter #(row? (:token/layer %))) (map (juxt :token/layer :token/end))) wide)
         sentence-starts (into #{} (comp (filter #(or (partitioning (:token/layer %))
                                                      (row-ends [(:token/layer %) (:token/begin %)])))
                                         (map :token/begin))
                               wide)
         side-of (fn [g]
                   (let [{:keys [a b]} (info g)]
                     (when (and (= a b) (pos? a) (< a len)
                                (not (ws? (aget o (dec a)))) (not (ws? (aget o a)))
                                (or (and (flag? g :before) (flag? g :after))
                                    (sentence-starts a)))
                       (:side (gaps g)))))
         new-at (fn [g] (+ (long (:a (info g))) (aget shift g)))
        ;; [the letters the tokens ending at the gap take, the letters those
        ;; beginning after it take], the same for every layer, so that a
        ;; partition keeps to the words' edges. New text with no whitespace
        ;; goes to one side: the word holding the gap at that end, else the
        ;; word before it, else the one after. A gap a token is exactly goes
        ;; to that token alone.
         given (mapv (fn [g]
                       (let [{:keys [n lead trail word? before-ok after-ok]} (info g)
                             before? (and before-ok (or (flag? g :before) (flag? g :holds-end)))
                             after? (and after-ok (or (flag? g :after) (flag? g :holds-start)))]
                         (cond
                           (flag? g :exact) [0 0]
                           ;; the caret said which side it typed on, where
                           ;; two words meet with no whitespace
                           (= :after (side-of g)) [0 (if word? n trail)]
                           (= :before (side-of g)) [(if word? n lead) 0]
                           (not word?) [(if before? lead 0) (if after? trail 0)]
                           (flag? g :holds-end) [(if before-ok n 0) 0]
                           (flag? g :holds-start) [0 (if after-ok n 0)]
                           before? [n 0]
                           after? [0 n]
                           :else [0 0])))
                     (range k))
        ;; a word typed over as a word of its own at the gap's start or end
        ;; holds the new text there, which no neighbour takes
         given (let [held (reduce (fn [m [_ [g off len]]]
                                    (cond-> m
                                      (zero? off) (assoc-in [g 0] true)
                                      (= (+ off len) (:n (info g))) (assoc-in [g 1] true)))
                                  {} keep-at)]
                 (mapv (fn [g [x y]] (let [h (held g)] [(if (get h 0) 0 x) (if (get h 1) 0 y)])) (range k) given))
         given-before (fn [g] (first (given g)))
         given-after (fn [g] (second (given g)))
        ;; text typed where two sentences meet, between whitespace and the
        ;; next sentence's first letter, goes to that sentence when the
        ;; caret put it there
         by-caret? (fn [g {:token/keys [layer]}]
                     (let [{:keys [a b]} (info g)]
                       (and caret (= a b) (pos? a) (< a len) (partitioning layer)
                            (ws? (aget o (dec a))) (not (ws? (aget o a)))
                           ;; text holding a line break goes to the sentence
                           ;; before: a line added before a sentence is a
                           ;; sentence of its own, to be split off
                            (not (re-find #"[\n\r\u0085\u2028\u2029]" (:value (gaps g)))))))
         placed (mapv (fn [{:token/keys [begin end layer] :as t}]
                        (if-let [[g off len] (keep-at [begin end])]
                          ;; one of the gap's words typed over: it goes on
                          ;; its new word
                          (assoc t :token/begin (+ (new-at g) off) :token/end (+ (new-at g) off len))
                          (let [gb (at-or-before begin)
                                {:keys [a b n]} (when (>= gb 0) (info gb))
                              ;; the gap's words typed over that the token
                              ;; holds: an edge of it inside the gap, or at
                              ;; the edge of one of them, goes to their edge
                              ;; (a sentence keeps its word, a node its words)
                                inner (fn [g] (filter (fn [[kb ke]] (and (<= begin kb) (<= ke end) (keep-at [kb ke]))) (:keeps (gaps g))))
                                nb (cond
                                     (neg? gb) begin
                                     (and (< a b) (<= a begin) (< begin b) (or (< a begin) (< end b) (some #(= begin (first %)) (inner gb))) (seq (inner gb)))
                                     (+ (new-at gb) (reduce min (map #(nth % 2) (inner gb))))
                                  ;; a gap took its first letters, or stands
                                  ;; right before it
                                     (and (< a begin) (<= begin b))
                                     (if (<= end b) nil (- (+ (new-at gb) n) (given-after gb)))
                                     (= a begin)
                                     (cond
                                       (and (= a b) (by-caret? gb t)) (new-at gb)
                                     ;; the text typed where two words meet
                                     ;; goes whole to the side the caret said
                                       (and (= a b) (or (partitioning layer) (row? layer)) (= :after (side-of gb))) (new-at gb)
                                       (and (= a b) (or (partitioning layer) (row? layer)) (= :before (side-of gb))) (+ (new-at gb) n)
                                       (= a b) (- (+ (new-at gb) n) (given-after gb))
                                       (>= end b) (+ (new-at gb) (given-before gb))
                                       :else nil)
                                     :else (+ begin (aget shift (inc gb))))
                                ge (at-or-before end)
                                {a2 :a b2 :b n2 :n} (when (>= ge 0) (info ge))
                                ne (cond
                                     (neg? ge) end
                                     (and (< a2 end) (<= end b2) (or (< end b2) (< a2 begin) (some #(= end (second %)) (inner ge))) (seq (inner ge)))
                                     (+ (new-at ge) (reduce max (map #(+ (nth % 2) (nth % 3)) (inner ge))))
                                   ;; and a row ending there takes it whole
                                     (and (= a2 b2 end) (row? layer) (= :before (side-of ge))) (+ (new-at ge) n2)
                                     (or (= a2 end) (and (< a2 end) (< end b2)))
                                     (if (< begin a2) (+ (new-at ge) (given-before ge)) nil)
                                     (and (< a2 end) (= end b2))
                                     (if (<= begin a2) (- (+ (new-at ge) n2) (given-after ge)) nil)
                                     :else (+ end (aget shift (inc ge))))]
                            (if (and nb ne (< nb ne))
                           ;; off whitespace it did not have at that edge
                              (let [nb (if (ws? (aget o begin))
                                         nb
                                         (loop [x nb] (if (and (< x ne) (ws? (aget nw x))) (recur (inc x)) x)))
                                    ne (if (ws? (aget o (dec end)))
                                         ne
                                         (loop [x ne] (if (and (> x nb) (ws? (aget nw (dec x)))) (recur (dec x)) x)))]
                                ;; one left with only whitespace, that had
                                ;; letters, is gone
                                (if (and (< nb ne)
                                         (not (and (every? #(ws? (aget nw %)) (range nb ne))
                                                   (some #(not (ws? (aget o %))) (range begin end)))))
                                  (assoc t :token/begin nb :token/end ne)
                                  (assoc t ::gone true)))
                              (assoc t ::gone true)))))
                      wide)
         {placed :placed made :made}
         (if split-on-space
           (let [typed (let [a (boolean-array (alength nw))]
                         (dotimes [g k]
                           (let [na (new-at g)] (dotimes [j (:n (info g))] (aset a (+ na j) true))))
                         a)]
             (split-spaced-words nw wide placed
                                 (if (seq (filter #(word-layers (:token/layer %)) wide))
                                   #(word-layers (:token/layer %))
                                   #(not (partitioning (:token/layer %))))
                                 #(partitioning (:token/layer %))
                                 #(aget typed (int %))
                                 #(contains? (set children) (:token/layer %))))
           {:placed placed})
         zero-r (when (seq zero) (apply-text-edits (gap-ops gaps) {:text/body old} zero))
         kept (filterv (complement ::gone) placed)
         was-token (let [m (into {} (map (juxt :token/id identity)) wide)] #(m (:token/id %)))
        ;; A line typed before the text's first sentence, one holding a
        ;; letter before its last line break, is a sentence of its own
        ;; (`:heads`): the new text before the first sentence's first letter
        ;; left, whatever the save's shape.
         firsts (filter #(and (partitioning (:token/layer %)) (zero? (:token/begin %))
                              (or (nil? head-layers) (contains? head-layers (:token/layer %))))
                        wide)
         head-end (when-let [{:token/keys [end]} (first firsts)]
                    (let [in-gap? (fn [i] (let [g (at-or-before i)]
                                            (and (>= g 0) (< i (:b (info g))) (<= (:a (info g)) i))))
                          q (first (filter #(and (not (ws? (aget o %))) (not (in-gap? %))) (range 0 end)))]
                      (when q
                        (let [p (+ q (aget shift (inc (at-or-before q))))
                              p (if (neg? (at-or-before q)) q p)
                              prefix (String. nw 0 (int p))
                              m (last (re-seq #"[\s\S]*[\n\r\u0085\u2028\u2029]" prefix))]
                          (when (and m (re-find #"\S" m))
                            (let [k (cp/cp-count m)]
                             ;; not over a whole word the edit kept (one typed
                             ;; over with the line)
                              (when-not (some #(and (decider-layers (:token/layer %))
                                                    (<= (:token/end %) k))
                                              kept)
                                k)))))))
        ;; the first sentence, and any token reaching over the line (a word
        ;; typed over at its start with it), begin at the first letter after
        ;; the line
         kept (if head-end
                (mapv (fn [t] (if (and (< head-end (:token/end t))
                                       (or (< (:token/begin t) head-end)
                                           (some #(= (:token/id %) (:token/id t)) firsts)))
                                (let [e (:token/end t)
                                      b (loop [x head-end] (if (and (< x e) (ws? (aget nw x))) (recur (inc x)) x))]
                                  (assoc t :token/begin (min b (dec e))))
                                t))
                      kept)
                kept)
         heads (when head-end
                 (mapv (fn [{:token/keys [layer]}] {:token/layer layer :token/begin 0 :token/end head-end})
                       (filter #(some (fn [f] (= (:token/id f) (:token/id %))) firsts) kept)))
         kept (follow-sentences o wide kept heads nw partitioning
                                (fn [t] (not (or (not (contains? exclusive (:token/layer t)))
                                                 (partitioning (:token/layer t))
                                                 (decider-layers (:token/layer t))
                                                 (contains? children (:token/layer t))))))]
     (cond-> {:text {:text/body new-body}
              ;; a point at the edge of a token of its layer that grew over it
              ;; stays at that edge, so nothing ends up inside another
              :tokens (into kept (pin-points-to-edges tokens kept (:tokens zero-r)))
              :deleted (into (mapv :token/id (filter ::gone placed)) (:deleted zero-r))}
       (seq heads) (assoc :heads heads)
       ;; the parts of a word split by a typed space (see `split-spaced-words`)
       (seq made) (assoc :made made)))))

(defn- word-extents
  "The old extents of the words of `tokens`: those on `word-layers`, else
  every token on no layer in `partitioning`."
  [tokens partitioning word-layers]
  (let [ws (filter #(contains? (set word-layers) (:token/layer %)) tokens)]
    (into #{} (map (juxt :token/begin :token/end))
          (if (seq ws) ws (remove #(contains? (set partitioning) (:token/layer %)) tokens)))))

(defn- merge-in-words
  "`gaps` with the gaps inside one word of `tokens` (`word?`), with no
  whitespace between them and none typed, made one gap when taken apart
  they would delete a token inside the word: `cow`, analysed `co` + `w`,
  saved as `abc` is the word typed over (its morphemes go, as the edits
  path has it, 2026-09-27), not `ab` typed before `c` and `ow` deleted,
  which left `co` on `abc` and deleted `w`. A respelling inside each token
  (`cat`, `ca` + `t`, to `bad`) is left as it is."
  [gaps ^ints o tokens word?]
  (let [wide (vec (sort-by :token/begin (filter #(< (:token/begin %) (:token/end %)) tokens)))
        wbegins (long-array (map :token/begin wide))
        words (vec (filter word? wide))
        begins (long-array (map :token/begin words))
        ;; the first index whose value is above x
        upper (fn [^longs xs x] (loop [a 0 b (alength xs)]
                                  (if (< a b)
                                    (let [h (quot (+ a b) 2)] (if (<= (aget xs h) (long x)) (recur (inc h) b) (recur a h)))
                                    a)))
        word-of (fn [{:keys [start end]}]
                  (let [i (dec (upper begins start))]
                    (when (>= i 0) (let [w (words i)] (when (<= end (:token/end w)) w)))))
        blank? (fn [^String v] (.anyMatch (.codePoints v) (reify java.util.function.IntPredicate (test [_ c] (space? c)))))
        apart? (fn [x y] (some #(space? (aget o %)) (range (:end x) (:start y))))
        ;; runs of gaps in one word with no whitespace between
        runs (reduce (fn [out g]
                       (let [w (word-of g)
                             [pw run] (peek out)]
                         (if (and w pw (= (:token/id w) (:token/id pw)) (not (blank? (:value g)))
                                  (not (blank? (:value (peek run)))) (not (apart? (peek run) g)))
                           (conj (pop out) [pw (conj run g)])
                           (conj out [w [g]]))))
                     [] gaps)
        ;; whether the gaps of `run` taken apart delete the token: one holds
        ;; it, and is not exactly its text typed over
        goes? (fn [run {tb :token/begin te :token/end}]
                (some (fn [{:keys [start end value]}]
                        (and (<= start tb) (<= te end)
                             (not (and (= start tb) (= end te) (seq value)))))
                      run))]
    (into []
          (mapcat (fn [[w run]]
                    (if (and w (< 1 (count run))
                             (some #(goes? run %)
                                   (subvec wide (upper wbegins (dec (:token/begin w)))
                                           (upper wbegins (dec (:token/end w))))))
                      (let [a (:start (first run))]
                        [{:start a :end (:end (peek run))
                          :value (apply str (map-indexed (fn [i g]
                                                           (str (when (pos? i)
                                                                  (let [f (run (dec i))] (String. o (int (:end f)) (int (- (:start g) (:end f))))))
                                                                (:value g)))
                                                         run))}])
                      run)))
          runs)))

(defn- body-word-layers
  "The layers whose tokens are the words of a whole-body save: `word-layers`,
  else every layer of `tokens` that is no partition."
  [tokens partitioning word-layers]
  (if (seq word-layers)
    (set word-layers)
    (into #{} (comp (map :token/layer) (remove (set partitioning))) tokens)))

(defn body-diff-gaps
  "The change a whole-body save of `old` as `new` reads, before it reads any
  stretch as words typed over: the diff, each edit moved to the equivalent
  place that disturbs the fewest `tokens` (see `slide-to-tokens` and
  `normalize-deletes`), each changed stretch aligned to the words of
  `word-layers` (see `align-to-words`), and edits that touch one gap. A
  letter outside these gaps is a letter the save keeps, and no token
  holding one is deleted. With `align?` false, the stretches are left as
  the diff spells them."
  ([old new tokens partitioning] (body-diff-gaps old new tokens partitioning nil))
  ([old new tokens partitioning word-layers] (body-diff-gaps old new tokens partitioning word-layers true))
  ([^String old ^String new tokens partitioning word-layers align?]
   (-> (diff old new)
       (slide-to-tokens old tokens partitioning)
       (normalize-deletes old tokens)
       (cond-> align? (align-to-words old tokens (body-word-layers tokens partitioning word-layers)))
       ops->edits
       edits->gaps)))

(defn plain-body-gaps
  "The gaps a whole-body save of `old` as `new` is taken as: those of
  `body-diff-gaps`, the gaps inside one word that would delete a token
  inside it made one gap (see `merge-in-words`), and each gap cut where it
  types words over words (see `cut-at-words`). Neither step reaches a
  letter outside the diff's gaps but inside the one word it reads as typed
  over, so no word with a letter left is deleted."
  ([old new tokens partitioning] (plain-body-gaps old new tokens partitioning nil))
  ([^String old ^String new tokens partitioning word-layers]
   (let [^ints o (.toArray (.codePoints old))
         wl (body-word-layers tokens partitioning word-layers)]
     (-> (body-diff-gaps old new tokens partitioning word-layers)
         (merge-in-words o tokens #(contains? wl (:token/layer %)))
         (->> (into [] (mapcat #(cut-at-words o %))))))))

(defn- pick-reading
  "`[gaps result]`: of the two readings of a change of `old`, `gaps` (the
  words aligned, typed over and retyped, see `plain-body-gaps`) and `gaps0`
  (a delay of the diff as it stands, see `body-diff-gaps`), and
  `apply-plain-gaps` of it. `gaps` is taken when every token it deletes
  `gaps0` deletes too, not counting the tokens under the words
  (`:children`, a morpheme of a word typed over), or when it deletes
  fewer, else `gaps0`. So a change never deletes a word its own diff keeps
  letters of only to keep another (REV2-one-rule): where two readings each
  delete one word, the diff's is taken."
  [^String old tokens gaps gaps0 partitioning word-layers opts]
  (let [opts (dissoc opts :caret)
        run #(apply-plain-gaps old tokens % partitioning word-layers opts)
        layer-of (into {} (map (juxt :token/id :token/layer)) tokens)
        children (set (:children opts))
        counted (fn [r] (into #{} (remove #(children (layer-of %))) (:deleted r)))
        read (run gaps)
        gone (counted read)]
    (if (empty? gone)
      [gaps read]
      (let [as-diffed (run @gaps0)
            gone0 (counted as-diffed)]
        (if (or (every? gone0 gone) (< (count gone) (count gone0)))
          [gaps read]
          [@gaps0 as-diffed])))))

(defn plain-body-read
  "`[gaps result]`: the gaps a whole-body save of `old` as `new` is taken as
  and `apply-plain-gaps` of them, the aligned reading (`plain-body-gaps`) or
  the diff as it stands, as `pick-reading` chooses."
  [^String old ^String new tokens partitioning word-layers opts]
  (pick-reading old tokens
                (plain-body-gaps old new tokens partitioning word-layers)
                (delay (body-diff-gaps old new tokens partitioning word-layers false))
                partitioning word-layers opts))

(defn plain-body
  "`apply-plain-gaps` for a whole-body save of `old` as `new`, as
  `plain-body-read` reads it."
  ([old new tokens partitioning word-layers] (plain-body old new tokens partitioning word-layers nil))
  ([old new tokens partitioning word-layers opts]
   (second (plain-body-read old new tokens partitioning word-layers opts))))

(defn plain-edit-gaps
  "The gaps an edit of `old` by `ops` from the caret is taken as, for
  `tokens` (see `apply-plain-gaps` for `partitioning`, `word-layers` and
  `opts`): its net change (see `compose-edits`), each gap of it taken apart
  and as it was made, less the text its new value shares with the old at
  either end. A gap that only deletes or only types carries all it means
  and is always taken so: a word shrinks, and goes only with all its
  letters (REV2-F-TEXT-CORE R1).

  A gap that both deletes and types, reaching inside two words or more, or
  inside one and holding or typing words with whitespace between (a paste
  over a line, a row or the whole body, a selection typed over), is read as
  a whole-body save reads the stretch it was sent over (see
  `plain-body-read`; the text outside the stretch is the same), so a word
  pasted in, left out or typed over moves no other word (H1-IGT-TEXT-1,
  REV-F-TEXT-CORE). That reading is taken when it deletes no word or
  sentence that the gap as sent keeps, or deletes fewer, weighed on the
  text between the gap's neighbours. Where both delete the same, it is
  taken unless it leaves a word over a run of typed text of its own with
  whitespace between (`hi` on `Oh my.\nHi`) and the gap as sent does not.
  Otherwise the gap is taken as made."
  ([old ops tokens partitioning word-layers] (plain-edit-gaps old ops tokens partitioning word-layers nil))
  ([^String old ops tokens partitioning word-layers opts]
   (let [^ints o (.toArray (.codePoints old))
         n (alength o)
         ;; the words' old extents, by begin, and the longest
         words (vec (sort (word-extents tokens partitioning word-layers)))
         begins (long-array (map first words))
         longest (reduce max 0 (map (fn [[b e]] (- e b)) words))
         ;; how many words [a, b) touches the inside of, two at most
         over (fn [a b] (let [from (loop [lo 0 hi (alength begins)]
                                     (if (< lo hi)
                                       (let [m (quot (+ lo hi) 2)]
                                         (if (< (aget begins m) (- a longest)) (recur (inc m) hi) (recur lo m)))
                                       lo))]
                          (loop [i from k 0]
                            (if (and (< i (count words)) (< k 2) (< (aget begins i) b))
                              (recur (inc i) (if (> (second (words i)) a) (inc k) k))
                              k))))
         ;; how many runs of text with no whitespace [a, b) of `cs` holds
         runs (fn [^ints cs a b] (count (filter (fn [[_ _ w?]] (not w?)) (cp-runs cs a b))))
         gaps (compose-edits ops old)
         k (count gaps)
         ;; a gap that both deletes and types, over two words or more, or
         ;; over one and holding or typing words with whitespace between
         multi? (fn [{:keys [start end ^String value]}]
                  (let [w (over start end)
                        ^ints v (.toArray (.codePoints value))]
                    (and (< start end) (pos? (alength v))
                         (or (<= 2 w)
                             (and (= 1 w) (or (<= 2 (runs o start end)) (<= 2 (runs v 0 (alength v)))))))))
         word? (let [ws (set word-layers)]
                 (if (some #(ws (:token/layer %)) tokens)
                   #(ws (:token/layer %))
                   #(not (contains? (set partitioning) (:token/layer %)))))
         children (set (:children opts))
         ;; gap i read as a whole-body save of its window (the text between
         ;; its neighbours) reads it, the tokens cut to the window, when that
         ;; reading deletes no word or sentence the gap as made keeps, or
         ;; deletes fewer, else the gap as made
         ;; `tokens` cut to old [lo, hi), in its coordinates
         by-begin (vec (sort-by :token/begin tokens))
         tbegins (long-array (map :token/begin by-begin))
         tlongest (reduce max 0 (map #(- (:token/end %) (:token/begin %)) tokens))
         cut (fn [lo hi]
               (let [from (loop [a 0 b (alength tbegins)]
                            (if (< a b)
                              (let [m (quot (+ a b) 2)]
                                (if (< (aget tbegins m) (- lo tlongest)) (recur (inc m) b) (recur a m)))
                              a))]
                 (loop [i from out (transient [])]
                   (if (and (< i (count by-begin)) (<= (aget tbegins i) hi))
                     (let [{:token/keys [begin end] :as tk} (by-begin i)]
                       (recur (inc i)
                              (if (if (= begin end) (<= lo begin hi) (and (< begin hi) (< lo end)))
                                (conj! out (assoc tk :token/begin (- (max lo begin) lo) :token/end (- (min hi end) lo)))
                                out)))
                     (persistent! out)))))
         shift (fn [gs by] (mapv (fn [gap] (cond-> (-> gap (update :start + by) (update :end + by))
                                             (:keeps gap) (update :keeps (fn [ks] (mapv (fn [[b e off len]] [(+ b by) (+ e by) off len]) ks)))))
                                 gs))
         ;; gap i (`t` as made, less the text it shares at its ends) read as
         ;; a whole-body save reads the stretch it was sent over (the text
         ;; outside it is the same), when that reading deletes no word or
         ;; sentence the gap as made keeps, or deletes fewer, else as made.
         ;; The two are weighed on the text between the gap's neighbours.
         read (fn [i t]
                (let [g (gaps i)
                      ;; the reading, on the stretch
                      a (:start g)
                      st-old (cp/cp-subs old a (:end g))
                      st-tokens (cut a (:end g))
                      aligned (plain-body-gaps st-old (:value g) st-tokens partitioning word-layers)
                      diffed (delay (body-diff-gaps st-old (:value g) st-tokens partitioning word-layers false))
                      rgaps (first (pick-reading st-old st-tokens aligned diffed partitioning word-layers (dissoc opts :split-on-space)))
                      ;; weighed on the window
                      lo (if (pos? i) (inc (:end (gaps (dec i)))) 0)
                      hi (if (< (inc i) k) (dec (:start (gaps (inc i)))) n)
                      w-old (cp/cp-subs old lo hi)
                      w-tokens (cut lo hi)
                      w-read (shift rgaps (- a lo))
                      ;; the gap as it was sent, whole: a paste carries the text it
                      ;; did not change, which the trim would read as kept
                      ;; wherever its letters match (`talu talu x` pasted as `talu
                      ;; x` trims to `alu t` deleted, which keeps a `t` of each)
                      w-made [(-> g (update :start - lo) (update :end - lo))]
                      ;; (a layer that splits on space splits what either
                      ;; reading gives alike, so the choice does not depend on it)
                      run #(apply-plain-gaps w-old w-tokens % partitioning word-layers (dissoc opts :caret :split-on-space))
                      rr (run w-read)
                      made (run w-made)
                      ;; the words and sentences a reading deletes
                      counted-ids (into #{} (comp (filter #(or (word? %) (contains? (set partitioning) (:token/layer %))))
                                                  (remove #(children (:token/layer %)))
                                                  (map :token/id))
                                        w-tokens)
                      counted (fn [r] (into #{} (filter counted-ids) (:deleted r)))
                      dr (counted rr)
                      dm (counted made)
                      ;; whether `r`, read from `gs`, leaves a word over several runs
                      ;; of text with whitespace between, one of them typed text
                      ;; alone (`hi` on `Oh my.\nHi`)
                      foreign? (fn [gs r]
                                 (let [^ints nw (.toArray (.codePoints ^String (:text/body (:text r))))
                                       typed (let [arr (boolean-array (alength nw))]
                                               (reduce (fn [sh {:keys [start end value]}]
                                                         (let [c (cp/cp-count value)]
                                                           (dotimes [j c] (aset arr (+ start sh j) true))
                                                           (+ sh (- c (- end start)))))
                                                       0 (sort-by :start gs))
                                               arr)
                                       gone (set (:deleted r))]
                                   (some (fn [{:token/keys [id begin end] :as tk}]
                                           (and (word? tk) (not (gone id))
                                                (let [rs (remove #(nth % 2) (cp-runs nw begin end))]
                                                  (and (< 1 (count rs))
                                                       (some (fn [[x y]] (every? #(aget typed %) (range x y))) rs)))))
                                         (:tokens r))))
                      take-read? (if (= dr dm)
                                   (or (not (foreign? w-read rr)) (foreign? w-made made))
                                   (or (every? dm dr) (< (count dr) (count dm))))]
                  (if (and take-read? (= (:value g) (gaps-body st-old rgaps)))
                    (shift rgaps a)
                    [t])))]
     (into []
           (mapcat (fn [i]
                     (let [g (gaps i)
                           t (trim-gap o g)]
                       (cond
                         (nil? t) []
                         ;; only typing or only deleting: as made
                         (multi? g) (read i t)
                         :else [t]))))
           (range k)))))

(defn plain-edits
  "`apply-plain-gaps` for an edit of `old` by `ops` from the caret (running
  coordinates, see `compose-edits`), the change taken as `plain-edit-gaps`
  takes it."
  ([old tokens ops partitioning word-layers] (plain-edits old tokens ops partitioning word-layers nil))
  ([^String old tokens ops partitioning word-layers opts]
   (apply-plain-gaps old tokens (plain-edit-gaps old ops tokens partitioning word-layers opts)
                     partitioning word-layers (assoc opts :caret true))))

(defn layer-roles
  "What each token layer of a text is to a body save, from `layers`, each
  `{:id :overlap-mode :parent :split-on-space}` (`:overlap-mode` as the
  token layer row has it, `:parent` its parent token layer's id or nil,
  `:split-on-space` whether its config sets `splitOnSpace`). Nothing but the
  layers' shape is read, so a layer any app or script made takes an edit the
  same way.
  - `:partitioning`: the partition layers (sentences).
  - `:deciders`: the word layers, which decide where typed text goes (see
    `apply-plain-gaps`): a layer that forbids overlap and has a parent, or
    has a layer nested under it (words a script made on a root layer, with
    morphemes under them), and is not nested under another such layer (a
    syntactic word layer under the words follows them, it does not decide).
  - `:children`: the layers nested under a deciding layer at any depth
    (morphemes, syntactic words), which keep to their words.
  - `:exclusive`: the layers that forbid overlap.
  - `:split-on-space`: whether a layer of the text sets `splitOnSpace`,
    which then holds for every word of the text.
  - `:head-layers`: the partitions a line typed before the first sentence
    is made a sentence of (see `apply-plain-gaps`): those the words are
    nested under, else the text's one partition layer, else none. A second
    partition (a document's one token, paragraphs) is never split."
  [layers]
  (let [parent-of (into {} (map (juxt :id :parent)) layers)
        parents (into #{} (keep :parent) layers)
        word-layers (into #{}
                          (comp (filter #(and (= "non-overlapping" (:overlap-mode %))
                                              (or (some? (:parent %)) (parents (:id %)))))
                                (map :id))
                          layers)
        ;; whether a layer's parent chain, past the layer itself, reaches one
        ;; in `xs`
        under? (fn [xs id] (loop [id (parent-of id) seen #{}]
                             (cond (nil? id) false
                                   (xs id) true
                                   (seen id) false
                                   :else (recur (parent-of id) (conj seen id)))))
        deciders (into #{} (remove #(under? word-layers %)) word-layers)
        partitioning (into #{} (comp (filter #(= "partitioning" (:overlap-mode %))) (map :id)) layers)
        heads (into #{} (filter (fn [p] (some #(under? #{p} %) deciders))) partitioning)]
    {:partitioning partitioning
     :head-layers (cond (seq heads) heads
                        (= 1 (count partitioning)) partitioning
                        :else #{})
     :deciders deciders
     :children (into #{} (filter #(under? deciders %)) (keys parent-of))
     :exclusive (into #{} (comp (filter #(= "non-overlapping" (:overlap-mode %))) (map :id)) layers)
     :split-on-space (boolean (some :split-on-space layers))}))
