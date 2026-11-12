(ns plaid.rest-api.v1.vocab-move-test
  "Moving a vocabulary to another project (POST /vocab-layers/:id/move): the
  target becomes its home, the old home keeps it linked as a borrower,
  rights follow the new home, the operation is under the old home, and no
  document is bumped."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db with-rest-handler
                                            with-admin with-test-users api-call admin-request user1-request]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h :refer [id]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} (some? body) (assoc :body body))))

(defn- links [pid]
  (set (map :vocab_layer_id (psc/q fix/db {:select [:vocab_layer_id] :from [:project_vocabs] :where [:= :project_id pid]}))))

(defn- version [doc] (:version (psc/q1 fix/db {:select [:version] :from [:documents] :where [:= :id doc]})))

(deftest a-move-gives-the-vocabulary-a-new-home
  (let [a (h/create-test-project admin-request "A")
        b (h/create-test-project admin-request "B")
        v (id (call admin-request :post "/api/v1/vocab-layers" {:name "Lex" :project-id a}))
        kai (id (h/create-vocab-item admin-request v "kai"))
        tl (id (h/create-text-layer admin-request a "T"))
        tkl (id (h/create-token-layer admin-request tl "W"))
        doc (h/create-test-document admin-request a "D")
        text (id (h/create-text admin-request tl doc "kai"))
        tok (id (h/create-token admin-request tkl text 0 3))
        _ (id (h/create-vocab-link admin-request kai [tok]))
        doc-version (version doc)]
    (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" a "/writers/user1@example.com")))
    (testing "a writer of A writes entries before the move"
      (is (= 201 (:status (call user1-request :post "/api/v1/vocab-items" {:vocab-layer-id v :form "a1"}))))
      (is (= 200 (:status (call user1-request :put (str "/api/v1/vocab-items/" kai "/metadata") {"g" "1"})))))
    (let [resp (call admin-request :post (str "/api/v1/vocab-layers/" v "/move") {:project-id b})]
      (is (= 200 (:status resp)))
      (is (= (str b) (str (-> resp :body :vocab/project)))))
    (testing "B is the home, A keeps it linked as a borrower"
      (is (contains? (links b) v))
      (is (contains? (links a) v))
      (is (= (str b) (str (:project_id (psc/q1 fix/db {:select [:project_id] :from [:vocab_layers] :where [:= :id v]})))))
      (is (= [{:id a :name "A"}] (mapv #(update % :id (comp parse-uuid str))
                                       (:body (call admin-request :get (str "/api/v1/vocab-layers/" v "/borrowers")))))
          "A's own row is a borrower now"))
    (testing "rights follow the new home: A's writer reads and changes no entry"
      (is (= 200 (:status (call user1-request :get (str "/api/v1/vocab-layers/" v)))))
      (is (= 403 (:status (call user1-request :post "/api/v1/vocab-items" {:vocab-layer-id v :form "a2"}))))
      (is (= 403 (:status (call user1-request :put (str "/api/v1/vocab-items/" kai "/metadata") {"g" "2"})))))
    (testing "no document is bumped"
      (is (= doc-version (version doc))))
    (testing "the operation is under the old home, says where it went, and B's Activity lists later changes"
      (let [op (psc/q1 fix/db {:select [:project_id :description] :from [:operations] :where [:= :op_type "vocab/move"]})]
        (is (= (str a) (str (:project_id op))))
        (is (= "Move vocabulary “Lex” to project “B”" (:description op))))
      (fix/assert-ok (call admin-request :patch (str "/api/v1/vocab-layers/" v) {:name "Lex 2"}))
      (is (= (str b) (str (:project_id (psc/q1 fix/db {:select [:project_id] :from [:operations] :where [:= :op_type "vocab/update"]}))))))
    (testing "a move to its current home writes nothing"
      (let [n (:n (psc/q1 fix/db {:select [[[:count :*] :n]] :from [:operations]}))]
        (is (= 200 (:status (call admin-request :post (str "/api/v1/vocab-layers/" v "/move") {:project-id b}))))
        (is (= n (:n (psc/q1 fix/db {:select [[[:count :*] :n]] :from [:operations]}))))))
    (testing "B cannot be deleted while A borrows it, nor unlink its own, and A can unlink it"
      (is (= 409 (:status (call admin-request :delete (str "/api/v1/projects/" b)))))
      (is (= 409 (:status (call admin-request :delete (str "/api/v1/projects/" b "/vocabs/" v)))))
      (is (= 204 (:status (call admin-request :delete (str "/api/v1/projects/" a "/vocabs/" v)))))
      (is (= 204 (:status (call admin-request :delete (str "/api/v1/projects/" b))))))))

(deftest a-move-to-a-project-that-does-not-exist
  (let [a (h/create-test-project admin-request "A")
        v (id (call admin-request :post "/api/v1/vocab-layers" {:name "Lex" :project-id a}))]
    (is (= 400 (:status (call admin-request :post (str "/api/v1/vocab-layers/" v "/move") {:project-id (random-uuid)}))))
    (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" a "/maintainers/user1@example.com")))
    (is (= 403 (:status (call user1-request :post (str "/api/v1/vocab-layers/" v "/move") {:project-id (random-uuid)}))))))
