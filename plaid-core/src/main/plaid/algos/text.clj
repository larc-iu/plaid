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
  everything hanging off it (morphemes, spans, links). A diff-based body
  update emits it too, for every delete that has an insert beside it (see
  `pair-replacements`), so respelling a word's last letter keeps the new
  letter inside the word's tokens.
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
  nearest, so an edit already at such a place stays there. Edits that touch stay together, since
  `pair-replacements` reads them as one respelling. The reconstructed string
  is unchanged. `partitioning` is the set of the tokens' layers that are
  partitions (see `slide-cost`). `bounds`, when given, holds for each edit
  (in the order `ops` makes them) the [lo hi] of old text it must stay
  within, or nil (see `plan-edits`)."
  ([ops old tokens] (slide-to-tokens ops old tokens #{}))
  ([ops old tokens partitioning] (slide-to-tokens ops old tokens partitioning nil))
  ([ops old tokens partitioning bounds]
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
                        [glo ghi] (when bounds (get bounds i))
                        lo (max (if prev (inc (reach-of (peek moved))) 0) (or glo 0))
                        hi (min (if nxt (dec (start-of nxt)) n) (or ghi n))]
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

;; ---------------------------------------------------------------------------
;; Replace pairing
;;
;; The diff spells a changed stretch as deletes and inserts, and a token that
;; ends (or begins) exactly at the stretch loses what was typed there:
;; respelling `юкъуз` as `юкъуь` is delete `з` then insert `ь` at the same
;; index, the delete shrinks the word token to `юкъу`, and an insert at a
;; token's end is taken into no token. A replace op keeps every token that
;; covers the whole changed stretch, so a body update folds each stretch into
;; one. Editscript may split one stretch across several ops in either order
;; (delete then insert, insert then delete, two deletes at one index), so a
;; stretch is every op that starts where the previous one left off.
;;
;; A stretch also reaches over kept text when a letter each side of it
;; changed: `dancde` respelled `danced` is delete `d`, keep `e`, insert `d`,
;; and folding only what touches leaves the word token over `dance`. Such a
;; stretch is folded only when a token holds it with room to spare, so the
;; whole of it is one word being respelled.
;;
;; A stretch over the whole body is NOT folded: a text typed over from
;; scratch is a new text, and the tokens of the old one, with their spans,
;; relations and vocabulary links, do not belong to it.

(defn- op-end
  "Running index just past `op`'s effect: an insert ends after its text, a
  delete leaves the index where it was."
  [{:keys [type index value]}]
  (if (= type :insert) (+ index (cp/cp-count value)) index))

;; A run holds the ops of one stretch, and `:keep` entries for text the ops
;; reach over. A keep is old text that comes through unchanged, so it counts
;; to both sides of a replace: its length to what the replace takes out, its
;; text to what the replace puts back.
(defn- old-width [{:keys [type value]}]
  (case type :delete value :keep (cp/cp-count value) 0))

(defn- new-text [{:keys [type value]}]
  (case type (:insert :keep) value nil))

(defn- token-inside?
  "A token the stretch would swallow: inside [s e) without holding it. A
  replace deletes such a token, where a delete and an insert clip it and
  keep it."
  [tokens s e]
  (boolean (some (fn [{:token/keys [begin end]}]
                   (and (<= s begin) (<= end e)
                        (not (and (<= begin s) (<= e end)))))
                 tokens)))

;; A word replaced by another comes out of the diff as pieces with kept
;; letters between them: `cow` to `abc` is insert `ab`, keep `c`, delete
;; `ow`, and applied as it is that leaves the token of `cow` on the `c` of
;; `abc`, with its gloss. A replaced word keeps its annotations (ruled
;; 2026-09-21), so when the pieces lie exactly over a token, from its first
;; letter to its last, they become one replace and the token moves onto the
;; new word whole.

(defn- lcs-length
  "Length of the longest common subsequence of two code-point arrays."
  [^ints a ^ints b]
  (let [n (alength b)]
    (loop [i 0 prev (long-array (inc n))]
      (if (< i (alength a))
        (let [cur (long-array (inc n))]
          (dotimes [j n]
            (aset cur (inc j) (if (= (aget a i) (aget b j))
                                (inc (aget prev j))
                                (max (aget prev (inc j)) (aget cur j)))))
          (recur (inc i) cur))
        (aget prev n)))))

(defn- run-bounds
  "For each place i of `o` (0 to its length), where the run of code points
  that are not `sep?` around i begins and where it ends, as two arrays: the
  same walks `holding` and `split-off-new-words` made from each edit, made
  once. In a script without spaces a run is a whole line, and walking it for
  every edit took most of a minute on a line of 30,000 letters."
  [^ints o sep?]
  (let [n (alength o)
        starts (int-array (inc n))
        ends (int-array (inc n))]
    (dotimes [i (inc n)]
      (aset starts i (int (if (or (zero? i) (sep? (aget o (dec i)))) i (aget starts (dec i))))))
    (loop [i n]
      (when (>= i 0)
        (aset ends i (int (if (or (= i n) (sep? (aget o i))) i (aget ends (inc i)))))
        (recur (dec i))))
    [starts ends]))

(defn- holders-fn
  "A function of p and q giving the tokens of `near` (see `tokens-near`)
  that hold [p q] inside the run without whitespace from before p to past
  q, that is [B E) of `bounds` (see `run-bounds`): (< begin end), B <= begin
  <= p and q <= end <= E, and `keep?`. In the order of a stable sort by
  begin of `near`'s. The tokens of a run are gathered once, and a short one
  (at most 64 code points) is looked for only among those beginning no
  further than its length before q."
  [near [^ints starts ^ints ends] keep?]
  (let [memo (java.util.HashMap.)
        short-max 64
        index (fn [B E]
                (let [v (vec (sort-by :token/begin
                                      (filter (fn [{tb :token/begin te :token/end :as t}]
                                                (and (< tb te) (<= B tb) (<= te E) (keep? t)))
                                              (near B E))))]
                  {:v v
                   :begins (long-array (map :token/begin v))
                   :longer (vec (keep-indexed (fn [i {tb :token/begin te :token/end}]
                                                (when (< short-max (- te tb)) i))
                                              v))}))]
    (fn [p q]
      (let [B (aget starts (int p))
            E (aget ends (int q))
            k [B E]
            {:keys [v ^longs begins longer]} (or (.get memo k) (let [x (index B E)] (.put memo k x) x))
            lower (fn [x] (loop [a 0 b (alength begins)]
                            (if (< a b)
                              (let [m (quot (+ a b) 2)]
                                (if (< (aget begins m) (long x)) (recur (inc m) b) (recur a m)))
                              a)))
            holds? (fn [i] (let [{tb :token/begin te :token/end} (v i)] (and (<= tb p) (<= q te))))]
        (mapv v (sort (distinct (concat (filter holds? (range (lower (- q short-max)) (lower (inc p))))
                                        (filter holds? longer)))))))))

(defn- split-off-new-words
  "The edits for `r`, a replace of [s, t) in `o`, with any whole word its
  new text adds beside the replaced letters put outside them, when tokens
  without whitespace cover [s, t). `cat` to `cat dog` keeps `cat`'s token
  on `cat`. Where the replace takes the whole of those tokens, they stay on
  the new word that shares the most letters with the old one, the first on
  a tie, or the next such on a tie when putting the rest beside the first
  would move text into the token before or away from a zero-width token.
  When no word can take them so, the replace stays as it is.
  `near` gives the tokens that begin or end in a stretch (see
  `tokens-near`), and `holders` those that hold one inside a run without
  whitespace (see `holders-fn`)."
  [^ints o near holders r]
  (let [n (alength o)
        {s :start t :end ^String value :value} r
        v (.toArray (.codePoints value))
        ws? (fn [c] (space? c))
        ;; the new text's words, as [from to) code-point ranges of v
        words (loop [i 0 out []]
                (let [b (loop [i i] (if (and (< i (alength v)) (ws? (aget v i))) (recur (inc i)) i))
                      e (loop [i b] (if (and (< i (alength v)) (not (ws? (aget v i)))) (recur (inc i)) i))]
                  (if (< b e) (recur e (conj out [b e])) out)))
        covering (when (and (some ws? v)
                            (not-any? #(ws? (aget o %)) (range s t)))
                   ;; within the run of old text without whitespace around [s, t)
                   (holders s t))
        sub (fn [p q] (String. v (int p) (int (- q p))))
        edits (fn [[p q]]
                (cond-> []
                  (pos? p) (conj {:kind :insert :at s :value (sub 0 p)})
                  (< p q) (conj (assoc r :value (sub p q)))
                  (= p q) (conj {:kind :delete :start s :end t})
                  (< q (alength v)) (conj {:kind :insert :at t :value (sub q (alength v))})))
        ;; Text put in front of [s, t) lands outside every token beginning
        ;; at s. With a token ending at s as well (the sentence before, when
        ;; s starts a sentence) a partition hands it to that token, so it
        ;; goes there only when nothing ends at s. It also lands after a
        ;; zero-width token at s, which marks the start of the old word's
        ;; first letter, so when that letter came through it goes there only
        ;; when no such token is at s. Text put after [s, t)
        ;; lands after a zero-width token at t, which marks the end of the
        ;; old word's last letter, and the same holds.
        front-ok? (not-any? (fn [{:token/keys [begin end]}]
                              (or (and (< begin end) (= end s))
                                  (and (:head-kept r) (= begin end s))))
                            (near s s))
        back-ok? (or (not (:tail-kept r))
                     (not-any? (fn [{:token/keys [begin end]}] (= begin end t)) (near t t)))
        ;; Spaces alone go outside the word whatever stands at its edge. A
        ;; space typed before a marked word goes after the marker, as all
        ;; text inserted where a zero-width token stands does, so the marker
        ;; is left in front of the space. One typed after a word goes behind
        ;; a marker at its end.
        blank? (fn [p q] (every? #(ws? (aget v %)) (range p q)))
        ;; A new word holding the old last letter can take the token even
        ;; with text after it: the marker at t follows the replace's end,
        ;; and the text inserted at t goes behind it (`sat` to `Xat XQ`).
        tail-at (:tail-at r)
        holds-tail? (fn [p q] (and tail-at (<= p tail-at) (< tail-at q)))
        allowed? (fn [[p q]] (and (or (zero? p) front-ok? (blank? 0 p))
                                  (or (= q (alength v)) back-ok? (blank? q (alength v)) (holds-tail? p q))))]
    (if (empty? covering)
      [r]
      (let [before? (< (reduce min (map :token/begin covering)) s)
            after? (< t (reduce max (map :token/end covering)))
            ;; the part of v that stays in the tokens, by preference
            choices (cond
                      ;; a word split in two where it was edited: leave it to the tokens
                      (and before? after?) []
                      ;; letters of the token before the replace: its first new word joins them
                      before? [(if (ws? (aget v 0)) [0 0] (first words))]
                      ;; letters after it: its last new word joins them
                      after? [(if (ws? (aget v (dec (alength v)))) [(alength v) (alength v)] (peek words))]
                      (empty? words) [[0 0]]
                      :else (let [old-word (java.util.Arrays/copyOfRange o (int s) (int t))
                                  score (fn [[p q]] (lcs-length old-word (java.util.Arrays/copyOfRange v (int p) (int q))))]
                              ;; the words that share the most letters, first to
                              ;; last (a word that shares fewer is no better a
                              ;; home than the whole new text)
                              (let [best (reduce max (map score words))]
                                (filter #(= best (score %)) words))))]
        ;; When none of the words sharing the most letters can take them
        ;; (the word starts a sentence, whose text in front would go to the
        ;; sentence before, or stands by a marker), the next that shares any
        ;; letter can, so no token is left over a space (`the` split as `t
        ;; he` at a sentence start stays on `t`).
        ;; Last, when only markers stand in the way (a word marked at both
        ;; edges), the word goes on the new word sharing the most letters and
        ;; the markers stay where they are, rather than the token staying
        ;; over a space. Text in front never goes to the sentence before.
        (if-let [choice (or (first (filter allowed? choices))
                            (when (and (not before?) (not after?) (seq words))
                              (let [old-word (java.util.Arrays/copyOfRange o (int s) (int t))
                                    score (fn [[p q]] (lcs-length old-word (java.util.Arrays/copyOfRange v (int p) (int q))))
                                    ranked (->> words
                                                (filter #(pos? (score %)))
                                                (sort-by (comp - score)))
                                    partition-ok? (fn [[p _]]
                                                    (or (zero? p) (blank? 0 p)
                                                        (not-any? (fn [{:token/keys [begin end]}] (and (< begin end) (= end s)))
                                                                  (near s s))))]
                                (or (first (filter allowed? (remove (set choices) ranked)))
                                    (first (filter partition-ok? ranked))))))]
          (edits choice)
          [r])))))

;; A replace that takes whole words and the edge of the next one: deleting
;; `Yarın ` and capitalizing `köye` is delete `Yarın k`, insert `K`, which
;; pair into one replace. No token holds it, so `köye` would lose its `k` and
;; `K` stand outside every word. Cut at the edge of the word it reaches into,
;; it is `Yarın ` deleted and `k` replaced by `K`, and the word keeps its
;; first letter.

(defn- inside-word-fn
  "A function of p telling whether two tokens meet at p inside a word
  without a space that runs across it: p is between two morphemes of the
  word. Where a punctuation mark is left between two words, nothing meets.
  In a script without spaces a sentence, a UMR node or a time-alignment
  segment over several words is such a token too, and only its layer
  (`word?`) tells it from a word. `near` gives the tokens that begin or end
  in a stretch (see `tokens-near`).

  The places are worked out once for each run of `o` without a space, when
  the run is first asked about. In a script without spaces a run is a whole
  line, and walking it and its tokens for every place asked about took 80 s
  on a line of 30,000 letters retyped, under the write lock."
  [^ints o near word?]
  (let [width? (fn [{:token/keys [begin end]}] (< begin end))
        ;; the run of `o` without a space around i
        [^ints starts ^ints ends] (run-bounds o space?)
        run (fn [i] [(aget starts (int i)) (aget ends (int i))])
        ;; the places inside a word of the run [B E): for each word there,
        ;; those strictly inside it where a token within it ends and one
        ;; within it begins
        places (fn [B E]
                 (let [ts (filterv width? (near B E))
                       by-begin (vec (sort-by :token/begin ts))
                       begins (long-array (map :token/begin by-begin))
                       from (fn [x] (loop [a 0 b (alength begins)]
                                      (if (< a b)
                                        (let [m (quot (+ a b) 2)]
                                          (if (< (aget begins m) (long x)) (recur (inc m) b) (recur a m)))
                                        a)))]
                   (into #{}
                         (mapcat (fn [{sb :token/begin se :token/end :as S}]
                                   (when (and (word? S) (<= B sb) (<= se E))
                                     (let [in (filter (fn [{:token/keys [begin end]}]
                                                        (and (<= end se) (not= [begin end] [sb se])))
                                                      (subvec by-begin (from sb) (from se)))
                                           ends (into #{} (comp (map :token/end) (filter #(< sb % se))) in)]
                                       (filter ends (map :token/begin in))))))
                         ts)))
        memo (java.util.HashMap.)]
    (fn [p]
      (let [[B E] (run p)]
        (when (< B E)
          (let [ps (or (.get memo B) (let [ps (places B E)] (.put memo B ps) ps))]
            (contains? ps p)))))))

(defn- edit-start [e] (or (:start e) (:at e)))
(defn- edit-reach [e] (or (:end e) (:at e)))

(defn- edits-text
  "[p q) of `o` with `edits`, which lie within it in order, made on it."
  [^ints o edits p q]
  (loop [edits edits p p sb (StringBuilder.)]
    (if-let [x (first edits)]
      (do (.append sb (String. o (int p) (int (- (edit-start x) p))))
          (when (:value x) (.append sb ^String (:value x)))
          (recur (rest edits) (edit-reach x) sb))
      (str (.append sb (String. o (int p) (int (- q p))))))))

(defn- split-at-token-edges
  "`out`, the edits before `r` as cut so far, with those for `r`, a replace
  of [s, t) in `o`, cut where it reaches into
  tokens it does not hold. When tokens begin inside [s, t) and end past it,
  and none begins before it and ends inside it, the part from the last such
  beginning to t is replaced by the new text after its last space, and the
  part before is replaced by the rest (deleted when there is none). The same
  at the other end: tokens beginning before it and ending inside it get the
  new text up to its first space. A replace reaching into words at both
  ends with no space in its new text joins them into one word, which the
  word sharing more letters with it takes whole (the first on a tie), and
  the other is deleted: `cat dog` to `cQog` keeps `dog` on `cQog`, where
  the replace as it was left `c` and `og` a token each. With a space typed
  it stays as it is. A delete reaching into two words joins them the same
  way (`a big dog` to `a bog` keeps `big` on `bog`, where the delete left
  `b` and `og` a token each), and is otherwise left as it is. So does one
  that takes the space after a word it leaves whole and letters of the next
  (`the kaki` to `theki`), or the space before one and letters of the word
  before (`the kaki` to `thkaki`), when a letter stands at both edges; with
  only the space gone (`a big dog` to `a bigdog`) the two keep a token each.
  An edit after it that takes the space after the joined word and reaches
  into the next word, or up to it with letters taken, joins that word too
  (`a big dog ran` to `a bon`). The edits in
  the letters of the two words that the join types back become part of it:
  those of the word it deletes, taken
  from the end of `out` or the start of `later` (the edits after `r`), and
  one reaching out of the word is cut at its edge. So no edit takes a
  letter another one takes. Gives the new `out` and how many of `later` it
  took.

  Only a word's edge in `o` is a place to cut: a space or the text's edge
  beside it, or a token beginning or ending there, unless two tokens meet
  there inside a token without a space that `word?` takes for a word (a
  morpheme's edge inside its word).
  So a punctuation mark the tokenizer left out of the words (`well-known`,
  `verdi.`), a punctuation token, a no-break space, and two words of a script
  written without spaces all make edges. A token reaching in has no space in
  the part the replace takes: a sentence ends after the space that follows
  it, and cut there, `a` replaced over `\na` put the new text's space on the
  word (`mat \na` to `mat Qx `). A replace that ends at a word's edge takes
  that word whole, and a token going on past it is over several words (a
  sentence, a UMR node over `köye cat` when `t köye` becomes `Ж`). It marks
  where to cut only when the replace starts inside no word at the other end,
  or `mat` would lose its `t`. `near` gives the tokens that
  begin or end in a stretch (see `tokens-near`), and `inside-word?` is
  `inside-word-fn`'s for `o`, `near` and `word?`."
  [^ints o near word? inside-word? out r later]
  (let [{s :start t :end} r
        ;; A delete is cut only where it joins two words, as a replace
        ;; typing nothing would be.
        delete? (= :delete (:kind r))
        ^String value (if delete? "" (:value r))
        o-space? (fn [i] (space? (aget o (int i))))
        no-space? (fn [p q] (not-any? o-space? (range p q)))
        width? (fn [{:token/keys [begin end]}] (< begin end))
        ;; p is at a word's edge: a space or the text's edge beside it, or a
        ;; token beginning or ending there that is not a morpheme's edge
        edge? (fn [p]
                (or (<= p 0) (>= p (alength o)) (o-space? (dec p)) (o-space? p)
                    (and (some #(and (width? %) (or (= p (:token/begin %)) (= p (:token/end %)))) (near p p))
                         (not (inside-word? p)))))
        ts (filter width? (near s t))
        next-all (filter (fn [{:token/keys [begin end]}]
                           (and (< s begin t) (< t end) (no-space? begin t) (edge? begin)))
                         ts)
        prev-all (filter (fn [{:token/keys [begin end]}]
                           (and (< begin s) (< s end t) (no-space? s end) (edge? end)))
                         ts)
        ;; A replace ending inside a word reaches into it. One ending at a
        ;; word's edge takes that word whole, and a token going on past it is
        ;; over several words (a sentence, a UMR node): it still marks where
        ;; the word begins, but a word reached into at the other end decides.
        next-in (if (edge? t) [] next-all)
        prev-in (if (edge? s) [] prev-all)
        [into-next into-prev] (if (or (seq next-in) (seq prev-in))
                                [next-in prev-in]
                                [next-all prev-all])
        v (.toArray (.codePoints value))
        n (alength v)
        ws? (fn [i] (space? (aget v (int i))))
        sub (fn [p q] (String. v (int p) (int (- q p))))
        ;; [p q) given `value`. Spaces alone are no word, so [p q) is
        ;; deleted and they go in at `at`, the end away from the word the
        ;; cut keeps: a replace would leave a token over [p q) on a space.
        piece (fn [p q value at]
                (cond
                  (= "" value) [{:kind :delete :start p :end q}]
                  (every? space? (.toArray (.codePoints ^String value)))
                  (if (= at p)
                    [{:kind :insert :at p :value value} {:kind :delete :start p :end q}]
                    [{:kind :delete :start p :end q} {:kind :insert :at q :value value}])
                  :else [{:kind :replace :start p :end q :value value}]))
        walk-left (fn [p] (loop [p p] (if (edge? p) p (recur (dec p)))))
        walk-right (fn [p] (loop [p p] (if (edge? p) p (recur (inc p)))))
        spaced? (fn [^String v] (and v (.anyMatch (.codePoints v) (reify java.util.function.IntPredicate
                                                                    (test [_ c] (space? c))))))
        ;; A word's token begins or ends at p, with a letter (or a digit, or
        ;; a mark) there: a punctuation mark at a word's edge keeps the
        ;; words apart (`big, dog` to `big,og`).
        letter? (fn [i] (let [c (aget o (int i))] (or (Character/isLetterOrDigit c) (combining-mark? c))))
        word-from? (fn [p] (and (letter? p) (some #(and (width? %) (word? %) (= p (:token/begin %))) (near p p))))
        word-to? (fn [p] (and (letter? (dec p)) (some #(and (width? %) (word? %) (= p (:token/end %))) (near p p))))
        ;; A replace reaching into a word at one end may take the space
        ;; after a word it leaves whole at the other (`the kaki` to
        ;; `theki`), or the space before one (`the kaki` to `thkaki`). No
        ;; space is left between the two, and the one it reaches into lost
        ;; letters, so they are one word, joined as below. With letters of
        ;; neither gone (`a big dog` to `a bigdog`), nothing reaches in and
        ;; two words written together keep a token each. An edit touching
        ;; that end is left to itself.
        prev-edge? (and (empty? prev-in) (seq next-in) (pos? s) (o-space? s) (not (o-space? (dec s)))
                        (word-to? s)
                        (not (some-> (peek out) edit-reach (>= s))))
        next-edge? (and (empty? next-in) (seq prev-in) (< t (alength o)) (o-space? (dec t)) (not (o-space? t))
                        (word-from? t)
                        (not (some-> (first later) edit-start (<= t))))
        ;; Reaching into a word at each end with no space typed, the replace
        ;; makes the two words one, and one of them takes it whole: the one
        ;; sharing more letters with it, the first on a tie. The other is
        ;; deleted, with the words between, and the letters the kept one
        ;; loses by that are typed back. `tat the` to `tZe` keeps `the` on
        ;; `tZe`, where the replace alone left `tat` on `t` and `the` on `e`.
        ;;
        ;; The letters of the two words beyond the replace, [pb s) and [t ne),
        ;; are typed back, so edits beside it in them are made on what is typed
        ;; back instead, and are part of the join. Left beside it they would
        ;; take letters the join takes too, and the fold could not judge the
        ;; edits (a 500) or would make another text of them.
        join (fn []
               (let [pb (walk-left (if prev-edge? (dec s) s))
                     a (walk-right s)
                     ;; the edits made before and after the replace within the two
                     ;; words, and those reaching out of them
                     [kept before] (loop [out out before ()]
                                     (let [x (peek out)]
                                       (if (and x (> (edit-reach x) pb))
                                         (recur (pop out) (cons x before))
                                         [out before])))
                     ;; An edit reaching out of the word is cut at its edge: what it
                     ;; types and takes inside the word is part of the join, and the
                     ;; letters it takes beyond the word are deleted.
                     [outside-before before] (let [x (first before)]
                                               (if (and x (< (edit-start x) pb))
                                                 [[{:kind :delete :start (edit-start x) :end pb}]
                                                  (cons (assoc x :start pb) (rest before))]
                                                 [[] before]))
                     ;; An edit after the replace that takes the space after the
                     ;; last word, with letters of it or of the next, and
                     ;; reaches into the next or up to one it leaves whole,
                     ;; joins that word too: `a big dog ran` to `a bon` is
                     ;; `ig d` and `g ra` deleted, one new word. The last word
                     ;; is then the one it reaches, from q.
                     [after q ne outside-after]
                     (loop [q t ne (walk-right (if next-edge? (inc t) t))]
                       (let [after (vec (take-while #(< (edit-start %) ne) later))
                             x (peek after)
                             out? (and x (> (edit-reach x) ne))
                             ;; the edit reaching out of the word, or one
                             ;; starting at its end
                             y (if out?
                                 x
                                 (let [y (get later (count after))]
                                   (when (and y (= ne (edit-start y)) (< ne (alength o)) (o-space? ne)
                                              (letter? (dec ne))
                                              (not (every? o-space? (range ne (edit-reach y)))))
                                     y)))
                             rr (some-> y edit-reach)
                             later-after (count (take-while #(< (edit-start %) (or rr ne)) later))
                             ne' (when (and y (< ne rr (alength o)) (not (o-space? rr)))
                                   (walk-right (if (edge? rr) (inc rr) rr)))
                             bq (when ne' (walk-left rr))]
                         (cond
                           (and ne'
                                (or (not (edge? rr)) (and (o-space? (dec rr)) (letter? rr)))
                                (some #(and (width? %) (word? %) (= bq (:token/begin %)) (< rr (:token/end %)))
                                      (near bq bq))
                                (not-any? #(spaced? (:value %)) (take-while #(< (edit-start %) ne') later))
                                (not (some-> (get later later-after) edit-start (<= rr))))
                           (recur rr ne')

                           out?
                           [(conj (pop after) (assoc x :end ne)) q ne [{:kind :delete :start ne :end (edit-reach x)}]]

                           :else [after q ne []])))
                     b (walk-left q)
                     word (edits-text o (concat before [r] after) pb ne)
                     word-cps (.toArray (.codePoints word))
                     shares (fn [p q] (lcs-length (java.util.Arrays/copyOfRange o (int p) (int q)) word-cps))]
                 (cond
                   ;; a word joined at its edge, or on to the next word, is one
                   ;; word only without a space
                   (and (or prev-edge? next-edge? (not= q t)) (spaced? word)) nil
                   ;; and when no edit after it reaches out of its last word,
                   ;; since that one may join the next word itself
                   (and (or prev-edge? next-edge?) (seq outside-after)) nil

                   ;; The first word takes it, from the replace's start, or
                   ;; from its last letter when the replace begins after it.
                   (>= (shares pb a) (shares b ne))
                   (let [x (if (< s a) s (dec a))]
                     [(-> out
                          (conj {:kind :replace :start x :end a :value (edits-text o (cons r after) x ne)}
                                {:kind :delete :start a :end ne})
                          (into outside-after))
                      (count after)])

                   ;; The last word takes it, up to where the edits reaching
                   ;; into it end, or its first letter when they end before it.
                   :else
                   (let [absorbed (vec (take-while #(< (edit-start %) b) after))
                         reach (edit-reach (or (peek absorbed) r))
                         y (if (> reach b) reach (inc b))]
                     [(-> kept
                          (into outside-before)
                          (conj {:kind :delete :start pb :end b}
                                {:kind :replace :start b :end y
                                 :value (edits-text o (concat before [r] absorbed) pb y)}))
                      (count absorbed)]))))]
    (or (when (and (or (and (seq prev-in) (seq next-in)) prev-edge? next-edge?)
                   (or delete? (pos? n))
                   (not-any? ws? (range n)))
          (join))
        (cond
          (and (not delete?) (seq into-next) (empty? into-prev))
          (let [b (reduce max (map :token/begin into-next))
                k (loop [k n] (if (and (pos? k) (not (ws? (dec k)))) (recur (dec k)) k))]
            [(-> out (into (piece s b (sub 0 k) s)) (into (piece b t (sub k n) t))) 0])

          (and (not delete?) (seq into-prev) (empty? into-next))
          (let [a (reduce min (map :token/end into-prev))
                k (loop [k 0] (if (and (< k n) (not (ws? k))) (recur (inc k)) k))]
            [(-> out (into (piece s a (sub 0 k) s)) (into (piece a t (sub k n) t))) 0])

          :else [(conj out r) 0]))))

(defn- split-all-at-token-edges
  "`edits` with each replace, and each delete joining two words, cut by
  `split-at-token-edges`, in order."
  [^ints o near word? inside-word? edits]
  (let [edits (vec edits)]
    (loop [i 0 out []]
      (if (< i (count edits))
        (let [e (edits i)]
          (if (#{:replace :delete} (:kind e))
            (let [[out k] (split-at-token-edges o near word? inside-word? out e (subvec edits (inc i)))]
              (recur (+ i 1 k) out))
            (recur (inc i) (conj out e))))
        out))))

(declare apply-text-edits apply-text-edits* fold-whole-words*)

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

(defn fold-whole-words
  "Rewrite `ops` (as produced by `pair-replacements` for `old`) so that the
  edits lying within one token's extent, reaching both its ends and holding a
  delete and an insert between them, become ONE replace of that extent. Only when no other edit
  touches the extent, no token sits inside it (a same-extent token on another
  layer moves with it, a zero-width one at its edge stays at the edge) and it
  is not the whole of `old`. A word with tokens inside it (its morphemes) is
  folded too when it has no whitespace, the edits as they are would leave it
  off the new text or cut or delete a token inside it, and it lands on one
  new word: the word moves onto the new one and the tokens inside are
  deleted (ruled 2026-09-27, `cow` analyzed `co` + `w` replaced by `abc`
  left the word and `co` on the `c`). So is such a word whose edits do not
  reach both its ends, when they take letters out and would leave some of
  its letters outside the tokens of a layer that held them all, and every
  token inside it is on such a layer: `cow` to `cab` is `ow` replaced by
  `ab`, since the shared `c` is trimmed off the diff, and left `co` on the
  `c` and `ab` in no morpheme. Edits over two words never lie within one
  word's extent, and a token over both has the words inside it, so they stay
  as they are. Inserts alone (`a` to `tat`) stay too: text typed at a word's
  edge stays outside it. So does a whole word typed beside the replaced
  letters, in this replace or one `pair-replacements` made (`cow` to `a co`
  keeps the token on `co`, see `split-off-new-words`). Edits that give a
  token without whitespace a space are folded the same way, inserts alone
  and wherever they begin, so the token goes on one of the new words and
  not over both (`NY` to `New York`). A space typed inside any morpheme of
  a word (first, middle or last) folds the word that way, and no morpheme
  is left cut on a new word (D28). The reconstructed string is unchanged.

  `word-layers` is the set of the tokens' layers that hold words: those
  that forbid overlap, are no partition and nest under another layer (see
  `update-body`). Only a token on one is a word around morphemes, so a
  sentence, a UMR node or a time-alignment segment over several words of a
  script without spaces is never taken for one. Without it any token
  without a space may be a word. Edits leaving only spaces in a word's place
  are not folded onto it: the word is deleted. A token with the same extent
  as a word given a space moves with the word, as a ud syntactic word does."
  ([ops old tokens] (fold-whole-words ops old tokens nil))
  ([ops old tokens word-layers]
   (let [word? (if (nil? word-layers)
                 (constantly true)
                 (fn [{:token/keys [layer]}] (contains? word-layers layer)))]
     ;; The fold must leave the text as it was. On a line retyped almost
     ;; whole, a replace joining two words took letters the next edit also
     ;; took, and the fold gave `forUnveistbr` for `for banister`: the save
     ;; stored a body the user never typed, or answered 500 (`tatukaiYarın`
     ;; to `tatuata`). A join now takes the edits beside it into itself
     ;; (see `split-at-token-edges`), and a word whose edits the fold cannot
     ;; judge is left as it came while the others fold. Should the folded
     ;; ops still not give the same text, or the fold throw elsewhere, all
     ;; the ops stay as they came, as a last guard.
     (let [folded (try (fold-whole-words* ops old tokens word?)
                       (catch clojure.lang.ExceptionInfo _ ops)
                       (catch IndexOutOfBoundsException _ ops))
           body #(ops-body % old)]
       (if (or (= folded ops)
               (let [b (body ops)] (and b (= b (body folded)))))
         folded
         ops)))))

(defn- fold-whole-words*
  [ops old tokens word?]
  (let [edits0 (vec (ops->edits ops))
        ^ints o (.toArray (.codePoints ^String old))
        near (delay (tokens-near tokens (count edits0)))
        inside-word? (delay (inside-word-fn o @near word?))
        ws-runs (delay (run-bounds o #(space? %)))
        ;; the tokens holding a stretch inside a run without whitespace, for
        ;; `split-off-new-words`
        covering (delay (holders-fn @near @ws-runs (constantly true)))
        ;; A replace reaching into the edge of a word it does not hold is cut
        ;; there first, so the part inside the word is judged below as any
        ;; edit of that word is: `dog cow` to `cab` folds `cow` as `cow` to
        ;; `cab` does.
        edits (split-all-at-token-edges o @near word? @inside-word? edits0)
        cut? (not= edits edits0)
        whole (alength o)
        old-text (fn [p q] (String. o (int p) (int (- q p))))
        start-of (fn [e] (or (:start e) (:at e)))
        reach-of (fn [e] (or (:end e) (:at e)))
        ;; Whether the edits beside [b e) leave it to itself: none touches
        ;; it, or a delete or replace ends at b or begins at e, as the parts
        ;; of a replace cut at a word's edge do. Text typed at an edge does
        ;; not, since it stays outside the word.
        ;; Text typed at a word's edge that meets it with a space or a
        ;; punctuation mark (a new word typed in front with its space, a comma
        ;; after it) stays outside the word, as it does when typed alone,
        ;; whatever else was changed in the word (N1, N2).
        punct-at? (fn [x at before?]
                    (and (= :insert (:kind x)) (= at (:at x))
                         (let [cs (.toArray (.codePoints ^String (:value x)))
                               c (when (pos? (alength cs)) (aget cs (if before? (dec (alength cs)) 0)))]
                           (and c (not (Character/isLetterOrDigit (int c))) (not (combining-mark? c))))))
        ;; an insert meeting a word that begins where it stands with a space
        ;; or a punctuation mark: text typed in front of the word
        front-text? (fn [x] (and (= :insert (:kind x))
                                 (punct-at? x (:at x) true)
                                 (some #(and (word? %) (< (:token/begin %) (:token/end %)) (= (:at x) (:token/begin %)))
                                       (@near (:at x) (:at x)))))
        clear-before? (fn [prev b] (or (nil? prev) (< (reach-of prev) b) (= (:end prev) b)
                                       (punct-at? prev b true)))
        clear-after? (fn [j e] (or (= j (count edits)) (> (start-of (edits j)) e)
                                   (and (:end (edits j)) (= (:start (edits j)) e))
                                   (punct-at? (edits j) e false)))
        starts (set (map start-of edits))
        ends-at (reduce (fn [m {:token/keys [begin end]}]
                          (if (and (starts begin) (< begin end)
                                   (not (and (zero? begin) (= end whole))))
                            (update m begin (fnil conj (sorted-set)) end)
                            m))
                        {} tokens)
        parts (fn [b e]
                (filter (fn [{tb :token/begin te :token/end}]
                          (if (= tb te)
                            (< b tb e)
                            (and (<= b tb) (<= te e) (not (and (= tb b) (= te e))))))
                        (@near b e)))
        inside? (fn [b e] (seq (parts b e)))
        ;; Whether a word stands over [b e), so that the tokens inside it are
        ;; its morphemes and not the words under a sentence or a UMR node.
        word-at? (fn [b e] (some #(and (= b (:token/begin %)) (= e (:token/end %)) (word? %)) (@near b e)))
        ;; [b e) of `old` with the edits of `g` applied.
        new-text (fn [g b e] (edits-text o g b e))
        ;; No edit of `g` takes a letter one before it takes: only then do
        ;; its edits make one text of [b e) (see `split-at-token-edges`).
        apart? (fn [g] (every? (fn [[x y]] (<= (reach-of x) (start-of y))) (partition 2 1 g)))
        ws? (fn [c] (space? c))
        has-ws? (fn [^String v] (and v (.anyMatch (.codePoints v) (reify java.util.function.IntPredicate
                                                                    (test [_ c] (space? c))))))
        ;; The edits put whitespace between letters of a token that had
        ;; none, so the letters it keeps are in two words now, and its token
        ;; goes on one of them.
        splits? (fn [g b e]
                  (and (some #(has-ws? (:value %)) g)
                       (not-any? #(ws? (aget o %)) (range b e))
                       ;; the words of the new text that hold a kept letter
                       (loop [g g p b word 0 prev-ws? true held #{}]
                         (let [x (first g)
                               kept (if x (- (start-of x) p) (- e p))
                               held (if (pos? kept) (conj held (if prev-ws? (inc word) word)) held)
                               word (if (and (pos? kept) prev-ws?) (inc word) word)
                               prev-ws? (if (pos? kept) false prev-ws?)]
                           (cond
                             (< 1 (count held)) true
                             (nil? x) false
                             :else
                             (let [[word prev-ws?]
                                   (reduce (fn [[w pw] c] (if (ws? c) [w true] [(if pw (inc w) w) false]))
                                           [word prev-ws?]
                                           (when-let [v (:value x)] (.toArray (.codePoints ^String v))))]
                               (recur (rest g) (reach-of x) word prev-ws? held)))))))
        ;; Whether the edits of `g`, applied as they are, would leave the
        ;; token over [b e) off the new text or cut or delete a token inside
        ;; it (a morpheme of the word): `cow` (`co` + `w`) to `abc` leaves
        ;; the word and `co` on the `c` and deletes `w`. A token inside that
        ;; holds each change it meets keeps it as a respelling.
        broken? (fn [g b e]
                  (let [w {:token/id ::whole :token/begin 0 :token/end (- e b)}
                        shifted (mapv (fn [x] (cond-> x
                                                (:start x) (update :start - b)
                                                (:end x) (update :end - b)
                                                (:at x) (update :at - b)))
                                      g)
                        {:keys [tokens]} (apply-text-edits (edits->ops shifted)
                                                           {:text/body (old-text b e)} [w])
                        want [0 (cp/cp-count (new-text g b e))]]
                    (or (not= [want] (mapv (juxt :token/begin :token/end) tokens))
                        (some (fn [{tb :token/begin te :token/end}]
                                (some (fn [{s :start t :end k :kind}]
                                        (and s (< s t)
                                             (if (= tb te)
                                               (< s tb t)
                                               (and (< s te) (> t tb)
                                                    (not (and (<= tb s) (<= t te)
                                                              (or (= k :replace) (< tb s) (< t te))))))))
                                      g))
                              (parts b e)))))
        ;; A stretch of the word typed over with a space in what was typed,
        ;; so the word's text is two words now (`kaki` to `a ki`, a letter
        ;; deleted at one caret and a space typed at another, paired into one
        ;; replace): the word is given a space as by a typed space (D28), even
        ;; when the letters it keeps are all in one of the new words.
        retyped-split? (fn [g b e]
                         (and (some #(and (= :replace (:kind %)) (has-ws? (:value %))) g)
                              (not-any? #(ws? (aget o %)) (range b e))
                              (boolean (re-find #"\S\s+\S" (new-text g b e)))))
        ;; The edits of `g` as one replace of [b e).
        as-replace (fn [g b e]
                     (let [v (new-text g b e)
                           ;; the old word's last letter came through
                           tail-kept (not-any? #(= e (:end %)) g)]
                       {:kind :replace :start b :end e :value v
                        :tail-kept tail-kept
                        ;; where it is in the new text: before what is typed after it
                        :tail-at (when tail-kept
                                   (- (cp/cp-count v) 1
                                      (reduce + 0 (keep #(when (and (= :insert (:kind %)) (= e (:at %)))
                                                           (cp/cp-count (:value %)))
                                                        g))))
                        :head-kept (not-any? #(and (:end %) (= b (:start %))) g)}))
        ;; The edits from i on that make up the whole of [b e), or nil.
        group (fn group
                ([i b e] (group i b e false false))
                ([i b e split?] (group i b e split? false))
                ([i b e split? cut-ok?]
                 (let [j (loop [j i]
                           (if (and (< j (count edits)) (<= (reach-of (edits j)) e) (not (punct-at? (edits j) e false))
                                    (>= (start-of (edits j)) b))
                             (recur (inc j))
                             j))
                       g (subvec edits i j)
                       kinds (set (map :kind g))]
                   (when (and (seq g)
                              (apart? g)
                              (clear-after? j e)
                              ;; spaces alone are no word to fold onto: a word
                              ;; they take the place of is deleted
                              (not (every? space? (.toArray (.codePoints ^String (new-text g b e)))))
                              (or (and (> (count g) 1)
                                       (= b (start-of (first g)))
                                       (= e (reduce max (map reach-of g)))
                                       (or (kinds :replace)
                                           (and (kinds :delete) (kinds :insert))))
                                  (splits? g b e)
                                  (retyped-split? g b e))
                              ;; A token inside a word (a morpheme) given a space
                              ;; is left to the word, which folds onto one of
                              ;; the new words (D28: `unbreakable` as `un` +
                              ;; `break` + `able` to `unbreakab le` kept `ab`
                              ;; with the gloss of `able`). Only with `cut-ok?`,
                              ;; once the word could not fold, does the morpheme
                              ;; take the replace when one new word can take it
                              ;; whole.
                              (not (and (not (word-at? b e))
                                        (or (splits? g b e) (retyped-split? g b e))
                                        (some #(and (word? %) (not (and (= b (:token/begin %)) (= e (:token/end %)))))
                                              (@covering b e))
                                        (or (not cut-ok?)
                                            (some #(and (= :replace (:kind %)) (has-ws? (:value %)))
                                                  (split-off-new-words o @near @covering (as-replace g b e))))))
                              ;; A word with tokens inside (its morphemes)
                              ;; takes the replace only when the edits as they
                              ;; are would break it, and when the word then
                              ;; lands on one new word: kept apart from a word
                              ;; typed beside it (`cow` to `at co` at a
                              ;; sentence start keeps the word and `co` on
                              ;; `co`, as the edits leave them). With `split?`
                              ;; a word given a space is broken too.
                              (or (not (inside? b e))
                                  (and (word-at? b e)
                                       (not-any? #(ws? (aget o %)) (range b e))
                                       (or (broken? g b e) (and split? (splits? g b e)) (retyped-split? g b e))
                                       (not-any? #(and (= :replace (:kind %)) (has-ws? (:value %)))
                                                 (split-off-new-words o @near @covering (as-replace g b e))))))
                     g))))
        ;; Whether every letter of [b e) lies in one of `ts`.
        covered? (fn [ts b e]
                   (loop [p b
                          spans (sort (keep (fn [{tb :token/begin te :token/end}]
                                              (when (< tb te) [tb te]))
                                            ts))]
                     (cond
                       (>= p e) true
                       (empty? spans) false
                       (> (ffirst spans) p) false
                       :else (recur (max p (second (first spans))) (rest spans)))))
        ;; Whether the edits of `g`, applied as they are, would leave letters
        ;; of the token over [b e) outside the tokens inside it, on a layer
        ;; whose tokens held every letter: `cow` (`co` + `w`) to `cab` is `ow`
        ;; replaced by `ab`, which leaves `co` on the `c` and `ab` in no
        ;; morpheme. Every token inside must be such a part, since the fold
        ;; deletes them all and these edits reach only some of them.
        analysis-lost? (fn [g b e]
                         (let [inner (parts b e)
                               layers (group-by :token/layer inner)]
                           (and (seq inner)
                                (every? (fn [{tb :token/begin te :token/end}] (< tb te)) inner)
                                (every? #(covered? % b e) (vals layers))
                                (let [at-b (fn [t] (-> t (update :token/begin - b) (update :token/end - b)))
                                      w {:token/id ::whole :token/begin 0 :token/end (- e b)}
                                      shifted (mapv (fn [x] (cond-> x
                                                              (:start x) (update :start - b)
                                                              (:end x) (update :end - b)
                                                              (:at x) (update :at - b)))
                                                    g)
                                      {:keys [tokens]} (apply-text-edits (edits->ops shifted)
                                                                         {:text/body (old-text b e)}
                                                                         (into [w] (map at-b) inner))
                                      w' (first (filter #(= ::whole (:token/id %)) tokens))
                                      after (group-by :token/layer (remove #(= ::whole (:token/id %)) tokens))]
                                  (and w'
                                       (some #(not (covered? (get after %) (:token/begin w') (:token/end w')))
                                             (keys layers)))))))
        ;; The edits from i on that lie within [b e) of a word with tokens
        ;; inside it (its morphemes), when they do not reach both its ends,
        ;; take out some of its letters and would leave the rest of its
        ;; analysis short of the word. Such a word was replaced outright
        ;; although a letter at its edge came through, and it folds as one
        ;; whose edits reach both ends does.
        partial-group (fn [i b e]
                        (let [j (loop [j i]
                                  (if (and (< j (count edits)) (<= (reach-of (edits j)) e) (not (punct-at? (edits j) e false))
                                           (>= (start-of (edits j)) b))
                                    (recur (inc j))
                                    j))
                              g (subvec edits i j)]
                          (when (and (seq g)
                                     (apart? g)
                                     (clear-after? j e)
                                     (some #(and (:end %) (< (:start %) (:end %))) g)
                                     (not-any? #(ws? (aget o %)) (range b e))
                                     (analysis-lost? g b e)
                                     (not-any? #(and (= :replace (:kind %)) (has-ws? (:value %)))
                                               (split-off-new-words o @near @covering (as-replace g b e))))
                            g)))
        ;; The tokens without whitespace that hold the whole of `e0`.
        holding (let [f (delay (holders-fn @near @ws-runs
                                           (fn [{tb :token/begin te :token/end :as t}]
                                             (and (not (and (zero? tb) (= te whole))) (word? t)))))]
                  (fn [e0] (@f (start-of e0) (reach-of e0))))
        ;; Tokens without whitespace that an edit giving one a space falls
        ;; strictly inside: `NY` to `New York` is `ew ` typed inside it and
        ;; `ork` after it.
        around (fn [lo e0]
                 (let [p (start-of e0)
                       B (loop [q p] (if (and (> q lo) (not (ws? (aget o (dec q))))) (recur (dec q)) q))]
                   (when (and (has-ws? (:value e0)) (< B p))
                     (->> (@near B p)
                          (filter (fn [{tb :token/begin te :token/end}]
                                    (and (<= B tb) (< tb p) (< p te)
                                         (not (and (zero? tb) (= te whole))))))
                          (sort-by :token/begin)))))
        ;; The edits from i on within the word over [b e) (with tokens
        ;; inside it, its morphemes), when they give it spaces only where
        ;; two of those meet and break none of them, as the edits that put
        ;; the word on one of the new words with its tokens there, and the
        ;; others outside it, with the edits it takes in. `pqmrs` as `pq` +
        ;; `mrs` to `pq mrs` left one word over the space. The word goes on the new word that shares
        ;; the most letters with it, the first on a tie, as a word without
        ;; morphemes does, and the morphemes of the others are deleted.
        split-between (fn [i b e]
                        (let [j (loop [j i]
                                  (if (and (< j (count edits)) (<= (reach-of (edits j)) e) (not (punct-at? (edits j) e false))
                                           (>= (start-of (edits j)) b))
                                    (recur (inc j))
                                    j))
                              g (subvec edits i j)
                              cut? (fn [x] (has-ws? (:value x)))
                              cuts (sort (distinct (map :at (filter cut? g))))]
                          (when (and (seq cuts)
                                     (apart? g)
                                     (clear-after? j e)
                                     (word-at? b e)
                                     (inside? b e)
                                     (not-any? #(ws? (aget o %)) (range b e))
                                     (every? (fn [x] (if (cut? x)
                                                       (and (= :insert (:kind x)) (< b (:at x) e)
                                                            (@inside-word? (:at x))
                                                            (every? space? (.toArray (.codePoints ^String (:value x)))))
                                                       (not (some #(= % (:at x)) cuts))))
                                             g)
                                     (not (broken? g b e)))
                            (let [segs (partition 2 1 (concat [b] cuts [e]))
                                  within (fn [[x y]] (filterv #(and (not (cut? %)) (<= x (start-of %)) (<= (reach-of %) y)) g))
                                  word (java.util.Arrays/copyOfRange o (int b) (int e))
                                  score (fn [[x y :as seg]]
                                          (lcs-length word (.toArray (.codePoints ^String (new-text (within seg) x y)))))
                                  ;; Text put in front of the word goes to a sentence
                                  ;; ending there, so the first new word keeps it then.
                                  segs (if (some #(and (< (:token/begin %) b) (= b (:token/end %))) (@near b b))
                                         (take 1 segs)
                                         segs)
                                  best (reduce max (map score segs))
                                  [x y :as seg] (first (filter #(= best (score %)) segs))
                                  before (filterv #(<= (reach-of %) x) g)
                                  after (filterv #(>= (start-of %) y) g)]
                              [g (cond-> []
                                   (< b x) (conj {:kind :insert :at b :value (new-text before b x)}
                                                 {:kind :delete :start b :end x})
                                   true (into (within seg))
                                   (< y e) (conj {:kind :delete :start y :end e}
                                                 {:kind :insert :at e :value (new-text after y e)}))]))))]
    (loop [i 0 out [] folded? false]
      (if (< i (count edits))
        (let [e0 (edits i)
              b (start-of e0)
              prev (peek out)
              ;; a word may begin where a delete before it ends, or where
              ;; text typed in front of it with a space or a punctuation mark
              ;; stands (X1)
              lo (cond (nil? prev) 0
                       (:end prev) (reach-of prev)
                       (front-text? prev) (reach-of prev)
                       :else (inc (reach-of prev)))
              ;; Edits the fold cannot judge stay as they came, and only
              ;; they: the other words of the text still fold. Text typed in
              ;; front of a word, meeting it with a space or a punctuation
              ;; mark, is left out of the word's group and stays as it came.
              g-e (when (and (clear-before? prev b) (not (front-text? e0)))
                    (try
                      (or (some (fn [e] (when-let [g (group i b e)] [g b e])) (ends-at b))
                          (some (fn [{tb :token/begin te :token/end}]
                                  (if-let [g (group i tb te)]
                                    [g tb te]
                                    (when-let [[g x] (split-between i tb te)]
                                      [g tb te x])))
                                (around lo e0))
                          ;; A word given a space some other way folds as
                          ;; one replaced outright, rather than hold it.
                          (some (fn [{tb :token/begin te :token/end}]
                                  (when-let [g (group i tb te true)] [g tb te]))
                                (around lo e0))
                          ;; A word that cannot fold onto one new word (the
                          ;; one to take it would move text into the sentence
                          ;; before or past a marker, or the word is the whole
                          ;; text) leaves the cut morpheme on the new word
                          ;; holding it, as before D28.
                          (some (fn [e] (when-let [g (group i b e false true)] [g b e])) (ends-at b))
                          (some (fn [{tb :token/begin te :token/end}]
                                  (when-let [g (group i tb te false true)] [g tb te]))
                                (around lo e0))
                          (some (fn [{tb :token/begin te :token/end}]
                                  (when (clear-before? prev tb)
                                    (when-let [g (partial-group i tb te)] [g tb te])))
                                (holding e0)))
                      (catch clojure.lang.ExceptionInfo _ nil)
                      (catch IndexOutOfBoundsException _ nil)))]
          ;; A space typed in a word after other edits of it left as they
          ;; came (`pumpkin` to `pXump kin`, two inserts): the word is found
          ;; from the space, and the edits of it before are taken back from
          ;; `out` into the group, so it folds as one edit of the word.
          (if-let [[g b e split k]
                   (or (when (has-ws? (:value e0))
                         (try
                           (some (fn [{tb :token/begin te :token/end :as w}]
                                   (let [k (loop [k 0]
                                             (let [j (- i k 1)
                                                   x (when (<= 0 j) (nth out (- (count out) k 1) nil))]
                                               (if (and x (= x (edits j)) (<= tb (start-of x)) (not (front-text? x)))
                                                 (recur (inc k))
                                                 k)))]
                                     (when (pos? k)
                                       (let [prev (nth out (- (count out) k 1) nil)]
                                         (when (clear-before? prev tb)
                                           (when-let [g (group (- i k) tb te true)]
                                             [g tb te nil k]))))))
                                 (filter (fn [{tb :token/begin te :token/end :as w}]
                                           (and (word? w) (< tb (start-of e0) te)
                                                (not (and (zero? tb) (= te whole)))
                                                (not-any? #(ws? (aget o %)) (range tb te))))
                                         (let [[^ints st ^ints en] @ws-runs
                                               p (start-of e0)]
                                           (@near (aget st (int p)) (aget en (int p))))))
                           (catch clojure.lang.ExceptionInfo _ nil)
                           (catch IndexOutOfBoundsException _ nil)))
                       g-e)]
            (let [out (if k (subvec out 0 (- (count out) k)) out)
                  i (if k (- i k) i)]
              (recur (+ i (count g))
                     (if split (into out split) (conj out (as-replace g b e)))
                     true))
            (recur (inc i) (conj out e0) folded?)))
        ;; A word typed beside the replaced letters stays out of them,
        ;; here and in the replaces `pair-replacements` made, and a replace
        ;; reaching into the edge of a token it does not hold is cut there.
        (let [replace? #(= :replace (:kind %))
              out' (split-all-at-token-edges o @near word? @inside-word?
                                             (into [] (mapcat #(if (replace? %) (split-off-new-words o @near @covering %) [%])) out))]
          (if (or folded? cut? (not= out out')) (edits->ops out') ops))))))

(defn pair-replacements
  "Rewrite `ops` (as produced by `diff` for `old`, after `normalize-deletes`)
  so that every run of adjacent ops holding both a delete and an insert
  becomes ONE replace op of the run's deleted length and inserted text. A run
  that is only deletes or only inserts is left as it is, so appending to a
  word is still an insert at the token's end. The reconstructed string is
  unchanged.

  A delete and an insert with kept text between them are folded too, together
  with that text, when a token of `tokens` (old-body code-point offsets) holds
  the whole stretch with room to spare and no token sits inside it: that is
  one word being respelled, and the letters typed belong in it.

  A run that covers the whole of `old` is never folded. Tokens hold a text
  they no longer share a letter with, and everything hanging off them.

  A run is not folded across a zero-width token that stands between two of its
  deletes. The token sat at the edge of each delete, where a delete keeps it;
  one replace over both would hold it strictly inside, and delete it. Joining
  two lines while dropping a quote after the newline deleted an unaligned UMR
  node that way.

  `apart`, when given, is a function of an old-body position giving the
  stretch it belongs to (see `plan-edits`): a delete and an insert with kept
  text between them are folded only when they belong to the same one. Edits
  made at the caret are where they were made, and two of them with text
  between are two edits (`dance` with a letter deleted inside and one typed
  after it keeps the typed one outside the word, as typing at a word's end
  does)."
  ([ops old] (pair-replacements ops old []))
  ([ops old tokens] (pair-replacements ops old tokens nil))
  ([ops old tokens apart]
   (let [^ints o (.toArray (.codePoints ^String old))
         whole (alength o)
         ;; Tokens are looked up by position: a long text pasted over by
         ;; another has thousands of stretches, and scanning every token for
         ;; each took 20 s on 50,000 words.
         near (tokens-near tokens (count ops))
         by-begin (vec (sort-by :token/begin (filter (fn [{:token/keys [begin end]}] (< begin end)) tokens)))
         begins (long-array (map :token/begin by-begin))
         ;; the furthest end among the first i+1 tokens by begin
         reach-by (long-array (rest (reductions max Long/MIN_VALUE (map :token/end by-begin))))
         below (fn [x] (loop [a 0 b (alength begins)]
                         (if (< a b)
                           (let [m (quot (+ a b) 2)]
                             (if (< (aget begins m) (long x)) (recur (inc m) b) (recur a m)))
                           a)))
         ;; A token that holds [s e) and reaches past it on one side at
         ;; least, so the stretch is a change inside the token and not the
         ;; whole of it: one beginning before s and reaching e, or one
         ;; beginning at s and reaching past e.
         holds-with-room? (fn [s e]
                            (let [c (below s)]
                              (or (and (pos? c) (>= (aget reach-by (dec c)) (long e)))
                                  (loop [i c]
                                    (and (< i (alength begins)) (= (aget begins i) (long s))
                                         (or (> (:token/end (by-begin i)) e) (recur (inc i))))))))
         token-inside? (fn [s e] (token-inside? (near s e) s e))
         pinned (into #{}
                      (comp (filter #(= (:token/begin %) (:token/end %)))
                            (map :token/begin))
                      tokens)
         kind-of (fn [run] (set (map :type run)))
         flush (fn [out run start]
                 (let [width (reduce + (map old-width run))
                       kinds (kind-of run)]
                   (if (and (contains? kinds :delete)
                            (contains? kinds :insert)
                            (not (and (zero? start) (= width whole))))
                     (conj out (replace-op (:index (first run))
                                           width
                                           (apply str (keep new-text run))))
                     (into out (remove #(= :keep (:type %)) run)))))]
     ;; `shift` is what the ops so far have changed the length by, so an op's
     ;; index less it is where it falls in the old body, where tokens are.
     ;; `start` is where the run began there, and `width` how much of the old
     ;; body it has taken in.
     (loop [ops ops run [] at nil start 0 width 0 shift 0 out []]
       (if-let [op (first ops)]
         (let [old-index (- (:index op) shift)
               shift' (case (:type op)
                        :insert (+ shift (cp/cp-count (:value op)))
                        :delete (- shift (:value op))
                        shift)
               taken (old-width op)
               apart? (and (= :delete (:type op))
                           (some #(= :delete (:type %)) run)
                           (contains? pinned old-index))
               same-stretch? (fn [] (or (nil? apart)
                                        (let [a (::gap (first run)) b (::gap op)]
                                          (if (and a b) (= a b) (= (apart start) (apart old-index))))))
               touching? (and (seq run) (= (:index op) at) (not apart?) (same-stretch?))
               ;; The run is all of one kind and this op is the other: the
               ;; kept text between them is part of one respelling when a
               ;; token holds the lot with room to spare.
               gap-start (+ start width)
               reach (+ old-index (old-width op))
               over-kept? (and (seq run)
                               (not touching?)
                               (not apart?)
                               (same-stretch?)
                               (< gap-start old-index)
                               (= #{(if (= :delete (:type op)) :insert :delete)}
                                  (kind-of run))
                               (holds-with-room? start reach)
                               (not (token-inside? start reach)))]
           (cond
             touching?
             (recur (rest ops) (conj run op) (op-end op) start (+ width taken) shift' out)

             over-kept?
             (let [kept {:type :keep :value (String. o (int gap-start) (int (- old-index gap-start)))}]
               (recur (rest ops) (conj run kept op) (op-end op) start
                      (+ width (old-width kept) taken) shift' out))

             :else
             (recur (rest ops) [op] (op-end op) old-index taken shift'
                    (flush out run start))))
         (flush out run start))))))

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

(defn keep-edges-off-spaces
  "`result` (what `apply-text-edits` gave for a whole-body update of `old`
  with `tokens`) with every token that now begins or ends on a space it did
  not begin or end on moved off it, onto the letters it holds. Deleting the
  words between two UMR nodes over several words, one ending on them and
  one beginning on them, leaves one of the two on the space between, since
  a delete that takes the space before them moves the second node's start
  onto it and one that takes the space after moves the first node's end:
  `mat\\ttat\\tcat` to `mat\\tcat` with nodes over `mat tat` and `tat cat`.
  No place for the delete keeps both off it, and the same holds for a node
  whose edge a delete takes between two different separators. A token on a
  layer in `partitioning` is left as it is, since a partition has no gaps,
  and so is one holding only spaces. So is one that stood over exactly a
  partition token and still does: a UMR node aligned to no word stands
  over the whole of its sentence, and deleting the sentence's last word so
  that a space ends it leaves the sentence on that space, and the node
  over it."
  [old tokens result partitioning]
  (let [^ints o (.toArray (.codePoints ^String old))
        ^ints n (.toArray (.codePoints ^String (:text/body (:text result))))
        before (into {} (map (juxt :token/id identity)) tokens)
        on-space? (fn [^ints cs i] (space? (aget cs (int i))))
        extent (juxt :token/begin :token/end)
        part? #(contains? partitioning (:token/layer %))
        parts-now (into {} (comp (filter part?) (map (juxt :token/id extent))) (:tokens result))
        ;; [old-extent new-extent] of each partition token still there
        over-part (into #{}
                        (keep (fn [p] (some->> (parts-now (:token/id p)) (vector (extent p)))))
                        (filter part? tokens))]
    (update result :tokens
            (fn [ts]
              (mapv (fn [{:token/keys [id layer begin end] :as t}]
                      (let [was (before id)]
                        (if (or (nil? was) (>= begin end) (contains? partitioning layer)
                                (over-part [(extent was) [begin end]])
                                (every? #(on-space? n %) (range begin end)))
                          t
                          (let [b (if (and (on-space? n begin)
                                           (not (on-space? o (:token/begin was))))
                                    (loop [k begin] (if (on-space? n k) (recur (inc k)) k))
                                    begin)
                                e (if (and (on-space? n (dec end))
                                           (not (on-space? o (dec (:token/end was)))))
                                    (loop [k end] (if (on-space? n (dec k)) (recur (dec k)) k))
                                    end)]
                            (assoc t :token/begin b :token/end e)))))
                    ts)))))

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
;; (`PATCH /texts/:id` with `edits`). Nothing is guessed about where a pure
;; insert or a pure delete stands: the caret said. Only a stretch that both
;; loses text and gets text typed in its place (a selection typed over, a
;; paste over a selection) is read as a whole-body save reads the same
;; change, confined to that stretch. The ops then go through the same steps
;; a whole-body save does after it has placed its edits, so the two agree on
;; what an edit at a known place does to the tokens.

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

(defn- gap-edits
  "`gap` as old-coordinate edits: an insert, a delete, or both, as `diff`
  gives a stretch sharing nothing."
  [{:keys [start end value]}]
  (cond-> []
    (< start end) (conj {:kind :delete :start start :end end})
    (seq value) (conj {:kind :insert :at start :value value})))

(defn plan-edits
  "Ops for the gaps `compose-edits` made of an edit of `old`, placed and
  ready for `pair-replacements` and the steps after it, as a diffed body's
  are after `align-to-words`: `{:ops ops :stretch f}`, the ops inserts and
  deletes only, in running coordinates, and `f` giving for an old position
  an op stands at the gap it was made for (`pair-replacements`' `apart`).

  A pure insert or a pure delete stands where it was made: never slid,
  snapped or aligned. A gap that both takes text and types text is read as
  a whole-body save reads the same change: its old and new text are diffed,
  and the edits slid to the tokens (`slide-to-tokens`), snapped
  (`normalize-deletes`) and aligned by words (`align-to-words`), so a
  selection typed over keeps what a respelling keeps. Those steps only move
  an edit to an equal place, and each edit is kept inside its gap: one moved
  past the gap's edge is put back at an equal place inside it (`sat tat`
  typed over with `tX` deletes `sat `, not ` sat`). When that cannot be
  done, or the stretch would come out as other text, the gap stays one
  delete and one insert, so no text outside it is ever read as changed. `partitioning` and `word-layers`
  are as `update-body` gives them to those steps."
  [^String old tokens gaps partitioning word-layers]
  (let [o (.toArray (.codePoints old))
        gaps (vec gaps)
        ;; an exact gap (see `apply-edits`) stands as made too
        pure? (fn [{:keys [start end value exact]}] (or exact (= start end) (empty? value)))
        start-of (fn [e] (or (:start e) (:at e)))
        reach-of (fn [e] (or (:end e) (:at e)))
        ;; the edits a gap's own diff gives, in old coordinates
        diffed (fn [{:keys [start end value]}]
                 (mapv (fn [e] (cond-> e
                                 (:start e) (update :start + start)
                                 (:end e) (update :end + start)
                                 (:at e) (update :at + start)))
                       (ops->edits (diff (String. ^ints o (int start) (int (- end start))) value))))
        ;; A gap's edits stand in the gap: the caret or the selection said
        ;; where the change was, and text outside it is not the user's to
        ;; lose. A step that moves an edit to an equal place outside the gap
        ;; (`sat tat` typed over as `tX` reads as ` sat` deleted) has it put
        ;; back at an equal place inside (`sat ` deleted), when there is one.
        window (fn [i] [(:start (gaps i)) (:end (gaps i))])
        pull-in (fn [idx e]
                  (if (some (fn [i] (let [[lo hi] (window i)]
                                      (and (<= lo (start-of e)) (<= (reach-of e) hi))))
                            idx)
                    e
                    (or (some (fn [i]
                                (let [[lo hi] (window i)]
                                  (when (and (<= (- lo slide-reach) (start-of e)) (<= (reach-of e) (+ hi slide-reach)))
                                    (first (filter #(and (<= lo (start-of %)) (<= (reach-of %) hi))
                                                   (slide-places o e 0 (alength o)))))))
                              idx)
                        e)))
        ;; the placed edits of the gaps in `idx`, or the gaps among them
        ;; whose edits left their window
        place (fn [idx]
                (let [per (mapv (fn [i] [i (diffed (gaps i))]) idx)
                      edits (vec (mapcat second per))
                      bounds (vec (mapcat (fn [[i es]] (repeat (count es) (window i))) per))
                      placed (if (empty? edits)
                               []
                               (-> (edits->ops edits)
                                   (slide-to-tokens old tokens partitioning bounds)
                                   (normalize-deletes old tokens)
                                   (align-to-words old tokens word-layers)
                                   ops->edits
                                   (->> (mapv #(pull-in idx %)))
                                   (->> (sort-by start-of))
                                   vec))
                      ;; each placed edit's gap, or nil when it lies in none
                      owner (fn [e]
                              (some (fn [i] (let [[lo hi] (window i)]
                                              (when (and (<= lo (start-of e)) (<= (reach-of e) hi)) i)))
                                    idx))
                      owned (group-by owner placed)
                      stray (get owned nil)
                      bad (into #{}
                                (concat
                                 (for [i idx
                                       :let [{:keys [start end value]} (gaps i)
                                             [lo hi] (window i)]
                                       :let [mine (get owned i)]
                                       :when (or (some (fn [[x y]] (> (reach-of x) (start-of y))) (partition 2 1 mine))
                                                 (not= (edits-text o [{:kind :replace :start start :end end :value value}] lo hi)
                                                       (edits-text o mine lo hi)))]
                                   i)
                                 ;; an edit outside every window: the gaps beside it
                                 (for [e stray
                                       i idx
                                       :let [[lo hi] (window i)]
                                       :when (and (<= (start-of e) (inc hi)) (<= (dec lo) (reach-of e)))]
                                   i)
                                 ;; the edits of two gaps meeting between them, or
                                 ;; two edits put in one place
                                 (for [[x y] (partition 2 1 placed)
                                       :let [i (owner x) j (owner y)]
                                       :when (and i j (if (= i j)
                                                        (> (reach-of x) (start-of y))
                                                        (>= (reach-of x) (start-of y))))
                                       k [i j]]
                                   k)))
                      bad (if (and (seq stray) (empty? bad)) (set idx) bad)]
                  (if (seq bad) {:bad bad} {:edits (mapv (fn [e] (assoc e ::gap (owner e))) placed)})))
        ;; Placing again without the gaps that went wrong, until none does.
        [placed fallback] (loop [idx (vec (remove #(pure? (gaps %)) (range (count gaps)))) fallback #{}]
                            (let [{:keys [bad edits]} (if (seq idx) (place idx) {:edits []})]
                              (if bad
                                (recur (vec (remove bad idx)) (into fallback bad))
                                [edits fallback])))
        fixed (into [] (mapcat (fn [i] (when (or (pure? (gaps i)) (fallback i))
                                         (map #(assoc % ::gap i) (gap-edits (gaps i))))))
                    (range (count gaps)))
        ;; gaps never share a place, and each gap's edits keep their order
        edits (vec (sort-by (juxt start-of ::gap) (into (vec placed) fixed)))
        starts (long-array (map start-of edits))]
    ;; each op carries its gap, for `pair-replacements`' `apart`
    {:ops (mapv (fn [op e] (assoc op ::gap (::gap e))) (edits->ops edits) edits)
     ;; the gap an old position an edit stands at belongs to
     :stretch (fn [p]
                (let [i (dec (loop [a 0 b (alength starts)]
                               (if (< a b)
                                 (let [m (quot (+ a b) 2)]
                                   (if (<= (aget starts m) (long p)) (recur (inc m) b) (recur a m)))
                                 a)))]
                  (loop [i i]
                    (when (<= 0 i)
                      (let [e (edits i)]
                        (if (<= (start-of e) p (reach-of e)) (::gap e) (recur (dec i))))))))}))

(defn edit-ops-body
  "The text `ops` (running coordinates, applied in turn) make of `old`, or
  nil when one does not fit it."
  [ops ^String old]
  (ops-body ops old))

(defn apply-edits
  "What an edit of `old` by `ops` (running coordinates, see `compose-edits`)
  does to it and to `tokens`, as `apply-text-edits` gives it: the ops made
  into gaps (`compose-edits`), placed (`plan-edits`), and then read by the
  steps a whole-body save runs after placing its edits (`pair-replacements`,
  `fold-whole-words`, `apply-text-edits`, `keep-edges-off-spaces`), with the
  layer sets `update-body` gives them."
  [^String old tokens ops {:keys [partitioning word-layers]}]
  (let [^ints o (.toArray (.codePoints old))
        word? (if (nil? word-layers) (constantly true) #(contains? word-layers (:token/layer %)))
        ;; Gaps inside one word are one change of it, and are read as one
        ;; stretch typed over, as a whole-body save reads the change: a typo
        ;; fixed at two carets (`teh` to `the`) keeps the whole word, and a
        ;; space typed with another change in the word folds it (D28). Gaps
        ;; with a space between them, or in no one word without a space, stay
        ;; apart (L3).
        ;; the word without a space holding gaps g to h, or nil
        ;; Text typed at the word's edge is part of the word only when it is
        ;; letters (or digits, or marks): a new word typed there with its space
        ;; (`slowly ` in front of `walkd`), or a comma after it, stays outside,
        ;; as a whole-body save reads it, whatever else was fixed in the word.
        word-text? (fn [^String v]
                     (and (seq v)
                          (.allMatch (.codePoints v) (reify java.util.function.IntPredicate
                                                       (test [_ c] (or (Character/isLetterOrDigit c)
                                                                       (combining-mark? c)))))))
        one-word (fn [g h]
                   (when (not-any? #(space? (aget o %)) (range (:start g) (:end h)))
                     (some (fn [{:token/keys [begin end] :as t}]
                             (when (and (word? t) (< begin end) (<= begin (:start g)) (<= (:end h) end)
                                        (not (and (= (:start g) (:end g) begin) (not (word-text? (:value g)))))
                                        (not (and (= (:start h) (:end h) end) (not (word-text? (:value h))))))
                               t))
                           tokens)))
        ;; runs of gaps inside one word, each with its word
        runs (reduce (fn [out h]
                       (let [{run :gaps} (peek out)
                             w (when run (one-word (first run) h))]
                         (if w
                           (conj (pop out) {:gaps (conj run h) :word w})
                           (conj out {:gaps [h]}))))
                     []
                     (compose-edits ops old))
        letter-at (fn [i] (String. o (int i) 1))
        has-space? (fn [^String v] (.anyMatch (.codePoints v) (reify java.util.function.IntPredicate
                                                                (test [_ c] (space? c)))))
        merged (fn [run]
                 {:start (:start (first run)) :end (:end (peek run))
                  :value (apply str (map-indexed (fn [k g]
                                                   (str (when (pos? k)
                                                          (let [f (run (dec k))]
                                                            (String. o (int (:end f)) (int (- (:start g) (:end f))))))
                                                        (:value g)))
                                                 run))})
        ;; Letters typed at the word's edge in a run without a space typed
        ;; (`mat` to `mtX`, a letter deleted inside and one typed at the end)
        ;; are part of the word: the typed letters replace the edge letter
        ;; with it and them, which the token holding it keeps. The other
        ;; gaps stay where they were made.
        edge-letters (fn [{:keys [gaps word]}]
                       (let [b (:token/begin word) e (:token/end word)
                             g0 (first gaps) gn (peek gaps)
                             v (vec gaps)
                             ;; an edge letter with a gap right beside it is
                             ;; taken in with that gap
                             v (if (= (:start g0) (:end g0) b)
                                 (let [h (second v)]
                                   (if (< (inc b) (:start h))
                                     (assoc v 0 {:start b :end (inc b) :value (str (:value g0) (letter-at b)) :exact true})
                                     (into [{:start b :end (:end h) :value (str (:value g0) (letter-at b) (:value h)) :exact true}]
                                           (subvec v 2))))
                                 v)
                             n (dec (count v))
                             v (if (and (pos? n) (= (:start gn) (:end gn) e))
                                 (let [h (v (dec n))]
                                   (if (< (:end h) (dec e))
                                     (assoc v n {:start (dec e) :end e :value (str (letter-at (dec e)) (:value gn)) :exact true})
                                     (conj (subvec v 0 (dec n))
                                           {:start (:start h) :end e :value (str (:value h) (letter-at (dec e)) (:value gn))
                                            :exact true})))
                                 v)]
                         (when (not= v (vec gaps)) v)))
        gaps (into []
                   (mapcat (fn [{run :gaps :as r}]
                             (cond
                               (= 1 (count run)) run
                               (and (not-any? #(has-space? (:value %)) run) (edge-letters r)) (edge-letters r)
                               :else [(merged run)])))
                   runs)
        {:keys [ops stretch]} (plan-edits old tokens gaps partitioning word-layers)]
    (-> ops
        (pair-replacements old tokens stretch)
        (fold-whole-words old tokens word-layers)
        (apply-text-edits {:text/body old} tokens)
        (as-> r (keep-edges-off-spaces old tokens r partitioning)))))

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
;; A layer whose config sets `plainEdits` (igt's words, morphemes and time
;; alignment segments) takes a text edit the plain way: an edit inside one of
;; its tokens, or touching its edge with no whitespace between, grows or
;; shrinks the token, and nothing else happens to it. Such a token is never
;; split by a typed space, never joined to its neighbour by a deleted one,
;; never folded onto another word, and loses nothing hanging off it. Only a
;; token whose whole text is deleted goes. An igt word can hold a space (a
;; FLEx phrase), and its analysis is the app's business, not the core's.

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
  "`placed` (the tokens `apply-plain-gaps` placed, `::gone` marking the
  deleted) with each word (`word?`) that the edit typed whitespace inside
  split there, as D28 has it: only at the runs of whitespace holding typed
  whitespace, never at spaces the word had. The word goes on the part holding
  the most of its old letters (the first on a tie), a token that was as long
  as it goes with it, a token that stood strictly inside it is cut to that
  part (and deleted when none of it is there), and a token over several
  words that began or ended with it begins or ends where it does now.
  `typed?` says whether a new-body position holds typed text."
  [^ints nw old-tokens placed word? part? typed?]
  (let [was (into {} (map (juxt :token/id identity)) old-tokens)
        ;; the old letters kept, by new position
        kept (fn [x y] (count (filter #(and (not (typed? %)) (not (space? (aget nw %)))) (range x y))))
        moves (into {}
                    (keep (fn [{:token/keys [id begin end] :as t}]
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
                                    (let [pieces (map vector (cons begin (map second cuts)) (concat (map first cuts) [end]))
                                          best (reduce max (map #(apply kept %) pieces))]
                                      [[ob oe] (first (filter #(= best (apply kept %)) pieces))])))))))
                    placed)
        edge-moves (into {} (map (fn [[[ob oe] [x y]]] [ob [x y]])) moves)
        end-moves (into {} (map (fn [[[ob oe] [x y]]] [oe [x y]])) moves)]
    (if (empty? moves)
      placed
      (mapv (fn [{:token/keys [id begin end] :as t}]
              (let [{ob :token/begin oe :token/end} (was id)]
                (cond
                  (or (::gone t) (nil? ob) (part? t)) t
                  (moves [ob oe]) (let [[x y] (moves [ob oe])] (assoc t :token/begin x :token/end y))
                  ;; inside a split word: cut to its part
                  (some (fn [[[wb we] _]] (and (<= wb ob) (<= oe we))) moves)
                  (let [[x y] (some (fn [[[wb we] xy]] (when (and (<= wb ob) (<= oe we)) xy)) moves)
                        b (max begin x) e (min end y)]
                    (if (< b e) (assoc t :token/begin b :token/end e) (assoc t ::gone true)))
                  ;; over several words: an edge at a split word's edge follows it
                  :else (let [b (if-let [[x _] (edge-moves ob)] x begin)
                              e (if-let [[_ y] (end-moves oe)] y end)]
                          (if (< b e) (assoc t :token/begin b :token/end e) t)))))
            placed))))

(defn apply-plain-gaps
  "What `gaps` (old-body code points, in order, never touching, each
  `{:start a :end b :value v}`, see `compose-edits`) do to `old` and to
  `tokens` taken the plain way. Returns `{:text :tokens :deleted}` as
  `apply-text-edits` does.

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
  ([^String old tokens gaps partitioning word-layers {:keys [caret split-on-space children]}]
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
        ;; the length of a line typed before the text's first sentence: up
        ;; to the last line break of an insert at 0
         head-length (fn [g]
                       (let [{:keys [a b]} (info g)
                             v (:value (gaps g))]
                         (when (= a b 0)
                           (when-let [m (last (re-seq #"[\s\S]*[\n\r\u0085\u2028\u2029]" v))]
                             (cp/cp-count m)))))
        ;; an insert's `side`, where a word ends and another begins at it
        ;; with no whitespace between, else none
         side-of (fn [g]
                   (let [{:keys [a b]} (info g)]
                     (when (and (= a b) (pos? a) (< a len)
                                (not (ws? (aget o (dec a)))) (not (ws? (aget o a)))
                                (flag? g :before) (flag? g :after))
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
                        (let [gb (at-or-before begin)
                              {:keys [a b n]} (when (>= gb 0) (info gb))
                              nb (cond
                                   (neg? gb) begin
                                  ;; a gap took its first letters, or stands
                                  ;; right before it
                                   (and (< a begin) (<= begin b))
                                   (if (<= end b) nil (- (+ (new-at gb) n) (given-after gb)))
                                   (= a begin)
                                   (cond
                                     (and (= a b) (by-caret? gb t)) (new-at gb)
                                     ;; the text typed where two words meet
                                     ;; goes whole to the side the caret said
                                     (and (= a b) (partitioning layer) (= :after (side-of gb))) (new-at gb)
                                     (and (= a b) (partitioning layer) (= :before (side-of gb))) (+ (new-at gb) n)
                                     ;; a line typed before the text's first
                                     ;; sentence is a sentence of its own
                                     (and (= a b 0) (partitioning layer) (head-length gb)) (head-length gb)
                                     (= a b) (- (+ (new-at gb) n) (given-after gb))
                                     (>= end b) (+ (new-at gb) (given-before gb))
                                     :else nil)
                                   :else (+ begin (aget shift (inc gb))))
                              ge (at-or-before end)
                              {a2 :a b2 :b n2 :n} (when (>= ge 0) (info ge))
                              ne (cond
                                   (neg? ge) end
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
                            (assoc t ::gone true))))
                      wide)
         placed (if split-on-space
                  (let [typed (let [a (boolean-array (alength nw))]
                                (dotimes [g k]
                                  (let [na (new-at g)] (dotimes [j (:n (info g))] (aset a (+ na j) true))))
                                a)]
                    (split-spaced-words nw wide placed
                                        (if (seq (filter #(word-layers (:token/layer %)) wide))
                                          #(word-layers (:token/layer %))
                                          #(not (partitioning (:token/layer %))))
                                        #(partitioning (:token/layer %))
                                        #(aget typed (int %))))
                  placed)
         zero-r (when (seq zero) (apply-text-edits (gap-ops gaps) {:text/body old} zero))
         kept (filterv (complement ::gone) placed)
         was-token (let [m (into {} (map (juxt :token/id identity)) wide)] #(m (:token/id %)))
        ;; the partitions that begin after a line typed before them at the
        ;; start of the text: a sentence is made over that line (`:heads`)
         heads (when (and (pos? k) (head-length 0))
                 (vec (keep (fn [{:token/keys [layer begin]}]
                              (when (and (partitioning layer) (= begin (head-length 0)))
                                {:token/layer layer :token/begin 0 :token/end (head-length 0)}))
                            (filter #(zero? (:token/begin (was-token %))) kept))))
         kept (follow-sentences o wide kept heads nw partitioning
                                (fn [t] (not (or (partitioning (:token/layer t))
                                                 (some #(= (:token/layer %) (:token/layer t)) deciders)
                                                 (contains? children (:token/layer t))))))]
     (cond-> {:text {:text/body new-body}
              :tokens (into kept (:tokens zero-r))
              :deleted (into (mapv :token/id (filter ::gone placed)) (:deleted zero-r))}
       (seq heads) (assoc :heads heads)))))

(defn plain-edit-gaps
  "The gaps an edit of `old` by `ops` from the caret is taken as on a layer
  that declares `plainEdits`: its net change (see `compose-edits`), each gap
  less the text its new value shares with the old at either end."
  [^String old ops]
  (let [^ints o (.toArray (.codePoints old))]
    (into [] (keep #(trim-gap o %)) (compose-edits ops old))))

(defn plain-edits
  "`apply-plain-gaps` for an edit of `old` by `ops` from the caret (running
  coordinates, see `compose-edits`). Each gap is taken as it was made, less
  the text its new value shares with the old at either end."
  ([old tokens ops partitioning word-layers] (plain-edits old tokens ops partitioning word-layers nil))
  ([^String old tokens ops partitioning word-layers opts]
   (apply-plain-gaps old tokens (plain-edit-gaps old ops) partitioning word-layers (assoc opts :caret true))))

(defn plain-body-gaps
  "The gaps a whole-body save of `old` as `new` is taken as on a layer that
  declares `plainEdits`: the diff, each edit moved to the equivalent place
  that disturbs the fewest `tokens` (see `slide-to-tokens` and
  `normalize-deletes`), and edits that touch one gap."
  [^String old ^String new tokens partitioning]
  (-> (diff old new)
      (slide-to-tokens old tokens partitioning)
      (normalize-deletes old tokens)
      ops->edits
      edits->gaps))

(defn plain-body
  "`apply-plain-gaps` for a whole-body save of `old` as `new` (see
  `plain-body-gaps`)."
  ([old new tokens partitioning word-layers] (plain-body old new tokens partitioning word-layers nil))
  ([^String old ^String new tokens partitioning word-layers opts]
   (apply-plain-gaps old tokens (plain-body-gaps old new tokens partitioning) partitioning word-layers
                     (dissoc opts :caret))))

(defn- restore-over-words
  "`result` with each token in `followers` it deleted put back when a word it
  stood over, or the word it stood inside, is left in `words-result`: over
  the words left, from the first one's begin to the last one's end. A node
  never goes while its word stays."
  [old-tokens words-result word? followers exclusive? result]
  (let [gone (set (:deleted result))
        dead (set (:deleted words-result))
        now (into {} (comp (filter word?) (map (juxt :token/id identity))) (:tokens words-result))
        live (fn [w] (when-not (dead (:token/id w)) (now (:token/id w))))
        words (filterv #(and (word? %) (< (:token/begin %) (:token/end %))) old-tokens)
        back (keep (fn [{:token/keys [id begin end] :as t}]
                     (when (and (gone id) (followers id) (< begin end))
                       (let [ws (keep live (filter #(or (and (<= begin (:token/begin %)) (<= (:token/end %) end))
                                                        (and (<= (:token/begin %) begin) (<= end (:token/end %))))
                                                   words))]
                         (when (seq ws)
                           (let [b (reduce min (map :token/begin ws)) e (reduce max (map :token/end ws))]
                             (when (< b e) (assoc t :token/begin b :token/end e)))))))
                   old-tokens)
        ;; never two tokens of a layer that forbids overlap on one stretch
        back (reduce (fn [out {:token/keys [layer begin end] :as t}]
                       (if (and (exclusive? layer)
                                (some #(and (= layer (:token/layer %)) (< (:token/begin %) end) (< begin (:token/end %)))
                                      (concat (:tokens result) out)))
                         out
                         (conj out t)))
                     []
                     back)
        ids (set (map :token/id back))]
    (-> result
        (update :tokens into back)
        (update :deleted #(into [] (remove ids) %)))))

(defn follow-word-edges
  "`result` (tokens and deleted ids, as `apply-plain-gaps` gives them) with
  each edge of a token in `followers` that stood at a word's edge in `old`
  (a begin at a word's begin, an end at a word's end) moved to where that
  word's edge is in `words-result`, whatever rule the word took. For a plain
  layer beside words that are not plain (a node layer beside the words): a
  node never differs from its words. An edge whose word is gone keeps its
  plain place, and when one edge followed its word past the other, the token
  keeps to that word."
  ([old-tokens result words-result word? followers]
   (follow-word-edges old-tokens result words-result word? followers (constantly false)))
  ([old-tokens result words-result word? followers exclusive?]
   (let [was (into {} (map (juxt :token/id identity)) old-tokens)
         now (into {} (comp (filter word?) (map (juxt :token/id identity))) (:tokens words-result))
         gone (set (:deleted words-result))
         live (fn [w] (when-not (gone (:token/id w)) (now (:token/id w))))
         words (filterv #(and (word? %) (< (:token/begin %) (:token/end %))) old-tokens)
         by-begin (group-by :token/begin words)
         by-end (group-by :token/end words)]
     (->> (update result :tokens
                  (fn [ts]
                    (mapv (fn [{:token/keys [id] :as t}]
                            (if-let [{:token/keys [begin end]} (when (followers id) (was id))]
                              (let [wb (some live (by-begin begin))
                                    we (some live (by-end end))
                                    b (or (:token/begin wb) (:token/begin t))
                                    e (or (:token/end we) (:token/end t))
                              ;; one edge followed its word past the other:
                              ;; the node keeps to that word
                                    [b e] (cond
                                            (< b e) [b e]
                                            we [(:token/begin we) e]
                                            wb [b (:token/end wb)]
                                            :else [b e])]
                                (if (and (or wb we) (< b e))
                                  (assoc t :token/begin b :token/end e)
                                  t))
                              t))
                          ts)))
          (restore-over-words old-tokens words-result word? followers exclusive?)))))
