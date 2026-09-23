(ns plaid.sql.vocab-doc-version-bump-test
  "Task #72: vocab/delete and project/remove-vocab wipe vocab_links across
  many documents. Because their op-attrs carry `:document nil`, the post-
  body `bump-document-version!` hook doesn't fire — so OCC clients editing
  the affected documents weren't told their view was stale.

  Fix: both ops now collect the distinct `document_ids` of the vocab_links
  they're about to delete and call `bump-document-versions!` (plural) from
  `plaid.sql.operation`, which emits one `:doc-version-bump` audit row per
  affected document. Replay parity preserved.

  The same rule binds every writer that renames or removes an ENTRY, which
  the original fix missed: a deep document read embeds the entry's `form` on
  each vocab_link, so `vocab-item/merge` restates those documents and
  `vocab-item/delete` / `bulk-delete` remove rows from them, all under ops
  carrying `:document nil`. Those cases are covered below."
  (:require [clojure.data.json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.audit-write :as psaw]
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
                                        update-vocab-item
                                        delete-vocab-item
                                        bulk-delete-vocab-items
                                        bulk-update-vocab-items
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

(defn- assert-bumped!
  "Every doc in `docs` went up by exactly one, and the op carries one
  :doc-version-bump audit row naming each of them."
  [op-type docs pre-versions]
  (let [post-versions (mapv (comp doc-version :doc) docs)]
    (doseq [[doc-info pre post] (map vector docs pre-versions post-versions)]
      (is (= (inc pre) post)
          (str "doc " (:doc doc-info) " version " pre " -> " post
               " (expected +1)"))))
  (let [op-id (latest-op-id op-type)
        bumps (doc-bump-rows op-id)
        bumped-doc-ids (set (map (comp str :target_id) bumps))]
    (is (some? op-id) (str op-type " op was recorded"))
    (is (= (count docs) (count bumps))
        (str "expected " (count docs) " :doc-version-bump audit rows for "
             op-type ", got " (count bumps)))
    (doseq [{:keys [doc]} docs]
      (is (contains? bumped-doc-ids (str doc))
          (str "expected a :doc-version-bump row for doc " doc
               ", got rows for " bumped-doc-ids)))))

(deftest vocab-item-rename-bumps-linked-doc-versions
  (testing "vocab-item/merge bumps every document that links the renamed
            entry: the deep read embeds the entry's form on each link, so
            those bodies are stale even though nothing in them changed"
    (let [{:keys [item docs]} (setup-fixture! "ItemRename")
          pre-versions (mapv (comp doc-version :doc) docs)]
      (update-vocab-item admin-request item "salutation")
      (assert-bumped! "vocab-item/merge" docs pre-versions))))

(deftest vocab-item-rename-to-same-form-bumps-nothing
  (testing "a PATCH setting the form the entry already has restates no
            document, so it must not bump every document that links it"
    (let [{:keys [item docs]} (setup-fixture! "ItemNoop")
          pre-versions (mapv (comp doc-version :doc) docs)]
      (update-vocab-item admin-request item "greeting")
      (is (= pre-versions (mapv (comp doc-version :doc) docs))
          "an unchanged form left every linked document's version alone")
      (is (empty? (doc-bump-rows (latest-op-id "vocab-item/merge")))
          "and emitted no :doc-version-bump audit rows"))))

(deftest vocab-item-delete-bumps-linked-doc-versions
  (testing "vocab-item/delete bumps every document that loses a vocab_link"
    (let [{:keys [item docs]} (setup-fixture! "ItemDel")
          pre-versions (mapv (comp doc-version :doc) docs)]
      (delete-vocab-item admin-request item)
      (assert-bumped! "vocab-item/delete" docs pre-versions))))

(deftest vocab-item-bulk-delete-bumps-linked-doc-versions
  (testing "vocab-item/bulk-delete bumps every document that loses a
            vocab_link, across every entry in the call"
    (let [{:keys [item docs]} (setup-fixture! "ItemBulkDel")
          pre-versions (mapv (comp doc-version :doc) docs)]
      (bulk-delete-vocab-items admin-request [item])
      (assert-bumped! "vocab-item/bulk-delete" docs pre-versions))))

(deftest vocab-item-bulk-merge-bumps-only-the-renamed
  (testing "vocab-item/bulk-merge bumps the linked documents of an entry
            whose form really changes, and of no other entry in the call:
            a metadata-only patch, or a form rewritten to itself, restates
            nothing"
    (let [{:keys [vocab item docs]} (setup-fixture! "ItemBulkMerge")
          quiet (-> (create-vocab-item admin-request vocab "other") :body :id)
          pre-versions (mapv (comp doc-version :doc) docs)]
      ;; One real rename, one no-op form, one metadata-only patch.
      (bulk-update-vocab-items admin-request
                               [{:id item :form "salutation"}
                                {:id quiet :form "other" :metadata [{:op "set" :path ["pos"] :value "N"}]}])
      (assert-bumped! "vocab-item/bulk-merge" docs pre-versions)))
  (testing "a bulk update that renames nothing bumps nothing"
    (let [{:keys [item docs]} (setup-fixture! "ItemBulkMergeNoop")
          pre-versions (mapv (comp doc-version :doc) docs)]
      (bulk-update-vocab-items admin-request
                               [{:id item :form "greeting" :metadata [{:op "set" :path ["pos"] :value "N"}]}])
      (is (= pre-versions (mapv (comp doc-version :doc) docs))
          "an unchanged form left every linked document's version alone")
      (is (empty? (doc-bump-rows (latest-op-id "vocab-item/bulk-merge")))
          "and emitted no :doc-version-bump audit rows"))))

(defn- header-versions
  "The X-Document-Versions map on a response, keyed by document id string."
  [response]
  (some-> (get-in response [:headers "X-Document-Versions"])
          (clojure.data.json/read-str)))

(deftest an-entry-write-tells-the-client-the-new-versions
  (testing "a rename and a delete both report every bumped document in
            X-Document-Versions: a strict-mode client holds versions for the
            document it has open, and without the header its next write there
            is refused for a change it made itself"
    (let [{:keys [item docs]} (setup-fixture! "ItemHeader")
          expected (into {} (map (fn [{:keys [doc]}]
                                   [(str doc) (inc (doc-version doc))]))
                         docs)
          renamed (update-vocab-item admin-request item "salutation")]
      (is (= expected (header-versions renamed))
          "the rename response names every document that links the entry")
      (let [after-rename (into {} (map (fn [{:keys [doc]}]
                                         [(str doc) (inc (doc-version doc))]))
                               docs)
            deleted (delete-vocab-item admin-request item)]
        (is (= after-rename (header-versions deleted))
            "and so does the delete, on a 204 with no body to carry them")))))

;; ---------------------------------------------------------------------------
;; Task #102.4 — :seq monotonicity for bump-document-versions!
;; ---------------------------------------------------------------------------
;; The per-op `:seq` counter in `psaw/*op*` is a single atom; every
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
