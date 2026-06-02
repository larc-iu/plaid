(ns plaid.rest-api.v1.query-test
  "REST-level tests for POST /api/v1/query: endpoint wiring, auth, response
  envelope, and error->status mapping. The deep query/ACL semantics are covered
  in plaid.sql.query.exec-test; here we prove the HTTP surface."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [ring.mock.request :as mock]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request user1-request user2-request]]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- build-corpus! [pname]
  (let [pid (h/create-test-project admin-request pname)
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl   (id (h/create-span-layer admin-request tokl "pos"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb cc"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))
        t2 (id (h/create-token admin-request tokl text 6 8))]
    {:pid pid
     :noun0 (id (h/create-span admin-request sl [t0] "NOUN"))
     :verb1 (id (h/create-span admin-request sl [t1] "VERB"))}))

(def ^:private noun-verb-query
  {:find ["?s1" "?s2"]
   :where [["span" "?s1" {"layer" "pos" "value" "NOUN"}]
           ["span" "?s2" {"layer" "pos" "value" "VERB"}]
           ["covers" "?s1" "?t1"] ["covers" "?s2" "?t2"]
           ["precedes" "?t1" "?t2"]]})

(deftest query-endpoint-happy-path
  (let [{:keys [noun0 verb1]} (build-corpus! "P1")
        resp (api-call admin-request {:method :post :path "/api/v1/query" :body noun-verb-query})]
    (fix/assert-status 200 resp)
    (is (= ["s1" "s2"] (-> resp :body :columns)))
    (is (= 1 (-> resp :body :count)))
    (is (= [[(str noun0) (str verb1)]]
           (mapv (fn [t] (mapv str t)) (-> resp :body :results))))))

(deftest query-endpoint-rejects-bad-query
  (build-corpus! "P1")
  (testing "unbound find var -> 400 with a message"
    (let [resp (api-call admin-request
                         {:method :post :path "/api/v1/query"
                          :body {:find ["?nope"] :where [["span" "?s" {"layer" "pos"}]]}})]
      (fix/assert-status 400 resp)
      (is (string? (-> resp :body :error)))))
  (testing "as-of -> 400"
    (let [resp (api-call admin-request
                         {:method :post :path "/api/v1/query"
                          :body (assoc noun-verb-query :as-of "2020-01-01")})]
      (fix/assert-status 400 resp))))

(deftest query-endpoint-requires-auth
  (testing "no bearer token -> 401"
    (let [resp (api-call (fn [m p] (-> (mock/request m p)
                                       (mock/header "accept" "application/edn")))
                         {:method :post :path "/api/v1/query" :body noun-verb-query})]
      (is (= 401 (:status resp))))))

(deftest query-endpoint-acl
  (let [c1 (build-corpus! "P1")
        c2 (build-corpus! "P2")]
    (h/add-project-reader admin-request (:pid c1) "user1@example.com")
    (h/add-project-reader admin-request (:pid c2) "user2@example.com")
    (testing "each reader only sees their own project's match over HTTP"
      (let [r1 (api-call user1-request {:method :post :path "/api/v1/query" :body noun-verb-query})
            r2 (api-call user2-request {:method :post :path "/api/v1/query" :body noun-verb-query})]
        (is (= 1 (-> r1 :body :count)))
        (is (= 1 (-> r2 :body :count)))
        (is (not= (-> r1 :body :results) (-> r2 :body :results)))))))
