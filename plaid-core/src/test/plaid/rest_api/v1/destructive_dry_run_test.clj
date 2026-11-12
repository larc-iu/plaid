(ns plaid.rest-api.v1.destructive-dry-run-test
  "What a vocabulary delete, a project delete or an unlink would take is a
  read on a route of its own (GET .../deletion, .../unlinking), never the
  destructive request with a flag. Those once took `?dry-run=true` and wrote
  nothing, so a core or a client that did not know the flag deleted on the
  mere opening of a confirm. The DELETE routes now refuse any query parameter
  but the audit labels, so a page or a client from before that still sends
  `?dry-run=true` is told 400 and nothing is deleted."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db with-rest-handler
                                            with-admin with-test-users api-call admin-request]]
            [plaid.sql.common :as psc]
            [plaid.sql.project :as prj]
            [plaid.test-helpers :as h :refer [id]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- call [method path & [body]]
  (api-call admin-request (cond-> {:method method :path path} (some? body) (assoc :body body))))

(defn- n [table where] (:n (psc/q1 fix/db {:select [[[:count :*] :n]] :from [table] :where where})))

(defn- ops [] (n :operations [:= 1 1]))

(defn- world []
  (let [a (h/create-test-project admin-request "A")
        b (h/create-test-project admin-request "B")
        v (id (call :post "/api/v1/vocab-layers" {:name "V" :project-id a}))]
    (fix/assert-no-content (h/link-vocab-to-project admin-request b v))
    {:a a :b b :v v}))

(deftest the-reads-answer-what-would-go-and-write-nothing
  (let [{:keys [a b v]} (world)
        before (ops)]
    (is (= {:links 0} (:body (call :get (str "/api/v1/projects/" b "/vocabs/" v "/unlinking")))))
    (is (= 409 (:status (call :get (str "/api/v1/vocab-layers/" v "/deletion")))))
    (is (= 409 (:status (call :get (str "/api/v1/projects/" a "/deletion")))))
    (is (= 200 (:status (call :get (str "/api/v1/projects/" b "/deletion")))))
    (is (= before (ops)) "no operation written")
    (is (= 2 (n :project_vocabs [:= :vocab_layer_id v])))))

(deftest a-delete-sent-with-the-old-dry-run-flag-is-refused-and-deletes-nothing
  (let [{:keys [a b v]} (world)]
    (testing "unlink"
      (let [resp (call :delete (str "/api/v1/projects/" b "/vocabs/" v "?dry-run=true"))]
        (is (= 400 (:status resp)))
        (is (= "This request takes no query parameter dry-run." (-> resp :body :error))))
      (is (= 2 (n :project_vocabs [:= :vocab_layer_id v])) "still borrowed"))
    (testing "project delete, whatever the spelling"
      (doseq [q ["?dry-run=true" "?Dry-Run=1" "?audit-message=x&dry-run=true"]]
        (is (= 400 (:status (call :delete (str "/api/v1/projects/" b q)))) q))
      (is (nil? (:deleted_at (psc/fetch-by-id fix/db :projects b)))))
    (testing "the same inside a batch"
      (let [resp (api-call admin-request {:method :post :path "/api/v1/batch"
                                          :body [{:path (str "/api/v1/projects/" b "?dry-run=true") :method "DELETE"}]})]
        (is (not= 200 (:status resp)) (pr-str (:body resp))))
      (is (nil? (:deleted_at (psc/fetch-by-id fix/db :projects b)))))
    (testing "vocabulary delete"
      (fix/assert-no-content (call :delete (str "/api/v1/projects/" b "/vocabs/" v)))
      (is (= 400 (:status (call :delete (str "/api/v1/vocab-layers/" v "?dry-run=true")))))
      (is (= 1 (n :vocab_layers [:= :id v]))))
    (testing "the audit labels are still taken"
      (fix/assert-no-content (call :delete (str "/api/v1/vocab-layers/" v "?audit-message=Clean%20up")))
      (is (zero? (n :vocab_layers [:= :id v])))
      (fix/assert-no-content (call :delete (str "/api/v1/projects/" a "?audit-message=Gone&group-id=" (random-uuid))))
      (is (nil? (prj/get fix/db a)) "the project is gone"))))
