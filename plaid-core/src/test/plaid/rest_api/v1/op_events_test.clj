(ns plaid.rest-api.v1.op-events-test
  "Regression coverage for op-attrs completeness on the event/audit
  surface:

  - Multi-document ops (vocab/delete, project/remove-vocab) bump N
    documents' versions but carried `:document nil`, so their audit
    events had an EMPTY :audit/documents — document-scoped listeners
    were never notified that their view went stale. The version-bump
    helpers now record every bumped doc into psaw/*op*'s
    :affected-documents, which ->audit-event-shape unions into the event.

  - Editor-config ops carried `:project nil` and `:user nil`, so the
    audit log couldn't answer 'who changed this layer's config' and the
    op never appeared in project-scoped audit queries. Both are now
    attributed."
  (:require [clojure.core.async :as async]
            [clojure.test :refer :all]
            [mount.core :as mount]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-created assert-ok assert-no-content
                                    assert-status with-clean-db]]
            [plaid.server.events :as events]
            [plaid.sql.audit-write :as psaw]
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
          "event names the document whose vocab_link was wiped (its version was bumped)")
      (is (contains? (set (map str (:audit/projects evt))) (str proj))
          "the event goes to the bumped document's project, although the op names none"))))

(deftest vocab-rename-event-reaches-the-linking-documents-projects
  ;; A vocabulary write carries `:project nil`. The bus fans out by project,
  ;; so without the bumped documents' projects nobody with the document open
  ;; hears the rename (REV-W3-REST C1).
  (let [proj (create-test-project admin-request "OpEvtRenameProj")
        doc (create-test-document admin-request proj "OpEvtRenameDoc")
        tl (-> (create-text-layer admin-request proj "OERTL") :body :id)
        text-id (-> (create-text admin-request tl doc "hello") :body :id)
        tkl (-> (create-token-layer admin-request tl "OERTKL") :body :id)
        tok (-> (create-token admin-request tkl text-id 0 5) :body :id)
        vid (-> (create-vocab-layer admin-request "OERVocab") :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vid))
        item (-> (create-vocab-item admin-request vid "hello") :body :id)
        _ (assert-created (create-vocab-link admin-request item [tok]))
        published (atom [])]
    (with-redefs [events/publish-audit-event!
                  (fn [op _audits _user-id] (swap! published conj op))]
      (assert-status 200 (update-vocab-layer admin-request vid {:name "OERVocab2"})))
    (let [evt (first (filter #(= :vocab/update (:op/type %)) @published))]
      (is (some? evt))
      (is (= #{(str doc)} (set (map str (:audit/documents evt)))))
      (is (= #{(str proj)} (set (map str (:audit/projects evt))))))))

(defn- linked-project!
  "A project with one document whose word links an entry of vocabulary `vid`."
  [vid item-form label]
  (let [proj (create-test-project admin-request label)
        doc (create-test-document admin-request proj (str label "Doc"))
        tl (-> (create-text-layer admin-request proj (str label "TL")) :body :id)
        text-id (-> (create-text admin-request tl doc "hello") :body :id)
        tkl (-> (create-token-layer admin-request tl (str label "TKL")) :body :id)
        tok (-> (create-token admin-request tkl text-id 0 5) :body :id)
        _ (assert-status 204 (link-vocab-to-project admin-request proj vid))
        item (-> (create-vocab-item admin-request vid item-form) :body :id)]
    (assert-created (create-vocab-link admin-request item [tok]))
    {:proj proj :doc doc}))

(deftest a-vocabulary-event-tells-each-project-only-its-own-documents
  ;; A vocabulary linked from two projects: its rename reaches both, and each
  ;; project's listeners hear only that project and its documents, so a reader
  ;; of one learns no id from the other (REV-W3F F3, HUNT-recent 11).
  (let [vid (-> (create-vocab-layer admin-request "OENVocab") :body :id)
        p (linked-project! vid "hello" "OENP")
        q (linked-project! vid "hullo" "OENQ")
        pid (parse-uuid (str (:proj p)))
        qid (parse-uuid (str (:proj q)))
        p-chan (async/chan 10)
        q-chan (async/chan 10)
        audit-event (fn [ch]
                      (loop []
                        (let [[e c] (async/alts!! [ch (async/timeout 3000)])]
                          (cond (not= c ch) nil
                                (= "vocab:update" (some-> e :audit/ops first :op/type)) e
                                :else (recur)))))]
    (mount/start #'events/client-registry #'events/event-bus)
    (events/register-client! pid p-chan)
    (events/register-client! qid q-chan)
    (try
      (assert-status 200 (update-vocab-layer admin-request vid {:name "OENVocab2"}))
      (let [pe (audit-event p-chan)
            qe (audit-event q-chan)]
        (is (some? pe) "P's listener hears the rename")
        (is (some? qe) "Q's listener hears the rename")
        (is (= #{(str (:proj p))} (set (map str (:audit/projects pe)))))
        (is (= #{(str (:doc p))} (set (map str (:audit/documents pe)))))
        (is (= #{(str (:proj q))} (set (map str (:audit/projects qe)))))
        (is (= #{(str (:doc q))} (set (map str (:audit/documents qe)))))
        (is (not-any? #(re-find #"(?i)by-project" (name %)) (keys (events/wire-payload pe)))
            "the routing key stays off the wire"))
      (finally
        (events/unregister-client! pid p-chan)
        (events/unregister-client! qid q-chan)
        (mount/stop #'events/event-bus #'events/client-registry)))))

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
