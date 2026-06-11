(ns plaid.rest-api.v1.op-events-test
  "Regression coverage for op-attrs completeness on the event/audit
  surface:

  - Multi-document ops (vocab/delete, project/remove-vocab) bump N
    documents' versions but carried `:document nil`, so their audit
    events had an EMPTY :audit/documents — document-scoped listeners
    were never notified that their view went stale. The version-bump
    helpers now record every bumped doc into psc/*op*'s
    :affected-documents, which ->v2-shape unions into the event.

  - Editor-config ops carried `:project nil` and `:user nil`, so the
    audit log couldn't answer 'who changed this layer's config' and the
    op never appeared in project-scoped audit queries. Both are now
    attributed."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.server.events :as events]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- set-text-layer-config [user-request-fn layer-id editor key value]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/text-layers/" layer-id "/config/" editor "/" key)
                             :body value}))

(defn- remove-text-layer-config [user-request-fn layer-id editor key]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/text-layers/" layer-id "/config/" editor "/" key)}))

(deftest vocab-delete-event-names-affected-documents
  (let [proj (create-test-project admin-request "OpEvtProj")
        doc (create-test-document admin-request proj "OpEvtDoc")
        tl (-> (create-text-layer admin-request proj "OETL") :body :id)
        text-id (-> (create-text admin-request tl doc "hello world") :body :id)
        tkl (-> (create-token-layer admin-request tl "OETKL") :body :id)
        tok-res (create-token admin-request tkl text-id 0 5)
        tok (-> tok-res :body :id)
        _ (assert-created tok-res)
        vid (-> (create-vocab-layer admin-request "OEVocab") :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vid))
        item (-> (create-vocab-item admin-request vid "hello") :body :id)
        link-res (create-vocab-link admin-request item [tok])
        _ (assert-created link-res)
        published (atom [])]
    (with-redefs [events/publish-audit-event!
                  (fn [op _audits _user-id] (swap! published conj op))]
      (assert-no-content (delete-vocab-layer admin-request vid)))
    (let [evt (first (filter #(= :vocab/delete (:op/type %)) @published))]
      (is (some? evt) "vocab/delete event published")
      (is (contains? (set (map str (:audit/documents evt))) (str doc))
          "event names the document whose vocab_link was wiped (its version was bumped)"))))

(deftest editor-config-op-attributed-to-project-and-actor
  (let [proj (create-test-project admin-request "OpEvtCfgProj")
        tl (-> (create-text-layer admin-request proj "OECfgTL") :body :id)]
    (assert-no-content (set-text-layer-config admin-request tl "test-editor" "some-key" "v"))
    (let [op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:= :op_type "layer/assoc-editor-config-pair"]
                         :order-by [[:ts :desc]] :limit 1})]
      (is (some? op) "config op recorded")
      (is (= (str proj) (str (:project_id op)))
          "op attributed to the layer's project")
      (is (= "admin@example.com" (str (:user_id op)))
          "op attributed to the acting user"))
    (assert-no-content (remove-text-layer-config admin-request tl "test-editor" "some-key"))
    (let [op (psc/q1 db {:select [:*] :from [:operations]
                         :where [:= :op_type "layer/dissoc-editor-config-pair"]
                         :order-by [[:ts :desc]] :limit 1})]
      (is (= (str proj) (str (:project_id op))))
      (is (= "admin@example.com" (str (:user_id op)))))))
