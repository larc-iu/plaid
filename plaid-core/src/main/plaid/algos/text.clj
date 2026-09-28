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
                                                  :str-change-limit 0.9999999}))]
    (if (string? ops)
      ;; Total replacement of the original string
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

(declare middle-diff)

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

  The diff is computed at code-point granularity (via `codepoint-proxy`) so an
  edit boundary never splits a surrogate pair — otherwise a char-level diff of
  e.g. an interior emoji deletion would mis-shift the surrounding tokens."
  [^String old ^String new]
  (let [o (.toArray (.codePoints old))
        n (.toArray (.codePoints new))
        no (alength o)
        nn (alength n)
        shorter (min no nn)
        prefix (loop [i 0]
                 (if (and (< i shorter) (= (aget o i) (aget n i))) (recur (inc i)) i))
        suffix (loop [i 0]
                 (if (and (< i (- shorter prefix))
                          (= (aget o (- no 1 i)) (aget n (- nn 1 i))))
                   (recur (inc i))
                   i))
        old-mid (cps->str (java.util.Arrays/copyOfRange o (int prefix) (int (- no suffix))))
        new-mid (cps->str (java.util.Arrays/copyOfRange n (int prefix) (int (- nn suffix))))]
    (cond
      (and (= "" old-mid) (= "" new-mid)) []
      (= "" old-mid) [(insert-op prefix new-mid)]
      (= "" new-mid) [(delete-op prefix (- no prefix suffix))]
      :else (mapv #(update % :index + prefix) (middle-diff old-mid new-mid)))))

(defn- middle-diff
  "`diff` of two strings that share no first and no last code point."
  [old new]
  (if-let [{:keys [old* new* decode]} (codepoint-proxy old new)]
    (let [results (editscript-diff old* new*)]
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
            (throw (ex-info "Unknown diff op code" {:code 500 :op-code code}))))))
    ;; Fallback: more distinct code points than the proxy pool (not reachable
    ;; for real text) — whole-string replace. Correct, just not minimal.
    [(delete-op 0 (cp/cp-count old)) (insert-op 0 new)]))

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
                     (let [c (aget o i)] (if (Character/isWhitespace (int c)) :apart c))
                     :apart))
        apart (fn [c] (if (Character/isWhitespace (int c)) :apart c))]
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

(defn slide-to-tokens
  "Rewrite `ops` (as produced by `diff` for `old`) so that each delete or
  insert that stands apart from the others, and could stand elsewhere for the
  same resulting string, stands where it disturbs the fewest of `tokens`
  (old-body code-point offsets, see `slide-cost`), the nearest such place
  when there are several. An edit that disturbs no more than any other place
  stays where it is. Edits that touch stay together, since
  `pair-replacements` reads them as one respelling. The reconstructed string
  is unchanged. `partitioning` is the set of the tokens' layers that are
  partitions (see `slide-cost`)."
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
                        ;; The edit before may already have moved towards
                        ;; this one, and the two must not meet.
                        lo (if prev (inc (max (reach-of prev) (reach-of (peek moved)))) 0)
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
                                ;; The fewest cuts, then the nearest place. The sort
                                ;; is stable and `places` starts with the edit itself.
                                (first (sort-by (juxt cost
                                                      #(Math/abs (long (- (start-of %) (start-of e)))))
                                                places))))))))
                []
                edits)]
     (if (= edits moved) ops (edits->ops moved)))))

(defn- cut-count
  "How many (non-empty) tokens the delete ranges overlap only PARTIALLY."
  [tokens ranges]
  (count (filter (fn [{:token/keys [begin end]}]
                   (and (< begin end)
                        (some (fn [[s e]]
                                (and (< s end) (> e begin)
                                     (not (and (<= s begin) (<= end e)))))
                              ranges)))
                 tokens)))

(defn normalize-deletes
  "Rewrite `ops` (as produced by `diff` for `old`) so that two deletes
  separated by a kept run equal to an edge of the adjacent deleted text
  become one contiguous delete when that cuts fewer of `tokens` (old-body
  code-point offsets). The reconstructed string is unchanged."
  [ops old tokens]
  (let [edits (ops->edits ops)
        ranges-of (fn [edits] (keep #(when (= (:kind %) :delete) [(:start %) (:end %)]) edits))
        cp-sub (fn [s e] (cp/cp-subs old s e))
        step (fn [edits]
               (let [v (vec edits)]
                 (loop [i 0]
                   (when (< (inc i) (count v))
                     (let [a (v i) b (v (inc i))]
                       (if (and (= (:kind a) :delete) (= (:kind b) :delete)
                                (< (:end a) (:start b)))
                         (let [m (- (:start b) (:end a))
                               k (cp-sub (:end a) (:start b))
                               candidates
                               (cond-> []
                                 ;; kept run == tail of the second delete: delete [a.start, b.end-m)
                                 (and (<= m (- (:end b) (:start b)))
                                      (= k (cp-sub (- (:end b) m) (:end b))))
                                 (conj {:kind :delete :start (:start a) :end (- (:end b) m)})
                                 ;; kept run == head of the first delete: delete [a.start+m, b.end)
                                 (and (<= m (- (:end a) (:start a)))
                                      (= k (cp-sub (:start a) (+ (:start a) m))))
                                 (conj {:kind :delete :start (+ (:start a) m) :end (:end b)}))
                               before (cut-count tokens (ranges-of v))
                               best (->> candidates
                                         (map (fn [c] [(cut-count tokens (ranges-of (assoc v i c (inc i) nil))) c]))
                                         (filter (fn [[n _]] (< n before)))
                                         (sort-by first)
                                         first)]
                           (if best
                             (into (subvec v 0 i) (into [(second best)] (subvec v (+ i 2))))
                             (recur (inc i))))
                         (recur (inc i))))))))]
    (loop [edits edits merged? false]
      (if-let [next (step edits)]
        (recur (vec (remove nil? next)) true)
        ;; Untouched input when nothing merged: the caller's ops are already
        ;; valid, so don't risk a lossy round trip.
        (if merged? (edits->ops edits) ops)))))

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

(defn- holds-with-room?
  "A token that holds [s e) and reaches past it on one side at least, so the
  stretch is a change inside the token and not the whole of it."
  [tokens s e]
  (boolean (some (fn [{:token/keys [begin end]}]
                   (and (< begin end) (<= begin s) (<= e end)
                        (or (< begin s) (< e end))))
                 tokens)))

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
  `tokens-near`)."
  [^ints o near r]
  (let [n (alength o)
        {s :start t :end ^String value :value} r
        v (.toArray (.codePoints value))
        ws? (fn [c] (Character/isWhitespace (int c)))
        ;; the new text's words, as [from to) code-point ranges of v
        words (loop [i 0 out []]
                (let [b (loop [i i] (if (and (< i (alength v)) (ws? (aget v i))) (recur (inc i)) i))
                      e (loop [i b] (if (and (< i (alength v)) (not (ws? (aget v i)))) (recur (inc i)) i))]
                  (if (< b e) (recur e (conj out [b e])) out)))
        ;; the run of old text without whitespace around [s, t)
        B (loop [i s] (if (and (pos? i) (not (ws? (aget o (dec i))))) (recur (dec i)) i))
        E (loop [i t] (if (and (< i n) (not (ws? (aget o i)))) (recur (inc i)) i))
        covering (when (and (some ws? v)
                            (not-any? #(ws? (aget o %)) (range s t)))
                   (filter (fn [{:token/keys [begin end]}]
                             (and (< begin end) (<= B begin s) (<= t end E)))
                           (near B E)))
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
        (if-let [choice (first (filter allowed? choices))]
          (edits choice)
          [r])))))

;; A replace that takes whole words and the edge of the next one: deleting
;; `Yarın ` and capitalizing `köye` is delete `Yarın k`, insert `K`, which
;; pair into one replace. No token holds it, so `köye` would lose its `k` and
;; `K` stand outside every word. Cut at the edge of the word it reaches into,
;; it is `Yarın ` deleted and `k` replaced by `K`, and the word keeps its
;; first letter.

(defn- split-at-token-edges
  "The edits for `r`, a replace of [s, t) in `o`, cut where it reaches into
  tokens it does not hold. When tokens begin inside [s, t) and end past it,
  and none begins before it and ends inside it, the part from the last such
  beginning to t is replaced by the new text after its last space, and the
  part before is replaced by the rest (deleted when there is none). The same
  at the other end: tokens beginning before it and ending inside it get the
  new text up to its first space. A replace reaching into tokens at both
  ends stays as it is, since the text cannot tell which of them the new
  letters belong to.

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
  begin or end in a stretch (see `tokens-near`)."
  [^ints o near word? r]
  (let [{s :start t :end ^String value :value} r
        o-space? (fn [i] (space? (aget o (int i))))
        no-space? (fn [p q] (not-any? o-space? (range p q)))
        ;; the run of `o` without a space around i
        run (fn [i] [(loop [k i] (if (and (pos? k) (not (o-space? (dec k)))) (recur (dec k)) k))
                     (loop [k i] (if (and (< k (alength o)) (not (o-space? k))) (recur (inc k)) k))])
        width? (fn [{:token/keys [begin end]}] (< begin end))
        ;; Two tokens meet at p inside a word without a space that runs
        ;; across it: p is between two morphemes of the word. Where a
        ;; punctuation mark is left between two words, nothing meets. In a
        ;; script without spaces a sentence, a UMR node or a time-alignment
        ;; segment over several words is such a token too, and only its
        ;; layer tells it from a word.
        inside-word? (fn [p]
                       (let [[B E] (run p)
                             ts (filter width? (near B E))
                             in (fn [S] (filter (fn [{:token/keys [begin end]}]
                                                  (and (<= (:token/begin S) begin) (<= end (:token/end S))
                                                       (not= [begin end] [(:token/begin S) (:token/end S)])))
                                                ts))]
                         (some (fn [{:token/keys [begin end] :as S}]
                                 (and (word? S) (<= B begin) (< begin p end) (<= end E)
                                      (some #(= p (:token/end %)) (in S))
                                      (some #(= p (:token/begin %)) (in S))))
                               ts)))
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
                  :else [{:kind :replace :start p :end q :value value}]))]
    (cond
      (and (seq into-next) (empty? into-prev))
      (let [b (reduce max (map :token/begin into-next))
            k (loop [k n] (if (and (pos? k) (not (ws? (dec k)))) (recur (dec k)) k))]
        (into (piece s b (sub 0 k) s) (piece b t (sub k n) t)))

      (and (seq into-prev) (empty? into-next))
      (let [a (reduce min (map :token/end into-prev))
            k (loop [k 0] (if (and (< k n) (not (ws? k))) (recur (inc k)) k))]
        (into (piece s a (sub 0 k) s) (piece a t (sub k n) t)))

      :else [r])))

(declare apply-text-edits fold-whole-words*)

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
  not over both (`NY` to `New York`). The reconstructed string is
  unchanged.

  `word-layers` is the set of the tokens' layers that hold words: those
  that forbid overlap, are no partition and nest under another layer (see
  `update-body`). Only a token on one is a word around morphemes, so a
  sentence, a UMR node or a time-alignment segment over several words of a
  script without spaces is never taken for one. Without it any token
  without a space may be a word. Edits leaving only spaces in a word's place
  are not folded onto it: the word is deleted."
  ([ops old tokens] (fold-whole-words ops old tokens nil))
  ([ops old tokens word-layers]
   (let [word? (if (nil? word-layers)
                 (constantly true)
                 (fn [{:token/keys [layer]}] (contains? word-layers layer)))]
     (fold-whole-words* ops old tokens word?))))

(defn- fold-whole-words*
  [ops old tokens word?]
  (let [edits0 (vec (ops->edits ops))
        ^ints o (.toArray (.codePoints ^String old))
        near (delay (tokens-near tokens (count edits0)))
        ;; A replace reaching into the edge of a word it does not hold is cut
        ;; there first, so the part inside the word is judged below as any
        ;; edit of that word is: `dog cow` to `cab` folds `cow` as `cow` to
        ;; `cab` does.
        edits (into [] (mapcat #(if (= :replace (:kind %)) (split-at-token-edges o @near word? %) [%])) edits0)
        cut? (not= edits edits0)
        whole (alength o)
        old-text (fn [p q] (String. o (int p) (int (- q p))))
        start-of (fn [e] (or (:start e) (:at e)))
        reach-of (fn [e] (or (:end e) (:at e)))
        ;; Whether the edits beside [b e) leave it to itself: none touches
        ;; it, or a delete or replace ends at b or begins at e, as the parts
        ;; of a replace cut at a word's edge do. Text typed at an edge does
        ;; not, since it stays outside the word.
        clear-before? (fn [prev b] (or (nil? prev) (< (reach-of prev) b) (= (:end prev) b)))
        clear-after? (fn [j e] (or (= j (count edits)) (> (start-of (edits j)) e)
                                   (and (:end (edits j)) (= (:start (edits j)) e))))
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
        new-text (fn [g b e]
                   (loop [g g p b sb (StringBuilder.)]
                     (if-let [x (first g)]
                       (do (.append sb (old-text p (start-of x)))
                           (when (:value x) (.append sb ^String (:value x)))
                           (recur (rest g) (reach-of x) sb))
                       (str (.append sb (old-text p e))))))
        ws? (fn [c] (Character/isWhitespace (int c)))
        has-ws? (fn [^String v] (and v (.anyMatch (.codePoints v) (reify java.util.function.IntPredicate
                                                                    (test [_ c] (Character/isWhitespace c))))))
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
        group (fn [i b e]
                (let [j (loop [j i]
                          (if (and (< j (count edits)) (<= (reach-of (edits j)) e)
                                   (>= (start-of (edits j)) b))
                            (recur (inc j))
                            j))
                      g (subvec edits i j)
                      kinds (set (map :kind g))]
                  (when (and (seq g)
                             (clear-after? j e)
                             ;; spaces alone are no word to fold onto: a word
                             ;; they take the place of is deleted
                             (not (every? space? (.toArray (.codePoints ^String (new-text g b e)))))
                             (or (and (> (count g) 1)
                                      (= b (start-of (first g)))
                                      (= e (reduce max (map reach-of g)))
                                      (or (kinds :replace)
                                          (and (kinds :delete) (kinds :insert))))
                                 (splits? g b e))
                             ;; A word with tokens inside (its morphemes)
                             ;; takes the replace only when the edits as they
                             ;; are would break it, and when the word then
                             ;; lands on one new word: kept apart from a word
                             ;; typed beside it (`cow` to `at co` at a
                             ;; sentence start keeps the word and `co` on
                             ;; `co`, as the edits leave them).
                             (or (not (inside? b e))
                                 (and (word-at? b e)
                                      (not-any? #(ws? (aget o %)) (range b e))
                                      (broken? g b e)
                                      (not-any? #(and (= :replace (:kind %)) (has-ws? (:value %)))
                                                (split-off-new-words o @near (as-replace g b e))))))
                    g)))
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
                                  (if (and (< j (count edits)) (<= (reach-of (edits j)) e)
                                           (>= (start-of (edits j)) b))
                                    (recur (inc j))
                                    j))
                              g (subvec edits i j)]
                          (when (and (seq g)
                                     (clear-after? j e)
                                     (some #(and (:end %) (< (:start %) (:end %))) g)
                                     (not-any? #(ws? (aget o %)) (range b e))
                                     (analysis-lost? g b e)
                                     (not-any? #(and (= :replace (:kind %)) (has-ws? (:value %)))
                                               (split-off-new-words o @near (as-replace g b e))))
                            g)))
        ;; The tokens without whitespace that hold the whole of `e0`.
        holding (fn [e0]
                  (let [p (start-of e0)
                        q (reach-of e0)
                        B (loop [k p] (if (and (pos? k) (not (ws? (aget o (dec k))))) (recur (dec k)) k))
                        E (loop [k q] (if (and (< k whole) (not (ws? (aget o k)))) (recur (inc k)) k))]
                    (->> (@near B E)
                         (filter (fn [{tb :token/begin te :token/end :as t}]
                                   (and (< tb te) (<= B tb p) (<= q te E)
                                        (not (and (zero? tb) (= te whole)))
                                        (word? t))))
                         (sort-by :token/begin))))
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
                          (sort-by :token/begin)))))]
    (loop [i 0 out [] folded? false]
      (if (< i (count edits))
        (let [e0 (edits i)
              b (start-of e0)
              prev (peek out)
              lo (if prev (inc (reach-of prev)) 0)
              g-e (when (clear-before? prev b)
                    (or (some (fn [e] (when-let [g (group i b e)] [g b e])) (ends-at b))
                        (some (fn [{tb :token/begin te :token/end}]
                                (when-let [g (group i tb te)] [g tb te]))
                              (around lo e0))
                        (some (fn [{tb :token/begin te :token/end}]
                                (when (clear-before? prev tb)
                                  (when-let [g (partial-group i tb te)] [g tb te])))
                              (holding e0))))]
          (if-let [[g b e] g-e]
            (recur (+ i (count g))
                   (conj out (as-replace g b e))
                   true)
            (recur (inc i) (conj out e0) folded?)))
        ;; A word typed beside the replaced letters stays out of them,
        ;; here and in the replaces `pair-replacements` made, and a replace
        ;; reaching into the edge of a token it does not hold is cut there.
        (let [replace? #(= :replace (:kind %))
              out' (into []
                         (comp (mapcat #(if (replace? %) (split-off-new-words o @near %) [%]))
                               (mapcat #(if (replace? %) (split-at-token-edges o @near word? %) [%])))
                         out)]
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
  node that way."
  ([ops old] (pair-replacements ops old []))
  ([ops old tokens]
   (let [whole (cp/cp-count old)
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
               touching? (and (seq run) (= (:index op) at) (not apart?))
               ;; The run is all of one kind and this op is the other: the
               ;; kept text between them is part of one respelling when a
               ;; token holds the lot with room to spare.
               gap-start (+ start width)
               reach (+ old-index (old-width op))
               over-kept? (and (seq run)
                               (not touching?)
                               (not apart?)
                               (< gap-start old-index)
                               (= #{(if (= :delete (:type op)) :insert :delete)}
                                  (kind-of run))
                               (holds-with-room? tokens start reach)
                               (not (token-inside? tokens start reach)))]
           (cond
             touching?
             (recur (rest ops) (conj run op) (op-end op) start (+ width taken) shift' out)

             over-kept?
             (let [kept {:type :keep :value (cp/cp-subs old gap-start old-index)}]
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
  and so is one holding only spaces."
  [old tokens result partitioning]
  (let [^ints o (.toArray (.codePoints ^String old))
        ^ints n (.toArray (.codePoints ^String (:text/body (:text result))))
        before (into {} (map (juxt :token/id identity)) tokens)
        on-space? (fn [^ints cs i] (space? (aget cs (int i))))]
    (update result :tokens
            (fn [ts]
              (mapv (fn [{:token/keys [id layer begin end] :as t}]
                      (let [was (before id)]
                        (if (or (nil? was) (>= begin end) (contains? partitioning layer)
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
  applied in turn."
  [ops text tokens]
  (let [ops (vec (take-while some? ops))
        ^String body (:text/body text)
        ^ints o (.toArray (.codePoints body))
        n (alength o)
        ;; Validate as the ops come, and place each in the old body: an op
        ;; at running index i stands at old position i - shift. `edits` is
        ;; nil once an op stands before where the previous one left off.
        {:keys [edits]}
        (reduce (fn [{:keys [len shift reach edits] :as acc} op]
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
                                                 :value (if (= type :delete) "" value)})))))
                {:len n :shift 0 :reach 0 :edits []}
                ops)]
    (if-not edits
      (apply-text-edits-in-turn ops text tokens)
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
