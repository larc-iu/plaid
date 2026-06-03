(ns plaid.sql.bulk-create-audit-test
  "Regression test for bug #4: span/bulk-create must emit :insert audit
  rows whose post_image folds the `span_tokens` junction state under
  `:tokens` (matching single-row span/create).

  Because the history replayer treats an :insert as a full put (replace),
  a bulk-created span that is never subsequently updated would land in
  the history with NO tokens if the :insert audit row didn't carry them —
  even though the OLTP `span_tokens` table has them. This test drives
  the real REST bulk-create path, inspects the emitted audit rows, and
  feeds them through the replayer to confirm the resulting history doc
  carries `:tokens` (the unqualified junction key the history read API
  depends on)."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.history.replayer :as replayer]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request assert-created assert-ok with-admin with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- insert-audit-rows-for-spans
  "Fetch the :insert audit_writes rows against :spans for the given ids,
  keyed by target_id. next.jdbc reads the TEXT id columns back as UUID
  objects, and the REST `:ids` are UUIDs too, so we key by UUID."
  [span-ids]
  (let [rows (psc/q db {:select [:aw.*]
                        :from [[:audit_writes :aw]]
                        :where [:and
                                [:= :aw.target_table "spans"]
                                [:= :aw.change_type "insert"]
                                [:in :aw.target_id (mapv str span-ids)]]})]
    (into {} (map (fn [r] [(:target_id r) r])) rows)))

(deftest bulk-create-spans-insert-audit-folds-tokens
  (let [proj (create-test-project admin-request "BulkAuditProj")
        doc  (create-test-document admin-request proj "BulkAuditDoc")
        tl   (-> (create-text-layer admin-request proj "BTL") :body :id)
        tid  (-> (create-text admin-request tl doc "abcdefgh") :body :id)
        tkl  (-> (create-token-layer admin-request tl "BTKL") :body :id)
        t1   (-> (create-token admin-request tkl tid 0 2) :body :id)
        t2   (-> (create-token admin-request tkl tid 2 4) :body :id)
        t3   (-> (create-token admin-request tkl tid 4 6) :body :id)
        t4   (-> (create-token admin-request tkl tid 6 8) :body :id)
        sl   (-> (create-span-layer admin-request tkl "BSL") :body :id)
        ;; Two single-token spans + one multi-token span. None of these
        ;; is ever updated afterwards, so the :insert audit row is the
        ;; ONLY record the history will ever see for them.
        spans [{:span-layer-id sl :tokens [t1] :value "A"}
               {:span-layer-id sl :tokens [t2 t3] :value "BC"}
               {:span-layer-id sl :tokens [t4] :value "D" :metadata {"k" "v"}}]
        res  (bulk-create-spans admin-request spans)
        _    (assert-created res)
        ids  (-> res :body :ids)
        expected-tokens {(first ids)  [(str t1)]
                         (second ids) [(str t2) (str t3)]
                         (nth ids 2)  [(str t4)]}]
    (is (= 3 (count ids)))

    (testing "each bulk-created span got an :insert audit row folding :tokens"
      (let [by-id (insert-audit-rows-for-spans ids)]
        (is (= 3 (count by-id))
            "exactly one :insert audit row per bulk-created span")
        (doseq [id ids]
          (let [row  (clojure.core/get by-id id)
                post (psc/read-json (:post_image row))]
            (is (some? row) (str "audit row present for " id))
            (is (= (clojure.core/get expected-tokens id) (:tokens post))
                (str "post_image for " id " folds the ordered token list under :tokens"))))
        ;; The span carrying metadata folds it into the same :insert row.
        (let [meta-row  (clojure.core/get by-id (nth ids 2))
              meta-post (psc/read-json (:post_image meta-row))]
          ;; psc/read-json keywordizes keys, so {"k" "v"} round-trips as
          ;; {:k "v"} here. The point is that the metadata is PRESENT in
          ;; the :insert post_image (not lost), which is what bug #4 is
          ;; about for the metadata-bearing span.
          (is (= {:k "v"} (:metadata meta-post))
              "metadata folded into the :insert post_image"))))

    (testing "replaying the :insert audit row yields an history doc with :tokens"
      (let [by-id (insert-audit-rows-for-spans ids)
            id    (second ids) ; multi-token span
            row   (clojure.core/get by-id id)
            [op-kw _table doc-out] (replayer/audit-row->tx-op row)]
        (is (= :put-docs op-kw) ":insert replays as a full put-docs")
        ;; Junction key passes through unqualified, coerced to UUIDs.
        (is (= [t2 t3] (:tokens doc-out))
            "replayed history doc carries the ordered :tokens vector")
        (is (= id (:xt/id doc-out)))))))
