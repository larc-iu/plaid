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

(defn- names-any? [rows {:keys [link doc]}]
  (some #(or (= (str link) (str (:target_id %)))
             (= (str doc) (str (:target_id %)))
             (= (str doc) (str (:document_id %))))
        rows))

(deftest an-entry-delete-counts-and-audits-no-link-in-a-project-being-deleted
  (let [vocab (-> (create-vocab-layer admin-request "Shared") :body :id)
        item (-> (create-vocab-item admin-request vocab "greeting") :body :id)
        doomed (project-with-link! "Doomed" vocab item)
        live (project-with-link! "Live" vocab item)
        del (fn [n] (api-call admin-request {:method :delete
                                             :path (str "/api/v1/vocab-items/" item "?expected-link-count=" n)}))]
    (is (:success (prj/delete db (:proj doomed) "admin@example.com")))
    (testing "the count a reader sees leaves the hidden project's link out, and the refusal says so"
      (let [resp (del 2)]
        (is (= 409 (:status resp)))
        (is (= 1 (get-in resp [:body :links])))))
    (testing "the delete given that count lands"
      (assert-no-content (del 1)))
    (let [rows (op-rows "vocab-item/delete")]
      (testing "nothing under the vocab-item/delete names the hidden project's link or document"
        (is (not (names-any? rows doomed)) (pr-str rows)))
      (testing "the live project's link delete stays audited"
        (is (some #(and (= "vocab_links" (:target_table %)) (= "delete" (:change_type %))
                        (= (str (:link live)) (str (:target_id %))))
                  rows))))
    (testing "both links are gone"
      (is (empty? (psc/q db {:select [:id] :from [:vocab_links]
                             :where [:in :id [(:link doomed) (:link live)]]}))))))

(deftest a-bulk-entry-delete-audits-no-link-in-a-project-being-deleted
  (let [vocab (-> (create-vocab-layer admin-request "Shared") :body :id)
        item (-> (create-vocab-item admin-request vocab "greeting") :body :id)
        doomed (project-with-link! "Doomed" vocab item)
        live (project-with-link! "Live" vocab item)]
    (is (:success (prj/delete db (:proj doomed) "admin@example.com")))
    (assert-no-content (api-call admin-request {:method :delete :path "/api/v1/vocab-items/bulk" :body [item]}))
    (let [rows (op-rows "vocab-item/bulk-delete")]
      (is (not (names-any? rows doomed)) (pr-str rows))
      (is (names-any? rows live)))
    (is (empty? (psc/q db {:select [:id] :from [:vocab_links]
                           :where [:in :id [(:link doomed) (:link live)]]})))))

(deftest renames-config-writes-and-restores-bump-no-document-in-a-project-being-deleted
  ;; PB-17: a write that restates the documents linking an entry or a
  ;; vocabulary bumps only those of live projects, so it leaves no audit row
  ;; for a hidden project's document, which the purge never reaches
  (let [vocab (-> (create-vocab-layer admin-request "Shared") :body :id)
        item (-> (create-vocab-item admin-request vocab "greeting") :body :id)
        doomed (project-with-link! "Doomed" vocab item)
        live (project-with-link! "Live" vocab item)
        before (do (Thread/sleep 5) (str (java.time.Instant/now)))
        _ (Thread/sleep 5)
        version (fn [{:keys [doc]}] (:version (psc/q1 db {:select [:version] :from [:documents] :where [:= :id doc]})))
        doomed-version (version doomed)]
    (is (:success (prj/delete db (:proj doomed) "admin@example.com")))
    (doseq [[op-type write] [["vocab-item/merge"
                              #(api-call admin-request {:method :patch :path (str "/api/v1/vocab-items/" item)
                                                        :body {:form "hello"}})]
                             ["vocab-item/bulk-merge"
                              #(api-call admin-request {:method :patch :path "/api/v1/vocab-items/bulk"
                                                        :body [{:id item :form "hi"}]})]
                             ["vocab/update"
                              #(api-call admin-request {:method :patch :path (str "/api/v1/vocab-layers/" vocab)
                                                        :body {:name "Shared words"}})]
                             ["layer/assoc-editor-config-pair"
                              #(api-call admin-request {:method :put
                                                        :path (str "/api/v1/vocab-layers/" vocab "/config/plaid/note")
                                                        :body "x"})]
                             ["vocab-item/restore"
                              #(api-call admin-request {:method :post
                                                        :path (str "/api/v1/vocab-layers/" vocab "/items/" item
                                                                   "/restore?as-of=" (java.net.URLEncoder/encode before "UTF-8"))})]]]
      (testing op-type
        (let [res (write)]
          (is (< (:status res) 300) (pr-str res)))
        (let [rows (op-rows op-type)]
          (is (not (names-any? rows doomed)) (pr-str rows))
          (is (some #(and (= "doc-version-bump" (:change_type %)) (= (str (:doc live)) (str (:target_id %)))) rows)
              (pr-str rows)))
        (is (= doomed-version (version doomed)))))
    (is (= "greeting" (:form (psc/q1 db {:select [:form] :from [:vocab_items] :where [:= :id item]}))))))
