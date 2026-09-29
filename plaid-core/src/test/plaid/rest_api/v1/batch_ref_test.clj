(ns plaid.rest-api.v1.batch-ref-test
  "A batch operation's body may use the id an earlier operation of the same
  batch created (`{\"$ref\": n}`), so \"+ Create\" and the link it is for go in
  one transaction and a refused link leaves no entry behind (D4, V1 H1-6).
  And an entry create no longer ignores the document-version a strict client
  stamps on it."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-test-users
                                    api-call assert-status assert-no-content with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-text-layer
                                        create-token-layer create-text create-token
                                        create-vocab-layer link-vocab-to-project
                                        get-document]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- setup! []
  (let [proj (create-test-project admin-request "Refs")
        tl (-> (create-text-layer admin-request proj "T") :body :id)
        tkl (-> (create-token-layer admin-request tl "W") :body :id)
        vocab (-> (create-vocab-layer admin-request "Lex") :body :id)
        _ (assert-no-content (link-vocab-to-project admin-request proj vocab))
        doc (-> (api-call admin-request {:method :post :path "/api/v1/documents"
                                         :body {:project-id proj :name "D"}})
                :body :id)
        text (-> (create-text admin-request tl doc "dog barks") :body :id)
        tok (-> (create-token admin-request tkl text 0 3) :body :id)]
    {:vocab vocab :doc doc :tok tok}))

(defn- version [doc] (-> (get-document admin-request doc) :body :document/version))

(defn- batch [ops]
  (api-call admin-request {:method :post :path "/api/v1/batch" :body ops}))

(defn- entries [vocab]
  (psc/q db {:select [:id :form] :from :vocab_items :where [:= :vocab_layer_id (str vocab)]}))

(defn- link-items [doc]
  (set (map (comp str :vocab_item_id)
            (psc/q db {:select [:vocab_item_id] :from :vocab_links :where [:= :document_id (str doc)]}))))

(defn- create-entry [vocab form & [query]]
  {:path (str "/api/v1/vocab-items" (or query "")) :method "POST"
   :body {:vocab-layer-id vocab :form form}})

(defn- link-to [ref tok & [query]]
  {:path (str "/api/v1/vocab-links" (or query "")) :method "POST"
   :body {:vocab-item ref :tokens [tok]}})

(deftest create-and-link-in-one-batch
  (let [{:keys [vocab doc tok]} (setup!)
        v (version doc)
        resp (batch [(create-entry vocab "dog" (str "?document-version=" v))
                     (link-to {"$ref" 0} tok (str "?document-version=" v))])]
    (assert-status 200 resp)
    (let [new-id (str (get-in resp [:body 0 :body :id]))]
      (is (= #{new-id} (link-items doc)))
      (is (= [new-id] (map (comp str :id) (entries vocab)))))))

(deftest a-refused-link-leaves-no-entry-behind
  (let [{:keys [vocab doc tok]} (setup!)
        stale (dec (version doc))
        resp (batch [(create-entry vocab "dog" (str "?document-version=" stale))
                     (link-to {"$ref" 0} tok (str "?document-version=" stale))])]
    (assert-status 409 resp)
    (is (empty? (entries vocab)))
    (is (empty? (link-items doc)))))

(deftest a-ref-into-a-bulk-create
  (let [{:keys [vocab doc tok]} (setup!)
        resp (batch [{:path "/api/v1/vocab-items/bulk" :method "POST"
                      :body [{:vocab-layer-id vocab :form "a"} {:vocab-layer-id vocab :form "b"}]}
                     (link-to {"$ref" 0 "index" 1} tok)])]
    (assert-status 200 resp)
    (let [b-id (->> (entries vocab) (filter #(= "b" (:form %))) first :id str)]
      (is (= #{b-id} (link-items doc))))))

(deftest a-ref-that-names-nothing-refuses-the-batch
  (let [{:keys [vocab doc tok]} (setup!)]
    (doseq [[label ops] [["itself" [(create-entry vocab "x") (link-to {"$ref" 1} tok)]]
                         ["a later op" [(create-entry vocab "x") (link-to {"$ref" 5} tok)]]
                         ["a negative" [(create-entry vocab "x") (link-to {"$ref" -1} tok)]]
                         ["not a number" [(create-entry vocab "x") (link-to {"$ref" "0"} tok)]]
                         ["an index past the ids" [{:path "/api/v1/vocab-items/bulk" :method "POST"
                                                    :body [{:vocab-layer-id vocab :form "a"}]}
                                                   (link-to {"$ref" 0 "index" 1} tok)]]
                         ["an op that answered no id" [{:path (str "/api/v1/documents/" doc) :method "PATCH"
                                                        :body {:name "E"}}
                                                       (link-to {"$ref" 0} tok)]]]]
      (testing label
        (assert-status 400 (batch ops))
        (is (empty? (entries vocab)))
        (is (empty? (link-items doc)))))))

(deftest a-map-of-another-shape-is-not-a-ref
  (let [{:keys [vocab]} (setup!)
        resp (batch [(create-entry vocab "x")
                     {:path "/api/v1/vocab-items" :method "POST"
                      :body {:vocab-layer-id vocab :form "y" :metadata {"note" {"$ref" 0 "other" 1}}}}])]
    (assert-status 200 resp)
    (let [y (->> (entries vocab) (filter #(= "y" (:form %))) first :id)
          stored (:body (api-call admin-request {:method :get :path (str "/api/v1/vocab-items/" y)}))]
      (is (= {"$ref" 0 "other" 1} (get-in stored [:metadata "note"]))))))

(deftest an-entry-create-checks-the-version-it-is-stamped-with
  (let [{:keys [vocab doc]} (setup!)
        v (version doc)
        create (fn [q] (api-call admin-request {:method :post :path (str "/api/v1/vocab-items" q)
                                                :body {:vocab-layer-id vocab :form "dog"}}))]
    (testing "a stale version for the document named is refused"
      (assert-status 409 (create (str "?document-version=" (dec v) "&document-id=" doc)))
      (is (empty? (entries vocab))))
    (testing "the bulk create too"
      (assert-status 409 (api-call admin-request {:method :post
                                                  :path (str "/api/v1/vocab-items/bulk?document-version=" (dec v) "&document-id=" doc)
                                                  :body [{:vocab-layer-id vocab :form "dog"}]}))
      (is (empty? (entries vocab))))
    (testing "a version with no document is refused rather than ignored"
      (assert-status 400 (create (str "?document-version=" v)))
      (is (empty? (entries vocab))))
    (testing "the current version goes through, and so does no version"
      (assert-status 201 (create (str "?document-version=" v "&document-id=" doc)))
      (assert-status 201 (create "")))
    (testing "in a batch, a stamp with no document is left to the batch's other writes"
      (assert-status 200 (batch [(create-entry vocab "cat" (str "?document-version=" v))])))))
