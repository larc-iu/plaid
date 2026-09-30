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
                    (let [w (pick vocab)
                          k (count (cps w))]
                      {:id (swap! id inc)
                       :pre (if (< (.nextDouble rng) 0.1) (pick (:pres opts [""])) "")
                       :w w
                       :cuts (when (and (> k 1) (< (.nextDouble rng) 0.4))
                               (vec (sort (distinct (repeatedly (inc (.nextInt rng 2))
                                                                #(inc (.nextInt rng (dec k))))))))
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
              [(assoc-in doc [si i :w] w') {:resp #{(:id (sent i))}}])
      :del (if (< n 2)
             (edit doc rng [:resp])
             (let [k (inc (.nextInt rng (min 3 (dec n))))
                   i (.nextInt rng (- n k -1))]
               [(delete-items doc si i (+ i k)) {:del (set (map :id (subvec sent i (+ i k)))) :si si}]))
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
              {:ins true}])
      ;; a respelling with a space typed in front of the word
      :resp+space (let [i (.nextInt rng n)
                        [_ w'] (respell rng (:w (sent i)))
                        id (:id (sent i))
                        doc (assoc-in doc [si i :w] w')]
                    (cond
                      (pos? i) [(update-in doc [si (dec i) :sep] str " ") {:resp #{id} :typed-front {id 1}}]
                      (zero? si)
                      [(update-in doc [0 0 :pre] #(str " " %)) {:resp #{id} :typed-front {id 1}}]
                      :else [doc {:resp #{id}}]))
      ;; a respelling with a new word typed after it
      :resp+ins (let [i (.nextInt rng n)
                      [_ w'] (respell rng (:w (sent i)))
                      item {:id (+ 1000 (.nextInt rng 1000)) :pre "" :w (fresh-word rng (inc (.nextInt rng 3)))
                            :post "" :new true :sep (:sep (sent i))}]
                  [(assoc doc si (-> (subvec (assoc-in sent [i :w] w') 0 (inc i))
                                     (assoc-in [i :sep] " ")
                                     (conj item)
                                     (into (subvec sent (inc i)))))
                   {:resp #{(:id (sent i))} :ins true}])
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
                            w (str (apply str (take (inc (.nextInt rng (dec (count ca)))) ca))
                                   (apply str (take-last (inc (.nextInt rng (dec (count cb)))) cb)))
                            joined (assoc a :w w :post (:post b) :sep (:sep b) :cuts nil)]
                        [(assoc doc si (-> (subvec sent 0 i) (conj joined) (into (subvec sent (+ i 2)))))
                         {:resp #{(:id a)} :del #{(:id b)} :si si :amb #{} :group [(:id a) (:id b)]}])))
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
                                w (if left-whole?
                                    (str (:w a) (apply str (take-last (inc (.nextInt rng (dec (count cb)))) cb)))
                                    (str (apply str (take (inc (.nextInt rng (dec (count ca)))) ca)) (:w b)))
                                joined (assoc a :w w :post (:post b) :sep (:sep b) :cuts nil)]
                            [(assoc doc si (-> (subvec sent 0 i) (conj joined) (into (subvec sent (+ i 2)))))
                             {:resp #{(:id a)} :del #{(:id b)} :si si :amb #{} :group [(:id a) (:id b)]}])))
      ;; Only the space between two words deleted: two words written
      ;; together, each keeping its token (D22).
      :join-space (let [i (when (> n 1) (.nextInt rng (dec n)))
                        a (some-> i sent)
                        b (some-> i inc sent)]
                    (if (or (nil? i) (not= " " (:sep a)))
                      (edit doc rng [:resp])
                      [(assoc-in doc [si i :sep] "") {}]))
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
                            w (str (apply str (take (inc (.nextInt rng (dec (count ca)))) ca))
                                   (apply str (subvec cb p q))
                                   (apply str (take-last (inc (.nextInt rng (dec (count cc)))) cc)))
                            joined (assoc a :w w :post (:post c) :sep (:sep c) :cuts nil)]
                        ;; a whole word inside the new one reads as that word kept,
                        ;; the others cut to its sides (`tat tat sat` to `ttat`)
                        (if (some #(.contains ^String w ^String (:w %)) [a b c])
                          (edit doc rng [:resp])
                          [(assoc doc si (-> (subvec sent 0 i) (conj joined) (into (subvec sent (+ i 3)))))
                           {:resp #{(:id a)} :del #{(:id b) (:id c)} :si si :amb #{}
                            :group [(:id a) (:id b) (:id c)]}]))))
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
      (:space-at-cut :split-word :split-in-morpheme)
      (let [inner (fn [{:keys [w cuts]}] (remove (set cuts) (range 1 (count (cps w)))))
            cands (filter #(case kind
                             :space-at-cut (:cuts (sent %))
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
                    :split-word (inc (.nextInt rng (dec (count c))))
                    (let [ks (vec (inner it))] (ks (.nextInt rng (count ks)))))
                respelled? (and (not= kind :space-at-cut) (.nextBoolean rng))
                left (apply str (subvec c 0 k))
                right (str (if respelled? (fresh-word rng 1) (c k))
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
             {:resp #{id} :si si :fold fold
                            ;; or the right half is the word, and the left half
                            ;; is typed in front of it
              :alts [[(split (+ 2000 id) id)
                      {:resp #{id} :si si :fold fold :typed-front {id (inc (count (cps left)))}}]]}])))
      :join (if (< si (dec (count doc)))
              [(-> doc
                   (assoc-in [si (dec n) :sep] " ")
                   (as-> d (into (conj (subvec d 0 si) (into (d si) (d (inc si)))) (subvec d (+ si 2)))))
               {:join si}]
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

(defn- run-case [{:keys [old new tokens info] :as c}]
  (let [result (-> (ta/diff old new)
                   (ta/slide-to-tokens old tokens #{:s})
                   (ta/normalize-deletes old tokens)
                   (ta/align-to-words old tokens #{:w :p})
                   (ta/pair-replacements old tokens)
                   ;; the words and the punctuation tokens are the word
                   ;; layers (overlap forbidden, no partition, a parent)
                   (ta/fold-whole-words old tokens #{:w :p})
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
     :split-in-morpheme-nodes {:seps [" "] :marks 0.4 :nodes 4 :kinds [:split-in-morpheme]}}))

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
