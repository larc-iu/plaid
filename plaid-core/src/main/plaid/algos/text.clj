(ns plaid.algos.text
  "What a change to a text's body does to the text and to the tokens over
  it. The work is in the namespaces under this one, and this one keeps the
  public names its callers use (see `export`)."
  (:require [clojure.set :as set]
            [plaid.algos.text.chars :refer [combining-mark? in-ranges? punct-classes punct-only? space?
                                            word-letter?]]
            [plaid.algos.text.diff]
            [plaid.algos.text.ops :refer [edits->ops ops->edits]]
            [plaid.algos.text.plain :refer [gaps-body typed-to-next? word-token?]]
            [plaid.util.codepoint :as cp]))

(defmacro ^:private export
  "Each of `syms`, a fully qualified public var of a namespace under this
  one, defined here under its own name with its doc and arglists."
  [& syms]
  `(do ~@(for [s syms
               :let [m (meta (resolve s))]]
           `(def ~(vary-meta (symbol (name s)) assoc :doc (:doc m) :arglists (list 'quote (:arglists m)))
              ~s))))

(export plaid.algos.text.chars/ignored-rule
        plaid.algos.text.diff/diff
        plaid.algos.text.plain/follow-sentences
        plaid.algos.text.plain/apply-plain-gaps
        plaid.algos.text.plain/layer-roles
        plaid.algos.text.ops/delete-op
        plaid.algos.text.ops/insert-op
        plaid.algos.text.ops/replace-op
        plaid.algos.text.ops/edit-ops-body
        plaid.algos.text.ops/apply-text-edits
        plaid.algos.text.ops/compose-edits
        plaid.algos.text.ops/gap-ops)

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
  tokens meet goes into one of them (see `apply-plain-gaps`): the one
  beginning there when the text stands past whitespace on that token's
  first line, or right after the punctuation the token before ends on, else
  the one ending there (and at the start of the text the first). That token
  counts as disturbed there, as it does for an insert inside it, and the
  one beginning there, when the one ending there takes the text, if its
  letter before changes. Doubling the `a` of `tat! a. tat` before the `a`
  gives it to the second sentence, as doubling it after the `a` does.

  A delete that cuts a token at one end and leaves it ending (or beginning)
  on a space it did not have there counts that token half again, so of the
  two ways to delete a word at the edge of a token over several words (a
  UMR node), the one taking the space on the far side wins.

  A word token (one on a layer in `word-layers`) made only of punctuation
  (see `punct-only?`, `letter-like` as there) takes no text typed against
  it, so an insert at its edge disturbs nothing there."
  [^ints o tokens partitioning word-layers letter-like edit]
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
            ;; Where two tokens of a partition meet, the text goes into the
            ;; one beginning there when it is typed past whitespace on the
            ;; next letter's line, or right after punctuation with no
            ;; whitespace, and else into the one ending there (see `apply-plain-gaps`).
            to-next? (typed-to-next? o a v letter-like)
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
           (count (filter (fn [{:token/keys [begin end layer] :as t}]
                            (cond
                              (= begin end) false
                              (< begin a end) true
                              (partitioning layer) (cond
                                                     (= end a) (not to-next?)
                                                     (= begin a) (or (zero? a) to-next? new-before?)
                                                     :else false)
                              ;; a word made only of punctuation takes no
                              ;; text typed against it (see `apply-plain-gaps`)
                              (and (contains? word-layers layer) (punct-only? o letter-like t)) false
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
  left as they are. A code point in `letter-like` (see `layer-roles`) is a
  letter of a word."
  [ops old tokens word-layers letter-like]
  (if (empty? word-layers)
    ops
    (align-to-words* ops old tokens word-layers (or letter-like #{}))))

(defn- align-to-words*
  [ops old tokens word-layers letter-like]
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
                letter? (fn [i] (word-letter? letter-like (aget o (int (+ a i)))))
                in-word? (let [held (boolean-array (inc m))]
                           (doseq [{:token/keys [begin end layer]} (near a (min n (inc b)))
                                   :when (and (< begin end) (contains? word-layers layer))
                                   p (range (max a begin) (min (inc b) end))]
                             (aset held (- p a) true))
                           (fn [i] (and (aget held i) (letter? i))))
                osp (fn [i] (sp? (+ a i)))
                nsp (fn [j] (space? (aget N (int j))))
                lt? (fn [q] (word-letter? letter-like (aget o (int q))))
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
                                   ;; both old words (counted by `run-end`),
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
                 ;; token takes them, where the plain rule puts the letters
                 ;; typed in a word the diff kept by its middle on that word:
                 ;; `thekaitat` to `theaek` keeps `kai` by its `a`, and the
                 ;; plain rule gives it `aek`, where keeping it by its `k` left
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
  tokens' layers that are partitions, `word-layers` the words' layers and
  `letter-like` the code points the text's layers call letter-like (see
  `slide-cost`)."
  [ops old tokens partitioning word-layers letter-like]
  (let [partitioning (set partitioning)
        word-layers (set word-layers)
        edits (vec (ops->edits ops))
        ^ints o (.toArray (.codePoints ^String old))
        n (alength o)
        reach-of (fn [e] (if (= :delete (:kind e)) (:end e) (:at e)))
        start-of (fn [e] (if (= :delete (:kind e)) (:start e) (:at e)))
        near (tokens-near tokens (count edits))
         ;; an insert where a partition's token begins that the edits path
         ;; would give to that token: of two readings that disturb as much,
         ;; this one wins, so text typed at several sentence starts goes to
         ;; each sentence it starts, as one typed alone does
        next-start? (fn [near-e e]
                      (and (= :insert (:kind e))
                           (some #(and (partitioning (:token/layer %)) (= (:at e) (:token/begin %))) near-e)
                           (typed-to-next? o (:at e) (.toArray (.codePoints ^String (:value e))) letter-like)))
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
                                 near-e (near (reduce min (map start-of places))
                                              (reduce max (map reach-of places)))
                                 cost #(slide-cost o near-e partitioning word-layers letter-like %)
                                 here (cost e)
                                  ;; an insert that can stand right after (or
                                  ;; before) a delete of exactly one token's text
                                  ;; makes that token typed over whole, which
                                  ;; keeps it: `我你好吗。` saved as `我好好吗！` is
                                  ;; `你` typed over as `好`, not `你` deleted and
                                  ;; `好` doubled (REV3-F-TEXT-CORE G2)
                                 whole? (fn [d] (and d (= :delete (:kind d))
                                                     (some #(and (= (:token/begin %) (:start d)) (= (:token/end %) (:end d)))
                                                           (near (:start d) (:end d)))))
                                 typed-over (when (and (= :insert (:kind e)) (pos? here))
                                              (let [p (peek moved)]
                                                (or (when (and prev (whole? p) (<= (:end p) (:at e)))
                                                      (some #(when (= (:at %) (:end p)) %) (slide-places o e (:end p) hi)))
                                                    (when (and (whole? nxt) (<= (:at e) (:start nxt)))
                                                      (some #(when (= (:at %) (:start nxt)) %) (slide-places o e lo (:start nxt)))))))]
                             (cond
                               typed-over typed-over
                               (zero? here)
                               e
                                ;; The fewest disturbed, then the fewest cut, then
                                ;; the nearest place. The sort is stable and
                                ;; `places` starts with the edit itself.
                               :else
                               (first (sort-by (juxt cost
                                                     #(slide-cuts near-e %)
                                                     #(if (next-start? near-e %) 0 1)
                                                     #(Math/abs (long (- (start-of %) (start-of e)))))
                                               places))))))))
               []
               edits)]
    (if (= edits moved) ops (edits->ops moved))))

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
  [^ints o ^ints v ow vw a b x y letter-like]
  (let [m (count ow)
        n (count vw)]
    (if (or (zero? m) (zero? n))
      [[a b x y nil]]
      (let [ob (fn [i] (first (ow i))) oe (fn [i] (second (ow i)))
            vb (fn [i] (first (vw i))) ve (fn [i] (second (vw i)))
            most (fn [score from to] (reduce (fn [a i] (if (> (score i) (score a)) i a)) from (range (inc from) to)))
            at-start? (fn [i] (and (pos? a) (= a (ob i)) (word-letter? letter-like (aget o (dec a)))))
            at-end? (fn [i] (and (< b (alength o)) (= b (oe i)) (word-letter? letter-like (aget o b))))
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
  gap with fewer than two old words, or no new word, is left whole.
  `letter-like` as in `pair-words`."
  [^ints o letter-like {:keys [start end value] :as gap}]
  (let [^ints v (.toArray (.codePoints ^String value))
        ow (filterv #(not (nth % 2)) (cp-runs o start end))
        vw (filterv #(not (nth % 2)) (cp-runs v 0 (alength v)))]
    (if (or (< (count ow) 2) (empty? vw))
      [gap]
      (let [;; [old-b old-e new-b new-e keep], in order
            pieces (pair-words o v ow vw start end 0 (alength v) (or letter-like #{}))
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

(defn- word-extents
  "The old extents of the words of `tokens`: those on `word-layers`, else
  every token on no layer in `partitioning`."
  [tokens partitioning word-layers]
  (into #{} (comp (filter (word-token? tokens partitioning word-layers))
                  (map (juxt :token/begin :token/end)))
        tokens))

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
  "The layers whose tokens are the words of a whole-body save, as
  `word-token?` tells them."
  [tokens partitioning word-layers]
  (into #{} (comp (filter (word-token? tokens partitioning word-layers)) (map :token/layer)) tokens))

(defn body-diff-gaps
  "The change a whole-body save of `old` as `new` reads, before it reads any
  stretch as words typed over: the diff, each edit moved to the equivalent
  place that disturbs the fewest `tokens` (see `slide-to-tokens` and
  `normalize-deletes`), each changed stretch aligned to the words of
  `word-layers` (see `align-to-words`), and edits that touch one gap. A
  letter outside these gaps is a letter the save keeps, and no token
  holding one is deleted. With `align?` false, the stretches are left as
  the diff spells them. `letter-like` is the code points the text's
  layers call letter-like (see `layer-roles`)."
  ([^String old ^String new tokens partitioning word-layers align? letter-like]
   (-> (diff old new)
       (slide-to-tokens old tokens partitioning word-layers letter-like)
       (normalize-deletes old tokens)
       (cond-> align? (align-to-words old tokens (body-word-layers tokens partitioning word-layers) letter-like))
       ops->edits
       edits->gaps)))

(defn plain-body-gaps
  "The gaps a whole-body save of `old` as `new` is taken as: those of
  `body-diff-gaps`, the gaps inside one word that would delete a token
  inside it made one gap (see `merge-in-words`), and each gap cut where it
  types words over words (see `cut-at-words`). Neither step reaches a
  letter outside the diff's gaps but inside the one word it reads as typed
  over, so no word with a letter left is deleted."
  ([^String old ^String new tokens partitioning word-layers letter-like]
   (let [^ints o (.toArray (.codePoints old))
         wl (body-word-layers tokens partitioning word-layers)]
     (-> (body-diff-gaps old new tokens partitioning word-layers true letter-like)
         (merge-in-words o tokens #(contains? wl (:token/layer %)))
         (->> (into [] (mapcat #(cut-at-words o letter-like %))))))))

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
  (let [run #(apply-plain-gaps old tokens % partitioning word-layers opts)
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
                (plain-body-gaps old new tokens partitioning word-layers (:letter-like opts))
                (delay (body-diff-gaps old new tokens partitioning word-layers false (:letter-like opts)))
                partitioning word-layers opts))

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
         word? (word-token? tokens partitioning word-layers)
         ;; a word for `foreign?` below: a token of a word layer, where the
         ;; text has one. In a text whose word layer holds no token yet the
         ;; rows decide in the words' place, but a row holds runs of text
         ;; with whitespace between as a matter of course, so it is never
         ;; foreign, and the gap is read as a whole-body save reads it
         ;; (REV7-TEXT-4)
         word-of-layer? (if (seq word-layers) #(contains? (set word-layers) (:token/layer %)) word?)
         children (set (:children opts))
         ;; gap i read as a whole-body save of its window (the text between
         ;; its neighbours) reads it, the tokens cut to the window, when that
         ;; reading deletes no word or sentence the gap as made keeps, or
         ;; deletes fewer, else the gap as made
         ;; `tokens` cut to old [lo, hi), in its coordinates: the short ones
         ;; found by their begin, the few long ones (a text in one sentence,
         ;; a document's token, a node over a long sentence) looked at whole
         long? #(< 1024 (- (:token/end %) (:token/begin %)))
         longs (filterv long? tokens)
         by-begin (vec (sort-by :token/begin (remove long? tokens)))
         tbegins (long-array (map :token/begin by-begin))
         tlongest (reduce max 0 (map #(- (:token/end %) (:token/begin %)) by-begin))
         in? (fn [lo hi {:token/keys [begin end]}] (if (= begin end) (<= lo begin hi) (and (< begin hi) (< lo end))))
         cut-one (fn [lo hi tk] (assoc tk :token/begin (- (max lo (:token/begin tk)) lo) :token/end (- (min hi (:token/end tk)) lo)))
         cut (fn [lo hi]
               (let [from (loop [a 0 b (alength tbegins)]
                            (if (< a b)
                              (let [m (quot (+ a b) 2)]
                                (if (< (aget tbegins m) (- lo tlongest)) (recur (inc m) b) (recur a m)))
                              a))]
                 (loop [i from out (transient (into [] (comp (filter #(in? lo hi %)) (map #(cut-one lo hi %))) longs))]
                   (if (and (< i (count by-begin)) (<= (aget tbegins i) hi))
                     (let [tk (by-begin i)]
                       (recur (inc i) (if (in? lo hi tk) (conj! out (cut-one lo hi tk)) out)))
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
                      aligned (plain-body-gaps st-old (:value g) st-tokens partitioning word-layers (:letter-like opts))
                      diffed (delay (body-diff-gaps st-old (:value g) st-tokens partitioning word-layers false (:letter-like opts)))
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
                      run #(apply-plain-gaps w-old w-tokens % partitioning word-layers (dissoc opts :split-on-space))
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
                                           (and (word-of-layer? tk) (not (gone id))
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

;; ---------------------------------------------------------------------------
;; Tokenize new text
;;
;; A save naming a word layer (`tokenize-layer` on the text routes) gets
;; words for the text it types, after the old tokens are placed, so no new
;; word lands where an old one now stands. The cut is igt's built-in
;; tokenizer's (plaid-igt `tokenizationUtils.js`, which the Tokenize tab runs):
;; a word is a run of code points that are neither whitespace nor a break
;; character under the layer's ignored-tokens rule.

(defn typed-ranges
  "Where in the body `gaps` (old-body order, never touching, see
  `compose-edits`) make their values stand, as `[begin end]` code points of
  the new body."
  [gaps]
  (loop [gaps gaps shift 0 out []]
    (if-let [{:keys [start end value]} (first gaps)]
      (let [n (cp/cp-count value)
            b (+ start shift)]
        (recur (rest gaps) (+ shift (- n (- end start))) (cond-> out (pos? n) (conj [b (+ b n)]))))
      out)))

(defn new-words
  "The words \"Tokenize new text\" makes on layer `layer` for a save that made
  `body` and typed `typed` (`[begin end]` ranges of it), with `tokens` (each
  `{:token/layer :token/begin :token/end}`) standing on it after the save:
  each stretch no token of `layer` covers, cut at every token begin of the
  `partitions` layers (the sentences), is cut into words at whitespace and
  at the code points `rule`, the layer's ignored-tokens rule (see
  `ignored-rule`), breaks at. A word is made when it holds a typed code point,
  is not one the rule ignores, and holds no letter of a script written
  without spaces between words (Han, kana, Thai and the like), whose words
  are the user's to cut. Returns `[{:token/layer :token/begin :token/end}]`
  in order."
  [^String body typed tokens layer partitions rule]
  (let [^ints o (.toArray (.codePoints body))
        n (alength o)
        covered (boolean-array n)
        typed? (boolean-array n)
        cut (boolean-array (inc n))
        partitions (set partitions)]
    (doseq [[b e] typed, x (range (max 0 b) (min n e))] (aset typed? x true))
    (doseq [{:token/keys [begin end] l :token/layer} tokens]
      (cond
        (= l layer) (doseq [x (range (max 0 begin) (min n end))] (aset covered x true))
        (partitions l) (when (< 0 begin n) (aset cut begin true))))
    (let [{:keys [break? ignored-word?]} rule
          stop? (fn [x] (or (aget covered x) (space? (aget o x)) (break? (aget o x))))]
      (loop [x 0 out []]
        (cond
          (>= x n) out
          (stop? x) (recur (inc x) out)
          :else
          (let [y (loop [y (inc x)] (if (and (< y n) (not (stop? y)) (not (aget cut y))) (recur (inc y)) y))
                cps (map #(aget o %) (range x y))]
            (recur y (cond-> out
                       (and (some #(aget typed? %) (range x y))
                            (not (ignored-word? cps))
                            (not-any? #(in-ranges? (punct-classes "spaceless") %) cps))
                       (conj {:token/layer layer :token/begin x :token/end y})))))))))
