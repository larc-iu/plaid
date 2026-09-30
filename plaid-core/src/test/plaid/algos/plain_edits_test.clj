(ns plaid.algos.plain-edits-test
  "A layer that declares `plainEdits` takes a text edit the plain way (Luke,
  2026-09-30: \"if something lands within a word boundary grow the word,
  period\"). Examples here, the property in `plain-edits-oracle-test`."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.algos.text :as ta]
            [plaid.util.codepoint :as cp]))

(defn- ins [i v] {:type :insert :index i :value v})
(defn- del [i n] {:type :delete :index i :value n})
(defn- rep [i n v] {:type :replace :index i :length n :value v})

(defn- doc
  "Tokens for `s` with words split at `|` (so a word may hold a space) and
  sentences at `/`: a word token `[:w i]` and a morpheme `[:m i]` over the
  whole word, and one sentence token per sentence."
  [s]
  (let [body (.replace (.replace ^String s "|" "") "/" "")
        ;; walk the marked string
        [words sents] (loop [i 0 at 0 wb nil ws [] sb 0 ss []]
                        (if (>= i (count s))
                          [ws (conj ss [sb at])]
                          (let [c (.charAt ^String s i)]
                            (case c
                              \| (if wb
                                   (recur (inc i) at nil (conj ws [wb at]) sb ss)
                                   (recur (inc i) at at ws sb ss))
                              \/ (recur (inc i) at wb ws at (conj ss [sb at]))
                              (recur (inc i) (inc at) wb ws sb ss)))))]
    {:body body
     :tokens (-> []
                 (into (map-indexed (fn [i [b e]] {:token/id [:s i] :token/layer :s :token/begin b :token/end e}) sents))
                 (into (mapcat (fn [i [b e]]
                                 [{:token/id [:w i] :token/layer :w :token/begin b :token/end e}
                                  {:token/id [:m i] :token/layer :m :token/begin b :token/end e}])
                               (range) words)))}))

(defn- view
  "The body and each word's text by index, `nil` for a deleted word, after
  `r`, checking that every morpheme stayed on its word."
  [{:keys [text tokens deleted]} n]
  (let [body (:text/body text)
        by-id (into {} (map (juxt :token/id identity)) tokens)
        gone (set deleted)]
    (doseq [i (range n)]
      (is (= (contains? gone [:w i]) (contains? gone [:m i])) (str "word and morpheme " i " go together"))
      (when-let [w (by-id [:w i])]
        (is (= [(:token/begin w) (:token/end w)] ((juxt :token/begin :token/end) (by-id [:m i])))
            (str "morpheme " i " spans its word"))))
    (into [body] (map (fn [i] (when-let [{:token/keys [begin end]} (by-id [:w i])]
                                (cp/cp-subs body begin end)))
                      (range n)))))

(defn- edit [s ops]
  (let [{:keys [body tokens]} (doc s)]
    (view (ta/plain-edits body tokens ops #{:s}) (count (filter #(= :w (:token/layer %)) tokens)))))

(defn- save [s new]
  (let [{:keys [body tokens]} (doc s)]
    (view (ta/plain-body body new tokens #{:s}) (count (filter #(= :w (:token/layer %)) tokens)))))

(deftest an-edit-inside-a-word-or-at-its-edge-grows-it
  (testing "inside"
    (is (= ["the caat" "the" "caat"] (edit "|the| |cat|" [(ins 6 "a")])))
    (is (= ["the ct" "the" "ct"] (edit "|the| |cat|" [(del 5 1)])))
    (is (= ["the cQt" "the" "cQt"] (edit "|the| |cat|" [(rep 5 1 "Q")]))))
  (testing "letters typed at a word's end or start"
    (is (= ["the cats" "the" "cats"] (edit "|the| |cat|" [(ins 7 "s")])))
    (is (= ["the scat" "the" "scat"] (edit "|the| |cat|" [(ins 4 "s")])))
    (is (= ["the cat," "the" "cat,"] (edit "|the| |cat|" [(ins 7 ",")]))))
  (testing "a word replaced whole keeps its token"
    (is (= ["the dog" "the" "dog"] (edit "|the| |cat|" [(rep 4 3 "dog")])))
    (is (= ["the dog" "the" "dog"] (edit "|the| |cat|" [(del 4 3) (ins 4 "dog")])))))

(deftest a-typed-space-never-splits-a-word
  (is (= ["the c at" "the" "c at"] (edit "|the| |cat|" [(ins 5 " ")])))
  (is (= ["the c xy at" "the" "c xy at"] (edit "|the| |cat|" [(ins 5 " xy ")])))
  (testing "a word holding a space"
    (is (= ["talu lei x" "talu lei" "x"] (edit "|talu lei| |x|" [])))
    (is (= ["t alu lei x" "t alu lei" "x"] (edit "|talu lei| |x|" [(ins 1 " ")])))
    (is (= ["talulei x" "talulei" "x"] (edit "|talu lei| |x|" [(del 4 1)])))
    (is (= ["talu new lei x" "talu new lei" "x"] (edit "|talu lei| |x|" [(ins 4 " new")])))))

(deftest a-deleted-space-never-joins-two-words
  (is (= ["thecat" "the" "cat"] (edit "|the| |cat|" [(del 3 1)])))
  (testing "text typed where they meet goes to the first"
    (is (= ["thexcat" "thex" "cat"] (edit "|the| |cat|" [(del 3 1) (ins 3 "x")])))
    (is (= ["thex ycat" "thex" "ycat"] (edit "|the| |cat|" [(rep 3 1 "x y")])))))

(deftest new-text-apart-from-every-word-is-in-none
  (is (= ["the big cat" "the" "cat"] (edit "|the| |cat|" [(ins 4 "big ")])))
  (is (= ["the cat big" "the" "cat"] (edit "|the| |cat|" [(ins 7 " big")])))
  (testing "the letters touching a word go to it, the rest to none"
    (is (= ["the catx big" "the" "catx"] (edit "|the| |cat|" [(ins 7 "x big")])))
    (is (= ["the big xcat" "the" "xcat"] (edit "|the| |cat|" [(ins 4 "big x")])))))

(deftest only-a-word-whose-text-is-all-deleted-goes
  (is (= ["the " "the" nil] (edit "|the| |cat|" [(del 4 3)])))
  (is (= ["cat" nil "cat"] (edit "|the| |cat|" [(del 0 4)])))
  (testing "a stretch over two words leaves both with the letters they keep"
    (is (= ["tht" "th" "t"] (edit "|the| |cat|" [(del 2 4)])))
    (is (= ["thQt" "thQ" "t"] (edit "|the| |cat|" [(rep 2 4 "Q")]))))
  (testing "a word inside a stretch typed over goes"
    (is (= ["a birdog" "a" nil "birdog"] (edit "|a| |cat| |dog|" [(rep 2 5 "bird")]))))
  (testing "a word replaced by whitespace goes"
    (is (= ["the   dog" "the" nil "dog"] (edit "|the| |cat| |dog|" [(rep 4 3 " ")])))))

(deftest whitespace-typed-at-a-word-edge-stays-outside
  (is (= ["the  cat" "the" "cat"] (edit "|the| |cat|" [(rep 4 1 " c")])))
  (is (= ["the ca " "the" "ca"] (edit "|the| |cat|" [(rep 6 1 " ")]))))

(deftest partitions-follow-the-words
  (let [{:keys [body tokens]} (doc "|Hi.| /|Bye.|")
        r (ta/plain-edits body tokens [(ins 4 "x")] #{:s})
        at (fn [id] (let [t (some #(when (= id (:token/id %)) %) (:tokens r))] [(:token/begin t) (:token/end t)]))]
    (is (= "Hi. xBye." (:text/body (:text r))))
    (is (= [4 9] (at [:w 1]) (at [:s 1])))
    (is (= [0 4] (at [:s 0])))))

(deftest a-whole-body-save-takes-the-same-rules
  (is (= ["the cats" "the" "cats"] (save "|the| |cat|" "the cats")))
  (is (= ["the c at" "the" "c at"] (save "|the| |cat|" "the c at")))
  (is (= ["thecat" "the" "cat"] (save "|the| |cat|" "thecat")))
  (is (= ["the dog" "the" "dog"] (save "|the| |cat|" "the dog")))
  (is (= ["the cow" "the" nil "cow"] (save "|the| |cat| |cow|" "the cow")))
  (is (= ["the bat sat in" "the" "bat" "sat" "in"] (save "|the| |cat| |sat| |on|" "the bat sat in")))
  (is (= ["talu new lei x" "talu new lei" "x"] (save "|talu lei| |x|" "talu new lei x"))))
