(ns plaid.sql.audit-document-attribution-test
  "audit_writes.document_id is the scoping column for as-of
  reconstruction (XTDB-removal plan, Phase 1): a missing stamp = a row
  invisible to time travel. It is stamped from the row's OWN image, not
  the op's :document — the op-level attribution is nil for
  multi-document cascade ops (project/delete, vocab/delete), which is
  exactly where the rows matter most."
  (:require [clojure.test :refer :all]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-created assert-no-content with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- doc-stamps
  "All (target_table, change_type, document_id) triples for audit rows
  targeting `target-id`."
  [target-id]
  (psc/q db {:select [:target_table :change_type :document_id]
             :from [:audit_writes]
             :where [:= :target_id (str target-id)]
             :order-by [:ts :seq]}))

(deftest audit-rows-carry-their-documents-id
  (let [proj (create-test-project admin-request "AuditDocAttrProj")
        doc (create-test-document admin-request proj "AuditDocAttrDoc")
        tl (-> (create-text-layer admin-request proj "ADATL") :body :id)
        text-id (-> (create-text admin-request tl doc "hello world") :body :id)
        tkl (-> (create-token-layer admin-request tl "ADATKL") :body :id)
        tok (-> (create-token admin-request tkl text-id 0 5) :body :id)]

    (testing "ordinary doc-scoped writes stamp the document"
      (is (= [(str doc)] (distinct (map (comp str :document_id) (doc-stamps tok))))
          "token rows carry the document id"))

    (testing "doc-version-bump rows stamp via the documents special case"
      (let [bumps (filter #(= "doc-version-bump" (:change_type %)) (doc-stamps doc))]
        (is (seq bumps))
        (is (= [(str doc)] (distinct (map (comp str :document_id) bumps))))))

    (testing "non-document-scoped rows stay NULL"
      (is (= [nil] (distinct (map :document_id (doc-stamps proj))))
          "project rows (incl. synthetic ACL folds) carry no document")
      (is (= [nil] (distinct (map :document_id (doc-stamps tkl))))
          "layer rows carry no document"))

    (testing "cascade rows under a NULL-document op are still stamped"
      ;; project/delete carries :document nil but cascade-deletes every
      ;; entity in every document — THE case op-level attribution loses
      ;; (demonstrated by the spike: a project-deleted doc reconstructed
      ;; as alive). The row's image carries the truth.
      (assert-no-content (api-call admin-request
                                   {:method :delete :path (str "/api/v1/projects/" proj)}))
      (let [tok-rows (doc-stamps tok)
            delete-row (last tok-rows)]
        (is (= "delete" (:change_type delete-row))
            "the cascade delete row exists")
        (is (= (str doc) (str (:document_id delete-row)))
            "and is stamped with the token's document despite the op's nil :document")))))
