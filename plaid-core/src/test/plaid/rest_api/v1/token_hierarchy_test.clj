(ns plaid.rest-api.v1.token-hierarchy-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :as fixtures :refer [with-db
                                                 with-mount-states with-rest-handler admin-request api-call
                                                 assert-status assert-created assert-ok assert-no-content assert-bad-request
                                                 with-admin with-test-users with-clean-db]]
            [plaid.sql.constraints.token :as tc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; ---------------------------------------------------------------------------
;; Helpers
;; ---------------------------------------------------------------------------

(defn- setup-hierarchy
  "Create project, doc, text-layer, text, and a sentence > word > morpheme token
  layer hierarchy. Sentences partition the whole text (the root layer); words are
  non-overlapping inside sentences (gaps allowed for whitespace); morphemes are
  non-overlapping inside words. Partitioning is allowed only on the root layer, so
  the nested word and morpheme layers are non-overlapping."
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
                                              {:overlap-mode "non-overlapping"
                                               :parent-token-layer-id word})
        morpheme (-> morpheme-res :body :id)]
    (assert-created sentence-res)
    (assert-created word-res)
    (assert-created morpheme-res)
    {:project proj :doc doc :text-layer tl :text-id text-id
     :sentence sentence :word word :morpheme morpheme}))

(defn- toks [layer text-id pairs]
  (mapv (fn [[b e]] {:token-layer-id layer :text text-id :begin b :end e}) pairs))

(defn- layer-tokens
  "All tokens of token-layer `tlid` in document `doc`, as sorted [begin end] pairs,
  read from the include-body projection. Used to assert the full token set a cascade
  leaves behind (not just that specific ids survived/changed)."
  [doc tlid]
  (->> (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc "?include-body=true")})
       :body :document/text-layers
       (mapcat :text-layer/token-layers)
       (filter #(= tlid (:token-layer/id %)))
       first :token-layer/tokens
       (map (juxt :token/begin :token/end))
       sort vec))

(defn- setup-partitioning-hierarchy
  "A partitioning ROOT layer (sentences) with a nested non-overlapping child
  (words). Shifting a sentence boundary auto-grows the neighbor sentence and
  rebalances any straddling word. Partitioning is root-only, so the rebalance
  parent is the sentence layer rather than a nested layer."
  [text-body]
  (let [proj (create-test-project admin-request "PartHierProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc text-body) :body :id)
        sentence (-> (create-token-layer-opts admin-request tl "Sentences" {:overlap-mode "partitioning"}) :body :id)
        word (-> (create-token-layer-opts admin-request tl "Words"
                                          {:overlap-mode "non-overlapping" :parent-token-layer-id sentence}) :body :id)]
    {:project proj :doc doc :text-layer tl :text-id text-id
     :sentence sentence :word word}))

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

(deftest include-body-exposes-overlap-mode-and-parent
  (testing "GET document?include-body=true carries each token layer's overlap-mode and parent"
    (let [{:keys [doc sentence word morpheme]} (setup-hierarchy "dogs run")
          r (api-call admin-request {:method :get
                                     :path (str "/api/v1/documents/" doc "?include-body=true")})
          _ (assert-ok r)
          tls (-> r :body :document/text-layers first :text-layer/token-layers)
          by-id (into {} (map (juxt :token-layer/id identity)) tls)]
      (is (= 3 (count tls)))
      ;; overlap-mode is present for every layer (defaulted, never absent)
      (is (= :partitioning (-> by-id (get sentence) :token-layer/overlap-mode)))
      (is (= :non-overlapping (-> by-id (get word) :token-layer/overlap-mode)))
      (is (= :non-overlapping (-> by-id (get morpheme) :token-layer/overlap-mode)))
      ;; parent-token-layer present for nested layers, absent (nil) for the root
      (is (nil? (-> by-id (get sentence) :token-layer/parent-token-layer)))
      (is (= sentence (-> by-id (get word) :token-layer/parent-token-layer)))
      (is (= word (-> by-id (get morpheme) :token-layer/parent-token-layer))))))

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

(deftest word-spanning-whole-sentence-is-contained
  ;; A child whose extent exactly equals its parent's is contained (containment is
  ;; inclusive: parent.begin <= child.begin AND parent.end >= child.end). The
  ;; rejection side (a child NOT contained) is covered by containment-rejects-cross-parent
  ;; and single-create-and-update-containment.
  (let [{:keys [text-id sentence word]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (testing "A word equal to the whole sentence is contained"
      (assert-created (bulk-create-tokens admin-request (toks word text-id [[0 8]]))))))

;; ---------------------------------------------------------------------------
;; Editing nested tokens
;; ---------------------------------------------------------------------------

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

(deftest parent-delete-cascades-to-children
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          [word-id word2-id] (-> w :body :ids)
          _ (assert-created w)
          m (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]]))
          morpheme-ids (-> m :body :ids)]
      (assert-created m)
      (testing "Deleting a word cascades to delete its nested morphemes"
        (assert-no-content (delete-token admin-request word-id))
        (is (= 404 (:status (get-token admin-request word-id))))
        (doseq [mid morpheme-ids]
          (is (= 404 (:status (get-token admin-request mid)))
              "morpheme should be cascade-deleted with its word"))
        (testing "the sibling word is untouched"
          (assert-ok (get-token admin-request word2-id)))))))

(deftest parent-split-cascades-to-straddling-children
  (let [{:keys [doc text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))
          _ (assert-created w)
          ;; "dogs" tiled as [0,3][3,4]; the split at 2 straddles the first morpheme
          m (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]]))
          [m03 m34] (-> m :body :ids)]
      (assert-created m)
      (testing "Splitting the word at 2 cascades: the straddling morpheme is split too"
        (let [r (split-token admin-request word-id 2)
              new-word (-> r :body :id)]
          (assert-created r)
          ;; word → [0,2] (keeps id) + [2,4] (new)
          (is (= 2 (-> (get-token admin-request word-id) :body :token/end)))
          (is (= [2 4] [(-> (get-token admin-request new-word) :body :token/begin)
                        (-> (get-token admin-request new-word) :body :token/end)]))
          ;; straddling morpheme [0,3] was split at 2 → its id now covers [0,2]
          (let [mt (get-token admin-request m03)]
            (assert-ok mt)
            (is (= 0 (-> mt :body :token/begin)))
            (is (= 2 (-> mt :body :token/end))))
          ;; non-straddling morpheme [3,4] is untouched
          (let [mt (get-token admin-request m34)]
            (assert-ok mt)
            (is (= 3 (-> mt :body :token/begin)))
            (is (= 4 (-> mt :body :token/end))))
          ;; the cascade also CREATED the new right-half morpheme [2,3]: the morpheme
          ;; layer is now a clean re-tiling of "dogs", nothing orphaned
          (is (= [[0 2] [2 3] [3 4]] (layer-tokens doc morpheme))
              "straddler split produced a new [2,3] morpheme covering the freed region"))))))

(deftest parent-without-children-can-be-deleted
  (let [{:keys [text-id sentence word]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))]
      (assert-created w)
      (testing "A word with no morphemes can be deleted"
        (assert-no-content (delete-token admin-request word-id))))))

(deftest bulk-delete-orphan-guard-fires
  ;; Regression for a bug where bulk-delete's post-cascade orphan guard
  ;; was silently skipped because the same ctx key (:tokens-by-layer-doc)
  ;; gated both the partitioning all-or-nothing check (a pre-cascade
  ;; rule) and the orphan-descendant guard (a post-cascade rule);
  ;; passing nil to silence the former also silenced the latter.
  ;;
  ;; We probe the guard directly with `tc/enforce!`: build a hierarchy
  ;; with morphemes inside a word, then ask the guard to evaluate a
  ;; bulk-delete of the word AS IF the cascade had not deleted the
  ;; morphemes. The guard must throw 409.
  (let [{:keys [doc text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          [word-id _] (-> w :body :ids)
          _ (assert-created w)
          m (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]]))
          _ (assert-created m)
          dlids (tc/descendant-layer-ids fixtures/db word)
          ;; tokens-by-layer-doc carries the WORD we're "deleting"; the
          ;; morphemes still exist in the DB (the simulated cascade
          ;; was incomplete), so the orphan guard must reject this.
          tokens-by-layer-doc {[word doc] [{:token/id word-id
                                            :token/layer word
                                            :token/document doc
                                            :token/begin 0
                                            :token/end 4}]}
          ctx {:tokens-by-layer-doc tokens-by-layer-doc
               :dlids-by-layer {word dlids}
               :phase :post}]
      (testing "orphan guard rejects bulk-delete when descendants survive"
        (let [thrown? (try
                        (tc/enforce! fixtures/db :bulk-delete ctx)
                        false
                        (catch clojure.lang.ExceptionInfo e
                          (= 409 (:code (ex-data e)))))]
          (is thrown? "enforce! :bulk-delete must throw 409 when child morphemes survive in the word's extent"))))))

(deftest bulk-delete-partitioning-cross-document
  ;; Regression for the [layer, doc] grouping fix (sql-port-review §2.12,
  ;; Task #46). Before the fix, enforce-overlap-bulk-delete grouped by
  ;; :token/layer and passed (:token/document (first tokens)) as the
  ;; doc context. With a partitioning layer that spans two documents,
  ;; the all-or-nothing check would compare doc-A's count against the
  ;; full cross-doc eid set, causing both misfires:
  ;;
  ;;   1. Deleting the FULL partition of doc-A but leaving doc-B alone
  ;;      passed (because the eid set covers doc-A entirely) but the
  ;;      grouping silently included doc-B's tokens too, and if the
  ;;      sort order put doc-B first the check would COMPARE doc-B's
  ;;      count against eids that mostly target doc-A — failing
  ;;      spuriously, OR
  ;;   2. A partial delete against one doc could SUCCEED because the
  ;;      other doc's tokens accidentally made the count match.
  ;;
  ;; We probe both directions directly via tc/enforce!.
  ;; Build a shared project with two docs on the SAME partitioning
  ;; layer — layers belong to projects, so the cross-doc bug only
  ;; manifests when two documents share a single token layer.
  (let [proj (create-test-project admin-request "CrossDocProj")
        doc1 (create-test-document admin-request proj "Doc1")
        doc2 (create-test-document admin-request proj "Doc2")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text1 (-> (create-text admin-request tl doc1 "abc") :body :id)
        text2 (-> (create-text admin-request tl doc2 "xyz") :body :id)
        sent (-> (create-token-layer-opts admin-request tl "Sents"
                                          {:overlap-mode "partitioning"}) :body :id)
        ;; doc1 partition: one token [0,3]
        _ (assert-created (bulk-create-tokens admin-request (toks sent text1 [[0 3]])))
        ;; doc2 partition: two tokens [0,2] [2,3]
        _ (assert-created (bulk-create-tokens admin-request (toks sent text2 [[0 2] [2 3]])))
        doc1-ids (mapv :token/id (:token-layer/tokens
                                  (first (filter #(= sent (:token-layer/id %))
                                                 (mapcat :text-layer/token-layers
                                                         (-> (api-call admin-request
                                                                       {:method :get
                                                                        :path (str "/api/v1/documents/" doc1 "?include-body=true")})
                                                             :body :document/text-layers))))))
        doc2-ids (mapv :token/id (:token-layer/tokens
                                  (first (filter #(= sent (:token-layer/id %))
                                                 (mapcat :text-layer/token-layers
                                                         (-> (api-call admin-request
                                                                       {:method :get
                                                                        :path (str "/api/v1/documents/" doc2 "?include-body=true")})
                                                             :body :document/text-layers))))))]
    ;; Sanity
    (is (= 1 (count doc1-ids)) "doc1 has one partitioning token")
    (is (= 2 (count doc2-ids)) "doc2 has two partitioning tokens")

    (testing "deleting the full partition of each doc independently passes"
      ;; Build tokens-by-layer-doc covering ALL of doc1 AND a subset of doc2.
      ;; In the old shape (group-by layer alone), the count comparison
      ;; would pick one doc's count and combine all 3 ids — masking the
      ;; partial-deletion violation. In the new shape we have two
      ;; separate keys so doc2's partial-delete must throw.
      (let [doc1-tokens [{:token/id (first doc1-ids) :token/layer sent
                          :token/document doc1 :token/begin 0 :token/end 3}]
            doc2-subset [{:token/id (first doc2-ids) :token/layer sent
                          :token/document doc2 :token/begin 0 :token/end 2}]
            tokens-by-layer-doc {[sent doc1] doc1-tokens
                                 [sent doc2] doc2-subset}
            thrown? (try
                      (tc/enforce! fixtures/db :bulk-delete
                                   {:tokens-by-layer-doc tokens-by-layer-doc
                                    :dlids-by-layer {}
                                    :phase :pre})
                      false
                      (catch clojure.lang.ExceptionInfo e
                        (= 400 (:code (ex-data e)))))]
        (is thrown? "Partial deletion of doc2's partition must throw 400 even when bundled with full deletion of doc1")))

    (testing "deleting the full partition of BOTH docs passes"
      (let [doc1-tokens [{:token/id (first doc1-ids) :token/layer sent
                          :token/document doc1 :token/begin 0 :token/end 3}]
            doc2-tokens (mapv (fn [id [b e]]
                                {:token/id id :token/layer sent
                                 :token/document doc2 :token/begin b :token/end e})
                              doc2-ids [[0 2] [2 3]])
            tokens-by-layer-doc {[sent doc1] doc1-tokens
                                 [sent doc2] doc2-tokens}]
        (is (nil? (tc/enforce! fixtures/db :bulk-delete
                               {:tokens-by-layer-doc tokens-by-layer-doc
                                :dlids-by-layer {}
                                :phase :pre}))
            "Full deletion of both doc partitions on the same layer must pass")))))

;; ---------------------------------------------------------------------------
;; Precise parent-side guard (boundary-aligned ops allowed; orphaning rejected)
;; ---------------------------------------------------------------------------

(deftest parent-split-at-child-boundary-allowed
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))]
      (assert-created w)
      ;; morphemes tile "dogs" at boundary 2: [0,2][2,4]
      (assert-created (bulk-create-tokens admin-request (toks morpheme text-id [[0 2] [2 4]])))
      (testing "Splitting the word at the morpheme boundary (2) is allowed"
        (let [r (split-token admin-request word-id 2)]
          (assert-created r)
          ;; left word keeps id and is now [0,2]; both morphemes remain, re-derived
          ;; into the two new words by offset containment
          (let [left (get-token admin-request word-id)]
            (assert-ok left)
            (is (= 0 (-> left :body :token/begin)))
            (is (= 2 (-> left :body :token/end)))))))))

(deftest parent-grow-with-children-allowed
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))]
      (assert-created w)
      (assert-created (bulk-create-tokens admin-request (toks morpheme text-id [[0 2] [2 4]])))
      (testing "Growing the word's end into the gap (4→5) keeps all morphemes contained"
        (let [r (shift-token-boundary admin-request word-id :end 5)]
          (assert-ok r)
          (is (= 5 (-> r :body :token/end))))))))

(deftest parent-shrink-trims-straddling-child
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))
          _ (assert-created w)
          m (bulk-create-tokens admin-request (toks morpheme text-id [[0 2] [2 4]]))
          [m02 m24] (-> m :body :ids)]
      (assert-created m)
      (testing "Shrinking the word end (4→3) trims the straddling morpheme [2,4]→[2,3]"
        (let [r (shift-token-boundary admin-request word-id :end 3)]
          (assert-ok r)
          (is (= 3 (-> r :body :token/end)))
          (is (= [0 2] [(-> (get-token admin-request m02) :body :token/begin)
                        (-> (get-token admin-request m02) :body :token/end)]))
          (is (= [2 3] [(-> (get-token admin-request m24) :body :token/begin)
                        (-> (get-token admin-request m24) :body :token/end)])
              "straddling morpheme trimmed to the new word boundary"))))))

(deftest parent-shrink-deletes-fully-outside-child
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))
          _ (assert-created w)
          m (bulk-create-tokens admin-request (toks morpheme text-id [[0 2] [2 4]]))
          [m02 m24] (-> m :body :ids)]
      (assert-created m)
      (testing "Shrinking the word end (4→2) deletes the now fully-outside morpheme [2,4]"
        (let [r (shift-token-boundary admin-request word-id :end 2)]
          (assert-ok r)
          (assert-ok (get-token admin-request m02))
          (is (= 404 (:status (get-token admin-request m24)))
              "morpheme fully outside the shrunk word is deleted"))))))

(deftest partitioning-parent-shift-rebalances-child-to-neighbor
  ;; The partitioning parent is the (root) sentence layer; words are its nested
  ;; children. Shrinking a sentence grows its neighbor and splits a straddling word.
  (let [{:keys [text-id sentence word]} (setup-partitioning-hierarchy "abcd")
        s (bulk-create-tokens admin-request (toks sentence text-id [[0 2] [2 4]]))
        [sent1 sent2] (-> s :body :ids)
        _ (assert-created s)
        w (bulk-create-tokens admin-request (toks word text-id [[0 2] [2 4]]))
        [word1 word2] (-> w :body :ids)
        _ (assert-created w)]
    (testing "Shrinking sentence1 (end 2→1) grows sentence2 and splits the straddling word"
      (let [r (shift-token-boundary admin-request sent1 :end 1)]
        (assert-ok r)
        (is (= 1 (-> (get-token admin-request sent1) :body :token/end)))
        (is (= 1 (-> (get-token admin-request sent2) :body :token/begin))
            "partitioning neighbor grew to cover the freed region")
        (is (= [0 1] [(-> (get-token admin-request word1) :body :token/begin)
                      (-> (get-token admin-request word1) :body :token/end)])
            "the straddling word split at the new boundary; its left half stays in sentence1")))))

(deftest parent-collapse-to-zero-deletes-children
  ;; A root non-overlapping parent shrunk to zero width: its children retain no
  ;; positive overlap with the new (empty) extent, so they are deleted — the limit
  ;; of "shrink deletes children left outside the new extent" — rather than left as
  ;; ambiguous zero-width tokens. (A nested parent can't be shrunk to zero: the
  ;; nested zero-width ban rejects it, so the parent here is a root layer.)
  (let [proj (create-test-project admin-request "CollapseProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc "dogs") :body :id)
        word (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
        morpheme (-> (create-token-layer-opts admin-request tl "Morphemes"
                                              {:overlap-mode "non-overlapping" :parent-token-layer-id word}) :body :id)
        w (bulk-create-tokens admin-request (toks word text-id [[0 4]]))
        word1 (first (-> w :body :ids))
        _ (assert-created w)
        m (bulk-create-tokens admin-request (toks morpheme text-id [[0 2] [2 4]]))
        [m02 m24] (-> m :body :ids)
        _ (assert-created m)]
    (testing "Shrinking the word to zero width deletes its now overlap-less morphemes"
      (let [r (shift-token-boundary admin-request word1 :end 0)]
        (assert-ok r)
        (is (= 0 (-> (get-token admin-request word1) :body :token/end))
            "the word itself survives at zero width")
        (is (= 404 (:status (get-token admin-request m02)))
            "morpheme that collapsed to zero is deleted, not kept zero-width")
        (is (= 404 (:status (get-token admin-request m24))))))))

(deftest partitioning-parent-grow-rebalances-neighbor-child
  ;; mirror of the shrink case: when a sentence GROWS into its neighbor, the
  ;; straddling word lives in the NEIGHBOR — the cascade must still find it.
  (let [{:keys [text-id sentence word]} (setup-partitioning-hierarchy "abcd")
        s (bulk-create-tokens admin-request (toks sentence text-id [[0 2] [2 4]]))
        [sent1 sent2] (-> s :body :ids)
        _ (assert-created s)
        w (bulk-create-tokens admin-request (toks word text-id [[0 2] [2 4]]))
        [word1 word2] (-> w :body :ids)
        _ (assert-created w)]
    (testing "Growing sentence1 (end 2→3) shrinks sentence2 and splits the neighbor's word"
      (let [r (shift-token-boundary admin-request sent1 :end 3)]
        (assert-ok r)
        (is (= 3 (-> (get-token admin-request sent1) :body :token/end)))
        (is (= 3 (-> (get-token admin-request sent2) :body :token/begin)))
        (is (= [2 3] [(-> (get-token admin-request word2) :body :token/begin)
                      (-> (get-token admin-request word2) :body :token/end)])
            "the neighbor's word split at the new boundary; its left half re-homed to sentence1")))))

(deftest partitioning-shift-stays-within-neighbor
  ;; A partitioning shift only moves a shared boundary between two adjacent tokens.
  ;; It may not collapse either token or push onto/past the neighbor's far edge,
  ;; which would zero-width or invert it — keeping the layer a valid partition.
  (let [{:keys [text-id sentence]} (setup-partitioning-hierarchy "abcd")
        s (bulk-create-tokens admin-request (toks sentence text-id [[0 2] [2 4]]))
        [s1 s2] (-> s :body :ids)
        _ (assert-created s)]
    (testing "shifting a boundary onto the neighbor's far edge (zero-width neighbor) is rejected"
      (assert-bad-request (shift-token-boundary admin-request s1 :end 4)))
    (testing "collapsing the shifted token to zero width is rejected"
      (assert-bad-request (shift-token-boundary admin-request s1 :end 0)))
    (testing "collapsing the left neighbor via a begin shift is rejected"
      (assert-bad-request (shift-token-boundary admin-request s2 :begin 0)))
    (testing "the partition is untouched by the rejected shifts"
      (is (= [0 2] [(-> (get-token admin-request s1) :body :token/begin)
                    (-> (get-token admin-request s1) :body :token/end)]))
      (is (= [2 4] [(-> (get-token admin-request s2) :body :token/begin)
                    (-> (get-token admin-request s2) :body :token/end)])))
    (testing "a shift strictly inside the neighbor is allowed"
      (let [r (shift-token-boundary admin-request s1 :end 3)]
        (assert-ok r)
        (is (= 3 (-> (get-token admin-request s1) :body :token/end)))
        (is (= 3 (-> (get-token admin-request s2) :body :token/begin)))))))

(deftest partitioning-shift-past-neighbor-rejected
  ;; In a 3+ token partition, shifting a boundary past the adjacent neighbor would
  ;; invert that neighbor and overlap the one beyond it — rejected.
  (let [{:keys [text-id sentence]} (setup-partitioning-hierarchy "abcdef")
        s (bulk-create-tokens admin-request (toks sentence text-id [[0 2] [2 4] [4 6]]))
        [s1 s2 s3] (-> s :body :ids)
        _ (assert-created s)]
    (testing "shifting token1's end past the adjacent neighbor's far edge is rejected"
      (assert-bad-request (shift-token-boundary admin-request s1 :end 5)))
    (testing "the partition is untouched"
      (is (= [2 4] [(-> (get-token admin-request s2) :body :token/begin)
                    (-> (get-token admin-request s2) :body :token/end)]))
      (is (= [4 6] [(-> (get-token admin-request s3) :body :token/begin)
                    (-> (get-token admin-request s3) :body :token/end)])))))

;; ---------------------------------------------------------------------------
;; Disjoint-parent + zero-width restrictions (containment must be unambiguous)
;; ---------------------------------------------------------------------------

(deftest hierarchy-creation-rejects-any-parent
  (testing "An :any parent token layer is rejected — parents must be disjoint"
    (let [proj (create-test-project admin-request "AnyParentProj")
          tl (-> (create-text-layer admin-request proj "TL") :body :id)
          ;; explicit :any parent
          any-parent (-> (create-token-layer-opts admin-request tl "P" {:overlap-mode "any"}) :body :id)
          res (create-token-layer-opts admin-request tl "C"
                                       {:overlap-mode "non-overlapping" :parent-token-layer-id any-parent})]
      (assert-bad-request res))
    (testing "and a layer defaulting to :any (no overlap-mode) is rejected as a parent too"
      (let [proj (create-test-project admin-request "AnyParentProj2")
            tl (-> (create-text-layer admin-request proj "TL") :body :id)
            default-parent (-> (create-token-layer admin-request tl "P") :body :id)
            res (create-token-layer-opts admin-request tl "C" {:parent-token-layer-id default-parent})]
        (assert-bad-request res)))))

(deftest nested-partitioning-rejected
  (testing "A nested token layer may not be partitioning — partitioning is root-only"
    (let [proj (create-test-project admin-request "NestPartProj")
          tl (-> (create-text-layer admin-request proj "TL") :body :id)
          parent (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
          res (create-token-layer-opts admin-request tl "Morphemes"
                                       {:overlap-mode "partitioning" :parent-token-layer-id parent})]
      (assert-bad-request res))))

(deftest any-nested-layer-allows-overlap-but-enforces-containment
  ;; A nested `any` layer is the "contained-in" model: containment comes from the
  ;; parent ref (always enforced), while `any` lets its own tokens overlap — needed
  ;; for fused morphology (e.g. French "aux" -> à + les share the surface span).
  (let [proj (create-test-project admin-request "AnyNestProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc "aux dog") :body :id) ; len 7
        words (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
        morphemes (-> (create-token-layer-opts admin-request tl "Morphemes"
                                               {:overlap-mode "any" :parent-token-layer-id words}) :body :id)
        _ (assert-created (bulk-create-tokens admin-request (toks words text-id [[0 3] [4 7]])))] ; "aux", "dog"
    (testing "two overlapping morphemes sharing the fused 'aux' span are accepted on an :any layer"
      (assert-created (bulk-create-tokens admin-request (toks morphemes text-id [[0 3] [0 3]]))))
    (testing "containment is still enforced: a morpheme in the gap (no containing word) is rejected"
      (assert-bad-request (bulk-create-tokens admin-request (toks morphemes text-id [[3 4]]))))))

(deftest nested-zero-width-child-rejected
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (testing "A zero-width token on a nested layer is rejected (would be in two parents at once)"
      ;; word is nested in sentence; a zero-width word at offset 4 is ambiguous
      (assert-bad-request (bulk-create-tokens admin-request (toks word text-id [[4 4]]))))
    (testing "A zero-width single-create on a nested layer is rejected too"
      (assert-bad-request (create-token admin-request word text-id 4 4)))))

;; ---------------------------------------------------------------------------
;; Confirming tests for behaviors flagged-but-actually-safe by the branch review
;; ---------------------------------------------------------------------------

(deftest partitioning-parent-shift-on-child-boundary-self-heals
  ;; When the moved sentence boundary lands exactly on a word boundary, no word
  ;; straddles it, so the cascade splits nothing — the word on the far side simply
  ;; re-homes to the grown neighbor sentence by offset.
  (let [{:keys [text-id sentence word]} (setup-partitioning-hierarchy "abcd")
        s (bulk-create-tokens admin-request (toks sentence text-id [[0 2] [2 4]]))
        [sent1 sent2] (-> s :body :ids)
        _ (assert-created s)
        w (bulk-create-tokens admin-request (toks word text-id [[0 1] [1 2] [2 4]]))
        [w01 w12 w24] (-> w :body :ids)
        _ (assert-created w)]
    (testing "Shifting sentence1 end 2→1 lands on a word boundary: nothing is split"
      (let [r (shift-token-boundary admin-request sent1 :end 1)]
        (assert-ok r)
        (is (= 1 (-> (get-token admin-request sent1) :body :token/end)))
        (is (= 1 (-> (get-token admin-request sent2) :body :token/begin))
            "partitioning neighbor grew to cover the freed region")
        ;; all three words keep their original extents (no split happened)
        (is (= [0 1] [(-> (get-token admin-request w01) :body :token/begin)
                      (-> (get-token admin-request w01) :body :token/end)]))
        (is (= [1 2] [(-> (get-token admin-request w12) :body :token/begin)
                      (-> (get-token admin-request w12) :body :token/end)])
            "the word re-homes to the grown sentence2 by offset; extent unchanged")
        (is (= [2 4] [(-> (get-token admin-request w24) :body :token/begin)
                      (-> (get-token admin-request w24) :body :token/end)]))))))

(deftest text-edit-keeps-nested-tokens-contained
  ;; compensate-after-cascade gap-fills the root partitioning (sentence) layer;
  ;; this verifies the text edit also clips the nested words consistently so none
  ;; ends up orphaned outside its sentence.
  (let [{:keys [text-id sentence word]} (setup-partitioning-hierarchy "abcd")
        s (bulk-create-tokens admin-request (toks sentence text-id [[0 4]]))
        sent1 (first (-> s :body :ids))
        _ (assert-created s)
        w (bulk-create-tokens admin-request (toks word text-id [[0 2] [2 4]]))
        [word1 word2] (-> w :body :ids)
        _ (assert-created w)]
    (testing "Deleting the char 'b' (index 1) clips the sentence and words with no orphan"
      (assert-ok (update-text admin-request text-id "acd"))
      (is (= [0 3] [(-> (get-token admin-request sent1) :body :token/begin)
                    (-> (get-token admin-request sent1) :body :token/end)])
          "root partitioning sentence re-tiles the shortened text")
      ;; word1 [0,2]→[0,1]; word2 [2,4]→[1,3]; both stay within the sentence
      (is (= [0 1] [(-> (get-token admin-request word1) :body :token/begin)
                    (-> (get-token admin-request word1) :body :token/end)]))
      (is (= [1 3] [(-> (get-token admin-request word2) :body :token/begin)
                    (-> (get-token admin-request word2) :body :token/end)])
          "words clip consistently and stay within the sentence"))))

(deftest text-edit-keeps-partition-complete
  ;; A partitioning layer must stay "empty or a complete cover" through ANY text
  ;; edit — including insert/append/prepend/replace, which delete no token. This is
  ;; the regression for compensate-after-cascade being gated on deletions only
  ;; (insertions used to leave an uncovered gap, breaking the partition).
  (letfn [(extent [tid] (let [b (get-token admin-request tid)]
                          [(-> b :body :token/begin) (-> b :body :token/end)]))
          (assert-covers [tids len]
            (let [exts (sort-by first (map extent tids))]
              (is (= 0 (ffirst exts)) "partition starts at 0")
              (is (= len (last (last exts))) "partition ends at the new text length")
              (doseq [[[_ e1] [b2 _]] (partition 2 1 exts)]
                (is (= e1 b2) "partition is gap-free and non-overlapping"))))
          (run-edit [new-body len]
            (let [{:keys [text-id sentence]} (setup-partitioning-hierarchy "abcd")
                  s (bulk-create-tokens admin-request (toks sentence text-id [[0 2] [2 4]]))
                  ids (-> s :body :ids)]
              (assert-created s)
              (assert-ok (update-text admin-request text-id new-body))
              (assert-covers ids len)))]
    (testing "insert at a token boundary keeps the partition complete"
      (run-edit "abXXcd" 6))
    (testing "append at end keeps the partition complete"
      (run-edit "abcdYZ" 6))
    (testing "prepend at start keeps the partition complete"
      (run-edit "ZZabcd" 6))
    (testing "length-changing replacement keeps the partition complete"
      (run-edit "aXYZcd" 6))))

(deftest text-grow-with-empty-partition-layer-ok
  ;; Regression for the partition concurrency guard (empty partitioning layer must
  ;; stay empty): a text grow while the partitioning layer is un-established must
  ;; NOT false-fire that assert.
  (let [{:keys [text-id]} (setup-partitioning-hierarchy "ab")]
    (testing "growing the text while the partitioning layer is un-established succeeds"
      (assert-ok (update-text admin-request text-id "abcd")))))

(deftest text-grow-extends-established-partition
  (let [{:keys [text-id sentence]} (setup-partitioning-hierarchy "ab")
        s (bulk-create-tokens admin-request (toks sentence text-id [[0 2]]))
        tok (first (-> s :body :ids))
        _ (assert-created s)]
    (testing "growing the text extends the established partition to cover the new length"
      (assert-ok (update-text admin-request text-id "abcd"))
      (is (= [0 4] [(-> (get-token admin-request tok) :body :token/begin)
                    (-> (get-token admin-request tok) :body :token/end)])
          "the single partition token extends to the new text end"))))

(deftest text-edit-preserves-containment-deep
  ;; A text body edit reindexes every layer by the same offset rule; verify it can
  ;; never move a child outside its parent across a full sentence > word > morpheme
  ;; tree (an insertion inside a word).
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dog cat")
        st (bulk-create-tokens admin-request (toks sentence text-id [[0 7]]))
        sent (first (-> st :body :ids))
        _ (assert-created st)
        w (bulk-create-tokens admin-request (toks word text-id [[0 3] [4 7]]))
        [dog cat] (-> w :body :ids)
        _ (assert-created w)
        m1 (bulk-create-tokens admin-request (toks morpheme text-id [[0 1] [1 3]])) ; within "dog"
        [d og] (-> m1 :body :ids)
        _ (assert-created m1)
        m2 (bulk-create-tokens admin-request (toks morpheme text-id [[4 7]]))        ; within "cat"
        catm (first (-> m2 :body :ids))
        _ (assert-created m2)]
    (letfn [(ext [tid] (let [b (:body (get-token admin-request tid))]
                         [(:token/begin b) (:token/end b)]))
            (within? [cid pid] (let [[cb ce] (ext cid) [pb pe] (ext pid)]
                                 (and (<= pb cb) (<= ce pe))))]
      (testing "inserting inside a word keeps every child within its parent at all depths"
        (assert-ok (update-text admin-request text-id "doXg cat"))
        (is (within? dog sent) "word stays within sentence")
        (is (within? cat sent))
        (is (within? d dog) "morpheme stays within word")
        (is (within? og dog))
        (is (within? catm cat))))))

(deftest bulk-delete-parent-cascades-to-children
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          [word1 word2] (-> w :body :ids)
          _ (assert-created w)
          m1 (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]]))
          m1ids (-> m1 :body :ids)
          _ (assert-created m1)
          m2 (bulk-create-tokens admin-request (toks morpheme text-id [[5 8]]))
          m2ids (-> m2 :body :ids)
          _ (assert-created m2)]
      (testing "Bulk-deleting both words cascades to delete every nested morpheme"
        (assert-no-content (bulk-delete-tokens admin-request [word1 word2]))
        (is (= 404 (:status (get-token admin-request word1))))
        (is (= 404 (:status (get-token admin-request word2))))
        (doseq [mid (concat m1ids m2ids)]
          (is (= 404 (:status (get-token admin-request mid)))
              "morpheme cascade-deleted with its word"))))))

(deftest parent-token-layer-is-immutable
  (let [{:keys [sentence word morpheme]} (setup-hierarchy "dogs run")]
    (testing "A layer's parent is write-once: PATCH cannot repoint it"
      ;; attempt to repoint morpheme's parent from word to sentence
      (api-call admin-request {:method :patch
                               :path (str "/api/v1/token-layers/" morpheme)
                               :body {:name "Morphemes2" :parent-token-layer-id sentence}})
      (let [m (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" morpheme)})]
        (assert-ok m)
        (is (= word (-> m :body :token-layer/parent-token-layer))
            "morpheme's parent stays the word layer")))))

(deftest merge-of-parent-words-keeps-children-contained
  ;; Merging two parent tokens never orphans children: the merged extent contains
  ;; both originals, so every child stays contained (nothing is lost), even when the
  ;; two words were not adjacent.
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          [word1 word2] (-> w :body :ids)
          _ (assert-created w)
          m1 (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]]))
          m1ids (-> m1 :body :ids)
          _ (assert-created m1)
          m2 (bulk-create-tokens admin-request (toks morpheme text-id [[5 8]]))
          m2id (first (-> m2 :body :ids))
          _ (assert-created m2)]
      (testing "Merging the two words keeps all morphemes, contained in the merged word"
        (let [r (merge-tokens admin-request word1 word2)]
          (assert-ok r))
        (let [merged (get-token admin-request word1)]
          (assert-ok merged)
          (is (= [0 8] [(-> merged :body :token/begin) (-> merged :body :token/end)])
              "left word survives, grown to span both"))
        (is (= 404 (:status (get-token admin-request word2)))
            "right word is consumed by the merge")
        (doseq [mid (concat m1ids [m2id])]
          (let [mt (get-token admin-request mid)]
            (assert-ok mt)
            (is (and (>= (-> mt :body :token/begin) 0)
                     (<= (-> mt :body :token/end) 8))
                "morpheme survives and stays within the merged word")))))))

(deftest token-delete-trims-multi-token-vocab-link
  ;; Deleting one token of a multi-token vocab-link trims it (drops that token,
  ;; keeps the link) — consistent with how spans are handled; the link is deleted
  ;; only when no tokens remain.
  (let [proj (create-test-project admin-request "VLTrimProj")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc "dogs run") :body :id)
        word (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
        w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
        [t1 t2] (-> w :body :ids)
        _ (assert-created w)
        vocab (-> (create-vocab-layer admin-request "V") :body :id)
        _ (link-vocab-to-project admin-request proj vocab)
        item (-> (create-vocab-item admin-request vocab "dogs run") :body :id)
        link (-> (create-vocab-link admin-request item [t1 t2]) :body :id)]
    (testing "deleting one token of a 2-token vocab-link keeps the link with the remaining token"
      (assert-no-content (delete-token admin-request t1))
      (let [r (get-vocab-link admin-request link)]
        (assert-ok r)
        (is (= [t2] (-> r :body :vocab-link/tokens))
            "the deleted token is dropped; the link survives on the rest")))
    (testing "deleting the last token deletes the now-empty link"
      (assert-no-content (delete-token admin-request t2))
      (is (= 404 (:status (get-vocab-link admin-request link)))))))

(deftest delete-cascade-removes-descendant-annotations
  ;; Deleting a parent token drags down not only descendant tokens but their
  ;; dependent spans and vocab-links (the "and their dependents" half of the cascade
  ;; that the REST summaries promise).
  (let [{:keys [project text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          word-id (first (-> w :body :ids))
          _ (assert-created w)
          m (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [3 4]]))
          m03 (first (-> m :body :ids))
          _ (assert-created m)
          ;; a span (on the morpheme layer) and a vocab-link both over morpheme [0,3]
          sl (-> (create-span-layer admin-request morpheme "gloss") :body :id)
          span-res (create-span admin-request sl [m03] "DOG")
          span-id (-> span-res :body :id)
          _ (assert-created span-res)
          vocab (-> (create-vocab-layer admin-request "V") :body :id)
          _ (link-vocab-to-project admin-request project vocab)
          item (-> (create-vocab-item admin-request vocab "dog") :body :id)
          link-res (create-vocab-link admin-request item [m03])
          link-id (-> link-res :body :id)
          _ (assert-created link-res)]
      (testing "deleting the word cascades to the morpheme AND its span + vocab-link"
        (assert-no-content (delete-token admin-request word-id))
        (is (= 404 (:status (get-token admin-request m03))) "descendant morpheme deleted")
        (is (= 404 (:status (get-span admin-request span-id))) "descendant's span deleted")
        (is (= 404 (:status (get-vocab-link admin-request link-id))) "descendant's vocab-link deleted")))))

(deftest merge-reparents-annotations-to-survivor
  ;; Merging two tokens reparents the consumed (right) token's span and vocab-link
  ;; onto the surviving (left) token — nothing referencing the consumed token is orphaned.
  (let [{:keys [project text-id sentence word]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    (let [w (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]]))
          [w1 w2] (-> w :body :ids)
          _ (assert-created w)
          sl (-> (create-span-layer admin-request word "POS") :body :id)
          span-res (create-span admin-request sl [w2] "VERB")
          span-id (-> span-res :body :id)
          _ (assert-created span-res)
          vocab (-> (create-vocab-layer admin-request "V") :body :id)
          _ (link-vocab-to-project admin-request project vocab)
          item (-> (create-vocab-item admin-request vocab "run") :body :id)
          link-res (create-vocab-link admin-request item [w2])
          link-id (-> link-res :body :id)
          _ (assert-created link-res)]
      (testing "merging w1+w2 (left survives) moves w2's span and vocab-link onto w1"
        (assert-ok (merge-tokens admin-request w1 w2))
        (is (= 404 (:status (get-token admin-request w2))) "right token is consumed")
        (let [s (get-span admin-request span-id)]
          (assert-ok s)
          (is (= [w1] (-> s :body :span/tokens)) "span reparented to the survivor"))
        (let [l (get-vocab-link admin-request link-id)]
          (assert-ok l)
          (is (= [w1] (-> l :body :vocab-link/tokens)) "vocab-link reparented to the survivor"))))))

(deftest cross-parent-merge-and-shift-rejected
  ;; A nested child cannot escape its parent: a merge or shift whose resulting extent
  ;; has no single containing parent token is rejected by enforce-nesting (400).
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    ;; two words = two parents; one morpheme in each
    (assert-created (bulk-create-tokens admin-request (toks word text-id [[0 4] [5 8]])))
    (let [m (bulk-create-tokens admin-request (toks morpheme text-id [[0 3] [5 8]]))
          [m1 m2] (-> m :body :ids)]
      (assert-created m)
      (testing "merging morphemes from different words is rejected (escapes both parents)"
        (assert-bad-request (merge-tokens admin-request m1 m2))
        (assert-ok (get-token admin-request m1))
        (assert-ok (get-token admin-request m2)))
      (testing "shifting a morpheme's end past its word boundary is rejected; it stays put"
        ;; [0,3] -> [0,5] crosses word1's end (4) but only touches m2 [5,8] (half-open,
        ;; no overlap), so this is cleanly a containment rejection, not an overlap one.
        (assert-bad-request (shift-token-boundary admin-request m1 :end 5))
        (is (= [0 3] [(-> (get-token admin-request m1) :body :token/begin)
                      (-> (get-token admin-request m1) :body :token/end)]))))))

(deftest single-create-and-update-containment
  ;; The single (non-bulk) create/update path resolves the containing parent via the
  ;; SQL point-query (distinct from the in-memory batch path); verify it accepts a
  ;; contained child and rejects one that escapes its parent.
  (let [{:keys [text-id sentence word morpheme]} (setup-hierarchy "dogs run")]
    (assert-created (bulk-create-tokens admin-request (toks sentence text-id [[0 8]])))
    ;; a single word covering only [0,4]; [4,8] has no word, so a morpheme there has no parent
    (assert-created (create-token admin-request word text-id 0 4))
    (testing "single create of a morpheme inside the word is accepted"
      (let [r (create-token admin-request morpheme text-id 1 3)]
        (assert-created r)
        (testing "moving it out of the word via PATCH is rejected; it stays put"
          (let [mid (-> r :body :id)]
            (assert-bad-request (update-token admin-request mid :begin 5 :end 7))
            (is (= [1 3] [(-> (get-token admin-request mid) :body :token/begin)
                          (-> (get-token admin-request mid) :body :token/end)]))))))
    (testing "single create of a morpheme outside any word is rejected"
      (assert-bad-request (create-token admin-request morpheme text-id 5 7)))))

(deftest token-layer-delete-cascades-to-child-layers-and-their-tokens
  ;; Deleting a token LAYER must tear down its descendant token LAYERS too —
  ;; including their TOKENS, spans, relations, and vocab-links — otherwise those
  ;; tokens are orphaned (and un-editable: enforce-nesting would query a deleted
  ;; parent layer) and the child layers dangle a parent-token-layer ref.
  (let [proj (create-test-project admin-request "TLCascade")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc "dogs run") :body :id)
        words (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
        morphemes (-> (create-token-layer-opts admin-request tl "Morphemes"
                                               {:overlap-mode "non-overlapping" :parent-token-layer-id words}) :body :id)
        submorph (-> (create-token-layer-opts admin-request tl "Submorph"
                                              {:overlap-mode "any" :parent-token-layer-id morphemes}) :body :id)
        wt (-> (create-token admin-request words text-id 0 4) :body :id)
        mt (-> (create-token admin-request morphemes text-id 0 3) :body :id)
        st (-> (create-token admin-request submorph text-id 0 2) :body :id)
        ;; dependents hanging off DESCENDANT-layer tokens
        sl (-> (create-span-layer admin-request morphemes "gloss") :body :id)
        span-id (-> (create-span admin-request sl [mt] "DOG") :body :id)
        vocab (-> (create-vocab-layer admin-request "V") :body :id)
        _ (link-vocab-to-project admin-request proj vocab)
        item (-> (create-vocab-item admin-request vocab "dog") :body :id)
        link-id (-> (create-vocab-link admin-request item [st]) :body :id)]
    (testing "deleting the root token layer cascades to descendant layers, their tokens, and dependents"
      (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/token-layers/" words)}))
      ;; layers gone (target + child + grandchild)
      (is (= 404 (:status (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" words)}))))
      (is (= 404 (:status (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" morphemes)}))) "child layer deleted")
      (is (= 404 (:status (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" submorph)}))) "grandchild layer deleted")
      ;; THE BUG: descendant-layer tokens used to survive orphaned — assert they're gone
      (is (= 404 (:status (get-token admin-request wt))))
      (is (= 404 (:status (get-token admin-request mt))) "child-layer token deleted")
      (is (= 404 (:status (get-token admin-request st))) "grandchild-layer token deleted")
      ;; dependents of descendant tokens gone too
      (is (= 404 (:status (get-span admin-request span-id))) "descendant's span deleted")
      (is (= 404 (:status (get-vocab-link admin-request link-id))) "descendant's vocab-link deleted")
      ;; no dangling token-layer ids left in the text layer
      (let [txtl (api-call admin-request {:method :get :path (str "/api/v1/text-layers/" tl)})]
        (assert-ok txtl)
        (is (empty? (filter #{words morphemes submorph} (-> txtl :body :text-layer/token-layers)))
            "deleted layers removed from the text layer's token-layers list")))))

(deftest text-layer-delete-cascades-to-nested-token-layers-and-tokens
  ;; Deleting a text LAYER tears down all its token layers — including nested ones —
  ;; and their tokens and dependents (every token layer is listed under the text
  ;; layer, so the existing batched delete already reaches nested layers; this guards
  ;; against regression).
  (let [proj (create-test-project admin-request "TxtLCascade")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        text-id (-> (create-text admin-request tl doc "dogs run") :body :id)
        words (-> (create-token-layer-opts admin-request tl "Words" {:overlap-mode "non-overlapping"}) :body :id)
        morphemes (-> (create-token-layer-opts admin-request tl "Morphemes"
                                               {:overlap-mode "non-overlapping" :parent-token-layer-id words}) :body :id)
        wt (-> (create-token admin-request words text-id 0 4) :body :id)
        mt (-> (create-token admin-request morphemes text-id 0 3) :body :id)
        sl (-> (create-span-layer admin-request morphemes "gloss") :body :id)
        span-id (-> (create-span admin-request sl [mt] "DOG") :body :id)]
    (testing "deleting the text layer cascades to nested token layers, their tokens, and dependents"
      (assert-no-content (api-call admin-request {:method :delete :path (str "/api/v1/text-layers/" tl)}))
      (is (= 404 (:status (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" words)}))))
      (is (= 404 (:status (api-call admin-request {:method :get :path (str "/api/v1/token-layers/" morphemes)}))) "nested layer deleted")
      (is (= 404 (:status (get-token admin-request wt))))
      (is (= 404 (:status (get-token admin-request mt))) "nested-layer token deleted")
      (is (= 404 (:status (get-span admin-request span-id))) "nested layer's span deleted"))))
