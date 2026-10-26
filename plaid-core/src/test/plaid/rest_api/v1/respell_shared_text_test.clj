(ns plaid.rest-api.v1.respell-shared-text-test
  "R51 (Luke 2026-10-26): igt's Analyze grid respells one word with the write
  Bulk Edit's Respell words sends, one raw whole-word replace op with the
  digest of the text it was made on. On a text igt, ud and umr share, every
  token over the word keeps its id and takes the new extent: igt's word and
  morphemes, ud's syntactic words (full width, the parts of a multi-word token
  told apart by precedence), umr's node beside the words, the sentence. What
  hangs off them stays: spans, a relation, a vocab link."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler admin-request api-call
                                    assert-ok assert-status with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id-of [resp] (-> resp :body :id))

(defn- extent [id]
  (let [t (get-token admin-request id)]
    (assert-ok t)
    ((juxt :token/begin :token/end :token/value) (:body t))))

(defn- respell! [text-id ops base]
  (api-call admin-request {:method :patch
                           :path (str "/api/v1/texts/" text-id)
                           :body {:body ops :base base}}))

(deftest a-whole-word-replace-keeps-every-app's-tokens-on-a-shared-text
  (let [proj (create-test-project admin-request "Shared")
        doc (create-test-document admin-request proj "D")
        tl (id-of (create-text-layer admin-request proj "Text"))
        sents (id-of (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}))
        words (id-of (create-token-layer-opts admin-request tl "Tokens" {:overlap-mode "non-overlapping"
                                                                         :parent-token-layer-id sents}))
        morphs (id-of (create-token-layer-opts admin-request tl "Morphemes" {:overlap-mode "any"
                                                                             :parent-token-layer-id words}))
        synt (id-of (create-token-layer-opts admin-request tl "Words" {:overlap-mode "any"
                                                                       :parent-token-layer-id words}))
        nodes (id-of (create-token-layer-opts admin-request tl "Nodes" {:overlap-mode "any"}))
        gloss (id-of (create-span-layer admin-request morphs "Gloss"))
        form (id-of (create-span-layer admin-request synt "Form"))
        lemma (id-of (create-span-layer admin-request synt "Lemma"))
        deps (id-of (create-relation-layer admin-request lemma "Deps"))
        text (id-of (create-text admin-request tl doc "vino del mar"))
        s (-> (bulk-create-tokens admin-request [{:token-layer-id sents :text text :begin 0 :end 12}])
              :body :ids first)
        w1 (id-of (create-token admin-request words text 0 4))
        del (id-of (create-token admin-request words text 5 8))
        w3 (id-of (create-token admin-request words text 9 12))
        ;; igt: a word split in two morphemes, each of the word's full extent.
        m1 (id-of (create-token admin-request morphs text 5 8 1 {:form "de"}))
        m2 (id-of (create-token admin-request morphs text 5 8 2 {:form "l"}))
        ;; ud: a multi-word token, two syntactic words of its full width.
        de (id-of (create-token admin-request synt text 5 8 1))
        el (id-of (create-token admin-request synt text 5 8 2))
        node (id-of (create-token admin-request nodes text 5 8))
        g1 (id-of (create-span admin-request gloss [m1] "of"))
        f-de (id-of (create-span admin-request form [de] "de"))
        f-el (id-of (create-span admin-request form [el] "el"))
        l-de (id-of (create-span admin-request lemma [de] "de"))
        l-el (id-of (create-span admin-request lemma [el] "el"))
        rel (id-of (create-relation admin-request deps l-el l-de "case"))
        vocab (id-of (create-vocab-layer admin-request (str "V " (random-uuid))))
        _ (link-vocab-to-project admin-request proj vocab)
        item (id-of (create-vocab-item admin-request vocab "del"))
        link (id-of (create-vocab-link admin-request item [del]))
        base (-> (get-text admin-request text) :body :text/digest)]
    (testing "a stale digest is refused, nothing written"
      (let [res (respell! text [{:type "replace" :index 5 :length 3 :value "dell"}] "stale")]
        (assert-status 409 res)
        (is (= "vino del mar" (-> (get-text admin-request text) :body :text/body)))))
    (let [res (respell! text [{:type "replace" :index 5 :length 3 :value "dell"}] base)]
      (assert-ok res)
      (is (= "vino dell mar" (-> res :body :text/body)))
      (is (string? (-> res :body :text/digest)))
      (is (empty? (-> res :body :reshape :deleted :tokens)))
      (testing "every token over the word keeps its id and takes the new extent"
        (doseq [id [del m1 m2 de el node]]
          (is (= [5 9 "dell"] (extent id)))))
      (testing "the tokens around it shift or grow"
        (is (= [0 4 "vino"] (extent w1)))
        (is (= [10 13 "mar"] (extent w3)))
        (is (= [0 13 "vino dell mar"] (extent s))))
      (testing "what hangs off them stays, morpheme forms and Form spans as they were"
        (is (= "de" (-> (get-token admin-request m1) :body :metadata (get "form"))))
        (is (= "l" (-> (get-token admin-request m2) :body :metadata (get "form"))))
        (doseq [[span value] [[g1 "of"] [f-de "de"] [f-el "el"] [l-de "de"] [l-el "el"]]]
          (is (= value (-> (get-span admin-request span) :body :span/value))))
        (assert-ok (api-call admin-request {:method :get :path (str "/api/v1/relations/" rel)}))
        (assert-ok (get-vocab-link admin-request link))))))
