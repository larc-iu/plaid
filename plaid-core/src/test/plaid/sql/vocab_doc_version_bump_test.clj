(ns plaid.sql.vocab-doc-version-bump-test
  "Task #72: vocab/delete and project/remove-vocab wipe vocab_links across
  many documents. Because their op-attrs carry `:document nil`, the post-
  body `bump-document-version!` hook doesn't fire — so OCC clients editing
  the affected documents weren't told their view was stale.

  Fix: both ops now collect the distinct `document_ids` of the vocab_links
  they're about to delete and call `bump-document-versions!` (plural) from
  `plaid.sql.operation`, which emits one `:doc-version-bump` audit row per
  affected document. Replay parity preserved."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-no-content with-clean-db]]
            [plaid.test-helpers :refer [create-test-project
                                        create-text-layer
                                        create-token-layer
                                        create-text
                                        create-token
                                        create-vocab-layer
                                        create-vocab-item
                                        create-vocab-link
                                        delete-vocab-layer
                                        link-vocab-to-project
                                        unlink-vocab-from-project
                                        get-document]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- doc-version [doc-id]
  (-> (get-document admin-request doc-id) :body :document/version))

(defn- doc-bump-rows [op-id]
  (psc/q db {:select [:*] :from [:audit_writes]
             :where [:and
                     [:= :op_id op-id]
                     [:= :target_table "documents"]
                     [:= :change_type "doc-version-bump"]]
             :order-by [:seq]}))

(defn- latest-op-id [op-type]
  (-> (psc/q1 db {:select [:id] :from [:operations]
                  :where [:= :op_type op-type]
                  :order-by [[:ts :desc]] :limit 1})
      :id))

(defn- new-doc-with-token!
  "Create a doc with a single token (vocab_link.document_id will resolve
  to this doc via the token's text)."
  [proj tl tkl doc-name]
  (let [doc (-> (api-call admin-request {:method :post
                                         :path "/api/v1/documents"
                                         :body {:project-id proj :name doc-name}})
                :body :id)
        text (-> (create-text admin-request tl doc "hello world test") :body :id)
        tok  (-> (create-token admin-request tkl text 0 5) :body :id)]
    {:doc doc :token tok}))

(defn- setup-fixture!
  "Three docs, one vocab with one item, one vocab_link per doc. Returns
  {:proj :vocab :item :docs [{:doc :token :link}]}."
  [name-prefix]
  (let [proj (create-test-project admin-request (str name-prefix "Proj"))
        tl   (-> (create-text-layer admin-request proj (str name-prefix "TL"))
                 :body :id)
        tkl  (-> (create-token-layer admin-request tl (str name-prefix "TKL"))
                 :body :id)
        vocab (-> (create-vocab-layer admin-request (str name-prefix "Vocab"))
                  :body :id)
        item  (-> (create-vocab-item admin-request vocab "greeting")
                  :body :id)
        _ (assert-no-content (link-vocab-to-project admin-request proj vocab))
        docs (vec
              (for [i (range 3)]
                (let [{:keys [doc token]}
                      (new-doc-with-token! proj tl tkl (str name-prefix "Doc" i))
                      link (-> (create-vocab-link admin-request item [token])
                               :body :id)]
                  {:doc doc :token token :link link})))]
    {:proj proj :vocab vocab :item item :docs docs}))

(deftest vocab-delete-bumps-affected-doc-versions
  (testing "vocab/delete bumps version of every doc that loses a vocab_link
            and emits one :doc-version-bump audit row per affected doc"
    (let [{:keys [vocab docs]} (setup-fixture! "VocabDel")
          pre-versions (mapv (comp doc-version :doc) docs)]
      (assert-no-content (delete-vocab-layer admin-request vocab))
      (let [post-versions (mapv (comp doc-version :doc) docs)]
        (is (= 3 (count docs)) "fixture has 3 docs")
        (doseq [[doc-info pre post] (map vector docs pre-versions post-versions)]
          (is (= (inc pre) post)
              (str "doc " (:doc doc-info) " version " pre " -> " post
                   " (expected +1)"))))
      (let [op-id (latest-op-id "vocab/delete")
            bumps (doc-bump-rows op-id)
            ;; target_id round-trips as a stringified UUID in the bumps
            ;; rows; normalize to strings for set membership.
            bumped-doc-ids (set (map (comp str :target_id) bumps))]
        (is (some? op-id) "vocab/delete op was recorded")
        (is (= 3 (count bumps))
            (str "expected 3 :doc-version-bump audit rows for vocab/delete, got "
                 (count bumps)))
        (doseq [{:keys [doc]} docs]
          (is (contains? bumped-doc-ids (str doc))
              (str "expected a :doc-version-bump row for doc " doc
                   ", got rows for " bumped-doc-ids)))))))

(deftest project-remove-vocab-bumps-affected-doc-versions
  (testing "project/remove-vocab bumps version of every doc in the project
            that loses a vocab_link and emits one :doc-version-bump audit
            row per affected doc"
    (let [{:keys [proj vocab docs]} (setup-fixture! "ProjRmVocab")
          pre-versions (mapv (comp doc-version :doc) docs)]
      (assert-no-content (unlink-vocab-from-project admin-request proj vocab))
      (let [post-versions (mapv (comp doc-version :doc) docs)]
        (doseq [[doc-info pre post] (map vector docs pre-versions post-versions)]
          (is (= (inc pre) post)
              (str "doc " (:doc doc-info) " version " pre " -> " post
                   " (expected +1)"))))
      (let [op-id (latest-op-id "project/remove-vocab")
            bumps (doc-bump-rows op-id)
            ;; target_id round-trips as a stringified UUID in the bumps
            ;; rows; normalize to strings for set membership.
            bumped-doc-ids (set (map (comp str :target_id) bumps))]
        (is (some? op-id) "project/remove-vocab op was recorded")
        (is (= 3 (count bumps))
            (str "expected 3 :doc-version-bump audit rows for project/remove-vocab, got "
                 (count bumps)))
        (doseq [{:keys [doc]} docs]
          (is (contains? bumped-doc-ids (str doc))
              (str "expected a :doc-version-bump row for doc " doc
                   ", got rows for " bumped-doc-ids)))))))

;; ---------------------------------------------------------------------------
;; Task #102.4 — :seq monotonicity for bump-document-versions!
;; ---------------------------------------------------------------------------
;; The per-op `:seq` counter in `psc/*op*` is a single atom; every
;; record-audit-write! pulls + bumps it, so within one op the seqs MUST
;; be contiguous [N, N+1, N+2, ...] — never sparse. If a future change
;; were to fire writes from a parallel scope (e.g. a background thread)
;; the seq could skip — this test pins down the invariant.

(deftest vocab-delete-bump-rows-have-contiguous-seq
  (testing "audit_writes rows for the bump-document-versions! batch carry
            CONTIGUOUS :seq values within the parent vocab/delete op"
    (let [{:keys [vocab]} (setup-fixture! "SeqMonoVocabDel")
          _ (assert-no-content (delete-vocab-layer admin-request vocab))
          op-id (latest-op-id "vocab/delete")
          ;; All audit_writes rows tagged to this op, in :seq order.
          all-rows (psc/q db {:select [:*] :from [:audit_writes]
                              :where [:= :op_id op-id]
                              :order-by [:seq]})
          all-seqs (mapv (comp long :seq) all-rows)
          ;; Restrict to the doc-version-bump rows (the subset the test
          ;; targets) — but the contiguity invariant must hold over the
          ;; entire op, since the seq counter is a single atom.
          bumps (filterv #(= "doc-version-bump" (:change_type %)) all-rows)
          bump-seqs (mapv (comp long :seq) bumps)]
      (is (seq bumps) "the op produced at least one bump row")
      ;; Whole op is contiguous from 0..N-1 (no gaps).
      (is (= (vec (range (count all-rows))) all-seqs)
          (str "Expected op seqs to be [0..N-1] contiguous; got " all-seqs))
      ;; The bump rows specifically are contiguous within their own
      ;; sub-range (since they're emitted in a tight doseq loop with no
      ;; other writes interleaved by bump-document-versions!).
      (when (> (count bump-seqs) 1)
        (is (= bump-seqs (vec (range (first bump-seqs)
                                     (+ (first bump-seqs) (count bump-seqs)))))
            (str "Expected bump rows to have contiguous :seq; got " bump-seqs))))))
