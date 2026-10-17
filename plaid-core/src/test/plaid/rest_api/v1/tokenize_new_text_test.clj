(ns plaid.rest-api.v1.tokenize-new-text-test
  "\"Tokenize new text\": a text save naming a word layer (`tokenize-layer`)
  gets words for the text it types, made by core after it places the old
  tokens, on the create, the edits and the body forms."
  (:require [clojure.test :refer :all]
            [plaid.algos.text :as ta]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-ok assert-created assert-bad-request
                                    with-admin with-test-users with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- setup
  "A text over `body` with one sentence per entry of `sents` (else one), a
  word over each run without spaces, and `ignored` as the words' rule."
  [body & {:keys [sents ignored]}]
  (let [proj (create-test-project admin-request "TokProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        sentences (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}) :body :id)
        words (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"
                                                                     :parent-token-layer-id sentences})
                  :body :id)
        _ (when ignored
            (assert-status 204 (api-call admin-request {:method :put
                                                        :path (str "/api/v1/token-layers/" words "/config/igt/ignoredTokens")
                                                        :body ignored})))
        text-id (-> (create-text admin-request tl doc body) :body :id)
        _ (when (seq body)
            (assert-created (bulk-create-tokens admin-request (mapv (fn [[b e]] {:token-layer-id sentences :text text-id
                                                                                 :begin b :end e})
                                                                    (or sents [[0 (count body)]])))))
        m (re-matcher #"\S+" body)
        runs (loop [out []] (if (.find m) (recur (conj out [(.start m) (.end m)])) out))]
    (doseq [[b e] runs] (create-token admin-request words text-id b e))
    {:proj proj :doc doc :text text-id :tl tl :words words :sentences sentences}))

(defn- words-of [layer]
  (->> (psc/q db {:select [:begin :end_] :from [:tokens] :where [:= :token_layer_id layer]})
       (map (juxt :begin :end_))
       sort
       vec))

(defn- patch [text-id body]
  (api-call admin-request {:method :patch :path (str "/api/v1/texts/" text-id) :body body}))

(defn- ins [i v] {:type "insert" :index i :value v})

(deftest an-edit-naming-the-word-layer-gets-words-for-what-it-types
  (let [{:keys [text words]} (setup "hh cat")
        res (patch text {:edits [(ins 6 " big (dog).")] :tokenize-layer words})]
    (assert-ok res)
    (is (= [[0 2] [3 6] [7 10] [12 15]] (words-of words)))
    (testing "the new words come in the reshape with their layer and text"
      (is (= #{[7 10] [12 15]}
             (set (keep #(when (= (str words) (str (:layer %))) [(:begin %) (:end %)]) (-> res :body :reshape :tokens)))))
      (is (every? #(= (str text) (str (:text %))) (filter :layer (-> res :body :reshape :tokens)))))))

(deftest text-typed-against-a-word-is-the-words-and-gets-none
  (let [{:keys [text words]} (setup "hh cat")]
    (assert-ok (patch text {:edits [(ins 6 "s")] :tokenize-layer words}))
    (is (= [[0 2] [3 7]] (words-of words)))))

(deftest without-the-layer-no-word-is-made
  (let [{:keys [text words]} (setup "hh cat")]
    (assert-ok (patch text {:edits [(ins 6 " dog")]}))
    (is (= [[0 2] [3 6]] (words-of words)))))

(deftest ignored-and-spaceless-text-gets-no-word
  (let [{:keys [text words]} (setup "hh" :ignored {"type" "unicodePunctuation" "whitelist" ["'"]})]
    (assert-ok (patch text {:edits [(ins 2 " ... ★ 我很好 don't")] :tokenize-layer words}))
    ;; `★` is a pictograph, a word to igt; `don't` holds a letter-like `'`
    (is (= [[0 2] [7 8] [13 18]] (words-of words)))))

(deftest a-new-word-never-crosses-a-sentence
  (is (= [{:token/layer :w :token/begin 0 :token/end 3} {:token/layer :w :token/begin 3 :token/end 6}]
         (ta/new-words "abcdef" [[0 6]] [{:token/layer :s :token/begin 0 :token/end 3}
                                         {:token/layer :s :token/begin 3 :token/end 6}]
                       :w #{:s} nil)))
  (testing "and only text the save typed is cut, an old run beside it with it"
    (is (= [{:token/layer :w :token/begin 3 :token/end 5}]
           (ta/new-words "ab cd ef" [[4 5]] [] :w #{} nil)))))

(deftest the-other-forms-of-a-save-take-it-too
  (testing "a whole new body"
    (let [{:keys [text words]} (setup "hh cat")]
      (assert-ok (patch text {:body "hh cat dog" :tokenize-layer words}))
      (is (= [[0 2] [3 6] [7 10]] (words-of words)))))
  (testing "ops as the body"
    (let [{:keys [text words]} (setup "hh cat")]
      (assert-ok (patch text {:body [(ins 0 "big ")] :tokenize-layer words}))
      (is (= [[0 3] [4 6] [7 10]] (words-of words))))))

(deftest a-layer-of-another-text-layer-or-no-id-is-refused
  (let [{:keys [text words]} (setup "hh")
        other (setup "x")]
    (assert-bad-request (patch text {:edits [(ins 2 " a")] :tokenize-layer (:words other)}))
    (assert-bad-request (patch text {:edits [(ins 2 " a")] :tokenize-layer 7}))
    (is (= [[0 2]] (words-of words)))))

(deftest a-text-created-naming-the-word-layer-gets-its-words
  (let [{:keys [proj tl words]} (setup "")
        doc2 (create-test-document admin-request proj "Doc2")]
    (assert-created (api-call admin-request {:method :post :path "/api/v1/texts"
                                             :body {:text-layer-id tl :document-id doc2
                                                    :body "one two.\nthree" :tokenize-layer words}}))
    (is (= [[0 3] [4 7] [9 14]] (words-of words)))))
