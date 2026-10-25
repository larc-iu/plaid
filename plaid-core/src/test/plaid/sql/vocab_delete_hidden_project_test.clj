(ns plaid.sql.vocab-delete-hidden-project-test
  "R39: a vocabulary delete writes no audit rows for the links that sit in a
  project already being deleted, since nothing can travel back to that
  project. The links still go, and the purge never reaches rows written
  under an operation with no project, so audited ones would stay for good
  (FX-STALL finding 5). Links in live projects and the vocabulary's own
  delete stay audited."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-no-content with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.sql.project :as prj]
            [plaid.server.project-removal :as removal]
            [plaid.test-helpers :refer [create-test-project create-text-layer create-token-layer
                                        create-text create-token create-vocab-layer
                                        create-vocab-item create-vocab-link delete-vocab-layer
                                        link-vocab-to-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- project-with-link!
  "A project granted `vocab`, with one document whose one token links `item`."
  [pname vocab item]
  (let [proj (create-test-project admin-request pname)
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tkl (-> (create-token-layer admin-request tl "TKL") :body :id)
        _ (assert-no-content (link-vocab-to-project admin-request proj vocab))
        doc (-> (api-call admin-request {:method :post :path "/api/v1/documents"
                                         :body {:project-id proj :name "Doc"}})
                :body :id)
        text (-> (create-text admin-request tl doc "hello world") :body :id)
        tok (-> (create-token admin-request tkl text 0 5) :body :id)
        link (-> (create-vocab-link admin-request item [tok]) :body :id)]
    {:proj proj :doc doc :link link}))

(defn- op-rows [op-type]
  (let [op-id (:id (psc/q1 db {:select [:id] :from [:operations]
                               :where [:= :op_type op-type]
                               :order-by [[:ts :desc]] :limit 1}))]
    (psc/q db {:select [:target_table :target_id :change_type :document_id]
               :from [:audit_writes] :where [:= :op_id op-id]})))

(deftest a-vocab-delete-audits-no-link-in-a-project-being-deleted
  (let [vocab (-> (create-vocab-layer admin-request "Shared") :body :id)
        item (-> (create-vocab-item admin-request vocab "greeting") :body :id)
        doomed (project-with-link! "Doomed" vocab item)
        live (project-with-link! "Live" vocab item)]
    ;; The delete's first step alone, as the background removal has not yet
    ;; reached the documents.
    (is (:success (prj/delete db (:proj doomed) "admin@example.com")))
    (assert-no-content (delete-vocab-layer admin-request vocab))
    (let [rows (op-rows "vocab/delete")
          names? (fn [{:keys [link doc]}]
                   (some #(or (= (str link) (str (:target_id %)))
                              (= (str doc) (str (:target_id %)))
                              (= (str doc) (str (:document_id %))))
                         rows))]
      (testing "nothing under the vocab/delete names the hidden project's link or document"
        (is (not (names? doomed)) (pr-str rows)))
      (testing "the live project's link delete and version bump stay audited"
        (is (some #(and (= "vocab_links" (:target_table %)) (= "delete" (:change_type %))
                        (= (str (:link live)) (str (:target_id %))))
                  rows))
        (is (some #(and (= "doc-version-bump" (:change_type %))
                        (= (str (:doc live)) (str (:target_id %))))
                  rows)))
      (testing "the vocabulary's own delete stays audited"
        (is (some #(and (= "vocab_layers" (:target_table %)) (= "delete" (:change_type %))) rows))))
    (testing "both links are gone"
      (is (empty? (psc/q db {:select [:id] :from [:vocab_links]
                             :where [:in :id [(:link doomed) (:link live)]]}))))
    (testing "the removal still finishes the hidden project"
      (removal/remove-project! db (:proj doomed))
      (is (false? (prj/hidden? db (:proj doomed))))
      (is (empty? (psc/q db {:select [:id] :from [:documents] :where [:= :id (:doc doomed)]}))))))
