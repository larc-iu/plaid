(ns plaid.algos.plain-edits-paste-oracle-test
  "The plain-edits oracle on pastes over several words. The generators and the
  judge are in `plaid.algos.plain-edits-oracle`."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.algos.plain-edits-oracle :refer [cps gen-doc layout-tokens letters-left-problems nbsp problems run server-gaps]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

;; ---------------------------------------------------------------- pastes over several words

;; A paste over several words (the whole body, a line or a stretch of
;; whole words, pasted back with a word more, a word less or a word typed
;; over) is one gap that deletes and types. It is read as a delete and an
;; insert at the same place by the plain rule, as every other edit is
;; (R42): each word it covers whole goes, each word it cuts keeps the
;; letters left, and nothing reads the stretch for words typed again. The
;; judge holds every reading to that rule against the gaps the server
;; takes (`problems`), and no word or sentence goes with a letter left
;; outside the change.

(defn- one-word-change
  "`[start end value]`: one word typed in before or after `w`, `w` deleted
  with the whitespace on one side of it, or `w` typed over, or nil when `w`
  is its sentence's only word and the change would delete it. `words` are
  the words typed (some may be words the text has), `sep` what stands
  between words."
  [^java.util.Random rng ^ints o w sole? words sep]
  (let [{:token/keys [begin end]} w
        n (alength o)
        blank? (fn [c] (or (= c (int \space)) (= c (int \tab))))
        run-after (loop [x end] (if (and (< x n) (blank? (aget o x))) (recur (inc x)) x))
        run-before (loop [x begin] (if (and (pos? x) (blank? (aget o (dec x)))) (recur (dec x)) x))
        word (nth words (.nextInt rng (count words)))]
    (case (.nextInt rng 4)
      0 [begin begin (str word sep)]
      1 [end end (str sep word)]
      2 (when-not sole?
          (cond (< end run-after) [begin run-after ""]
                (< run-before begin) [run-before end ""]
                (= sep "") [begin end ""]
                :else nil))
      3 [begin end word])))

(def ^:private paste-configs
  {:apps {:spaced 0.3 :sentences 4 :words 8}
   :apps-nodes-and-children {:spaced 0.2 :nodes true :child 0.5 :points 0.2 :sentences 4 :words 8}
   :long {:spaced 0.2 :sentences 10 :words 14 :sentence-segments true}
   :script {:spaced 0.3 :sentences 4 :words 8 :layout :script}
   :rooted {:spaced 0.2 :sub 1.0 :one-morph true :sentences 4 :words 8 :layout :rooted}
   :script-no-sentences {:spaced 0.3 :words 12 :layout :script-no-sentences}
   :other-spaces {:spaced 0.2 :sentences 4 :words 8 :seps [" " nbsp "\t" "   "] :sentence-seps ["\n" ". " "\n\n"]}
   ;; a small vocabulary that repeats, the words typed among it
   :repeating {:spaced 0 :sentences 3 :words 6 :vocab ["xa" "ba" "cat" "the" "a"] :typed-words ["xa" "the" "a" "teh"]
               :sentence-seps ["\n"] :changes 3}
   :repeating-phrases {:spaced 0.3 :sentences 3 :words 6 :vocab ["a" "b" "talu" "lei"] :typed-words ["a" "b" "lei"] :changes 2}
   ;; a script without spaces: one word a character
   :spaceless {:spaced 0 :glue 1.0 :sentences 3 :words 6 :vocab ["你" "好" "吗" "我" "很" "。"] :typed-words ["嗎" "好" "！"]
               :sep "" :sentence-seps ["" "\n"] :changes 2}})

(deftest a-paste-over-several-words-takes-the-plain-rule
  (doseq [[cname opts] paste-configs
          k (range 1 (inc (:changes opts 3)))]
    (let [fails (atom [])]
      (dotimes [seed 250]
        (let [rng (java.util.Random. (+ seed (* 31 k) (* 104729 (hash cname))))
              layout (:layout opts :apps)
              {:keys [body tokens]} (gen-doc rng opts)
              tokens (layout-tokens layout tokens)
              o (cps body)
              n (alength o)
              words (vec (sort-by :token/begin (filter #(= :w (:token/layer %)) tokens)))
              sents (filter #(= :s (:token/layer %)) tokens)
              sole? (fn [w] (let [sent (some #(when (and (<= (:token/begin %) (:token/begin w)) (<= (:token/end w) (:token/end %))) %) sents)]
                              (or (= 1 (count words))
                                  (and sent (= 1 (count (filter #(and (<= (:token/begin sent) (:token/begin %)) (<= (:token/end %) (:token/end sent))) words)))))))
              ;; k changes, each at its own word, apart from each other
              changes (->> (repeatedly (* 3 k) #(let [w (words (.nextInt rng (count words)))]
                                                  (one-word-change rng o w (sole? w) (:typed-words opts ["XZ" "Ж𐍂" "qoke"]) (:sep opts " "))))
                           (remove nil?)
                           (sort-by first)
                           (reduce (fn [out [a :as c]] (if (and (seq out) (<= a (inc (second (peek out))))) out (conj out c))) [])
                           (take k)
                           vec)]
          (when (seq changes)
            (let [gaps (mapv (fn [[a b v]] {:start a :end b :value v}) changes)
                  new (ta/edit-ops-body (ta/gap-ops gaps) body)
                  d (- (cp/cp-count new) n)
                  [a b] [(first (first changes)) (second (peek changes))]
                  ;; a stretch from the start of a word before the changes to
                  ;; the end of one after them, pasted over with its new text
                  over (fn [x y] (let [x (min x a) y (max y b)]
                                   [{:type :replace :index x :length (- y x) :value (cp/cp-subs new x (+ y d))}]))
                  lo (or (last (filter #(<= (:token/begin %) a) (take (- (count words) (.nextInt rng 3)) words))) (first words))
                  hi (or (first (filter #(>= (:token/end %) b) (drop (.nextInt rng 3) words))) (peek words))
                  sent (some #(when (and (<= (:token/begin %) a) (<= b (:token/end %))) %) sents)
                  readings (cond-> {:whole-body-replace [{:type :replace :index 0 :length n :value new}]
                                    :stretch (over (:token/begin lo) (:token/end hi))}
                             sent (assoc :line (over (:token/begin sent) (:token/end sent))))]
              (doseq [[rname ops] readings]
                (let [r (run body tokens ops layout false)
                      ps (-> (problems body tokens (server-gaps body ops) r)
                             (into (letters-left-problems body tokens ops r)))]
                  (when (seq ps)
                    (swap! fails conj {:config cname :changes changes :seed seed :reading rname :old body :problems (take 3 ps)}))))))))
      (when (or (System/getenv "PLAIN_ORACLE_DEBUG") (System/getProperty "plain.oracle.debug"))
        (println cname k (count @fails) (frequencies (map :reading @fails)))
        (doseq [f (take 4 @fails)] (println (pr-str f))))
      (testing (str cname " " k " changes")
        (is (empty? @fails) (pr-str (take 3 @fails)))))))
