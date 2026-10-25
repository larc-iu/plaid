(ns plaid.algos.plain-edits-oracle-test
  "The plain-edits oracle's main property test: every config's edits, as the ops
  a client sends and as a whole-body save, under the judge, and the whole-body
  judges on their own. The generators and the judge are in
  `plaid.algos.plain-edits-oracle`."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.algos.plain-edits-oracle :refer [cases-per-config configs edit-loss-problems gen-doc gen-gaps keystrokes layout-tokens problems run save save-read server-gaps survivor-problems]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

(deftest a-plain-layer-takes-every-edit-the-plain-way
  (doseq [[cname opts] configs]
    (let [fails (atom [])]
      (dotimes [seed cases-per-config]
        (let [rng (java.util.Random. (+ seed (* 7919 (hash cname))))
              layout (:layout opts :apps)
              {:keys [body tokens]} (gen-doc rng opts)
              gaps (gen-gaps rng body tokens opts)
              tokens (layout-tokens layout tokens)
              new-body (ta/edit-ops-body (ta/gap-ops gaps) body)
              server (server-gaps body tokens (ta/gap-ops gaps) layout)
              readings {:composed (ta/gap-ops gaps)
                        :keys-left-to-right (keystrokes gaps false)
                        :keys-right-to-left (keystrokes gaps true)}]
          (doseq [[rname ops] readings]
            (let [r (run body tokens ops layout false)
                  ps (into (problems body tokens server r)
                           (edit-loss-problems body tokens ops layout r))]
              (when (seq ps) (swap! fails conj {:config cname :seed seed :reading rname :old body :gaps gaps :problems (take 3 ps)}))))
          (let [[bgaps r] (save-read body new-body tokens layout false)
                ps (into (problems body tokens bgaps r) (survivor-problems body new-body tokens layout r))]
            (when (seq ps) (swap! fails conj {:config cname :seed seed :reading :whole-body :old body :gaps bgaps :problems (take 3 ps)})))))
      (when (or (System/getenv "PLAIN_ORACLE_DEBUG") (System/getProperty "plain.oracle.debug"))
        (println cname (count @fails) (frequencies (map :reading @fails)))
        (doseq [f (take 6 @fails)] (println (pr-str f))))
      (testing (str cname)
        (is (empty? @fails) (pr-str (take 3 @fails)))))))

;; The judge of whole-body saves, on its own: a word may go only when some
;; shortest diff takes all its letters.
(deftest the-survivor-judge-reads-its-own-diff
  (let [tokens (fn [^String body] (into [{:token/id :s :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                                        (let [m (re-matcher #"[^ ]+" body)]
                                          (loop [out [] i 0] (if (.find m) (recur (conj out {:token/id i :token/layer :w :token/begin (.start m) :token/end (.end m)}) (inc i)) out)))))
        judged (fn [body new gone] (survivor-problems body new (tokens body) :intent {:deleted gone}))]
    ;; either reading of an ambiguous diff
    (is (empty? (judged "the a ab" "the aX" [1])))
    (is (empty? (judged "the a ab" "the aX" [2])))
    ;; a word every shortest diff keeps
    (is (seq (judged "the a ab" "the aX" [0])))
    (is (seq (judged "the cat sat" "the cat sat" [1])))
    ;; a word all of whose letters go
    (is (empty? (judged "the cat sat" "the sat" [1])))))

;; ---------------------------------------------------------------- whole-body saves by intent

;; The judge above holds a whole-body save to every shortest diff
;; (`survivor-problems`), which leaves out what was meant where the diff can
;; stand in several places (`the a ab` to `the aX`). This one knows what was meant: words of a script's layers,
;; one respelled with neighbours deleted, two respelled, or a run deleted,
;; saved as a whole body, and each word's token must be on the word it was
;; made for, or gone when its word was deleted (REV-one-rule F2, F5).

(defn- intent-save
  "The problems of saving `body` as `new` where old word i was meant to be
  new word `(intent i)` (nil: deleted). Words are the runs between spaces,
  on a word layer under one sentence."
  [^String body ^String new intent]
  (let [spans (fn [^String s] (let [m (re-matcher #"[^ .]+" s)] (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out))))
        old-w (spans body)
        new-w (spans new)
        tokens (into [{:token/id :s :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                     (map-indexed (fn [i [b e]] {:token/id i :token/layer :w :token/begin b :token/end e}) old-w))
        r (save body new tokens :intent false)
        gone (set (:deleted r))
        got (into {} (comp (remove #(gone (:token/id %))) (map (juxt :token/id (juxt :token/begin :token/end)))) (:tokens r))]
    (into (survivor-problems body new tokens :intent r)
          (keep (fn [i]
                  (let [want (some-> (intent i) new-w)
                        g (got i)]
                    (when (not= want g)
                      (str (apply subs body (old-w i)) " is on " (pr-str (some->> g (apply subs new)))
                           ", want " (pr-str (some->> want (apply subs new))))))))
          (range (count old-w)))))

(deftest a-whole-body-save-keeps-each-word-on-the-word-meant
  ;; the reviewer's cases the rules before the plain rule got right and it
  ;; got wrong (REV-one-rule, intent oracle, seed 31), that a reading of the
  ;; diff can get right without deleting a word it keeps letters of
  (doseq [[body new intent] [["ad ctb td a ctc." "ad ctb ta d ctc." [0 1 2 3 4]]
                             ["bac bbd ata ctc." "bac bba Yca ctc." [0 1 2 3]]
                             ["dtb a at da cdc c." "XZa d at da cdc c." [0 1 2 3 4 5]]
                             ;; a respelled word aligned where that deletes fewer words
                             ["ac d cda." "ac X." [0 1 nil]]]]
    (is (empty? (intent-save body new intent)) (str (pr-str body) " -> " (pr-str new) " " (pr-str (intent-save body new intent))))))

(deftest a-whole-body-save-keeps-every-word-the-diff-keeps-letters-of
  ;; The other eight of those cases. What was meant deletes a word that the
  ;; diff keeps letters of: the rules before the plain rule joined what was
  ;; left of two words into one and deleted the other (`tb ctc` to `ttc`), or
  ;; respelled a word from letters the diff took from its neighbours (`tcad
  ;; b abb` to `atbZ`). That also deleted words with letters left where
  ;; nothing like it was meant (REV2-one-rule G1: `reported prior
  ;; discrimination` to `reportedimination` deleted `reported`). A word goes
  ;; only when all its letters go, so each keeps what the diff left of it, as
  ;; the same change sent as edits does. Pinned with what each word reads.
  (doseq [[body new want] [["tcad b abb d bc." "atbZ d bc." ["at" "bZ" nil "d" "bc"]]
                           ["atc cda aaat bdd dtcb t." "atc dda dtcb t." ["atc" "d" nil "da" "dtcb" "t"]]
                           ["dbdt tb bd dtt." "dbdt tZt." ["dbdt" "tZ" nil "t"]]
                           ["dcb dbad cdd cc tbtc adba ad." "dcb dbad cdd tdba ad." ["dcb" "dbad" "cdd" nil "t" "dba" "ad"]]
                           ["ata bcac dbbb tctb d a." "aca tctb d a." ["a" "ca" nil "tctb" "d" "a"]]
                           ["cb b cdb tddb c cbb bcb." "cb b cdb tddb c cXc." ["cb" "b" "cdb" "tddb" "c" "cX" "c"]]
                           ["dd tb ctc c." "dd ttc c." ["dd" "t" "tc" "c"]]
                           ["b d d tdca bcb." "b ddca bcb." ["b" "d" nil "dca" "bcb"]]]]
    (let [spans (let [m (re-matcher #"[^ .]+" body)] (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out)))
          tokens (into [{:token/id :s :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                       (map-indexed (fn [i [b e]] {:token/id i :token/layer :w :token/begin b :token/end e}) spans))
          r (save body new tokens :intent false)
          gone (set (:deleted r))
          by-id (into {} (map (juxt :token/id identity)) (:tokens r))
          got (mapv (fn [i] (when-let [t (and (not (gone i)) (by-id i))] (subs new (:token/begin t) (:token/end t))))
                    (range (count spans)))]
      (is (= new (:text/body (:text r))))
      (is (= want got) (str (pr-str body) " -> " (pr-str new)))
      (is (empty? (survivor-problems body new tokens :intent r)) (str (pr-str body) " -> " (pr-str new))))))

(def ^:private intent-ceiling
  "Cases of `intent-cases` the save reads otherwise than meant, at most. In
  each the text cannot tell: which of two words was deleted and which
  respelled when they share no letter with the new word (`dc d` to `Z`), or
  whether `c d` saved as `cX` respelled `c` or typed `d` over as `X`, and
  a word meant to go that keeps letters the diff leaves it (a word goes only
  when all its letters do, REV2-one-rule, see the test above), or where
  two readings of the diff each delete one word and the meant one is not
  the diff's. 69 of 400 when pinned (2026-10-01). On the reviewer's 200 the rules before the plain
  rule read 78 otherwise, the plain rule before REV-one-rule 37."
  72)

(def ^:private intent-cases 400)

(deftest a-whole-body-save-reads-word-edits-as-meant
  (let [rng (java.util.Random. 31)
        pick #(nth % (.nextInt rng (count %)))
        word (fn [] (apply str (repeatedly (inc (.nextInt rng 4)) #(pick "abcdt"))))
        respell (fn [w] (let [nw (str (apply str (map #(if (< (.nextDouble rng) 0.5) % (pick "abcdtXYZ")) w))
                                      (when (< (.nextDouble rng) 0.3) (pick "XYZ")))]
                          (if (= nw w) (str w "X") nw)))
        fails (atom [])]
    (dotimes [c intent-cases]
      (let [words (vec (repeatedly (+ 3 (.nextInt rng 5)) word))
            n (count words)
            body (str (str/join " " words) ".")
            i (.nextInt rng n)
            new-words (case (pick [:respell+del :respell+del :two-respell :del-run])
                        :respell+del (let [k (inc (.nextInt rng 2))
                                           dels (if (.nextBoolean rng) (range (- i k) i) (range (inc i) (+ i 1 k)))]
                                       (reduce (fn [v j] (if (< -1 j n) (assoc v j nil) v))
                                               (assoc words i (respell (words i))) dels))
                        :two-respell (let [i (if (= i (dec n)) (dec i) i)]
                                       (-> words (update i respell) (update (inc i) respell)))
                        :del-run (reduce #(assoc %1 %2 nil) words (range i (min n (+ i 1 (.nextInt rng 3))))))
            kept (keep-indexed (fn [j w] (when w j)) new-words)]
        (when (seq kept)
          (let [new (str (str/join " " (keep identity new-words)) ".")
                intent (mapv (fn [j] (when (new-words j) (count (filter #(< % j) kept)))) (range n))
                ps (intent-save body new intent)]
            (when (seq ps) (swap! fails conj [body new ps]))))))
    ;; never a word with a letter left deleted, whatever was meant
    (is (empty? (filter (fn [[_ _ ps]] (some #(re-find #"deleted with a letter left" %) ps)) @fails)))
    (when (or (System/getenv "PLAIN_ORACLE_DEBUG") (System/getProperty "plain.oracle.debug"))
      (println "intent fails" (count @fails))
      (doseq [f (take 40 @fails)] (println (pr-str f))))
    (is (<= (count @fails) intent-ceiling) (str (count @fails) " " (pr-str (take 5 @fails))))))
