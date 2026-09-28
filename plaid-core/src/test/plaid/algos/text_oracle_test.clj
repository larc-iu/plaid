(ns plaid.algos.text-oracle-test
  "A seeded property test of a whole-body update, judged by what the user
  meant. Documents are sentences of words, with morphemes at random cuts,
  zero-width markers at word edges, punctuation left in the gaps (igt) or
  made tokens of its own (UD), and UMR-like nodes over one word, several
  words or a whole sentence. Each edit is made to the words (respell one,
  delete a run, delete a run beside a respelled word, insert a new word,
  join two sentences), and the new body goes through the chain
  `update-body` runs (diff, slide, snap, pair, fold, apply).

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
  token, and which of two words of one spelling was deleted.

  Classes still open are skipped by name in `open-classes`, one predicate
  each over the generated case. A fix for one deletes its entry, and the
  test then holds it."
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
                      :shape {:mode mode
                              ;; respelled at the edge beside the deleted words
                              :near? (or (and before? (= mode :prefix)) (and (not before?) (= mode :suffix)))
                              :shared? (boolean (some (into (set (mapcat (comp cps :w) dels)) gone) kept))}
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

(defn- run-case [{:keys [old new tokens] :as c}]
  (let [result (-> (ta/diff old new)
                   (ta/slide-to-tokens old tokens #{:s})
                   (ta/normalize-deletes old tokens)
                   (ta/pair-replacements old tokens)
                   ;; the sentences are a partition, the words and the
                   ;; punctuation tokens forbid overlap, as in the apps
                   (ta/fold-whole-words old tokens #{:s} #{:s :w :p})
                   (ta/apply-text-edits {:text/body old} tokens))]
    (problems c result)))

;; ---------------------------------------------------------------- open classes

(defn- node-edges
  "For each node over several words, [first-id last-id]."
  [{:keys [tokens]}]
  (for [{id :token/id layer :token/layer} tokens :when (and (= layer :u) (= :um (first id)))] [(id 1) (id 2)]))

(defn- ids-between [doc a b]
  (let [ids (->> doc (mapcat identity) (map :id) (drop-while #(not= % a)))]
    (concat (take-while #(not= % b) ids) [b])))

;; The deleted run of a case: the items of sentence `si` that were deleted,
;; and the items either side of it.
(defn- deleted-run [{:keys [doc info]}]
  (when-let [del (:del info)]
    (let [sent (doc (:si info))
          i (first (keep-indexed #(when (del (:id %2)) %1) sent))
          j (inc (last (keep-indexed #(when (del (:id %2)) %1) sent)))]
      {:before (get sent (dec i)) :run (subvec sent i j) :after (get sent j)})))

(defn- item-text [{:keys [pre w post sep]}] (str pre w post sep))

(def ^:private open-classes
  "Classes of case the chain still gets wrong, all older than the fixes of
  2026-09-28 this test was written to hold. Each is a predicate over the
  generated case, so a fix for one deletes its entry."
  {;; A replace reaching into words at both ends: letters the respelled word
   ;; kept are also in a deleted word or among the letters it lost, and the
   ;; diff may take them from there (`cat mat` to `cQt` leaves `c` and `t`,
   ;; `tatu a` to `Xtu` gives the word only `tu`).
   :kept-letters-found-elsewhere
   (fn [{{{:keys [mode near? shared?]} :shape} :info}]
     (and shared? (not near?) (not= mode :whole)))

   ;; The cut runs after the slide, so a delete it makes at the edge of a
   ;; node over several words can leave the node on a space.
   :node-edge-at-a-word-deleted-beside-a-respelled-one
   (fn [{:keys [info] :as c}]
     (and (:shape info)
          (some (fn [[a b]] (or ((:del info) a) ((:del info) b))) (node-edges c))))

   ;; Deleting the words between two nodes, one ending on them and one
   ;; beginning on them: one delete cannot keep both off the space.
   :nodes-on-both-sides-of-deleted-words
   (fn [{:keys [info doc] :as c}]
     (let [del (:del info #{})
           edges (for [[a b] (node-edges c)
                       :let [ids (ids-between doc a b)]
                       :when (some (complement del) ids)]
                   [(del a) (del b)])]
       (and (some (fn [[da _]] da) edges) (some (fn [[_ db]] db) edges))))

   ;; Deleted words at a node's edge between two different separators
   ;; (`ab  sat\tcat` to `ab  cat`): no place for the delete keeps the
   ;; node off the separator left.
   :node-edge-at-deleted-words-between-different-separators
   (fn [{:keys [info] :as c}]
     (let [del (:del info #{})
           {:keys [before run]} (deleted-run c)]
       (and before (not= (:sep before) (:sep (peek run)))
            (some (fn [[a b]] (or (del a) (del b))) (node-edges c)))))

   ;; A delete through a deleted word's zero-width marker counts as a cut
   ;; in the slide, so the delete keeps clear of it and a node at those
   ;; words can be left on the space.
   :marker-on-a-deleted-word-at-a-node-edge
   (fn [{:keys [info tokens] :as c}]
     (let [del (:del info #{})]
       (and (some (fn [t] (and (= :z (:token/layer t)) (del (second (:token/id t))))) tokens)
            (some (fn [[a b]] (or (del a) (del b))) (node-edges c)))))

   ;; Without spaces, the slide counts a word whose neighbouring letter
   ;; changes as disturbed, so a deleted run whose first letter is also the
   ;; letter after it (`café|athekaki|ab`) stays where it cuts `ab`.
   :deleted-run-slides-between-words-without-spaces
   (fn [c]
     (when-let [{:keys [before run after]} (deleted-run c)]
       (let [d (cps (apply str (map item-text run)))
             prev (some-> before item-text cps peek)
             next (some-> after item-text cps first)]
         (and (some #(= "" (:sep %)) (cons before run))
              (or (= (first d) next) (= (peek d) prev))))))})

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
     :joins {:seps [" "] :kinds [:join]}}))

;; ---------------------------------------------------------------- the test

(def ^:private cases-per-config 400)

(deftest a-whole-body-update-leaves-every-token-where-the-user-meant
  (doseq [[k opts] (sort configs)]
    (testing (name k)
      (let [cases (map #(gen-case % opts) (range cases-per-config))
            judged (remove open-class cases)]
        ;; the open classes must not grow to swallow the test
        (is (< (* 0.2 cases-per-config) (count judged))
            (str (count judged) " of " cases-per-config " cases judged"))
        (doseq [c judged
                :let [ps (run-case c)]
                :when (seq ps)]
          (is (empty? ps)
              (str "seed " (:seed c) ": " (pr-str (:old c)) " -> " (pr-str (:new c)) " " (pr-str (:info c)))))))))
