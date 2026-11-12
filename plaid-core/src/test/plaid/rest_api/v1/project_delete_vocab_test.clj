(ns plaid.rest-api.v1.project-delete-vocab-test
  "Deleting a project deletes its own vocabularies, and is refused while
  another project borrows one (for everyone, admins included). The dry run
  names the vocabularies the delete takes. The background removal takes them
  with their entries, metadata and comments. The history purge keeps the
  history a vocabulary made in the project before it moved away."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db with-rest-handler
                                            with-admin api-call admin-request]]
            [plaid.server.project-removal :as removal]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h :refer [id]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} (some? body) (assoc :body body))))

(defn- n [table where]
  (:n (psc/q1 fix/db {:select [[[:count :*] :n]] :from [table] :where where})))

(defn- vocab! [pid vname]
  (id (call admin-request :post "/api/v1/vocab-layers" {:name vname :project-id pid})))

(deftest a-borrower-blocks-the-delete-of-the-home
  (let [a (h/create-test-project admin-request "A")
        b (h/create-test-project admin-request "B")
        c (h/create-test-project admin-request "C")
        v (vocab! a "Lex")
        w (vocab! a "Other")]
    (fix/assert-no-content (h/link-vocab-to-project admin-request b v))
    (fix/assert-no-content (h/link-vocab-to-project admin-request c w))
    (doseq [path [(str "/api/v1/projects/" a) (str "/api/v1/projects/" a "?dry-run=true")]]
      (let [resp (call admin-request :delete path)]
        (is (= 409 (:status resp)) path)
        (is (= {:error "2 other projects use a vocabulary of this project." :other-projects 2} (:body resp)) path)))
    (is (= 2 (n :vocab_layers [:= :project_id a])) "nothing was taken")
    (is (nil? (:deleted_at (psc/fetch-by-id fix/db :projects a))))
    (testing "deleting a borrower is never refused for that"
      (is (= 204 (:status (call admin-request :delete (str "/api/v1/projects/" b)))))
      (is (= 1 (n :project_vocabs [:= :vocab_layer_id v]))))))

(deftest the-delete-takes-the-projects-own-vocabularies
  (let [a (h/create-test-project admin-request "A")
        b (h/create-test-project admin-request "B")
        v (vocab! a "Lex")
        kai (id (call admin-request :post "/api/v1/vocab-items" {:vocab-layer-id v :form "kai" :metadata {"g" "x"}}))
        other (vocab! b "Theirs")]
    (fix/assert-no-content (h/link-vocab-to-project admin-request a other))
    (is (= 201 (:status (call admin-request :post "/api/v1/comments" {:entity-type "vocab-item" :entity-id kai :body "hi"}))))
    (is (= {:vocabularies [{:id v :name "Lex"}]}
           (update (:body (call admin-request :delete (str "/api/v1/projects/" a "?dry-run=true")))
                   :vocabularies (partial mapv #(update % :id (comp parse-uuid str))))))
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" a)))
    (is (zero? (n :vocab_layers [:= :id v])))
    (is (zero? (n :vocab_items [:= :id kai])))
    (is (zero? (n :entity_metadata [:= :entity_id (str kai)])))
    (is (zero? (n :comments [:= :vocab_layer_id v])))
    (testing "a vocabulary it borrowed stays in its home"
      (is (= 1 (n :vocab_layers [:= :id other])))
      (is (= #{(str b)} (set (map (comp str :project_id) (psc/q fix/db {:select [:project_id] :from [:project_vocabs]
                                                                        :where [:= :vocab_layer_id other]}))))))))

(deftest the-purge-keeps-the-history-a-moved-vocabulary-made
  (reset! removal/purge-history? true)
  (try
    (let [a (h/create-test-project admin-request "A")
          b (h/create-test-project admin-request "B")
          moved (vocab! a "Moved")
          stays (vocab! a "Stays")
          _ (id (call admin-request :post "/api/v1/vocab-items" {:vocab-layer-id moved :form "kai"}))
          _ (fix/assert-ok (call admin-request :patch (str "/api/v1/vocab-layers/" moved) {:name "Moved 2"}))
          _ (id (call admin-request :post "/api/v1/vocab-items" {:vocab-layer-id stays :form "kaj"}))
          moved-history (fn [] (set (map :op_id (psc/q fix/db {:select [:op_id] :from [:audit_writes]
                                                               :where [:= :vocab_layer_id moved]}))))
          before (moved-history)]
      (is (= 3 (count before)) "create, an entry and a rename")
      (fix/assert-ok (call admin-request :post (str "/api/v1/vocab-layers/" moved "/move") {:project-id b}))
      (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" a "/vocabs/" moved)))
      (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" a)))
      (is (zero? (n :projects [:= :id a])))
      (testing "the moved vocabulary's history before the move is kept"
        (is (every? (moved-history) before))
        (is (= 200 (:status (call admin-request :get (str "/api/v1/vocab-layers/" moved "/audit"))))))
      (testing "the history of the vocabulary that went with the project went too"
        (is (zero? (n :audit_writes [:= :vocab_layer_id stays]))))
      (testing "and nothing else of A's history but its delete"
        (is (= ["project/delete"] (mapv :op_type (psc/q fix/db {:select [:op_type] :from [:operations]
                                                                :where [:and [:= :project_id a]
                                                                        [:not [:exists {:select [1] :from [:audit_writes]
                                                                                        :where [:and [:= :audit_writes.op_id :operations.id]
                                                                                                [:= :audit_writes.vocab_layer_id moved]]}]]]}))))))
    (finally (reset! removal/purge-history? false))))
