(ns plaid.rest-api.v1.batch-ref-test
  "A batch operation may use the id an earlier operation of the same batch
  created, so \"+ Create\" and the link it is for go in one transaction and a
  refused link leaves no entry behind (D4, V1 H1-6). The operation says where
  in its body each id goes, in `refs` beside the body, and the body is never
  searched, so user data shaped like `{\"$ref\": n}` is stored as it was sent
  (D19, REV-F-CORE-API REV-1). And an entry create no longer ignores the
  document-version a strict client stamps on it, without telling a caller
  who cannot read that document anything about it."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request user1-request with-admin with-test-users
                                    api-call assert-status assert-no-content with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-text-layer
                                        create-token-layer create-text create-token
                                        create-span-layer create-span
                                        create-vocab-layer link-vocab-to-project
                                        get-document]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- setup! []
  (let [proj (create-test-project admin-request "Refs")
        tl (-> (create-text-layer admin-request proj "T") :body :id)
        tkl (-> (create-token-layer admin-request tl "W") :body :id)
        sl (-> (create-span-layer admin-request tkl "S") :body :id)
        vocab (-> (create-vocab-layer admin-request "Lex") :body :id)
        _ (assert-no-content (link-vocab-to-project admin-request proj vocab))
        doc (-> (api-call admin-request {:method :post :path "/api/v1/documents"
                                         :body {:project-id proj :name "D"}})
                :body :id)
        text (-> (create-text admin-request tl doc "dog barks") :body :id)
        tok (-> (create-token admin-request tkl text 0 3) :body :id)]
    {:proj proj :vocab vocab :doc doc :tok tok :sl sl :tkl tkl :text text}))

(defn- version [doc] (-> (get-document admin-request doc) :body :document/version))

(defn- batch [ops]
  (api-call admin-request {:method :post :path "/api/v1/batch" :body ops}))

(defn- entries [vocab]
  (psc/q db {:select [:id :form] :from :vocab_items :where [:= :vocab_layer_id (str vocab)]}))

(defn- entry-id [vocab form]
  (->> (entries vocab) (filter #(= form (:form %))) first :id str))

(defn- entry-metadata [id]
  (:metadata (:body (api-call admin-request {:method :get :path (str "/api/v1/vocab-items/" id)}))))

(defn- link-items [doc]
  (set (map (comp str :vocab_item_id)
            (psc/q db {:select [:vocab_item_id] :from :vocab_links :where [:= :document_id (str doc)]}))))

(defn- create-entry [vocab form & [query metadata]]
  {:path (str "/api/v1/vocab-items" (or query "")) :method "POST"
   :body (cond-> {:vocab-layer-id vocab :form form}
           metadata (assoc :metadata metadata))})

(defn- link-to
  "A link to the entry `ref` stands for, `{:op n}` or `{:op n :index k}`."
  [ref tok & [query]]
  {:path (str "/api/v1/vocab-links" (or query "")) :method "POST"
   :body {:vocab-item nil :tokens [tok]}
   :refs [(assoc ref :at ["vocab-item"])]})

(deftest create-and-link-in-one-batch
  (let [{:keys [vocab doc tok]} (setup!)
        v (version doc)
        resp (batch [(create-entry vocab "dog" (str "?document-version=" v))
                     (link-to {:op 0} tok (str "?document-version=" v))])]
    (assert-status 200 resp)
    (let [new-id (str (get-in resp [:body 0 :body :id]))]
      (is (= #{new-id} (link-items doc)))
      (is (= [new-id] (map (comp str :id) (entries vocab)))))))

(deftest a-refused-link-leaves-no-entry-behind
  (let [{:keys [vocab doc tok]} (setup!)
        stale (dec (version doc))
        resp (batch [(create-entry vocab "dog" (str "?document-version=" stale))
                     (link-to {:op 0} tok (str "?document-version=" stale))])]
    (assert-status 409 resp)
    (is (empty? (entries vocab)))
    (is (empty? (link-items doc)))))

(deftest a-ref-into-a-bulk-create
  (let [{:keys [vocab doc tok]} (setup!)
        resp (batch [{:path "/api/v1/vocab-items/bulk" :method "POST"
                      :body [{:vocab-layer-id vocab :form "a"} {:vocab-layer-id vocab :form "b"}]}
                     (link-to {:op 0 :index 1} tok)])]
    (assert-status 200 resp)
    (is (= #{(entry-id vocab "b")} (link-items doc)))))

(deftest a-ref-through-a-list-index
  (let [{:keys [sl tok tkl text]} (setup!)
        resp (batch [{:path "/api/v1/tokens" :method "POST"
                      :body {:token-layer-id tkl
                             :text text
                             :begin 4 :end 9}}
                     {:path "/api/v1/spans" :method "POST"
                      :body {:span-layer-id sl :tokens [tok nil] :value "x"}
                      :refs [{:at ["tokens" 1] :op 0}]}])]
    (assert-status 200 resp)
    (let [new-tok (str (get-in resp [:body 0 :body :id]))
          span (str (get-in resp [:body 1 :body :id]))]
      (is (= #{(str tok) new-tok}
             (set (map (comp str :token_id)
                       (psc/q db {:select [:token_id] :from :span_tokens :where [:= :span_id span]}))))))))

(deftest a-ref-that-names-nothing-refuses-the-batch
  (let [{:keys [vocab doc tok]} (setup!)
        entry (create-entry vocab "x")
        with-refs (fn [refs] (assoc (link-to {:op 0} tok) :refs refs))]
    (doseq [[label ops] [["itself" [entry (link-to {:op 1} tok)]]
                         ["a later op" [entry (link-to {:op 5} tok)]]
                         ["a negative" [entry (link-to {:op -1} tok)]]
                         ["not a number" [entry (link-to {:op "0"} tok)]]
                         ["an index past the ids" [{:path "/api/v1/vocab-items/bulk" :method "POST"
                                                    :body [{:vocab-layer-id vocab :form "a"}]}
                                                   (link-to {:op 0 :index 1} tok)]]
                         ["an op that answered no id" [{:path (str "/api/v1/documents/" doc) :method "PATCH"
                                                        :body {:name "E"}}
                                                       (link-to {:op 0} tok)]]
                         ["a path to a value that is not null"
                          [entry (with-refs [{:at ["tokens"] :op 0}])]]
                         ["a path to no key" [entry (with-refs [{:at ["nothing"] :op 0}])]]
                         ["a path past a list's end" [entry (with-refs [{:at ["tokens" 3] :op 0}])]]
                         ["a key into a list" [entry (with-refs [{:at ["tokens" "a"] :op 0}])]]
                         ["an empty path" [entry (with-refs [{:at [] :op 0}])]]
                         ["refs that are not a list" [entry (with-refs {:at ["vocab-item"] :op 0})]]
                         ["a ref with no body" [entry {:path (str "/api/v1/documents/" doc) :method "DELETE"
                                                       :refs [{:at ["x"] :op 0}]}]]]]
      (testing label
        (assert-status 400 (batch ops))
        (is (empty? (entries vocab)))
        (is (empty? (link-items doc)))))))

(deftest data-shaped-like-a-ref-is-stored-as-sent
  (let [{:keys [proj vocab tok sl]} (setup!)
        shapes [{"$ref" 0} {"$ref" 0 "index" 0} {"$ref" "#/defs/tag"} {"$ref" 99}]
        metadata {"x" (first shapes) "all" shapes}]
    (testing "an entry created alone"
      (assert-status 201 (api-call admin-request {:method :post :path "/api/v1/vocab-items"
                                                  :body {:vocab-layer-id vocab :form "alone" :metadata metadata}}))
      (is (= metadata (entry-metadata (entry-id vocab "alone")))))
    (testing "an entry created after another in a batch, where op 0 answered an id"
      (assert-status 200 (batch [(create-entry vocab "first")
                                 (create-entry vocab "second" nil metadata)]))
      (is (= metadata (entry-metadata (entry-id vocab "second")))))
    (testing "beside a real ref in the same body"
      (assert-status 200 (batch [(create-entry vocab "third")
                                 (assoc (link-to {:op 0} tok) :body {:vocab-item nil :tokens [tok]
                                                                     :metadata metadata})]))
      (let [link (-> (psc/q db {:select [:id] :from :vocab_links
                                :where [:= :vocab_item_id (entry-id vocab "third")]})
                     first :id)]
        (is (= metadata (:metadata (:body (api-call admin-request {:method :get
                                                                   :path (str "/api/v1/vocab-links/" link)})))))))
    (testing "a config value, alone and in a batch"
      (let [path (str "/api/v1/projects/" proj "/config/t/schema")]
        (assert-no-content (api-call admin-request {:method :put :path path :body (nth shapes 2)}))
        (assert-status 200 (batch [(create-entry vocab "fourth")
                                   {:path path :method "PUT" :body {"$ref" 0}}]))
        (is (= {"$ref" 0}
               (get-in (api-call admin-request {:method :get :path (str "/api/v1/projects/" proj)})
                       [:body :config "t" "schema"])))))
    (testing "span metadata in a batch"
      (let [resp (batch [(create-entry vocab "fifth")
                         {:path "/api/v1/spans" :method "POST"
                          :body {:span-layer-id sl :tokens [tok] :value "v" :metadata metadata}}])
            span (get-in resp [:body 1 :body :id])]
        (assert-status 200 resp)
        (is (= metadata
               (:metadata (:body (api-call admin-request {:method :get :path (str "/api/v1/spans/" span)})))))))))

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
    (testing "a document that is gone is refused rather than skipped"
      (assert-status 409 (create (str "?document-version=" v "&document-id=" (random-uuid))))
      (assert-status 409 (api-call admin-request {:method :post
                                                  :path (str "/api/v1/vocab-items/bulk?document-version=" v
                                                             "&document-id=" (random-uuid))
                                                  :body [{:vocab-layer-id vocab :form "dog"}]}))
      (is (empty? (entries vocab))))
    (testing "the current version goes through, and so does no version"
      (assert-status 201 (create (str "?document-version=" v "&document-id=" doc)))
      (assert-status 201 (create "")))
    (testing "in a batch, a stamp with no document is left to the batch's other writes"
      (assert-status 200 (batch [(create-entry vocab "cat" (str "?document-version=" v))])))))

(deftest a-caller-who-cannot-read-the-document-learns-nothing-of-it
  ;; user1 writes to the vocabulary through a project of their own, and has
  ;; no access to the admin's project, where the document is.
  (let [{:keys [vocab doc]} (setup!)
        own (create-test-project user1-request "Mine")
        _ (assert-no-content (link-vocab-to-project admin-request own vocab))
        v (version doc)
        create (fn [q] (api-call user1-request {:method :post :path (str "/api/v1/vocab-items" q)
                                                :body {:vocab-layer-id vocab :form "probe"}}))]
    (assert-status 201 (create ""))
    (doseq [[label q] [["the current version" (str "?document-version=" v "&document-id=" doc)]
                       ["a stale version" (str "?document-version=" (dec v) "&document-id=" doc)]
                       ["a document that does not exist" (str "?document-version=" v "&document-id=" (random-uuid))]
                       ["a document named with no version" (str "?document-id=" doc)]]]
      (testing label
        (assert-status 403 (create q))
        (assert-status 403 (api-call user1-request {:method :post
                                                    :path (str "/api/v1/vocab-items/bulk" q)
                                                    :body [{:vocab-layer-id vocab :form "probe"}]}))))
    (is (= 1 (count (entries vocab))))))
