(ns plaid.algos.sentence-cut-cases-test
  "The shared table `sentence_cut_cases.json`: edits near sentence
  boundaries (REV3-TEXT's twin generators, seeded: sentences with assorted
  boundary shapes, some of only whitespace, words, one to three inserts,
  deletes and replacements, never touching, and after them FX-E-TEXT's 507
  user-shaped saves after REV4-TEXT's generator: Devanagari, Hebrew, Thai,
  Arabic and Latin texts of up to 30 sentences, leading whitespace, pasted
  sentences, a line typed at the start beside other edits, up to 13 gaps)
  with what core makes of each on
  the edits path, the body and the sentence begins and words after the save.
  igt's \"Tokenize new text\" (plaid-igt `newTextWords.js`) and its Python
  twin (plaid-client-py `new_words.py`) read where core puts a sentence
  boundary without asking it, and their tests hold them to this table
  (`sentenceCutCases.test.js`, `test_sentence_cut_cases.py`). This test holds
  core to it, so a change of core's rule fails here first. When the change is
  meant, rewrite the answers with `write-table!` and run the twins' tests."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is]]
            [plaid.algos.text :as ta]))

(def ^:private table-file "src/test/plaid/algos/sentence_cut_cases.json")

(defn core-answer
  "What core makes of case `c` on the edits path, as the twins read it: the
  new body, the sentences' begins after the partition's gap-fill (the first
  at 0, and a line typed before the first sentence is one of its own) and
  the words."
  [{:strs [base sentences words gaps]}]
  (let [tokens (-> []
                   (into (map-indexed (fn [i [b e]] {:token/id [:s i] :token/layer :s :token/begin b :token/end e}) sentences))
                   (into (mapcat (fn [i [b e]] [{:token/id [:w i] :token/layer :w :token/begin b :token/end e}
                                                {:token/id [:m i] :token/layer :m :token/begin b :token/end e}])
                                 (range) words)))
        gs (mapv (fn [{:strs [start end value]}] {:start start :end end :value value}) gaps)
        r (ta/plain-edits base tokens (ta/gap-ops gs) #{:s} #{:w} {:children #{:m}})
        of (fn [l] (sort (keep #(when (= l (:token/layer %)) [(:token/begin %) (:token/end %)]) (:tokens r))))]
    {"body" (:text/body (:text r))
     "sentenceBegins" (let [bs (map first (of :s))]
                        (vec (sort (distinct (if (seq (:heads r))
                                               (concat (map :token/begin (:heads r)) bs)
                                               (cons 0 (rest bs)))))))
     "words" (mapv vec (of :w))}))

(defn write-table!
  "Writes the table from `cases` (each `{base sentences words gaps}`, string
  keys) with core's answers."
  [cases]
  (with-open [w (io/writer table-file)]
    (json/write {"cases" (mapv #(assoc (select-keys % ["base" "sentences" "words" "gaps"]) "core" (core-answer %)) cases)}
                w :escape-unicode false :escape-slash false)))

(deftest core-answers-the-shared-sentence-cut-table
  (let [cases (-> (io/resource "plaid/algos/sentence_cut_cases.json") slurp json/read-str (get "cases"))]
    (is (<= 1000 (count cases)))
    (doseq [c cases]
      (is (= (get c "core") (core-answer c)) (pr-str (select-keys c ["base" "gaps"]))))))
