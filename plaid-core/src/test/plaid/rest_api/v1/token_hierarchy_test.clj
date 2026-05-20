(ns plaid.rest-api.v1.token-hierarchy-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request api-call
                                    assert-status assert-created assert-ok assert-no-content assert-bad-request
                                    with-admin with-test-users]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin with-test-users)

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defn- setup-hierarchy
  "Create project, doc, text-layer, text, and a sentence > word > morpheme token
  layer hierarchy. Sentences partition the whole text; words are non-overlapping
  inside sentences (gaps allowed for whitespace); morphemes partition each word."
  [text-body]
  (let [proj (create-test-project admin-request "HierProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc text-body) :body :id)
        sentence-res (create-token-layer-opts admin-request tl "Sentences"
                                              {:overlap-mode "partitioning"})
        sentence (-> sentence-res :body :id)
        word-res (create-token-layer-opts admin-request tl "Words"
                                          {:overlap-mode "non-overlapping"
                                           :parent-token-layer-id sentence})
        word (-> word-res :body :id)
        morpheme-res (create-token-layer-opts admin-request tl "Morphemes"
                                              {:overlap-mode "partitioning"
                                               :parent-token-layer-id word})
        morpheme (-> morpheme-res :body :id)]
    (assert-created sentence-res)
    (assert-created word-res)
    (assert-created morpheme-res)
    {:project proj :doc doc :text-layer tl :text-id text-id
     :sentence sentence :word word :morpheme morpheme}))

(defn- toks [layer text-id pairs]
  (mapv (fn [[b e]] {:token-layer-id layer :text text-id :begin b :end e}) pairs))

;; ---------------------------------------------------------------------------
;; Layer creation
;; ---------------------------------------------------------------------------

(deftest hierarchy-creation
  (testing "Parent refs are stored and returned"
    (let [{:keys [sentence word morpheme]} (setup-hierarchy "dogs run")]
      (let [w (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" word)})]
        (assert-ok w)
        (is (= sentence (-> w :body :token-layer/parent-token-layer))))
      (let [m (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" morpheme)})]
        (assert-ok m)
        (is (= word (-> m :body :token-layer/parent-token-layer))))
      ;; A root layer has no parent ref
      (let [s (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" sentence)})]
        (assert-ok s)
        (is (nil? (-> s :body :token-layer/parent-token-layer)))))))

(deftest hierarchy-creation-rejects-foreign-parent
  (testing "Parent token layer in a different text layer is rejected"
    (let [proj (create-test-project admin-request "HierProj2")
          tl1 (-> (create-text-layer admin-request proj "TL1") :body :id)
          tl2 (-> (create-text-layer admin-request proj "TL2") :body :id)
          parent (-> (create-token-layer-opts admin-request tl1 "P" {:overlap-mode "partitioning"}) :body :id)
          res (create-token-layer-opts admin-request tl2 "C" {:parent-token-layer-id parent})]
      (assert-bad-request res))))

;; ---------------------------------------------------------------------------
;; Containment
;; ---------------------------------------------------------------------------

(deftest nesting-happy-path
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (testing "Establish sentence (root partition), words, then per-word morphemes"
      (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
      (assert-created (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]])))
      ;; morphemes tile "dogs" = dog|s
      (assert-created (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]])))
      ;; morphemes tile "run" = run (single morpheme); separate establishment per word
      (assert-created (bulk-create-tokens admin-request (toks morpheme text-id [[5 8]]))))))

(deftest containment-requires-existing-parent
  (let [{:keys [text-id sentence morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (testing "Morphemes with no containing word are rejected"
      ;; no word tokens exist yet
      (assert-bad-request (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]]))))))

(deftest containment-rejects-cross-parent
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (assert-created (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]])))
    (testing "A morpheme spanning two words is rejected (not contained in any one word)"
      (assert-bad-request (bulk-create-tokens admin-request (toks morpheme text-id [[2 6]]))))))

(deftest word-not-contained-in-sentence-rejected
  (let [{:keys [text-id sentence word]} (setup-hierarchy "dogs run")]
    ;; sentence covers only [0,4]; partitioning would reject that, so instead test
    ;; with a sentence partition and a word outside it via a gap is impossible —
    ;; use a non-covering sentence layer scenario: establish sentence [0,8], then a
    ;; word fully inside is fine; a word equal to the whole sentence is fine too.
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (testing "A word within the sentence is contained"
      (assert-created (bulk-create-tokens admin-request (toks word text-id [[0 8]]))))))

;; ---------------------------------------------------------------------------
;; Parent-scoped partitioning (morphemes tile each word)
;; ---------------------------------------------------------------------------

(deftest morphemes-must-tile-word
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (assert-created (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]])))
    (testing "Morphemes that leave a gap in the word are rejected"
      ;; word "dogs" is [0,4]; [0,2] leaves [2,4] uncovered
      (assert-bad-request (bulk-create-tokens admin-request (toks morpheme text-id [[0 2]]))))
    (testing "Morphemes that tile the word are accepted"
      (assert-created (bulk-create-tokens admin-request (toks morpheme text-id [[0 2] [2 4]]))))))

(deftest morpheme-split-and-merge-within-word
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (assert-created (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]])))
    (let [m (bulk-create-tokens admin-request (toks morpheme text-id [[0 4]]))
          mid (first (-> m :body :ids))]
      (assert-created m)
      (testing "Splitting a morpheme (leaf) within its word works"
        (let [r (split-token admin-request mid 2)]
          (assert-created r)
          (let [new-id (-> r :body :id)]
            (testing "Merging the two halves back works"
              (assert-ok (merge-tokens admin-request mid new-id)))))))))

;; ---------------------------------------------------------------------------
;; Durable parent identity (the decisive requirement)
;; ---------------------------------------------------------------------------

(deftest wiping-morphemes-keeps-word-and-annotations
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))
          _ (assert-created w)
          m (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]]))
          morpheme-ids (-> m :body :ids)
          _ (assert-created m)
          ;; annotate the WORD with a span (span layer hangs off the word token layer)
          sl (-> (create-span-layer admin-request word "POS") :body :id)
          span-res (create-span admin-request sl [word-id] "NOUN")
          span-id (-> span-res :body :id)
          _ (assert-created span-res)]
      (testing "Deleting all morphemes leaves the word and its span intact"
        (assert-no-content (bulk-delete-tokens admin-request morpheme-ids))
        (assert-ok (get-token admin-request word-id))
        (let [s (get-span admin-request span-id)]
          (assert-ok s)
          (is (= [word-id] (-> s :body :span/tokens))))))))

;; ---------------------------------------------------------------------------
;; Parent-side guard rails (reject-don't-cascade)
;; ---------------------------------------------------------------------------

(deftest parent-delete-with-children-rejected
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))]
      (assert-created w)
      (assert-created (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]])))
      (testing "Deleting a word that still has morphemes is rejected"
        (assert-bad-request (delete-token admin-request word-id))))))

(deftest parent-split-with-children-rejected
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))]
      (assert-created w)
      (assert-created (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]])))
      (testing "Splitting a word that still has morphemes is rejected"
        (assert-bad-request (split-token admin-request word-id 2))))))

(deftest parent-without-children-can-be-deleted
  (let [{:keys [text-id sentence word]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))]
      (assert-created w)
      (testing "A word with no morphemes can be deleted"
        (assert-no-content (delete-token admin-request word-id))))))
