(ns plaid.algos.text.read
  "What a change to a text's body is read as, in gaps for the plain rule:
  a whole-body save's diff slid to the tokens, its deletes normalized and
  its stretches aligned to the words (`plain-body-read`), and the net
  change of an editor's edits (`plain-edit-gaps`)."
  (:require [clojure.set :as set]
            [plaid.algos.text.chars :refer [cps->str has-space? punct-only? space? word-letter?]]
            [plaid.algos.text.align :refer [align-to-words]]
            [plaid.algos.text.diff :refer [diff]]
            [plaid.algos.text.index :refer [lower-bound tokens-near upper-bound]]
            [plaid.algos.text.ops :refer [compose-edits edits->ops ops->edits]]
            [plaid.algos.text.plain :refer [apply-plain-gaps gaps-body typed-to-next? word-token?]]
            [plaid.util.codepoint :as cp]))

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
                                 (map (fn [[a v]] (assoc edit :at a :value (cps->str v))))))]
      (concat [edit] (places step-left) (places step-right)))))

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
  (let [;; [s e) slid by k code points, left when k is negative, when each
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
                 (not (has-space? (:value x)))
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
                 (not (has-space? (:value y)))
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
        word-of (fn [{:keys [start end]}]
                  (let [i (dec (upper-bound begins start))]
                    (when (>= i 0) (let [w (words i)] (when (<= end (:token/end w)) w)))))
        apart? (fn [x y] (some #(space? (aget o %)) (range (:end x) (:start y))))
        ;; runs of gaps in one word with no whitespace between
        runs (reduce (fn [out g]
                       (let [w (word-of g)
                             [pw run] (peek out)]
                         (if (and w pw (= (:token/id w) (:token/id pw)) (not (has-space? (:value g)))
                                  (not (has-space? (:value (peek run)))) (not (apart? (peek run) g)))
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
                                   (subvec wide (upper-bound wbegins (dec (:token/begin w)))
                                           (upper-bound wbegins (dec (:token/end w))))))
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
         over (fn [a b] (let [from (lower-bound begins (- a longest))]
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
               (let [from (lower-bound tbegins (- lo tlongest))]
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
