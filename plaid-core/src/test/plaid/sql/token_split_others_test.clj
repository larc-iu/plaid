(ns plaid.sql.token-split-others-test
  "A split reaches the layers below the split token and no other. A token of
  a layer beside it with the same extent is left as it is: igt's time
  alignment segment over a one-word utterance or a document's last sentence
  must keep its extent when Tokenize splits the word or the sentence
  (REV-FX-CORE F1, which reverted a generic follow). UMR keeps its node
  anchors to their words itself, on open."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-clean-db admin-request assert-created]]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- extent [tok]
  (let [b (:body (h/get-token admin-request tok))]
    [(:token/begin b) (:token/end b)]))

(defn- build!
  "Text `ikian, amu` with sentences over all of it, words under the
  sentences, morphemes under the words, a root layer of nodes with a node
  over `ikian,` carrying a concept span and a node over `amu`, and a root
  partitioning layer of rows, its first row over `ikian,`."
  []
  (let [proj (h/create-test-project admin-request "Split others")
        doc (h/create-test-document admin-request proj "D")
        tl (id (h/create-text-layer admin-request proj "T"))
        sl (id (h/create-token-layer-opts admin-request tl "Sentence" {:overlap-mode "partitioning"}))
        wl (id (h/create-token-layer-opts admin-request tl "Word" {:overlap-mode "non-overlapping"
                                                                   :parent-token-layer-id sl}))
        ml (id (h/create-token-layer-opts admin-request tl "Morpheme" {:parent-token-layer-id wl}))
        nl (id (h/create-token-layer-opts admin-request tl "Node" {:overlap-mode "non-overlapping"}))
        nml (id (h/create-token-layer-opts admin-request tl "Node part" {:parent-token-layer-id nl}))
        rl (id (h/create-token-layer-opts admin-request tl "Row" {:overlap-mode "partitioning"}))
        concept (id (h/create-span-layer admin-request nl "Concept"))
        text (id (h/create-text admin-request tl doc "ikian, amu"))
        tok (fn [layer b e] (let [r (h/create-token admin-request layer text b e)] (assert-created r) (id r)))
        sentence (-> (h/bulk-create-tokens admin-request [{:token-layer-id sl :text text :begin 0 :end 10}])
                     :body :ids first)
        word (tok wl 0 6)
        word2 (tok wl 7 10)
        morph (tok ml 0 6)
        node (tok nl 0 6)
        node-part (tok nml 4 6)
        node2 (tok nl 7 10)
        [row row2] (-> (h/bulk-create-tokens admin-request
                                             [{:token-layer-id rl :text text :begin 0 :end 6}
                                              {:token-layer-id rl :text text :begin 6 :end 10}])
                       :body :ids)
        span (id (h/create-span admin-request concept [node] "ikian"))]
    {:sentence sentence :word word :word2 word2 :morph morph :node node :node-part node-part
     :node2 node2 :row row :row2 row2 :span span :concept concept}))

(deftest a-split-leaves-the-tokens-of-other-layers-alone
  (let [{:keys [sentence word word2 morph node node-part node2 row row2 span]} (build!)
        r (h/split-token admin-request word 5)]
    (is (= 201 (:status r)) (pr-str (:body r)))
    (testing "the word and the morpheme below it split as before"
      (is (= [0 5] (extent word)))
      (is (= [0 5] (extent morph))))
    (testing "a token of a root layer over the word keeps its extent and its concept"
      (is (= [0 6] (extent node)))
      (is (= [4 6] (extent node-part)))
      (is (= [node] (:span/tokens (:body (h/get-span admin-request span))))))
    (testing "and so does a row of a root partitioning layer"
      (is (= [0 6] (extent row)))
      (is (= [6 10] (extent row2))))
    (testing "the sentence above the word and the other words are left"
      (is (= [0 10] (extent sentence)))
      (is (= [7 10] (extent word2)))
      (is (= [7 10] (extent node2))))))
