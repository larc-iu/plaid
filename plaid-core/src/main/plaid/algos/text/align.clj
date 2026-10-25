(ns plaid.algos.text.align
  "The word aligner of a whole-body save: each changed stretch of the diff
  aligned again word by word (see `align-to-words`)."
  (:require [plaid.algos.text.chars :refer [combining-mark? space? word-letter?]]
            [plaid.algos.text.index :refer [tokens-near]]
            [plaid.algos.text.ops :refer [edits->ops ops->edits]]
            [plaid.util.codepoint :as cp]))

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

(defmacro ^:private relax!
  "One step of `align-to-words*`'s dynamic programme from state `s`, at
  cost `v`, of `kind` over letter `p` into cell `cell`: the step's outcome
  read from `kept`, or worked out by `keep!` and kept there, and the cell's
  entry for the state after it set when unreached in this window (stamp
  `g`) or reached at a higher cost, with the back pointer `(+ (* s 4)
  code)`. A macro, so the loop stays on primitives. The first argument names the
  aligner's arrays, its window stamp, its state count and `keep!`."
  [[dp back stamp reached cell-stamp cell-count g S keep!] v s kept kind p cell code]
  `(let [t# (aget ~kept (+ (* ~p ~S) ~s))
         t# (if (neg? t#) (long (~keep! ~kept ~kind ~p ~s)) t#)
         c# ~cell
         s'# (bit-and t# 511)
         x# (+ (* c# ~S) s'#)
         w# (+ ~v (bit-shift-right t# 9))]
     (if (== (aget ~stamp x#) ~g)
       (when (< w# (aget ~dp x#))
         (aset ~dp x# w#)
         (aset ~back x# (int (+ (* ~s 4) ~code))))
       (let [n# (if (== (aget ~cell-stamp c#) ~g) (long (aget ~cell-count c#)) 0)]
         (aset ~cell-stamp c# ~g)
         (aset ~cell-count c# (inc n#))
         (aset ~reached (+ (* c# ~S) n#) (int s'#))
         (aset ~stamp x# ~g)
         (aset ~dp x# w#)
         (aset ~back x# (int (+ (* ~s 4) ~code)))))))

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
                              (relax! [dp back stamp reached cell-stamp cell-count g S keep!] v s
                                      m-kept :m i (+ (* (inc i) k1) (inc j)) 2))
                            (when (< i m)
                              (relax! [dp back stamp reached cell-stamp cell-count g S keep!] v s
                                      d-kept :d i (+ (* (inc i) k1) j) 0))
                            (when (< j k)
                              (relax! [dp back stamp reached cell-stamp cell-count g S keep!] v s
                                      i-kept :i j (+ (* i k1) (inc j)) 1))))))))
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
