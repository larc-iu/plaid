(ns plaid.algos.text-oracle-test
  "A seeded property test of a whole-body update, judged by what the user
  meant. Documents are sentences of words, with morphemes at random cuts,
  zero-width markers at word edges, punctuation left in the gaps (igt) or
  made tokens of its own (UD), and UMR-like nodes over one word, several
  words or a whole sentence. Each edit is made to the words (respell one,
  delete a run, delete a run beside a respelled word, insert a new word,
  join two sentences), and the new body goes through the chain
  `update-body` runs (diff, slide, snap, align by words, pair, fold, apply,
  and edges off spaces).

  The oracle knows which word each token was made for, so it judges the
  places the text alone leaves open too, where an oracle that trusts the
  diff finds nothing: a kept word keeps exactly one token,
  on its new spelling, no word or morpheme token holds a space, a kept
  word's morphemes are as they were, a respelled word's tile it or are
  gone, a one-word node follows its word, a node over several words runs
  from the first word left to the last, markers stay on their word's edge,
  and punctuation tokens stay on their marks.

  The only exemptions inside the oracle are the cases the text cannot
  settle: a word replaced whole beside deleted words may or may not keep a
  token, and which of two words of one spelling was deleted. The new word
  of such a replace may also be the one meant for any of the deleted
  words (`tat你好on` to `tatZЖ`), and a word respelled in part beside
  deleted words may be the respelling of a deleted one sharing as many of
  its letters (`cat mat` to `Xڤat`): the case passes when one of those
  readings passes whole, and is not skipped.

  Classes still open are named in `open-classes`, one predicate each over
  the generated case. Their cases are run too, and the test fails when more
  of them fail than `open-class-ceilings` allows, so a regression among the
  ones that pass still shows. A fix for one deletes its entry, and the test
  then holds each case."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

;; ---------------------------------------------------------------- documents

(def ^:private vocab
  ["the" "cat" "sat" "on" "a" "mat" "kai" "kaki" "tat" "köye" "Yarın" "dog"
   "كتاب" "שלום" "𐌰𐌱𐌲" "café" "é" "ab" "tatu" "你好"])

;; Letters no word has, so a respelling cannot take one from a neighbour.
(def ^:private fresh ["Q" "X" "Z" "𐍂" "ڤ" "Ж"])

(def ^:private nbsp (str (char 0xA0)))

(defn- cps [^String s]
  (mapv #(String. (Character/toChars (int %))) (.toArray (.codePoints s))))

(defn- gen-doc [^java.util.Random rng opts]
  (let [pick #(nth % (.nextInt rng (count %)))
        seps (:seps opts [" "])
        puncts (:puncts opts [""])
        nsent (inc (.nextInt rng 3))
        id (atom 0)]
    (vec (for [si (range nsent)]
           (let [n (+ 2 (.nextInt rng 4))]
             (vec (for [i (range n)]
                    (let [w (pick (:vocab opts vocab))
                          k (count (cps w))]
                      {:id (swap! id inc)
                       :pre (if (< (.nextDouble rng) 0.1) (pick (:pres opts [""])) "")
                       :w w
                       :cuts (or (when (and (> k 1) (< (.nextDouble rng) 0.4))
                                   (vec (sort (distinct (repeatedly (inc (.nextInt rng 2))
                                                                    #(inc (.nextInt rng (dec k))))))))
                                 ;; one morpheme over the whole word
                                 (when (and (:one-morph opts) (< (.nextDouble rng) (:one-morph opts)))
                                   []))
                       :zs (< (.nextDouble rng) (:marks opts 0))
                       :ze (< (.nextDouble rng) (:marks opts 0))
                       :post (if (< (.nextDouble rng) 0.3) (pick puncts) "")
                       :sep (if (= i (dec n))
                              (if (= si (dec nsent)) (if (.nextBoolean rng) "\n" "") "\n")
                              (pick seps))}))))))))

(defn- layout
  "The body of `doc`, each word's extent (with its punctuation's, `:pb` to
  `:qe`) by id, and the sentences' extents."
  [doc]
  (let [sb (StringBuilder.)
        pos (volatile! 0)
        add (fn [^String s] (.append sb s) (vswap! pos + (cp/cp-count s)))]
    (loop [sents (map-indexed vector doc) words {} spans []]
      (if-let [[si sent] (first sents)]
        (let [start @pos
              words (reduce (fn [words {:keys [id pre w post sep]}]
                              (let [pb @pos _ (add pre) b @pos _ (add w) e @pos _ (add post) qe @pos]
                                (add sep)
                                (assoc words id {:b b :e e :pb pb :qe qe :si si})))
                            words sent)]
          (recur (rest sents) words (conj spans [start @pos])))
        {:body (str sb) :words words :sents spans}))))

(defn- tokens-for [doc {:keys [words sents]} ^java.util.Random rng opts]
  (let [out (transient [])
        t! (fn [layer id b e] (conj! out {:token/id id :token/layer layer :token/begin b :token/end e}))]
    (doseq [[si [b e]] (map-indexed vector sents)] (t! :s [:s si] b e))
    (doseq [sent doc {:keys [id cuts zs ze pre post]} sent]
      (let [{:keys [b e pb qe]} (words id)]
        (t! :w id b e)
        (when (and (:ud opts) (seq pre)) (t! :p [:pp id] pb b))
        (when (and (:ud opts) (seq post)) (t! :p [:pq id] e qe))
        (when zs (t! :z [:zs id] b b))
        (when ze (t! :z [:ze id] e e))
        (doseq [[j [x y]] (map-indexed vector (partition 2 1 (concat [0] cuts [(- e b)])))
                :when cuts]
          (t! :m [:m id j] (+ b x) (+ b y)))))
    (doseq [[si sent] (map-indexed vector doc)]
      (doseq [{:keys [id]} sent :when (< (.nextDouble rng) 0.3)]
        (let [{:keys [b e]} (words id)] (t! :u [:u1 id] b e)))
      (when (< (.nextDouble rng) 0.3)
        (let [[b e] (sents si)] (t! :u [:us si] b e)))
      (dotimes [q (:nodes opts 1)]
        (when (and (> (count sent) 2) (< (.nextDouble rng) (if (:nodes opts) 0.9 0.3)))
          (let [i (.nextInt rng (dec (count sent)))
                j (+ i 1 (.nextInt rng (- (count sent) i 1)))]
            (t! :u [:um (:id (sent i)) (:id (sent j)) q]
                (:b (words (:id (sent i)))) (:e (words (:id (sent j)))))))))
    (persistent! out)))

;; ---------------------------------------------------------------- edits

(defn- fresh-word [^java.util.Random rng n]
  (apply str (repeatedly n #(nth fresh (.nextInt rng (count fresh))))))

(defn- lcs
  "The length of the longest common subsequence of two vectors."
  [a b]
  (peek (reduce (fn [prev x]
                  (reduce (fn [row [j y]]
                            (conj row (if (= x y) (inc (prev j)) (max (prev (inc j)) (peek row)))))
                          [0] (map-indexed vector b)))
                (vec (repeat (inc (count b)) 0))
                a)))

(defn- respell
  "[mode new-spelling kept-letters replaced-letters] for `w`."
  [^java.util.Random rng w]
  (let [c (cps w) n (count c)
        mode (if (= n 1) :whole (nth [:prefix :suffix :middle :whole] (.nextInt rng 4)))
        mode (if (and (= mode :middle) (< n 3)) :prefix mode)
        [keep-idx new] (case mode
                         :whole [[] (fresh-word rng (inc (.nextInt rng 3)))]
                         :prefix (let [r (inc (.nextInt rng (dec n)))]
                                   [(range r n) (str (fresh-word rng (inc (.nextInt rng 2))) (apply str (drop r c)))])
                         :suffix (let [r (inc (.nextInt rng (dec n)))]
                                   [(range (- n r)) (str (apply str (take (- n r) c)) (fresh-word rng (inc (.nextInt rng 2))))])
                         :middle (let [r (inc (.nextInt rng (- n 2)))]
                                   [(concat (range r) (range (inc r) n))
                                    (str (apply str (take r c)) (fresh-word rng 1) (apply str (drop (inc r) c)))]))
        kept (set keep-idx)]
    [mode new (map c keep-idx) (keep-indexed (fn [i x] (when-not (kept i) x)) c)]))

(defn- delete-items
  "`doc` without items [i, j) of sentence si (not all of it)."
  [doc si i j]
  (let [sent (doc si)
        kept (into (subvec sent 0 i) (subvec sent j))]
    (assoc doc si (if (= j (count sent)) (assoc-in kept [(dec i) :sep] (:sep (peek sent))) kept))))

(defn- edit
  "[new-doc info] for one edit of a kind in `kinds`."
  [doc ^java.util.Random rng kinds]
  (let [si (.nextInt rng (count doc))
        sent (doc si)
        n (count sent)
        kind (nth kinds (.nextInt rng (count kinds)))]
    (case kind
      :resp (let [i (.nextInt rng n)
                  [_ w'] (respell rng (:w (sent i)))]
              [(assoc-in doc [si i :w] w') {:resp #{(:id (sent i))} :kind :resp :si si :i i}])
      :del (if (< n 2)
             (edit doc rng [:resp])
             (let [k (inc (.nextInt rng (min 3 (dec n))))
                   i (.nextInt rng (- n k -1))]
               [(delete-items doc si i (+ i k)) {:del (set (map :id (subvec sent i (+ i k)))) :si si
                                                 :kind :del :i i :j (+ i k)}]))
      :del+resp (if (< n 3)
                  (edit doc rng [:resp])
                  (let [k (inc (.nextInt rng (min 2 (- n 2))))
                        ;; the deleted words [i, i+k) come before the respelled one, or after it
                        before? (.nextBoolean rng)
                        i (if before? (.nextInt rng (- n k)) (inc (.nextInt rng (- n k))))
                        r (if before? (+ i k) (dec i))
                        rid (:id (sent r))
                        [mode w' kept gone] (respell rng (:w (sent r)))
                        dels (subvec sent i (+ i k))]
                    [(delete-items (assoc-in doc [si r :w] w') si i (+ i k))
                     {:resp #{rid} :del (set (map :id dels)) :si si
                      :kind :del+resp :i i :j (+ i k) :r r
                      ;; replaced whole, the new word may be the one meant for
                      ;; any of these, and each reading is judged. Respelled
                      ;; in part, it may be the one meant for a deleted word
                      ;; that shares as many of its letters (`cat mat` to
                      ;; `Xڤat`), and not for one that shares fewer (`tat
                      ;; the` to `tZe` is `the` respelled).
                      :group (if (= mode :whole)
                               (into [rid] (map :id) dels)
                               (let [shares #(lcs (cps %) (cps w'))
                                     ties (filter #(<= (shares (:w (sent r))) (shares (:w %))) dels)]
                                 (when (seq ties) (into [rid] (map :id) ties))))
                      :shape {:mode mode
                              ;; respelled at the edge beside the deleted words
                              :near? (or (and before? (= mode :prefix)) (and (not before?) (= mode :suffix)))
                              :shared? (boolean (some (into (set (mapcat (comp cps :w) dels)) gone) kept))
                              ;; the kept letter beside the deleted words is in one of them
                              :edge-in-deleted? (boolean ((set (mapcat (comp cps :w) dels))
                                                          (if before? (first kept) (last kept))))}
                      :amb (cond-> #{}
                             (= mode :whole) (conj rid)
                             (some #(= (:w %) (:w (sent r))) dels) (conj rid))}]))
      :ins (let [i (.nextInt rng n)
                 item {:id (+ 1000 (.nextInt rng 1000)) :pre "" :w (fresh-word rng (inc (.nextInt rng 3)))
                       :post "" :new true}]
             [(assoc doc si (-> (subvec sent 0 (inc i))
                                (assoc-in [i :sep] " ")
                                (conj (assoc item :sep (:sep (sent i))))
                                (into (subvec sent (inc i)))))
              {:ins true :kind :ins :si si :i i :neww (:w item)}])
      ;; a respelling with a space typed in front of the word
      :resp+space (let [i (.nextInt rng n)
                        [_ w'] (respell rng (:w (sent i)))
                        id (:id (sent i))
                        doc (assoc-in doc [si i :w] w')]
                    (cond
                      (pos? i) [(update-in doc [si (dec i) :sep] str " ")
                                {:resp #{id} :typed-front {id 1} :kind :resp+space :si si :i i :space true}]
                      (zero? si)
                      [(update-in doc [0 0 :pre] #(str " " %))
                       {:resp #{id} :typed-front {id 1} :kind :resp+space :si si :i i :space true}]
                      :else [doc {:resp #{id} :kind :resp+space :si si :i i}]))
      ;; a respelling with a new word typed after it
      :resp+ins (let [i (.nextInt rng n)
                      [_ w'] (respell rng (:w (sent i)))
                      item {:id (+ 1000 (.nextInt rng 1000)) :pre "" :w (fresh-word rng (inc (.nextInt rng 3)))
                            :post "" :new true :sep (:sep (sent i))}]
                  [(assoc doc si (-> (subvec (assoc-in sent [i :w] w') 0 (inc i))
                                     (assoc-in [i :sep] " ")
                                     (conj item)
                                     (into (subvec sent (inc i)))))
                   {:resp #{(:id (sent i))} :ins true :kind :resp+ins :si si :i i :neww (:w item)}])
      ;; Two words beside each other made one by deleting the space between
      ;; them and letters of both: `a big dog` to `a bog`. It is one word
      ;; respelled and the other deleted, either way round, and the new word
      ;; has one token.
      :join-words (let [i (when (> n 1) (.nextInt rng (dec n)))
                        a (some-> i sent)
                        b (some-> i inc sent)]
                    (if (or (nil? i) (not= " " (:sep a)) (seq (:post a)) (seq (:pre b))
                            (< (count (cps (:w a))) 2) (< (count (cps (:w b))) 2))
                      (edit doc rng [:resp])
                      (let [ca (cps (:w a))
                            cb (cps (:w b))
                            ka (inc (.nextInt rng (dec (count ca))))
                            kb (inc (.nextInt rng (dec (count cb))))
                            w (str (apply str (take ka ca))
                                   (apply str (take-last kb cb)))
                            joined (assoc a :w w :post (:post b) :sep (:sep b) :cuts nil)]
                        [(assoc doc si (-> (subvec sent 0 i) (conj joined) (into (subvec sent (+ i 2)))))
                         {:resp #{(:id a)} :del #{(:id b)} :si si :amb #{} :group [(:id a) (:id b)]
                          :kind :join-words :i i :ka ka :kb kb}])))
      ;; The same with one word left whole: the space and letters of the
      ;; other go (`the kaki` to `theki`, `the kaki` to `thkaki`). It is one
      ;; word too (D22).
      :join-one-whole (let [i (when (> n 1) (.nextInt rng (dec n)))
                            a (some-> i sent)
                            b (some-> i inc sent)
                            left-whole? (.nextBoolean rng)
                            cut (if left-whole? b a)]
                        (if (or (nil? i) (not= " " (:sep a)) (seq (:post a)) (seq (:pre b))
                                (< (count (cps (:w cut))) 2))
                          (edit doc rng [:resp])
                          (let [ca (cps (:w a))
                                cb (cps (:w b))
                                [ka kb] (if left-whole?
                                          [(count ca) (inc (.nextInt rng (dec (count cb))))]
                                          [(inc (.nextInt rng (dec (count ca)))) (count cb)])
                                w (str (apply str (take ka ca)) (apply str (take-last kb cb)))
                                joined (assoc a :w w :post (:post b) :sep (:sep b) :cuts nil)]
                            [(assoc doc si (-> (subvec sent 0 i) (conj joined) (into (subvec sent (+ i 2)))))
                             {:resp #{(:id a)} :del #{(:id b)} :si si :amb #{} :group [(:id a) (:id b)]
                              :kind :join-words :i i :ka ka :kb kb}])))
      ;; Only the space between two words deleted: two words written
      ;; together, each keeping its token (D22).
      :join-space (let [i (when (> n 1) (.nextInt rng (dec n)))
                        a (some-> i sent)
                        b (some-> i inc sent)]
                    (if (or (nil? i) (not= " " (:sep a)))
                      (edit doc rng [:resp])
                      [(assoc-in doc [si i :sep] "") {:kind :join-space :si si :i i}]))
      ;; Three words made one, keeping letters of the middle one, so the
      ;; diff deletes twice: `a big dog ran` to `a bon`. One token.
      :join-three (let [i (when (> n 2) (.nextInt rng (- n 2)))
                        [a b c] (when i (subvec sent i (+ i 3)))]
                    (if (or (nil? i) (not= " " (:sep a)) (not= " " (:sep b))
                            (seq (:post a)) (seq (:pre b)) (seq (:post b)) (seq (:pre c))
                            (< (count (cps (:w a))) 2) (< (count (cps (:w c))) 2))
                      (edit doc rng [:resp])
                      (let [ca (cps (:w a))
                            cb (cps (:w b))
                            cc (cps (:w c))
                            p (.nextInt rng (count cb))
                            q (+ p 1 (.nextInt rng (- (count cb) p)))
                            ka (inc (.nextInt rng (dec (count ca))))
                            kc (inc (.nextInt rng (dec (count cc))))
                            w (str (apply str (take ka ca))
                                   (apply str (subvec cb p q))
                                   (apply str (take-last kc cc)))
                            joined (assoc a :w w :post (:post c) :sep (:sep c) :cuts nil)]
                        ;; a whole word inside the new one reads as that word kept,
                        ;; the others cut to its sides (`tat tat sat` to `ttat`)
                        (if (some #(.contains ^String w ^String (:w %)) [a b c])
                          (edit doc rng [:resp])
                          [(assoc doc si (-> (subvec sent 0 i) (conj joined) (into (subvec sent (+ i 3)))))
                           {:resp #{(:id a)} :del #{(:id b) (:id c)} :si si :amb #{}
                            :group [(:id a) (:id b) (:id c)]
                            :kind :join-three :i i :ka ka :p p :q q :kc kc}]))))
      ;; A space typed where two morphemes of a word meet: the word goes on
      ;; one of the two new words, either, with its morphemes there, and the
      ;; other is a new word.
      ;; Anywhere in the word, a letter respelled after the space or not
      ;; (`pqmrs` to `pq krs`), the same. Not a word starting a sentence
      ;; after the first or with a marker at an edge: there the new words
      ;; can neither leave the sentence nor the marker, and when the one
      ;; to take the token is the second, the token stays over both (`x.
      ;; cow y` to `x. a co y`, pinned in text_test).
      ;; Inside a morpheme of an analyzed word (first, middle or last), the
      ;; word folds and keeps no morpheme (D28).
      ;; `:split-any` also at a sentence start and beside a marker, for
      ;; edits from the caret
      (:space-at-cut :split-word :split-in-morpheme :split-any)
      (let [inner (fn [{:keys [w cuts]}] (remove (set cuts) (range 1 (count (cps w)))))
            cands (filter #(case kind
                             :space-at-cut (seq (:cuts (sent %)))
                             ;; Not a word with a marker at both edges, nor one
                             ;; starting a sentence with a marker at its end: no
                             ;; new word can take the token and leave the markers
                             ;; at its edges (the right one would take text into
                             ;; the sentence before or behind the start marker, the
                             ;; left one would leave the end marker off its end).
                             :split-any (let [{:keys [w zs ze]} (sent %)]
                                          (and (< 1 (count (cps w)))
                                               (not (and zs ze))
                                               (not (and ze (zero? %) (pos? si)))))
                             (let [{:keys [w zs ze cuts] :as it} (sent %)]
                               (and (< 1 (count (cps w))) (not zs) (not ze)
                                    (or (pos? %) (zero? si))
                                    (or (= kind :split-word) (and cuts (seq (inner it)))))))
                          (range n))]
        (if (empty? cands)
          (edit doc rng [:resp])
          (let [i (nth cands (.nextInt rng (count cands)))
                {:keys [id w cuts pre post sep] :as it} (sent i)
                c (cps w)
                k (case kind
                    :space-at-cut (nth cuts (.nextInt rng (count cuts)))
                    (:split-word :split-any) (inc (.nextInt rng (dec (count c))))
                    (let [ks (vec (inner it))] (ks (.nextInt rng (count ks)))))
                respelled? (and (not= kind :space-at-cut) (.nextBoolean rng))
                left (apply str (subvec c 0 k))
                x (when respelled? (fresh-word rng 1))
                right (str (or x (c k))
                           (apply str (subvec c (inc k))))
                ;; A space typed inside a morpheme folds the word. With the
                ;; last letter respelled after it (`dog` to `do Z`), the text
                ;; reads as that letter deleted and a new word typed, which
                ;; keeps the analysis, as well.
                fold (when (and cuts (not (some #{k} cuts))
                                (not (and respelled? (= k (dec (count c))))))
                       #{id})
                split (fn [lid rid]
                        (assoc doc si (-> (subvec sent 0 i)
                                          (conj (assoc it :id lid :w left :post "" :sep " " :cuts nil :new (not= lid id))
                                                {:id rid :pre "" :w right :post post :sep sep :new (not= rid id)})
                                          (into (subvec sent (inc i))))))]
            [(split id (+ 2000 id))
             {:resp #{id} :si si :fold fold :kind :split :i i :k k :x x
                            ;; or the right half is the word, and the left half
                            ;; is typed in front of it
              :alts [[(split (+ 2000 id) id)
                      {:resp #{id} :si si :fold fold :typed-front {id (inc (count (cps left)))}}]]}])))
      ;; The space between two words deleted and one typed inside a
      ;; morpheme of the second (`vow pumpkin` to `vowpum pkin`): the first
      ;; keeps its token, and the second folds (L3).
      :move-space
      (let [inner (fn [{:keys [w cuts]}] (when cuts (remove (set cuts) (range 1 (count (cps w))))))
            cands (filter (fn [i] (let [a (sent i) b (get sent (inc i))]
                                    (and b (= " " (:sep a)) (empty? (:post a)) (empty? (:pre b))
                                         (not (:zs b)) (not (:ze b)) (seq (inner b)))))
                          (range n))]
        (if (empty? cands)
          (edit doc rng [:resp])
          (let [i (nth cands (.nextInt rng (count cands)))
                a (sent i)
                {bid :id :as b} (sent (inc i))
                c (cps (:w b))
                ks (vec (inner b))
                k (ks (.nextInt rng (count ks)))
                split (fn [lid rid]
                        (assoc doc si (-> (subvec sent 0 i)
                                          (conj (assoc a :sep "")
                                                {:id lid :pre "" :w (apply str (subvec c 0 k)) :post "" :sep " "}
                                                (assoc b :id rid :w (apply str (subvec c k)) :cuts nil))
                                          (into (subvec sent (+ i 2))))))]
            [(split (+ 2000 bid) bid)
             {:resp #{bid} :si si :fold #{bid} :kind :move-space :i i :k k
              :alts [[(split bid (+ 2000 bid)) {:resp #{bid} :si si :fold #{bid}}]]}])))
      ;; A word changed at two carets, as people fix one: a letter deleted
      ;; at one place and a letter typed at another (`teh` to `the`, a
      ;; transposition, or a fresh letter), or a letter deleted and a space
      ;; typed elsewhere in the word (the word folds onto the half sharing
      ;; more letters, and an analysis is dropped, D28).
      :two-carets
      (let [cands (filter (fn [i] (let [{:keys [w zs ze]} (sent i)]
                                    (and (<= 3 (count (cps w))) (not zs) (not ze))))
                          (range n))
            i (when (seq cands) (nth cands (.nextInt rng (count cands))))
            {:keys [id w cuts post sep] :as it} (when i (sent i))
            c (when i (cps w))
            k (count c)
            a (when i (.nextInt rng k))
            ;; an old place for the second caret, a letter or more away
            ps (when i (vec (remove #(<= (dec a) % (inc a)) (range 0 (inc k)))))
            split? (when (seq ps) (.nextBoolean rng))
            sps (when split? (vec (remove (set cuts) (filter #(< 0 % k) ps))))
            p (cond (seq sps) (sps (.nextInt rng (count sps)))
                    (and (not split?) (seq ps)) (ps (.nextInt rng (count ps))))
            keep-at (fn [x y] (apply str (keep-indexed (fn [j ch] (when (and (<= x j) (< j y) (not= j a)) ch)) c)))
            left (when (and split? p) (keep-at 0 p))
            right (when (and split? p) (keep-at p k))
            letter (when (and p (not split?)) (if (.nextBoolean rng) (c a) (fresh-word rng 1)))
            w' (when letter (str (keep-at 0 p) letter (keep-at p k)))]
        (cond
          (nil? p) (edit doc rng [:resp])
          split?
          (if (or (empty? left) (empty? right))
            (edit doc rng [:resp])
            (let [split (fn [lid rid]
                          (assoc doc si (-> (subvec sent 0 i)
                                            (conj (assoc it :id lid :w left :post "" :sep " " :cuts nil)
                                                  {:id rid :pre "" :w right :post post :sep sep})
                                            (into (subvec sent (inc i))))))
                  fold (when cuts #{id})]
              [(split id (+ 2000 id))
               {:resp #{id} :si si :fold fold :kind :two-carets :i i
                :caret-gaps [[a (inc a) ""] [p p " "]]
                :typed (str left " " right)
                :alts [[(split (+ 2000 id) id)
                        {:resp #{id} :si si :fold fold :typed-front {id (inc (count (cps left)))}}]]}]))
          (= w' w) (edit doc rng [:resp])
          :else [(assoc-in doc [si i :w] w')
                 {:resp #{id} :kind :two-carets :si si :i i
                  :caret-gaps [[a (inc a) ""] [p p letter]] :typed w'}]))
      ;; A letter deleted inside a word and, in the same save, a new word
      ;; typed at its edge with its space, or a comma typed after it (N1,
      ;; N2): the new text stays outside the word, which keeps its analysis.
      :typo+edge
      (let [cands (filter (fn [i] (let [{:keys [w zs ze post]} (sent i)]
                                    (and (<= 3 (count (cps w))) (not zs) (not ze) (empty? post))))
                          (range n))
            i (when (seq cands) (nth cands (.nextInt rng (count cands))))
            {:keys [id w sep] :as it} (when i (sent i))
            c (when i (cps w))
            ;; Not in front of a sentence's first word: text typed where two
            ;; sentences meet goes to the sentence before, a rule of the
            ;; partition both paths share (see the report).
            where (when i (let [w (nth [:before :after :comma] (.nextInt rng 3))]
                            (if (and (= w :before) (zero? i) (pos? si)) :after w)))
            ;; the letter deleted inside the word, or at the edge where the
            ;; new text is typed (F1: `walkdd`, the last `d` Backspaced and
            ;; ` home` typed)
            a (when i (if (.nextBoolean rng)
                        (if (= where :before) 0 (dec (count c)))
                        (inc (.nextInt rng (- (count c) 2)))))
            neww (when i (fresh-word rng (inc (.nextInt rng 3))))]
        (if (nil? i)
          (edit doc rng [:resp])
          (let [w' (apply str (keep-indexed (fn [j ch] (when (not= j a) ch)) c))
                item {:id (+ 1000 (.nextInt rng 1000)) :pre "" :w neww :post "" :new true}]
            [(case where
               :before (assoc doc si (-> (subvec sent 0 i)
                                         (conj (assoc item :sep " ") (assoc it :w w'))
                                         (into (subvec sent (inc i)))))
               :after (assoc doc si (-> (subvec sent 0 i)
                                        (conj (assoc it :w w' :sep " ") (assoc item :sep sep))
                                        (into (subvec sent (inc i)))))
               :comma (assoc-in (assoc-in doc [si i :w] w') [si i :post] ","))
             {:resp #{id} :keep #{id} :ins (not= where :comma) :kind :typo+edge :si si :i i
              :caret-gaps [[a (inc a) ""]
                           (case where
                             :before [0 0 (str neww " ")]
                             :after [(count c) (count c) (str " " neww)]
                             :comma [(count c) (count c) ","])]
              :typed (case where
                       :before (str neww " " w')
                       :after (str w' " " neww)
                       :comma (str w' ","))}])))
      ;; A space typed inside a word and, in the same save, text typed at its
      ;; edge (a new word or punctuation in front, a new word or a comma after):
      ;; the word folds onto one half as a lone space folds it, and an
      ;; analysis is dropped (D28, X1).
      :split+edge
      (let [cands (filter (fn [i] (let [{:keys [w zs ze pre post]} (sent i)]
                                    (and (<= 2 (count (cps w))) (not zs) (not ze) (empty? pre) (empty? post)
                                         (or (pos? i) (zero? si)))))
                          (range n))
            i (when (seq cands) (nth cands (.nextInt rng (count cands))))
            {:keys [id w cuts sep] :as it} (when i (sent i))
            c (when i (cps w))
            k (when i (inc (.nextInt rng (dec (count c)))))
            where (when i (nth [:front-word :front-punct :back-word :comma] (.nextInt rng 4)))
            neww (when i (fresh-word rng (inc (.nextInt rng 2))))]
        (if (nil? i)
          (edit doc rng [:resp])
          (let [left (apply str (subvec c 0 k))
                right (apply str (subvec c k))
                item {:id (+ 1000 (.nextInt rng 1000)) :pre "" :w neww :post "" :new true}
                fold (when (and cuts (not (some #{k} cuts))) #{id})
                split (fn [lid rid]
                        (let [l (cond-> (assoc it :id lid :w left :post "" :sep " " :cuts nil)
                                  (= where :front-punct) (assoc :pre "("))
                              r (cond-> {:id rid :pre "" :w right :post "" :sep sep}
                                  (= where :comma) (assoc :post ","))]
                          (assoc doc si (-> (subvec sent 0 i)
                                            (cond-> (= where :front-word) (conj (assoc item :sep " ")))
                                            (conj l)
                                            (conj (cond-> r (= where :back-word) (assoc :sep " ")))
                                            (cond-> (= where :back-word) (conj (assoc item :sep sep)))
                                            (into (subvec sent (inc i)))))))]
            [(split id (+ 2000 id))
             {:resp #{id} :si si :fold fold :kind :split+edge :i i
              :caret-gaps [(case where
                             :front-word [0 0 (str neww " ")]
                             :front-punct [0 0 "("]
                             :back-word [(count c) (count c) (str " " neww)]
                             :comma [(count c) (count c) ","])
                           [k k " "]]
              :typed (case where
                       :front-word (str neww " " left " " right)
                       :front-punct (str "(" left " " right)
                       :back-word (str left " " right " " neww)
                       :comma (str left " " right ","))
              :alts [[(split (+ 2000 id) id)
                      {:resp #{id} :si si :fold fold
                       :typed-front {id (inc (count (cps left)))}}]]}])))
      :join (if (< si (dec (count doc)))
              [(-> doc
                   (assoc-in [si (dec n) :sep] " ")
                   (as-> d (into (conj (subvec d 0 si) (into (d si) (d (inc si)))) (subvec d (+ si 2)))))
               {:join si :kind :join :si si}]
              (edit doc rng [:resp])))))

;; ---------------------------------------------------------------- the oracle

(defn- spaced? [^String s]
  (.anyMatch (.codePoints s) (reify java.util.function.IntPredicate
                               (test [_ c] (or (Character/isWhitespace c) (Character/isSpaceChar c))))))

(defn- compensate
  "What `compensate-partition-layers!` does to the sentences after the edit."
  [tokens n]
  (let [{s true o false} (group-by #(= :s (:token/layer %)) tokens)
        s (vec (sort-by :token/begin s))
        k (count s)]
    (concat o (map-indexed (fn [i t]
                             (cond-> (assoc t :token/end (if (= i (dec k))
                                                           n
                                                           (max (:token/end t) (:token/begin (s (inc i))))))
                               (zero? i) (assoc :token/begin 0)))
                           s))))

(defn- problems
  "What is wrong with `result` for the case, by what the user meant."
  [{:keys [doc new-doc info tokens opts]} result]
  (let [{new-body :body words :words sents :sents} (layout new-doc)
        body (:text/body (:text result))
        out (compensate (:tokens result) (cp/cp-count body))
        read (fn [{:token/keys [begin end]}] (cp/cp-subs body begin end))
        by-layer (group-by :token/layer out)
        old-words (into {} (for [s doc it s] [(:id it) it]))
        amb (:amb info #{})
        resp (:resp info #{})
        ;; a word spelled as a respelled one beside it may have kept that one's token
        twin? (fn [it] (some #(= (:w it) (:w (old-words %))) amb))
        wt (into {} (map (juxt :token/id identity)) (by-layer :w))
        ;; a word deleted beside one of its spelling: either may be the one left
        twin-deleted? (when-let [del (:del info)]
                        (let [sent (doc (:si info))
                              kept (set (map :w (remove (comp del :id) sent)))]
                          (some #(and (del (:id %)) (kept (:w %))) sent)))
        ext (juxt :token/begin :token/end)
        ps (transient [])
        p! (fn [& xs] (conj! ps (apply str xs)))]
    (when (not= new-body body) (p! "BODY " (pr-str body)))
    ;; one token on each kept word, none elsewhere
    (let [amb-ext (set (for [id amb :let [x (words id)] :when x] [(:b x) (:e x)]))
          want (set (for [[id {:keys [b e]}] words :when (and (old-words id) (not (amb id)))] [b e]))
          all (map ext (by-layer :w))]
      (when (not= want (set (remove amb-ext all)))
        (p! "WORDS want " (pr-str (sort want)) " got " (pr-str (sort all))))
      (when (not= (count all) (count (set all))) (p! "WORDS twice " (pr-str (sort all)))))
    (doseq [t (by-layer :w)
            :let [it (old-words (:token/id t))]
            :when (and it (words (:token/id t)) (not (resp (:token/id t))) (not (twin? it)))]
      (when (not= (read t) (:w it))
        (p! "WORD " (:token/id t) " " (pr-str (:w it)) " reads " (pr-str (read t)))))
    (doseq [t (concat (by-layer :w) (by-layer :m) (by-layer :p))]
      (when (spaced? (read t)) (p! "SPACE in " (pr-str (:token/id t)) " " (pr-str (read t)))))
    (when (:ud opts)
      (let [want (set (for [[id {:keys [b e pb qe]}] words :when (old-words id)
                            x [[pb b] [e qe]] :when (< (first x) (second x))]
                        x))
            all (map ext (by-layer :p))]
        (when (or (not= want (set all)) (not= (count all) (count (set all))))
          (p! "PUNCT want " (pr-str (sort want)) " got " (pr-str (sort all))))))
    ;; markers by place, since the diff cannot tell two words of one spelling apart
    (let [at (set (map (juxt (comp first :token/id) :token/begin) (by-layer :z)))]
      (doseq [t tokens :when (= :z (:token/layer t))
              :let [[k id] (:token/id t) x (words id)]
              :when (and x (old-words id) (not (amb id)))]
        ;; Text typed where a start marker stands goes after it, so a space
        ;; typed in front of the word leaves the marker in front of the space.
        (let [want (if (= k :zs) (:b x) (:e x))
              typed (get-in info [:typed-front id] 0)]
          (when-not (or (at [k want]) (and (= k :zs) (at [k (- want typed)])))
            (p! "MARK " k " of " id " not at " want))))
      (doseq [t (by-layer :z) :let [pos (:token/begin t)]]
        (when (some (fn [[id {:keys [b e]}]] (and (not (amb id)) (< b pos e))) words)
          (p! "MARK inside a word at " pos))))
    (let [ms (group-by #(second (:token/id %)) (by-layer :m))]
      (doseq [[id it] old-words :when (:cuts it)]
        (let [m (sort-by :token/begin (ms id))
              w (wt id)]
          (cond
            (nil? w) (when (seq m) (p! "MORPH of deleted " id " left on " (pr-str (map read m))))
            ((or (:fold info) #{}) id) (when (seq m) (p! "MORPH of folded " id " left on " (pr-str (map read m))))
            (and ((or (:keep info) #{}) id) (empty? m)) (p! "MORPH of " id " dropped")
            (and (not (resp id)) (not (twin? it)))
            (let [c (cps (:w it))
                  want (map (fn [[x y]] (apply str (subvec c x y)))
                            (partition 2 1 (concat [0] (:cuts it) [(count c)])))]
              (when (not= want (map read m)) (p! "MORPH " id " " (pr-str want) " got " (pr-str (map read m)))))
            (seq m)
            (let [spans (map ext m)]
              (when-not (and (= (:token/begin w) (ffirst spans))
                             (= (:token/end w) (second (last spans)))
                             (every? (fn [[[_ e1] [b2 _]]] (= e1 b2)) (partition 2 1 spans)))
                (p! "MORPH respelled " id " on " (pr-str (read w)) " as " (pr-str (map read m)))))))))
    (doseq [t (by-layer :u) :let [[k a b] (:token/id t)]]
      (case k
        :u1 (when (and (not (amb a)) (not= (some-> (wt a) ext) (ext t)))
              (p! "NODE " a " on " (pr-str (read t)) ", its word on " (pr-str (some-> (wt a) read))))
        :um (let [ids (->> doc (mapcat identity) (map :id) (drop-while #(not= % a)))
                  ids (concat (take-while #(not= % b) ids) [b])
                  kept (filter words ids)]
              (cond
                (or (some amb ids) twin-deleted?) nil
                (empty? kept) (p! "NODE over deleted words left on " (pr-str (read t)))
                ;; its edges on the first and last word left, or on their punctuation
                :else (let [f (words (first kept)) l (words (last kept))]
                        (when-not (and ((hash-set (:b f) (:pb f)) (:token/begin t)) ((hash-set (:e l) (:qe l)) (:token/end t)))
                          (p! "NODE over words on " (pr-str (read t)) ", want "
                              (pr-str (cp/cp-subs body (:b f) (:e l))))))))
        :us nil))
    (doseq [t tokens :when (= :u (:token/layer t)) :let [[k a] (:token/id t)] :when (= k :u1)]
      (when (and (wt a) (not (amb a)) (not-any? #(= (:token/id t) (:token/id %)) (by-layer :u)))
        (p! "NODE " a " lost")))
    (when-not (:join info)
      (let [got (sort (map ext (by-layer :s)))]
        (when (not= (sort sents) got) (p! "SENTS want " (pr-str sents) " got " (pr-str got)))))
    (persistent! ps)))

;; ---------------------------------------------------------------- cases

(defn- gen-case [seed opts]
  (let [rng (java.util.Random. seed)
        doc (gen-doc rng opts)
        lay (layout doc)
        tokens (tokens-for doc lay rng opts)
        [new-doc info] (edit doc rng (:kinds opts))]
    {:seed seed :doc doc :new-doc new-doc :info info :tokens tokens :opts opts
     :old (:body lay) :new (:body (layout new-doc))}))

(defn- reading
  "The case with the new word of a replace taken for the one meant for `c`,
  a word deleted beside it, and the respelled word taken for deleted."
  [{:keys [info] :as case} c]
  (let [r (first (:group info))
        swap (fn [ids] (-> (set ids) (disj r) (conj c)))]
    (-> case
        (update :new-doc (fn [d] (mapv (fn [s] (mapv #(if (= r (:id %)) (assoc % :id c) %) s)) d)))
        (update :info #(-> %
                           (update :resp swap)
                           (update :amb (fn [ids] (if (contains? ids r) (swap ids) ids)))
                           (update :del (fn [ids] (-> ids (disj c) (conj r)))))))))

(defn- run-case [{:keys [old new tokens info opts] :as c}]
  (let [result (-> (ta/diff old new)
                   (ta/slide-to-tokens old tokens #{:s})
                   (ta/normalize-deletes old tokens)
                   (ta/align-to-words old tokens #{:w :p})
                   (ta/pair-replacements old tokens)
                   ;; the words and the punctuation tokens are the word
                   ;; layers (overlap forbidden, no partition, a parent)
                   (ta/fold-whole-words old tokens #{:w :p} (:segments opts))
                   (ta/apply-text-edits {:text/body old} tokens)
                   (as-> r (ta/keep-edges-off-spaces old tokens r #{:s})))
        ps (problems c result)]
    (if (and (seq ps) (or (some #(empty? (problems (reading c %) result)) (rest (:group info)))
                          (some (fn [[d i]] (empty? (problems (assoc c :new-doc d :info i) result))) (:alts info))))
      []
      ps)))

;; ---------------------------------------------------------------- open classes

(def ^:private open-classes
  "Classes of case the chain still gets wrong, all older than the fixes of
  2026-09-28 this test was written to hold. Each is a predicate over the
  generated case, so a fix for one deletes its entry."
  {;; In a script without spaces, a respelled word keeps its letters
   ;; beside the deleted words, and the one kept there is also in a deleted
   ;; word, so the diff may keep it from the deleted word (`sattat` to `tX`
   ;; keeps the `t` of `sat`, which is left on `t` and `tat` on `X`).
   ;; Deleting `sat` and respelling `tat` gives the same text at the same
   ;; cost, and without a space the text does not say that `tX` is one
   ;; word. With spaces the class is closed (`align-to-words`).
   :kept-edge-letter-also-in-a-deleted-word-without-spaces
   (fn [{{{:keys [mode near? shared? edge-in-deleted?]} :shape} :info opts :opts}]
     (and (= [""] (:seps opts)) shared? edge-in-deleted? (not near?) (not= mode :whole)))})

(def ^:private open-class-ceilings
  "How many cases of each open class may fail, at the sizes below. The
  class holds 49 cases, of which 2 fail and are undecidable: `كتابsattat`
  to `كتابtX` reads as `sat` deleted and `tat` respelled or as `sat` cut to
  `t` and `tat` replaced by `X`, and without a space nothing says whether
  `tX` is one word (REV-U-CORE-TEXT, 2026-09-29)."
  {:kept-edge-letter-also-in-a-deleted-word-without-spaces 2})

(defn- open-class [c]
  (some (fn [[k pred]] (when (pred c) k)) open-classes))

;; ---------------------------------------------------------------- configs

(def ^:private configs
  (let [all [:resp :del :del+resp :ins]]
    {:spaces {:seps [" "] :kinds all}
     :beside-deleted {:seps [" "] :kinds [:del+resp]}
     :tabs {:seps [" " "\t" "  " " \t"] :kinds all}
     :no-break-space {:seps [" " nbsp] :kinds all}
     :punctuation-in-gaps {:seps [" "] :puncts ["," "." "!"] :pres ["(" "\""] :kinds all}
     :punctuation-tokens {:seps [" "] :puncts ["," "." "!"] :pres ["(" "\""] :ud true :kinds all}
     :markers {:seps [" "] :marks 0.4 :kinds all}
     :typed-beside-markers {:seps [" "] :marks 0.5 :kinds [:resp+space :resp+ins]}
     :nodes {:seps [" " "\t"] :nodes 4 :kinds [:del :del+resp :resp]}
     :no-spaces {:seps [""] :kinds [:resp :del :del+resp]}
     ;; UMR nodes over the words of a script without spaces
     :no-spaces-nodes {:seps [""] :nodes 4 :kinds [:resp :del :del+resp] :cases 2000}
     :joins {:seps [" "] :kinds [:join]}
     :joined-words {:seps [" "] :kinds [:join-words]}
     :joined-words-marked {:seps [" "] :marks 0.4 :nodes 4 :kinds [:join-words]}
     :joined-one-whole {:seps [" "] :kinds [:join-one-whole :join-space]}
     :joined-one-whole-marked {:seps [" "] :marks 0.4 :nodes 4 :kinds [:join-one-whole :join-space]}
     :joined-three {:seps [" "] :kinds [:join-three]}
     :joined-three-marked {:seps [" "] :marks 0.4 :nodes 4 :kinds [:join-three]}
     :space-at-morpheme-edge {:seps [" "] :kinds [:space-at-cut]}
     :space-at-morpheme-edge-marked {:seps [" "] :marks 0.4 :nodes 4 :kinds [:space-at-cut]}
     :split-word {:seps [" "] :kinds [:split-word]}
     :split-word-nodes {:seps [" "] :marks 0.4 :nodes 4 :kinds [:split-word]}
     :split-in-morpheme {:seps [" "] :kinds [:split-in-morpheme]}
     :split-in-morpheme-nodes {:seps [" "] :marks 0.4 :nodes 4 :kinds [:split-in-morpheme]}
     ;; Words analyzed as one morpheme over the whole word, on a layer
     ;; declaring `segmentsParent`: a space typed inside one drops the
     ;; morpheme, as inside any morpheme (D28).
     :one-morpheme-cut {:seps [" "] :one-morph 0.6 :segments #{:m}
                        :kinds [:split-in-morpheme :split-word :resp :del+resp :join-words]}}))

;; ---------------------------------------------------------------- the test

(def ^:private cases-per-config 400)

(deftest a-whole-body-update-leaves-every-token-where-the-user-meant
  (let [open-failures (atom {})]
    (doseq [[k opts] (sort configs)]
      (testing (name k)
        (let [n (:cases opts cases-per-config)
              cases (map #(gen-case % opts) (range n))
              judged (remove open-class cases)]
          ;; the open classes must not grow to swallow the test
          (is (< (* 0.2 n) (count judged))
              (str (count judged) " of " n " cases judged"))
          (doseq [c cases
                  :let [cls (open-class c)
                        ps (run-case c)]
                  :when (seq ps)]
            (if cls
              (swap! open-failures update cls (fnil conj []) [k (:seed c)])
              (is (empty? ps)
                  (str "seed " (:seed c) ": " (pr-str (:old c)) " -> " (pr-str (:new c)) " " (pr-str (:info c)))))))))
    (doseq [[cls ceiling] open-class-ceilings
            :let [failed (get @open-failures cls [])]]
      (is (<= (count failed) ceiling)
          (str cls ": " (count failed) " cases fail, at most " ceiling " may: " (pr-str failed))))))

(deftest a-delete-joining-two-words-leaves-one-token-on-the-new-word
  (doseq [[old new want] [["a big dog ran" "a bog ran" [[0 1] [2 5] [6 9]]]
                          ["ka1292x ob1293 zz" "sh1299 zz" [[0 6] [7 9]]]]]
    (let [tokens (map-indexed (fn [i [b e]] {:token/id i :token/layer :w :token/begin b :token/end e})
                              (let [m (re-matcher #"\S+" old)]
                                (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out))))
          result (-> (ta/diff old new)
                     (ta/slide-to-tokens old tokens #{})
                     (ta/normalize-deletes old tokens)
                     (ta/align-to-words old tokens #{:w})
                     (ta/pair-replacements old tokens)
                     (ta/fold-whole-words old tokens #{:w})
                     (ta/apply-text-edits {:text/body old} tokens))]
      (is (= new (:text/body (:text result))))
      (is (= want (sort (map (juxt :token/begin :token/end) (:tokens result))))
          (str (pr-str old) " -> " (pr-str new))))))

(defn- words-and-morphemes
  "Word tokens on the runs of `s` without spaces, and morphemes of the words
  given in `cuts` (word index to the code points each cut stands after)."
  [s cuts]
  (let [m (re-matcher #"\S+" s)
        ws (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out))]
    (vec (concat
          (map-indexed (fn [i [b e]] {:token/id [:w i] :token/layer :w :token/begin b :token/end e}) ws)
          (for [[i cs] cuts
                :let [[b e] (ws i)]
                [j [x y]] (map-indexed vector (partition 2 1 (concat [0] cs [(- e b)])))]
            {:token/id [:m i j] :token/layer :m :token/begin (+ b x) :token/end (+ b y)})))))

(defn- body-save
  "The words and morphemes after `old` is saved as `new`, as [id text]."
  [old new cuts]
  (let [tokens (words-and-morphemes old cuts)
        result (-> (ta/diff old new)
                   (ta/slide-to-tokens old tokens #{})
                   (ta/normalize-deletes old tokens)
                   (ta/align-to-words old tokens #{:w})
                   (ta/pair-replacements old tokens)
                   (ta/fold-whole-words old tokens #{:w})
                   (ta/apply-text-edits {:text/body old} tokens))
        body (:text/body (:text result))]
    (is (= new body))
    (->> (:tokens result)
         (sort-by (juxt :token/layer :token/begin))
         (mapv (fn [{:token/keys [id begin end]}] [id (cp/cp-subs body begin end)])))))

(deftest a-join-that-leaves-one-word-whole-leaves-one-token
  ;; D22: the space and letters of one word gone
  (is (= [[[:w 0] "theki"] [[:w 2] "ran"]] (body-save "the kaki ran" "theki ran" {})))
  (is (= [[[:w 1] "thkaki"] [[:w 2] "ran"]] (body-save "the kaki ran" "thkaki ran" {})))
  (is (= [[[:w 0] "a"] [[:w 1] "catQat"]] (body-save "a cat mat" "a catQat" {})))
  ;; only the space: two words written together keep a token each
  (is (= [[[:w 0] "a"] [[:w 1] "big"] [[:w 2] "dog"]] (body-save "a big dog" "a bigdog" {})))
  (is (= [[[:w 0] "the"] [[:w 2] "dog"] [[:w 3] "x"]] (body-save "the cat dog x" "thedog x" {})))
  ;; a punctuation mark at the edge keeps the words apart
  (is (= [[[:w 0] "a"] [[:w 1] "big,"] [[:w 2] "og"] [[:w 3] "ran"]]
         (body-save "a big, dog ran" "a big,og ran" {}))))

(deftest a-join-over-three-words-leaves-one-token
  ;; REV-W-TEXT2 R1: a middle word's letter survives, so the diff deletes twice
  (is (= [[[:w 0] "a"] [[:w 1] "bon"] [[:w 4] "home"]] (body-save "a big dog ran home" "a bon home" {})))
  (is (= [[[:w 0] "a"] [[:w 3] "bodom"] [[:w 4] "home"]] (body-save "a bi dog random home" "a bodom home" {})))
  (is (= [[[:w 0] "a"] [[:w 1] "kitsats"]] (body-save "a kitten sat on mats" "a kitsats" {})))
  (is (= [[[:w 0] "one"] [[:w 1] "bdn"]] (body-save "one big dog ran" "one bdn" {}))))

(deftest a-space-typed-in-an-analyzed-word-leaves-no-token-over-it
  ;; REV-W-TEXT2 N1: between two morphemes, the word and its morphemes go on
  ;; the new word sharing more letters
  (is (= [[[:m 1 1] "mrs"] [[:w 0] "hh"] [[:w 1] "mrs"]] (body-save "hh pqmrs" "hh pq mrs" {1 [2]})))
  (is (= [[[:m 1 0] "pqm"] [[:w 0] "hh"] [[:w 1] "pqm"]] (body-save "hh pqmrs" "hh pqm rs" {1 [3]})))
  ;; inside a morpheme, respelled after the space: the word folds
  (is (= [[[:w 0] "hh"] [[:w 1] "pq"]] (body-save "hh pqmrs" "hh pq krs" {1 [3]})))
  (is (= [[[:m 0 0] "花花"] [[:m 0 1] "家犬犬"] [[:w 0] "花花家犬犬"] [[:w 2] "犬猫"]]
         (body-save "花花家犬犬 川川水川 犬猫水山木" "花花家犬犬 犬猫 川山木" {0 [2] 2 [2]}))))

(deftest a-space-typed-inside-any-morpheme-folds-the-word
  ;; D28: inside the first, middle or last morpheme, the word goes on the new
  ;; word sharing more letters and keeps no morpheme
  (is (= [[[:w 0] "hh"] [[:w 1] "unbreakab"]] (body-save "hh unbreakable" "hh unbreakab le" {1 [2 7]})))
  (is (= [[[:w 0] "hh"] [[:w 1] "nbreakable"]] (body-save "hh unbreakable" "hh u nbreakable" {1 [2 7]})))
  (is (= [[[:w 0] "hh"] [[:w 1] "reakable"]] (body-save "hh unbreakable" "hh unb reakable" {1 [2 7]})))
  (is (= [[[:w 0] "hh"] [[:w 1] "mrs"]] (body-save "hh pqmrs" "hh pq mrs" {1 [1]})))
  (is (= [[[:w 0] "hh"] [[:w 1] "pqm"]] (body-save "hh pqmrs" "hh pqm rs" {1 [4]})))
  ;; at a morpheme boundary the morphemes stay (N1)
  (is (= [[[:m 1 1] "break"] [[:m 1 2] "able"] [[:w 0] "hh"] [[:w 1] "breakable"]]
         (body-save "hh unbreakable" "hh un breakable" {1 [2 7]}))))

(deftest a-no-break-space-typed-in-a-word-splits-it-as-a-space-does
  ;; The diff and the apps take U+00A0, U+2007 and U+202F for spaces
  ;; (`space?`). The fold took them for letters, and left the word and a
  ;; morpheme with its gloss over the space (REV-W-TEXT4).
  (is (= [[[:w 0] "hh"] [[:w 1] "unbreakab"]] (body-save "hh unbreakable" "hh unbreakab\u00a0le" {1 [2 7]})))
  (is (= [[[:w 0] "hh"] [[:w 1] "nbreakable"]] (body-save "hh unbreakable" "hh u\u202fnbreakable" {1 [2 7]})))
  (is (= [[[:m 1 1] "break"] [[:m 1 2] "able"] [[:w 0] "hh"] [[:w 1] "breakable"]]
         (body-save "hh unbreakable" "hh un\u2007breakable" {1 [2 7]}))))

;; ---------------------------------------------------------------- edits from the caret

(defn- trimmed
  "[p s]: how many code points `a` and `b` share at the start, and then at
  the end."
  [a b]
  (let [a (cps a) b (cps b)
        m (min (count a) (count b))
        p (count (take-while true? (map = a b)))
        s (count (take-while true? (map = (rseq a) (rseq b))))]
    [p (min s (- m p))]))

(defn- merge-gaps
  "Gaps in old-body order with those that touch made one."
  [gaps]
  (reduce (fn [out {:keys [start end value] :as g}]
            (let [prev (peek out)]
              (if (and prev (= (:end prev) start))
                (conj (pop out) (assoc prev :end end :value (str (:value prev) value)))
                (conj out g))))
          []
          (sort-by (juxt :start :end) gaps)))

(defn- intended-gaps
  "The gaps the user's edit makes, read `:words` (each changed word selected
  and typed over, a deleted run selected and deleted with one separator, a
  new word typed with its separator) or `:keys` (only the letters that
  changed: Backspace over them and the new ones typed, a join by deleting
  the space and the letters between, a split by a typed space)."
  [{:keys [doc new-doc info]} reading]
  (let [{words :words} (layout doc)
        items (into {} (for [s new-doc it s] [(:id it) it]))
        {:keys [kind si i j r k x ka kb p q kc]} info
        sent (when si (doc si))
        at (fn [idx] (words (:id (sent idx))))
        resp (fn [idx]
               (let [{:keys [id w]} (sent idx)
                     w' (:w (items id))
                     {:keys [b e]} (words id)]
                 (when (not= w w')
                   (if (= reading :words)
                     [{:start b :end e :value w'}]
                     (let [[p s] (trimmed w w')
                           c' (cps w')]
                       [{:start (+ b p) :end (- e s) :value (apply str (subvec c' p (- (count c') s)))}])))))
        del (fn [i j]
              (if (< j (count sent))
                [{:start (:pb (at i)) :end (:pb (at j)) :value ""}]
                [{:start (:qe (at (dec i))) :end (:qe (at (dec j))) :value ""}]))
        ins (fn [i v] [{:start (:qe (at i)) :end (:qe (at i)) :value (str " " v)}])]
    (merge-gaps
     (case kind
       :resp (resp i)
       :del (del i j)
       :del+resp (concat (del i j) (resp r))
       :ins (ins i (:neww info))
       :resp+space (concat (when (:space info) [{:start (:pb (at i)) :end (:pb (at i)) :value " "}]) (resp i))
       :resp+ins (concat (resp i) (ins i (:neww info)))
       :join-words (let [a (at i) b (at (inc i))]
                     (if (= reading :words)
                       [{:start (:b a) :end (:e b) :value (:w (items (:id (sent i))))}]
                       [{:start (+ (:b a) ka) :end (- (:e b) kb) :value ""}]))
       :join-space [{:start (:qe (at i)) :end (:pb (at (inc i))) :value ""}]
       :join-three (let [a (at i) b (at (inc i)) c (at (+ i 2))]
                     (if (= reading :words)
                       [{:start (:b a) :end (:e c) :value (:w (items (:id (sent i))))}]
                       [{:start (+ (:b a) ka) :end (+ (:b b) p) :value ""}
                        {:start (+ (:b b) q) :end (- (:e c) kc) :value ""}]))
       :split (let [{:keys [b e]} (at i)
                    it (sent i)
                    c (cps (:w it))]
                (if (= reading :words)
                  [{:start b :end e :value (str (apply str (subvec c 0 k)) " " (or x (c k))
                                                (apply str (subvec c (inc k))))}]
                  [{:start (+ b k) :end (+ b k (if x 1 0)) :value (str " " x)}]))
       :move-space (let [a (at i) b (at (inc i))]
                     (if (= reading :words)
                       (let [c (cps (:w (sent (inc i))))]
                         [{:start (:b a) :end (:e b)
                           :value (str (:w (sent i)) (apply str (subvec c 0 k)) " " (apply str (subvec c k)))}])
                       [{:start (:qe a) :end (:pb b) :value ""}
                        {:start (+ (:b b) k) :end (+ (:b b) k) :value " "}]))
       (:two-carets :typo+edge :split+edge) (let [{:keys [b e]} (at i)]
                                              (if (= reading :words)
                                                [{:start b :end e :value (:typed info)}]
                                                (map (fn [[x y v]] {:start (+ b x) :end (+ b y) :value v}) (:caret-gaps info))))
       :join (let [last-item (peek sent)
                   e (:qe (words (:id last-item)))]
               [{:start e :end (+ e (cp/cp-count (:sep last-item))) :value " "}])))))

(defn- gaps->keystrokes
  "Running ops typing `gaps` as a person would: from the last change to the
  first, Backspace from the end of each over its old letters, then its new
  ones typed one at a time."
  [gaps]
  (vec (mapcat (fn [{:keys [start end value]}]
                 (concat (for [pos (range (dec end) (dec start) -1)] {:type :delete :index pos :value 1})
                         (map-indexed (fn [n c] {:type :insert :index (+ start n) :value c}) (cps value))))
               (reverse gaps))))

(defn- gaps->replaces
  "Running ops typing `gaps` as one replace each, a selection typed over."
  [gaps]
  (mapv (fn [{:keys [start end value]}] {:type :replace :index start :length (- end start) :value value})
        (reverse gaps)))

(defn- edit-chain
  "What `edit-body` does with `ops` on `old` and `tokens`."
  [old tokens ops opts]
  (ta/apply-edits old tokens ops {:partitioning #{:s} :word-layers #{:w :p} :segments (:segments opts)}))

(defn- judged
  "`problems`, with the readings the text cannot settle tried as `run-case` does."
  [{:keys [info] :as c} result]
  (let [ps (problems c result)]
    (if (and (seq ps) (or (some #(empty? (problems (reading c %) result)) (rest (:group info)))
                          (some (fn [[d i]] (empty? (problems (assoc c :new-doc d :info i) result))) (:alts info))))
      []
      ps)))

(defn- outside-changed
  "The tokens wholly apart from every gap (not touching one) that `result`
  deleted or gave another length: an edit changes nothing outside the text
  it was made in."
  [tokens gaps result]
  (let [after (into {} (map (juxt :token/id identity)) (:tokens result))
        ;; each gap with the words it touches, whose morphemes a fold may drop
        reach (for [{:keys [start end]} gaps
                    :let [ws (filter (fn [{:token/keys [layer begin] :as w}]
                                       (and (#{:w :p} layer) (<= begin end) (<= start (:token/end w))))
                                     tokens)]]
                [(reduce min start (map :token/begin ws)) (reduce max end (map :token/end ws))])]
    (for [{:token/keys [id begin end] :as t} tokens
          :when (every? (fn [[s e]] (or (< (:token/end t) s) (> begin e))) reach)
          :let [t' (after id)]
          :when (or (nil? t') (not= (- end begin) (- (:token/end t') (:token/begin t'))))]
      (str "OUTSIDE " (pr-str id) " [" begin " " end ")" (if t' " resized" " deleted")))))

(defn- run-case-edits
  "The problems of the case typed as `reading` (see `intended-gaps`), and
  the tokens outside every gap it changed. Throws when the gaps do not make
  the case's new body."
  [{:keys [old new tokens opts] :as c} reading]
  (let [gaps (intended-gaps c reading)
        ops (if (= reading :words) (gaps->replaces gaps) (gaps->keystrokes gaps))]
    (when (not= new (ta/edit-ops-body ops old))
      (throw (ex-info "reading does not make the new body" {:case (select-keys c [:seed :old :new :info]) :gaps gaps})))
    (let [result (edit-chain old tokens ops opts)]
      (into (vec (judged c result)) (outside-changed tokens gaps result)))))

(def ^:private edit-configs
  "The whole-body configs, and the residue the edit path was made for."
  (merge configs
         {:l2-identical-words {:seps [" "] :vocab ["bb"] :kinds [:join-space :resp :del :ins]}
          :l3-space-moved-into-morpheme {:seps [" "] :kinds [:move-space]}
          :l3-space-moved-marked {:seps [" "] :marks 0.4 :nodes 4 :kinds [:move-space]}
          ;; A space typed in a word at a sentence start or beside a marker,
          ;; where the second new word would take the token: text put in front
          ;; of it would go to the sentence before, or behind the marker, so
          ;; the first new word takes it (R9).
          :split-at-sentence-start {:seps [" "] :kinds [:split-any]}
          :split-beside-marker {:seps [" "] :marks 0.5 :nodes 4 :kinds [:split-any]}
          ;; a word fixed at two carets (R2, R8)
          :two-carets {:seps [" "] :kinds [:two-carets]}
          :two-carets-nodes {:seps [" " "\t"] :nodes 4 :kinds [:two-carets]}
          :two-carets-one-morpheme {:seps [" "] :one-morph 0.6 :segments #{:m} :kinds [:two-carets]}
          ;; a typo fixed and a new word or a comma typed at the word's edge (N1, N2)
          :typo-and-edge {:seps [" "] :kinds [:typo+edge]}
          :typo-and-edge-one-morpheme {:seps [" "] :one-morph 0.6 :segments #{:m} :kinds [:typo+edge]}
          ;; a space typed in a word with text typed at its edge (X1)
          :split-and-edge {:seps [" "] :kinds [:split+edge]}
          :split-and-edge-one-morpheme {:seps [" "] :one-morph 0.6 :segments #{:m} :kinds [:split+edge]}
          :split-and-edge-nodes {:seps [" "] :nodes 4 :kinds [:split+edge]}
          :one-morpheme-moved-space {:seps [" "] :one-morph 0.6 :segments #{:m} :kinds [:move-space]}}))

(def ^:private old-seeds
  "Seeds that once failed a whole-body save for a choice of place the text
  left open, run again in every config."
  [958 971 1023 1100])

(deftest an-edit-from-the-caret-leaves-every-token-where-the-user-meant
  (doseq [[k opts] (sort edit-configs)]
    (testing (name k)
      (let [n (:cases opts cases-per-config)
            cases (map #(gen-case % opts) (concat (range n) old-seeds))
            counts (reduce (fn [m c]
                             (let [whole (seq (run-case c))
                                   words (run-case-edits c :words)
                                   keys (run-case-edits c :keys)]
                               (when-not (:limit opts)
                                 (is (empty? keys)
                                     (str "keys, seed " (:seed c) ": " (pr-str (:old c)) " -> " (pr-str (:new c))
                                          " " (pr-str (intended-gaps c :keys)) " " (pr-str keys))))
                               (cond-> m
                                 whole (update :whole inc)
                                 (seq words) (update :words conj (:seed c))
                                 (seq keys) (update :keys conj (:seed c)))))
                           {:whole 0 :words [] :keys []}
                           cases)]
        (when (:limit opts)
          (is (<= (count (:keys counts)) (:whole counts))
              (str "typed at the caret, " (count (:keys counts)) " cases fail where a whole-body save fails "
                   (:whole counts) ": " (pr-str (take 10 (:keys counts))))))
        (is (<= (count (:words counts)) (:whole counts))
            (str "typed over word by word, " (count (:words counts)) " cases fail where a whole-body save fails "
                 (:whole counts) ": " (pr-str (take 10 (:words counts)))))))))

(defn- random-ops
  "A seeded stream of keystroke ops over `old`: letters typed, Backspace and
  Delete, a word deleted, a selection typed over, a paste, a cut."
  [^java.util.Random rng ^String old k]
  (loop [body old i 0 out []]
    (if (= i k)
      out
      (let [n (cp/cp-count body)
            pos (.nextInt rng (inc n))
            op (case (.nextInt rng 6)
                 0 {:type :insert :index pos :value (nth ["a" "Q" " " "é" "𐌰" "́" "ta"] (.nextInt rng 7))}
                 1 (if (pos? pos) {:type :delete :index (dec pos) :value 1} {:type :insert :index 0 :value "x"})
                 2 (if (< pos n) {:type :delete :index pos :value 1} {:type :insert :index pos :value " "})
                 3 (let [len (min (- n pos) (.nextInt rng 6))] {:type :delete :index pos :value len})
                 4 (let [len (min (- n pos) (.nextInt rng 6))]
                     {:type :replace :index pos :length len :value (nth ["dog" "" "Ж a" "cat"] (.nextInt rng 4))})
                 5 {:type :insert :index pos :value (nth ["the cat " "a\nb" "你好"] (.nextInt rng 3))})]
        (recur (ta/edit-ops-body [op] body) (inc i) (conj out op))))))

(defn- whole-chain
  "What `update-body` does with the whole new body."
  [old new tokens opts]
  (-> (ta/diff old new) (ta/slide-to-tokens old tokens #{:s}) (ta/normalize-deletes old tokens)
      (ta/align-to-words old tokens #{:w :p}) (ta/pair-replacements old tokens)
      (ta/fold-whole-words old tokens #{:w :p} (:segments opts)) (ta/apply-text-edits {:text/body old} tokens)
      (as-> r (ta/keep-edges-off-spaces old tokens r #{:s}))))

(defn- spaced-new
  "How many word, morpheme and punctuation tokens `result` gives a space they
  did not hold."
  [old tokens result]
  (let [body (:text/body (:text result))
        before (into {} (map (juxt :token/id identity)) tokens)]
    (count (for [t (:tokens result)
                 :when (#{:w :m :p} (:token/layer t))
                 :let [was (before (:token/id t))]
                 :when (and (spaced? (cp/cp-subs body (:token/begin t) (:token/end t)))
                            (not (spaced? (cp/cp-subs old (:token/begin was) (:token/end was)))))]
             t))))

(deftest an-edit-depends-only-on-the-change-it-makes
  ;; Keystrokes and their composed form give the same body and the same
  ;; tokens: what the server does depends on the gaps alone.
  (let [rng (java.util.Random. 20260930)
        opts-list (vals (sort edit-configs))
        spaced (atom {:edit 0 :whole 0 :edit-only []})]
    (dotimes [i 10000]
      (let [opts (nth opts-list (mod i (count opts-list)))
            {:keys [old tokens]} (gen-case (.nextInt rng 100000) opts)
            ops (random-ops rng old (inc (.nextInt rng 12)))
            gaps (ta/compose-edits ops old)
            composed (ta/gap-ops gaps)
            body (ta/edit-ops-body ops old)]
        (is (= body (ta/edit-ops-body composed old)) (pr-str old ops gaps))
        (is (= gaps (ta/compose-edits composed old)) (pr-str old ops gaps))
        (when (zero? (mod i 5))
          (let [raw (edit-chain old tokens ops opts)
                pre (edit-chain old tokens composed opts)
                view (fn [r] [(:text/body (:text r)) (set (map (juxt :token/id :token/begin :token/end) (:tokens r)))
                              (set (:deleted r))])
                read (fn [{:token/keys [begin end]}] (cp/cp-subs body begin end))
                before (into {} (map (juxt :token/id identity)) tokens)]
            (is (= body (:text/body (:text raw))))
            (is (= (view raw) (view pre)) (pr-str old ops))
            ;; and the result is right: nothing outside the edits changed, and
            ;; for a change of at most two stretches (a person's edit before a
            ;; save, not a mashup of pastes into words) no word, morpheme or
            ;; punctuation token is given a space where a whole-body save of
            ;; the same change gives none
            (is (empty? (outside-changed tokens gaps raw)) (pr-str old ops (outside-changed tokens gaps raw)))
            (when (<= (count gaps) 2)
              (let [e (spaced-new old tokens raw)
                    w (spaced-new old tokens (whole-chain old body tokens opts))]
                (swap! spaced update :edit + e)
                (swap! spaced update :whole + w)
                (when (> e w) (swap! spaced update :edit-only conj [old ops]))))))))
    ;; Counted over the run: a paste of several words into a word at a
    ;; morpheme's edge in a script without spaces can land differently on
    ;; the two paths (the whole-body diff slides it out of the word), so
    ;; the few cases where only the edit path gives a spaced token are
    ;; listed, and the edit path must not give more in all.
    (is (<= (:edit @spaced) (:whole @spaced)) (pr-str @spaced))
    (is (<= (count (:edit-only @spaced)) 3) (pr-str (:edit-only @spaced)))))

(deftest one-typed-over-stretch-is-read-as-a-whole-body-save-reads-it
  ;; The update-body differential: an edit that types over the stretch a
  ;; whole-body save's diff finds changed gives the whole-body save's
  ;; tokens, whenever the whole-body save's placed edits lie inside that
  ;; stretch (the edit path keeps them there). Cases whose change is a pure
  ;; insert or delete are not such an edit (those stand where the caret put
  ;; them), and the others are counted. So are the stretches over a word's
  ;; edge letters typed over with text leaving the word with a space or a
  ;; punctuation mark (F1): the edit path reads the letters' part as a change
  ;; of the word and the rest as text typed beside it, where the whole-body
  ;; save drops the word's analysis.
  (let [pure (atom 0) same (atom 0) outside (atom 0) edge (atom 0)
        letter? (fn [c] (let [t (Character/getType (int c))]
                          (or (Character/isLetterOrDigit (int c))
                              (#{Character/NON_SPACING_MARK Character/COMBINING_SPACING_MARK Character/ENCLOSING_MARK} t))))]
    (doseq [[_ opts] (sort edit-configs)
            seed (range 200)
            :let [{:keys [old new tokens]} (gen-case seed opts)
                  o (cps old) n (cps new)
                  p (count (take-while true? (map = o n)))
                  s (min (count (take-while true? (map = (rseq o) (rseq n)))) (- (min (count o) (count n)) p))
                  gap {:start p :end (- (count o) s) :value (apply str (subvec n p (- (count n) s)))}]
            :when (not= old new)]
      (cond
        (or (= (:start gap) (:end gap)) (empty? (:value gap)))
        (swap! pure inc)
        (let [placed (-> (ta/diff old new)
                         (ta/slide-to-tokens old tokens #{:s})
                         (ta/normalize-deletes old tokens)
                         (ta/align-to-words old tokens #{:w :p}))]
          (not-every? (fn [e] (and (<= (:start gap) (or (:start e) (:at e)))
                                   (<= (or (:end e) (:at e)) (:end gap))))
                      (#'ta/ops->edits placed)))
        (swap! outside inc)
        (and (not-every? letter? (.toArray (.codePoints ^String (:value gap))))
             (some (fn [{:token/keys [layer begin end]}]
                     (and (#{:w :p} layer) (< begin end)
                          (<= begin (:start gap)) (<= (:end gap) end)
                          (not= (= begin (:start gap)) (= end (:end gap)))))
                   tokens))
        (swap! edge inc)
        :else
        (let [whole (-> (ta/diff old new)
                        (ta/slide-to-tokens old tokens #{:s})
                        (ta/normalize-deletes old tokens)
                        (ta/align-to-words old tokens #{:w :p})
                        (ta/pair-replacements old tokens)
                        (ta/fold-whole-words old tokens #{:w :p} (:segments opts))
                        (ta/apply-text-edits {:text/body old} tokens)
                        (as-> r (ta/keep-edges-off-spaces old tokens r #{:s})))
              edit (edit-chain old tokens (ta/gap-ops [gap]) opts)
              view (fn [r] [(:text/body (:text r)) (set (map (juxt :token/id :token/begin :token/end) (:tokens r)))])]
          (swap! same inc)
          (is (= (view whole) (view edit)) (str (pr-str old) " -> " (pr-str new))))))
    (is (< 1000 @same) (str @same " typed over, " @pure " pure, " @outside " placed outside, " @edge " at a word's edge"))))
