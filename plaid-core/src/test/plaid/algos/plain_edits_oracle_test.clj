(ns plaid.algos.plain-edits-oracle-test
  "The plain-edits oracle's main property test: every config's edits, as the ops
  a client sends and as a whole-body save, under the judge, and the whole-body
  judges on their own. The generators and the judge are in
  `plaid.algos.plain-edits-oracle`."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.algos.plain-edits-oracle :refer [cases-per-config configs gen-doc gen-gaps keystrokes layout-tokens letters-left-problems problems run save save-read server-gaps survivor-problems]]
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
              server (server-gaps body (ta/gap-ops gaps))
              readings {:composed (ta/gap-ops gaps)
                        :keys-left-to-right (keystrokes gaps false)
                        :keys-right-to-left (keystrokes gaps true)}]
          (doseq [[rname ops] readings]
            (let [r (run body tokens ops layout false)
                  ps (into (problems body tokens server r)
                           (letters-left-problems body tokens ops r))]
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

;; The judge's own rules, on results made by hand: it passes what the
;; written rule gives and reports what breaks it (R42).
(deftest the-judge-holds-the-written-rule
  (let [t (fn [id layer b e] {:token/id id :token/layer layer :token/begin b :token/end e})
        old "the cat sat"
        tokens [(t [:s 0] :s 0 11) (t [:w 1] :w 0 3) (t [:w 2] :w 4 7) (t [:w 3] :w 8 11) (t [:a 0] :a 4 7)]
        result (fn [body gaps-of gone]
                 {:text {:text/body body}
                  :tokens (vec (for [tk tokens :when (not (gone (:token/id tk)))] (merge tk (gaps-of (:token/id tk)))))
                  :deleted (vec gone)})
        said? (fn [re ps] (some #(re-find re %) ps))
        typed-over [{:start 4 :end 7 :value "dog"}]]
    (testing "a word typed over whole goes, and a row typed over whole stays"
      (is (empty? (problems old tokens typed-over (result "the dog sat" {} #{[:w 2]}))))
      (is (said? #"\[:w 2\] kept with none of its text" (problems old tokens typed-over (result "the dog sat" {} #{})))))
    (testing "a row typed over whole may not go"
      (is (said? #"\[:a 0\] deleted though it has text" (problems old tokens typed-over (result "the dog sat" {} #{[:w 2] [:a 0]})))))
    (testing "a word with a letter left stays"
      (let [gaps [{:start 5 :end 7 :value "ow"}]]
        (is (empty? (problems old tokens gaps (result "the cow sat" {} #{}))))
        (is (said? #"\[:w 2\] deleted though it has text" (problems old tokens gaps (result "the cow sat" {} #{[:w 2]}))))))
    (testing "text typed at a word's edge with whitespace between stays out of it"
      (let [gaps [{:start 7 :end 7 :value " x"}]]
        (is (empty? (problems old tokens gaps (result "the cat x sat" {[:s 0] {:token/end 13} [:w 3] {:token/begin 10 :token/end 13}} #{}))))
        (is (said? #"\[:w 2\] took a new letter apart from it"
                   (problems old tokens gaps (result "the cat x sat" {[:s 0] {:token/end 13} [:w 2] {:token/end 9} [:a 0] {:token/end 9}
                                                                      [:w 3] {:token/begin 10 :token/end 13}} #{}))))))))

;; ---------------------------------------------------------------- whole-body saves of word edits

;; Words of a script's layers under one sentence, one respelled with
;; neighbours deleted, two respelled, or a run deleted, saved as a whole
;; body. The save is the character diff, read by the plain rule (R42), so
;; it is judged by that rule against the diff's gaps (`problems`), and no
;; word goes that every shortest diff keeps a letter of
;; (`survivor-problems`). Which word a respelling was meant for is not the
;; save's to guess.

(defn- word-edit-save
  "The problems of saving `body` as `new`. Words are the runs between
  spaces and periods, on a word layer under one sentence."
  [^String body ^String new]
  (let [spans (fn [^String s] (let [m (re-matcher #"[^ .]+" s)] (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out))))
        tokens (into [{:token/id [:s 0] :token/layer :s :token/begin 0 :token/end (cp/cp-count body)}]
                     (map-indexed (fn [i [b e]] {:token/id [:w i] :token/layer :w :token/begin b :token/end e}) (spans body)))
        [gaps r] (save-read body new tokens :intent false)]
    (into (problems body tokens gaps r) (survivor-problems body new tokens :intent r))))

(deftest a-whole-body-save-of-word-edits-takes-the-plain-rule
  (let [rng (java.util.Random. 31)
        pick #(nth % (.nextInt rng (count %)))
        word (fn [] (apply str (repeatedly (inc (.nextInt rng 4)) #(pick "abcdt"))))
        respell (fn [w] (let [nw (str (apply str (map #(if (< (.nextDouble rng) 0.5) % (pick "abcdtXYZ")) w))
                                      (when (< (.nextDouble rng) 0.3) (pick "XYZ")))]
                          (if (= nw w) (str w "X") nw)))
        fails (atom [])]
    (dotimes [_ 400]
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
                        :del-run (reduce #(assoc %1 %2 nil) words (range i (min n (+ i 1 (.nextInt rng 3))))))]
        (when (some some? new-words)
          (let [new (str (str/join " " (keep identity new-words)) ".")
                ps (word-edit-save body new)]
            (when (seq ps) (swap! fails conj [body new ps]))))))
    (is (empty? @fails) (pr-str (take 5 @fails)))))
