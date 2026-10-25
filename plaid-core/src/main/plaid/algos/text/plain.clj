(ns plaid.algos.text.plain
  "What a change, read as gaps, does to the tokens over a text: the plain
  rule (`apply-plain-gaps`), the rows that follow the sentences, a word a
  typed space splits, and the roles a layer's shape gives it in a save
  (`layer-roles`)."
  (:require [plaid.algos.text.chars :refer [line-break? punct? punct-only? space?]]
            [plaid.algos.text.index :refer [upper-bound]]
            [plaid.algos.text.ops :refer [apply-text-edits gap-ops]]
            [plaid.util.codepoint :as cp]))

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

(defn typed-to-next?
  "Whether text `v` (code points) inserted at `a` in `o` goes to the token of
  a partition beginning there (see `apply-plain-gaps`): typed past whitespace
  on the next letter's line, or right after punctuation (see `punct?`,
  `letter-like` as there) with no whitespace, and holding no line break."
  [^ints o a ^ints v letter-like]
  (let [n (alength o)]
    (boolean
     (and (pos? a) (< a n)
          (not-any? line-break? v)
          (if (space? (aget o (dec a)))
            (loop [x a] (cond (>= x n) false
                              (not (space? (aget o x))) true
                              (line-break? (aget o x)) false
                              :else (recur (inc x))))
            (and (not (space? (aget o a))) (punct? (or letter-like #{}) (aget o (dec a)))))))))

(defn gaps-body
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
  end, its begin when at or before the begin. A point inside a token the
  save makes (`made`, a part of a word a typed space split, which stood
  nowhere before) goes to that token's nearer edge, its end on a tie."
  [old-tokens kept made points]
  (let [was (into {} (map (juxt :token/id identity)) old-tokens)
        inside (fn [layer begin ts] (some (fn [t] (when (and (= layer (:token/layer t)) (< (:token/begin t) begin (:token/end t))) t)) ts))]
    (mapv (fn [{:token/keys [id layer begin] :as z}]
            (let [p (:token/begin (was id))
                  t (inside layer begin kept)
                  w (some-> t :token/id was)
                  m (when-not t (inside layer begin made))]
              (cond
                m (let [{mb :token/begin me :token/end} m
                        x (if (< (- begin mb) (- me begin)) mb me)]
                    (assoc z :token/begin x :token/end x))
                (or (nil? t) (nil? w) (nil? p)) z
                (>= p (:token/end w)) (assoc z :token/begin (:token/end t) :token/end (:token/end t))
                (<= p (:token/begin w)) (assoc z :token/begin (:token/begin t) :token/end (:token/begin t))
                :else z)))
          points)))

(defn follow-sentences
  "`kept` (tokens as a text edit left them) with each follower's
  (`follower?`, a row: a token of a layer that forbids overlap beside the
  words) edges placed by one rule, edge by edge (FX-D-TEXT):
  - An edge on a sentence boundary (a token of a layer in `partitioning`),
    a begin at a sentence's begin or first letter, an end at its end or
    after its last letter, of a row over that whole sentence goes where
    that edge of the sentence goes after the partition's gap-fill (see
    `compensate-partition-layers!`). An edge on whitespace keeps the
    sentence's whitespace there, an edge on a letter is moved off
    whitespace onto the sentence's letters. So text typed where such an
    edge meets the boundary goes with the sentence the partition rule
    chooses, and the row holds it when it is on that sentence's side. Text
    typed in the whitespace between such an edge and the row's letters
    counts as typed at the boundary (FX-E-TEXT, REV4-TEXT-1).
  - Such an edge of a row over part of the sentence takes only the text
    typed right at it (`typed-at`) that the sentence took after the
    gap-fill, where the plain rule left the edge beside that text.
  - Any other edge stays where the plain rule placed it.
  - No edge leaves out what the row holds as its own (`held`, of its old
    extent less that boundary whitespace: its old text left and the text
    typed strictly inside it), so text typed inside a row stays in it and
    no letter a row held leaves it (REV4-TEXT-2).
  - Two rows of a layer that did not overlap do not: where two edges cross,
    they meet at the one that stayed put, else at the one that keeps what
    each row holds, else every row of the layer keeps the plain placement.
  `heads` are the sentences to be made at the start of the text (see
  `apply-plain-gaps`), `nw` the new text's code points, `held` a function
  of an old extent `[b e]` giving the new extent of what it holds, or nil,
  and `typed-at` one of an old position giving the new extent of the text
  inserted there, or nil."
  [^ints o old-tokens kept heads ^ints nw partitioning follower? held typed-at]
  (let [n (alength nw)
        lead (fn [^ints cs b e] (loop [x b] (if (and (< x e) (space? (aget cs x))) (recur (inc x)) x)))
        tail (fn [^ints cs b e] (loop [x e] (if (and (> x b) (space? (aget cs (dec x)))) (recur (dec x)) x)))
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
        ;; old edge position -> where an edge there goes, from each
        ;; sentence's old edges (with and without its whitespace) to its new
        ;; ones, kept where every partition agrees: `:to`, the sentences'
        ;; text `:over` (its letters, or all of it when it has none) and
        ;; their new extents `:now`
        agreed (fn [pairs]
                 (into {}
                       (keep (fn [[x ys]] (let [ms (map second ys)]
                                            (when (= 1 (count (into #{} (map :to) ms)))
                                              [x {:to (:to (first ms)) :over (map :over ms) :now (map :now ms)}]))))
                       (group-by first pairs)))
        edges (for [{:token/keys [id begin end]} parts
                    :let [[nb ne] (filled id)]
                    :when nb]
                (let [ob (lead o begin end) oe (tail o begin end)
                      lb (lead nw nb ne) le (tail nw nb ne)
                      letters? (< ob oe)
                      new-letters? (< lb le)
                      e (fn [x to] [x {:to to :over (if letters? [ob oe] [begin end])
                                       :now [nb ne]}])]
                  {:begins (cond-> [(e begin (if (or (space? (aget o begin)) (not new-letters?)) nb lb))]
                             (and letters? (not= ob begin)) (conj (e ob (if new-letters? lb nb))))
                   :ends (cond-> [(e end (if (or (space? (aget o (dec end))) (not new-letters?)) ne le))]
                           (and letters? (not= oe end)) (conj (e oe (if new-letters? le ne))))}))
        begin-at (agreed (mapcat :begins edges))
        end-at (agreed (mapcat :ends edges))
        ;; where an edge goes: a row over the whole of the sentence there
        ;; follows the sentence's edge, a row over part of it takes the text
        ;; typed right at its edge that the sentence took, where the plain
        ;; rule left the edge beside it, and nothing else
        whole? (fn [{:keys [over]} begin end] (every? (fn [[x y]] (and (<= begin x) (<= y end))) over))
        place (fn [{:keys [to now] :as at} begin end begin? plain]
                (if (whole? at begin end)
                  to
                  (when-let [[x y] (typed-at (if begin? begin end))]
                    (let [[x y] (reduce (fn [[x y] [nb ne]] [(max x nb) (min y ne)]) [x y] now)
                          [x y] (if begin?
                                  [(if (space? (aget o begin)) x (lead nw x y)) y]
                                  [x (if (space? (aget o (dec end))) y (tail nw x y))])]
                      (when (and (< x y) (<= x plain y))
                        (if begin? (min x plain) (max y plain)))))))
        ;; each follower, where its edges go: `:b` `:e`, what it holds,
        ;; `:hb` `:he`, and whether each edge followed a sentence
        rows (keep (fn [{:token/keys [id] :as t}]
                     (let [{:token/keys [begin end]} (was id)]
                       (when (and begin (< begin end) (follower? t))
                         (let [ba (begin-at begin)
                               ea (end-at end)
                               ;; text typed in the whitespace where a row over
                               ;; whole sentences meets a sentence boundary
                               ;; counts as typed at the boundary, so it goes
                               ;; with the sentence that takes it
                               hb* (if (and ba (whole? ba begin end)) (lead o begin end) begin)
                               he* (if (and ea (whole? ea begin end)) (tail o begin end) end)
                               [hb he] (when (< hb* he*) (held [hb* he*]))
                               ;; every edge keeps what the row holds
                               pb (cond-> (:token/begin t) hb (min hb))
                               pe (cond-> (:token/end t) he (max he))
                               fb (some-> ba (place begin end true pb))
                               fe (some-> ea (place begin end false pe))
                               b (cond-> (or fb pb) hb (min hb))
                               e (cond-> (or fe pe) he (max he))]
                           (if (< b e)
                             {:id id :layer (:token/layer t) :old begin :b b :e e :hb hb :he he
                              :fb (and fb (= b fb)) :fe (and fe (= e fe))}
                             {:id id :layer (:token/layer t) :old begin :b (:token/begin t) :e (:token/end t)
                              :hb hb :he he})))))
                   kept)
        ;; where two rows of a layer now cross, one cut between them
        placed (into {}
                     (mapcat (fn [[_ rs]]
                               (let [rs (vec (sort-by :old rs))
                                     out (reduce
                                          (fn [out r]
                                            (let [p (peek out)]
                                              (if (and p (> (:e p) (:b r)))
                                                (let [lo (or (:he p) (inc (:b p)))
                                                      hi (or (:hb r) (dec (:e r)))
                                                      in? #(<= lo % hi)
                                                      c1 (:e p) c2 (:b r)
                                                      cut (cond (and (in? c2) (not (:fb r))) c2
                                                                (and (in? c1) (not (:fe p))) c1
                                                                (in? c2) c2
                                                                (in? c1) c1
                                                                (<= lo hi) (max lo (min hi c2)))]
                                                  (if cut
                                                    (conj (pop out) (assoc p :e cut) (assoc r :b cut))
                                                    (reduced nil)))
                                                (conj out r))))
                                          [] rs)]
                                 ;; nothing keeps both: the plain placement
                                 (map (juxt :id identity)
                                      (or out (map #(let [t (now (:id %))] (assoc % :b (:token/begin t) :e (:token/end t))) rs)))))
                             (group-by :layer rows)))]
    (mapv (fn [{:token/keys [id] :as t}]
            (if-let [{:keys [b e]} (placed id)]
              (assoc t :token/begin b :token/end e)
              t))
          kept)))

(defn- split-spaced-words
  "`{:placed :made}`: `placed` (the tokens `apply-plain-gaps` placed,
  `::gone` marking the deleted) with each word (`word?`) that the edit typed
  whitespace inside split there, and `made`, the new tokens the split
  makes (Luke, 2026-10-02: ud splits a word a space is typed in), each
  cut from a token naming it under `:token/from`, whose
  `preserveOnSplit` keys and precedence the save gives it. A word is
  cut only at the runs of whitespace holding typed whitespace, never at
  spaces it had. It stays on the part holding the most of its old letters
  (the first on a tie), with what hangs off it, and each other part holding
  one of its old letters is a new token of its layer (a part of typed text
  alone is text typed apart from the word, in no word).

  The tokens under the word (`child?`) are placed by where they stand
  (2026-10-06). One as long as the word stays with it, and each new part
  gets one new token of that layer as long as it, which is cut from no
  token and so names none under `:token/from`: it takes no metadata
  (HUNT-igt R4: a morpheme nobody proposed read as machine work) and,
  under `:token/precedence`, the precedence of the first of them, nulls
  last, else 1 where none stores one. Only on a layer that
  deals its tokens out (`dealt?`, the words of a multi-word token) do those
  as long as the word go one to each part, in order of precedence, when
  there are as many of them as parts (`can't`, `ca` + `n't`, typed as
  `ca n't`, leaves each word on its own part). One shorter than the word
  goes with the part it lies in, cut to it. One reaching over a cut stays
  on the part the word stays on (else the first it reaches), cut to it,
  and each other part it reaches gets a new token of its layer over its
  letters there. One holding no letter of any part is deleted.

  Any other token that stood strictly inside the word goes to the part
  holding most of its kept letters, cut to it, and is deleted when it holds
  nothing of any. Another token as long as the word stays with it, and one
  over several words that began or ended with it begins or ends where it
  does now. A row (`row?`) stays where the plain rule placed it, so a
  split moves no row. `typed?` says whether a new-body position holds typed
  text."
  [^ints nw old-tokens placed word? part? typed? child? dealt? row?]
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
                                                 :layer layer
                                                 :id id}])))))))
                     placed)
        live? (fn [t] (and (not (::gone t)) (was (:token/id t)) (not (part? t)) (not (word? t))))
        ;; by stored precedence, nulls last, then id, as the split route
        ;; orders them (`plaid.sql.token/split-straddlers!`)
        prec #(:token/precedence (was (:token/id %)))
        by-precedence #(sort-by (juxt (comp nil? prec) (fn [t] (or (prec t) 0)) (comp str :token/id)) %)
        ;; the tokens under a split word as long as it, by word and layer
        under (group-by (fn [t] (let [{ob :token/begin oe :token/end} (was (:token/id t))]
                                  [[ob oe] (:token/layer t)]))
                        (filter #(and (live? %) (child? %)
                                      (let [{ob :token/begin oe :token/end} (was (:token/id %))]
                                        (splits [ob oe])))
                                placed))
        ;; those that go one to each part: id -> part
        shared (into {}
                     (mapcat (fn [[[w l] ts]]
                               (let [pieces (:pieces (splits w))]
                                 (when (and (dealt? l) (= (count ts) (count pieces)))
                                   (map vector
                                        (map :token/id (by-precedence ts))
                                        pieces)))))
                     under)
        ;; the split word a token stood strictly inside, by its old extent
        inside-of (fn [ob oe]
                    (when ob
                      (some (fn [[[wb we] :as e]] (when (and (<= wb ob) (<= oe we) (not (and (= wb ob) (= oe we)))) e))
                            splits)))
        ;; a token under a split word, shorter than it: id -> {:home [x y]
        ;; :others [[x y] ...]}, the part it stays on and the others it
        ;; reaches, each cut to it (nil home: it reaches none)
        placed-under (into {}
                           (keep (fn [{:token/keys [id begin end] :as t}]
                                   (let [{ob :token/begin oe :token/end} (was id)]
                                     (when (and (live? t) (child? t))
                                       (when-let [[w {kp :keep :keys [pieces]}] (inside-of ob oe)]
                                         (let [reach (filterv (fn [[x y]] (pos? (kept x y)))
                                                              (map (fn [[x y]] [(max begin x) (min end y)]) pieces))
                                               home (or (first (filter (fn [[x y]] (and (<= (first kp) x) (<= y (second kp)))) reach))
                                                        (first reach))]
                                           [id {:word w :home home :others (filterv #(not= % home) reach)}]))))))
                           placed)
        made (into []
                   (mapcat (fn [[w {kp :keep :keys [pieces layer id]}]]
                             ;; one new token per token reaching over a cut,
                             ;; even where two reach the same letters, each
                             ;; naming under `:token/from` the token it was
                             ;; cut from (for `preserveOnSplit`)
                             (for [p pieces
                                   t (concat
                                      (when (not= p kp)
                                        (cons {:token/layer layer :token/begin (first p) :token/end (second p)
                                               :token/from id}
                                              (keep (fn [[[w2 l] ts]]
                                                      (when (and (= w2 w) (not (shared (:token/id (first ts)))))
                                                        ;; cut from nothing, so bare (HUNT-igt R4),
                                                        ;; first among the tokens it stands for,
                                                        ;; else 1 where none stores one
                                                        {:token/layer l :token/begin (first p) :token/end (second p)
                                                         :token/precedence (or (prec (first (by-precedence ts))) 1)}))
                                                    under)))
                                       ;; the pieces of the tokens under it
                                       ;; reaching over a cut, on this part
                                      (for [c placed
                                            :let [pu (placed-under (:token/id c))]
                                            :when (= w (:word pu))
                                            [x y] (:others pu)
                                            :when (and (<= (first p) x) (<= y (second p)))]
                                        {:token/layer (:token/layer c) :token/begin x :token/end y
                                         :token/from (:token/id c)}))]
                               t)))
                   splits)
        edge-moves (into {} (map (fn [[[ob _] {[x y] :keep}]] [ob [x y]])) splits)
        end-moves (into {} (map (fn [[[_ oe] {[x y] :keep}]] [oe [x y]])) splits)]
    (if (empty? splits)
      {:placed placed :made []}
      {:placed
       (mapv (fn [{:token/keys [id begin end] :as t}]
               (let [{ob :token/begin oe :token/end} (was id)
                     inside (second (inside-of ob oe))]
                 (cond
                   (or (::gone t) (nil? ob) (part? t) (row? t)) t
                   (shared id) (let [[x y] (shared id)] (assoc t :token/begin x :token/end y))
                   (splits [ob oe]) (let [[x y] (:keep (splits [ob oe]))] (assoc t :token/begin x :token/end y))
                   ;; under a split word, shorter than it: where it stands
                   (contains? placed-under id)
                   (if-let [[x y] (:home (placed-under id))]
                     (assoc t :token/begin x :token/end y)
                     (assoc t ::gone true))
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

(defn word-token?
  "Whether a token of `tokens` is a word, the one answer every path reads:
  a token on a layer in `word-layers`, or, when no token of `tokens` is on
  one (no word layer, or one that holds no token yet), any token on no
  layer in `partitioning`."
  [tokens partitioning word-layers]
  (let [ws (set word-layers)
        ps (set partitioning)]
    (if (some #(ws (:token/layer %)) tokens)
      #(contains? ws (:token/layer %))
      #(not (contains? ps (:token/layer %))))))

(defn apply-plain-gaps
  "What `gaps` (old-body code points, in order, never touching, each
  `{:start a :end b :value v}`, see `compose-edits`) do to `old` and to
  `tokens` taken the plain way. Returns `{:text :tokens :deleted}` as
  `apply-text-edits` does, with `:heads`, the sentences made over a line
  typed before the first one, and with `split-on-space`, `:made`, the new
  tokens of the words a typed space split (see `split-spaced-words`: only
  tokens on a layer in `word-layers` when it names one, so a text whose
  word layer holds no token has nothing split), each
  `{:token/layer :token/begin :token/end}`, a word before the tokens under
  it. `:dealt` names the layers under the words whose tokens as long as a
  split word are dealt one to each part (see `split-spaced-words`).
  `:letter-like` names the code points that are letters to the punctuation
  rule below (see `punct?`).

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
  - Text a gap only types between two tokens of a partition (sentences)
    goes to the one after when typed after whitespace with no line break
    between it and that token's first letter, or right after punctuation
    the one before ends on with no whitespace, and else to the one before
    (Luke, 2026-10-15), and so does the text of every other gap that only
    types in the same whitespace before it. Each such text goes to the
    first token of the partition beginning at or after it, so a token
    holding only whitespace there takes it and none is left empty, alone
    or with the others. A gap in that whitespace that deletes ends the
    run: text typed before it goes to the one before. Text holding a line
    break goes to the one before.
  - A gap that takes all of it, and more, deletes it.
  - The new text between the letters given to the tokens either side
    belongs to neither.
  - A token left beginning or ending on whitespace it did not begin or end
    on is moved off it onto its letters (`ki` deleted from `thung ki` leaves
    the word on `thung`), and one left with only whitespace is deleted.

  A zero-width token is moved as `apply-text-edits` moves it."
  ([^String old tokens gaps partitioning word-layers {:keys [split-on-space children dealt exclusive head-layers letter-like]}]
   (let [^ints o (.toArray (.codePoints old))
         len (alength o)
         partitioning (set partitioning)
         word-layers (set word-layers)
         gaps (vec gaps)
         k (count gaps)
         info (mapv (fn [{:keys [start end value]}]
                      (let [^ints v (.toArray (.codePoints ^String value))
                            n (alength v)
                            run (fn [idx] (loop [i 0] (if (and (< i n) (not (space? (aget v (int (idx i)))))) (recur (inc i)) i)))
                            lead (run identity)
                            trail (run #(- n 1 %))]
                        {:a start :b end :n n :v v :delta (- n (- end start))
                         :lead lead :trail trail :word? (= lead n)
                         :before-ok (and (pos? lead) (pos? start) (not (space? (aget o (dec start)))))
                         :after-ok (and (pos? trail) (< end len) (not (space? (aget o end))))}))
                    gaps)
         new-body (gaps-body old gaps)
         ^ints nw (.toArray (.codePoints ^String new-body))
        ;; shift[i]: what the gaps before gap i add to a position
         shift (long-array (inc k))
         _ (dotimes [i k] (aset shift (inc i) (+ (aget shift i) (long (:delta (info i))))))
         starts (long-array (map :start gaps))
        ;; the last gap starting at or before x, or -1
         at-or-before (fn [x] (dec (upper-bound starts x)))
         wide (filterv #(< (:token/begin %) (:token/end %)) tokens)

         zero (filterv #(= (:token/begin %) (:token/end %)) tokens)
        ;; The tokens that decide where new text goes: the words, those on a
        ;; layer in `word-layers`, else every token on no partition. The
        ;; others (sentences, time-alignment segments) follow them.
         decides? (word-token? wide partitioning word-layers)
         punct-word? (fn [t] (and (contains? word-layers (:token/layer t)) (punct-only? o letter-like t)))
         deciders (filterv decides? wide)
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
                 (doseq [{:token/keys [begin end] :as t} deciders
                         ;; a word made only of punctuation (ud's `(`,
                         ;; `.`) takes no text from a gap outside it: a
                         ;; letter typed against it stays apart, as where
                         ;; the punctuation has no token (REV7-IGT-1). A
                         ;; character the layer's rule calls letter-like is
                         ;; a letter here.
                         :let [punct-word? (punct-word? t)]]
                   (let [g (at-or-before end)]
                     (when (>= g 0)
                       (let [{:keys [a b]} (info g)]
                         (if (< a b)
                           (cond
                             (and (< begin a) (<= a end) (< end b)) (when-not punct-word? (mark! g :before))
                             (and (<= begin a) (= end b)) (mark! g :holds-end))
                           (when (and (= end a) (< begin a) (not punct-word?)) (mark! g :before))))))
                   (let [g (at-or-before begin)]
                     (when (>= g 0)
                       (let [{:keys [a b]} (info g)]
                         (if (< a b)
                           (cond
                             (and (< a begin) (<= begin b) (< b end)) (when-not punct-word? (mark! g :after))
                             (and (= begin a) (<= b end)) (mark! g :holds-start))
                           (when (and (= begin a) (< a end) (not punct-word?)) (mark! g :after)))))))
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
         part-starts (into #{} (comp (filter #(partitioning (:token/layer %))) (map :token/begin)) wide)
         ;; whether gap `g`, one that only types, goes to the sentence after
         ;; it (see `typed-to-next?`: text holding a line break is a line
         ;; typed, which goes to the sentence before, to be split off there)
         to-next-sentence? (fn [g] (let [{:keys [a b v]} (info g)] (and (= a b) (typed-to-next? o a v letter-like))))
         ;; where no whitespace stands between two sentences and the first
         ;; ends on punctuation, text typed where they meet with no side
         ;; said goes to the one after
         side-of (fn [g]
                   (let [{:keys [a b]} (info g)]
                     (when (and (= a b) (pos? a) (< a len)
                                (not (space? (aget o (dec a)))) (not (space? (aget o a)))
                                (or (and (flag? g :before) (flag? g :after))
                                    (sentence-starts a)))
                       (or (:side (gaps g))
                           (when (and (part-starts a) (to-next-sentence? g)) :after)))))
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
        ;; Text typed after whitespace, on the line of the next letter, goes
        ;; to the sentence that letter begins (Luke, 2026-10-15): the
        ;; position of that letter, `q`, for a gap that only types after
        ;; whitespace and goes to the next sentence (`typed-to-next?`), else
        ;; nil. A boundary of a partition at or after the gap, up to `q`,
        ;; moves to the gap's new text.
         next-letter (mapv (fn [g]
                             (let [{:keys [a]} (info g)]
                               (when (and (to-next-sentence? g) (space? (aget o (dec a))))
                                 (loop [x a] (if (space? (aget o x)) (recur (inc x)) x)))))
                           (range k))
        ;; the first gap of the run of such gaps that `g` ends, every one
        ;; of them typing before the same letter: their text goes to the
        ;; sentences beginning at or after each, up to that letter's
         run-start (let [r (long-array k)]
                     (dotimes [g k]
                       (aset r g (if (and (pos? g) (next-letter g) (= (next-letter (dec g)) (next-letter g)))
                                   (aget r (dec g))
                                   g)))
                     r)
        ;; the begins of each partition's tokens, to find a sentence of only
        ;; whitespace between the typed text and the next letter
         part-begins (reduce (fn [m {:token/keys [layer begin]}]
                               (if (partitioning layer) (update m layer (fnil conj (sorted-set)) begin) m))
                             {} wide)
        ;; whether a token of partition `layer` beginning (or ending) at
        ;; `x` begins (or ends) at the text typed in gap `g`, the last gap
        ;; at or before `x`: `x` is no later than the next letter, and no
        ;; other token of the layer begins between the gap and `x`. A
        ;; sentence of only whitespace there takes the text, so none is left
        ;; empty and the sentences keep their order.
         no-begin? (fn [layer a x] (empty? (subseq (get part-begins layer (sorted-set)) >= a < x)))
         to-next? (fn [g layer x]
                    (when (>= g 0)
                      (let [q (next-letter g)]
                        (and q (<= (:a (info g)) x q) (no-begin? layer (:a (info g)) x)))))
        ;; where that token begins (or ends): at the first gap of the run
        ;; with no other token of the layer beginning between it and `x`, so
        ;; each gap's text goes to the first sentence beginning at or after
        ;; it, alone or with the others
         run-at (fn [g layer x]
                  (let [s (aget run-start g)]
                    (loop [h g]
                      (if (and (> h s) (no-begin? layer (:a (info (dec h))) x))
                        (recur (dec h))
                        (new-at h)))))
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
                                     ;; a sentence beginning in the whitespace
                                     ;; after text typed there begins at it
                                     (and (partitioning layer) (to-next? gb layer begin)) (run-at gb layer begin)
                                     (and (< a b) (<= a begin) (< begin b) (or (< a begin) (< end b) (some #(= begin (first %)) (inner gb))) (seq (inner gb)))
                                     (+ (new-at gb) (reduce min (map #(nth % 2) (inner gb))))
                                  ;; a gap took its first letters, or stands
                                  ;; right before it
                                     (and (< a begin) (<= begin b))
                                     (if (<= end b) nil (- (+ (new-at gb) n) (given-after gb)))
                                     (= a begin)
                                     (cond
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
                                     ;; and the one before it ends there
                                     (and (partitioning layer) (< begin a2) (to-next? ge layer end)) (run-at ge layer end)
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
                              (let [nb (if (space? (aget o begin))
                                         nb
                                         (loop [x nb] (if (and (< x ne) (space? (aget nw x))) (recur (inc x)) x)))
                                    ne (if (space? (aget o (dec end)))
                                         ne
                                         (loop [x ne] (if (and (> x nb) (space? (aget nw (dec x)))) (recur (dec x)) x)))]
                                ;; one left with only whitespace, that had
                                ;; letters, is gone
                                (if (and (< nb ne)
                                         (not (and (every? #(space? (aget nw %)) (range nb ne))
                                                   (some #(not (space? (aget o %))) (range begin end)))))
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
                                 ;; only a word is split: a token of a
                                 ;; word layer, where the text has one. In
                                 ;; a text whose word layer holds no token
                                 ;; yet the rows decide in the words' place,
                                 ;; but a space typed in a row splits
                                 ;; nothing (REV6-TEXT-1)
                                 (if (seq word-layers) #(contains? word-layers (:token/layer %)) decides?)
                                 #(partitioning (:token/layer %))
                                 #(aget typed (int %))
                                 #(contains? (set children) (:token/layer %))
                                 #(contains? (set dealt) %)
                                 #(row? (:token/layer %))))
           {:placed placed})
         zero-r (when (seq zero) (apply-text-edits (gap-ops gaps) {:text/body old} zero))
         kept (filterv (complement ::gone) placed)
         was-token (let [m (into {} (map (juxt :token/id identity)) wide)] #(m (:token/id %)))
        ;; A line typed before the text's first sentence, one holding a
        ;; letter (anything but whitespace, as `space?` reads it, so not a
        ;; line of only no-break or ideographic spaces or of NEL) before its
        ;; last line break, is a sentence of its own
        ;; (`:heads`): the new text before the first sentence's first letter
        ;; left, whatever the save's shape.
         firsts (filter #(and (partitioning (:token/layer %)) (zero? (:token/begin %))
                              (or (nil? head-layers) (contains? head-layers (:token/layer %))))
                        wide)
         head-end (when-let [{:token/keys [end]} (first firsts)]
                    (let [in-gap? (fn [i] (let [g (at-or-before i)]
                                            (and (>= g 0) (< i (:b (info g))) (<= (:a (info g)) i))))
                          q (first (filter #(and (not (space? (aget o %))) (not (in-gap? %))) (range 0 end)))]
                      (when q
                        (let [p (+ q (aget shift (inc (at-or-before q))))
                              p (if (neg? (at-or-before q)) q p)
                              prefix (String. nw 0 (int p))
                              m (last (re-seq #"[\s\S]*[\n\r\u0085\u2028\u2029]" prefix))]
                          (when (and m (.anyMatch (.codePoints ^String m)
                                                  (reify java.util.function.IntPredicate (test [_ c] (not (space? c))))))
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
                                      b (loop [x head-end] (if (and (< x e) (space? (aget nw x))) (recur (inc x)) x))]
                                  (assoc t :token/begin (min b (dec e))))
                                t))
                      kept)
                kept)
         heads (when head-end
                 (mapv (fn [{:token/keys [layer]}] {:token/layer layer :token/begin 0 :token/end head-end})
                       (filter #(some (fn [f] (= (:token/id f) (:token/id %))) firsts) kept)))
        ;; the new extent of what old [b, e) holds as its own: its old text
        ;; left and the text typed strictly inside it, or nil
         held (fn [[b e]]
                (let [cut? (fn [g x] (and (>= g 0) (let [{a :a z :b} (info g)] (and (<= a x) (< x z)))))
                      at (fn [x] (let [g (at-or-before x)] (+ x (if (neg? g) 0 (aget shift (inc g))))))
                      first-left (loop [x b] (when (< x e) (let [g (at-or-before x)] (if (cut? g x) (recur (:b (info g))) x))))
                      last-left (loop [x (dec e)] (when (>= x b) (let [g (at-or-before x)] (if (cut? g x) (recur (dec (:a (info g)))) x))))
                      typed (loop [g (inc (at-or-before b)) out []]
                              (if (and (< g k) (< (:a (info g)) e))
                                (recur (inc g) (let [{a :a z :b m :n} (info g)]
                                                 (if (and (< b a) (if (= a z) (< a e) (< z e)) (pos? m))
                                                   (conj out [(new-at g) (+ (new-at g) m)])
                                                   out)))
                                out))
                      xs (cond-> typed first-left (conj [(at first-left) (inc (at last-left))]))]
                  (when (seq xs)
                    ;; off whitespace at an edge that had none
                    (let [x (reduce min (map first xs)) y (reduce max (map second xs))
                          ;; and past a line made a sentence of its own, as
                          ;; every token reaching over it
                          x (if head-end (max x (loop [x head-end] (if (and (< x (alength nw)) (space? (aget nw x))) (recur (inc x)) x))) x)
                          x (if (space? (aget o b)) x (loop [x x] (if (and (< x y) (space? (aget nw x))) (recur (inc x)) x)))
                          y (if (space? (aget o (dec e))) y (loop [y y] (if (and (> y x) (space? (aget nw (dec y)))) (recur (dec y)) y)))]
                      (when (< x y) [x y])))))
         kept (follow-sentences o wide kept heads nw partitioning
                                ;; a row, also where the text has no word yet
                                ;; and the rows decide in their place
                                #(let [l (:token/layer %)]
                                   (or (row? l)
                                       (and (seq word-layers) (contains? exclusive l) (not (partitioning l))
                                            (not (contains? children l)) (not (contains? (set word-layers) l)))))
                                held
                                ;; the new text of an insert at old x
                                (fn [x] (let [g (at-or-before x)]
                                          (when (>= g 0)
                                            (let [{a :a z :b m :n} (info g)]
                                              (when (and (= a z x) (pos? m)) [(new-at g) (+ (new-at g) m)]))))))]
     (cond-> {:text {:text/body new-body}
              ;; a point at the edge of a token of its layer that grew over it
              ;; stays at that edge, so nothing ends up inside another
              :tokens (into kept (pin-points-to-edges tokens kept made (:tokens zero-r)))
              :deleted (into (mapv :token/id (filter ::gone placed)) (:deleted zero-r))}
       (seq heads) (assoc :heads heads)
       ;; the parts of a word split by a typed space (see `split-spaced-words`)
       (seq made) (assoc :made made)))))

(defn layer-roles
  "What each token layer of a text is to a body save, from `layers`, each
  `{:id :overlap-mode :parent :split-on-space :role :letter-like}`
  (`:overlap-mode` as the token layer row has it, `:parent` its parent token
  layer's id or nil, `:split-on-space` whether its config sets
  `splitOnSpace`, `:role` its `config.plaid.role`, `:letter-like` the code
  points its ignored-tokens rule calls letter-like, see
  `ignored-rule`). Besides those settings nothing but the layers'
  shape is read, so a layer any app or script made takes an edit the same
  way.
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
  - `:dealt`: the children of role `syntactic-word`, the words of a
    multi-word token, whose tokens as long as a word a typed space splits
    go one to each part in order (see `split-spaced-words`). Every other
    child's tokens are placed by where they stand.
  - `:head-layers`: the partitions a line typed before the first sentence
    is made a sentence of (see `apply-plain-gaps`): those the words are
    nested under, else the text's one partition layer, else none. A second
    partition (a document's one token, paragraphs) is never split.
  - `:letter-like`: the code points any layer of the text calls
    letter-like, which are letters to the punctuation rule (see `punct?`)
    on every layer of the text."
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
     :dealt (into #{}
                  (comp (filter #(and (= "syntactic-word" (:role %)) (under? deciders (:id %))))
                        (map :id))
                  layers)
     :exclusive (into #{} (comp (filter #(= "non-overlapping" (:overlap-mode %))) (map :id)) layers)
     :split-on-space (boolean (some :split-on-space layers))
     :letter-like (let [ls (remove #(and (set? %) (empty? %)) (keep :letter-like layers))]
                    (cond (empty? ls) #{}
                          (every? set? ls) (into #{} cat ls)
                          :else (fn [c] (boolean (some #(% c) ls)))))}))
