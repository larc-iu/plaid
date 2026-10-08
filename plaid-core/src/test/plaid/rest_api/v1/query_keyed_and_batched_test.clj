(ns plaid.rest-api.v1.query-keyed-and-batched-test
  "A query sent with an Idempotency-Key, or carried inside a batch, is
  answered as it is on its own (H9-ACL-2: both answered 500). A query writes
  nothing, so a key on it changes nothing and no key row is kept. In a batch
  it reads what the batch's earlier operations wrote, as a read in a batch
  does, and a query the batch cannot run refuses the whole batch."
  (:require [clojure.data.json :as json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db rest-handler admin-request
                                    with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- send!
  "POST `body` to `path` as the admin, with Idempotency-Key `key` when
  given. Answers {:status :headers :body}."
  [path body & [key]]
  (let [req (cond-> (-> (admin-request :post path)
                        (mock/header "accept" "application/json")
                        (mock/json-body body))
              key (mock/header "Idempotency-Key" key))
        resp (rest-handler req)]
    {:status (:status resp)
     :headers (:headers resp)
     :body (when-let [b (:body resp)]
             (let [s (if (string? b) b (slurp b))]
               (when-not (= "" s) (json/read-str s :key-fn keyword))))}))

(defn- id [resp] (-> resp :body :id))

(defn- corpus! []
  (let [pid (h/create-test-project admin-request "Q")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        sl (id (h/create-span-layer admin-request tokl "pos"))
        doc (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "aa bb"))
        t0 (id (h/create-token admin-request tokl text 0 2))
        t1 (id (h/create-token admin-request tokl text 3 5))]
    {:sl sl :t0 t0 :t1 t1
     :noun (id (h/create-span admin-request sl [t0] "NOUN"))}))

(defn- spans-valued [v]
  {:find ["?s"] :where [["span" "?s" {"value" v}]]})

(defn- key-rows []
  (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:idempotency_keys]})))

(deftest a-keyed-query-is-answered
  (let [{:keys [noun]} (corpus!)
        k "query-key-0001"]
    (doseq [attempt ["first" "again with the same key"]]
      (testing attempt
        (let [resp (send! "/api/v1/query" (spans-valued "NOUN") k)]
          (is (= 200 (:status resp)) (str (:body resp)))
          (is (= [[(str noun)]] (-> resp :body :results)))
          (is (nil? (get-in resp [:headers "Idempotent-Replayed"]))))))
    (is (zero? (key-rows)) "a query keeps no key row")
    (testing "a bad query with a key is the usual 400"
      (is (= 400 (:status (send! "/api/v1/query" {:find ["?nope"] :where [["span" "?s" {}]]} k)))))))

(deftest a-query-in-a-batch-is-answered
  (let [{:keys [sl t1 noun]} (corpus!)]
    (testing "alone in a batch"
      (let [resp (send! "/api/v1/batch" [{:path "/api/v1/query" :method "post" :body (spans-valued "NOUN")}])]
        (is (= 200 (:status resp)) (str (:body resp)))
        (is (= [[(str noun)]] (-> resp :body first :body :results)))))
    (testing "after a write in the same batch, which it reads"
      (let [resp (send! "/api/v1/batch"
                        [{:path "/api/v1/spans" :method "post"
                          :body {:span-layer-id sl :tokens [t1] :value "VERB"}}
                         {:path "/api/v1/query" :method "post" :body (spans-valued "VERB")}])
            [made found] (:body resp)]
        (is (= 200 (:status resp)) (str (:body resp)))
        (is (= [[(-> made :body :id)]] (-> found :body :results)))))
    (testing "in a keyed batch, answered and replayed"
      (let [k "batch-key-0001"
            ops [{:path "/api/v1/query" :method "post" :body (spans-valued "NOUN")}]
            first-resp (send! "/api/v1/batch" ops k)
            again (send! "/api/v1/batch" ops k)]
        (is (= 200 (:status first-resp)) (str (:body first-resp)))
        (is (= [[(str noun)]] (-> first-resp :body first :body :results)))
        (is (= 200 (:status again)))
        (is (= "true" (get-in again [:headers "Idempotent-Replayed"])))))
    (testing "a bad query refuses the batch and its write rolls back"
      (let [before (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:spans]}))
            resp (send! "/api/v1/batch"
                        [{:path "/api/v1/spans" :method "post"
                          :body {:span-layer-id sl :tokens [t1] :value "ADJ"}}
                         {:path "/api/v1/query" :method "post" :body {:find ["?nope"] :where [["span" "?s" {}]]}}])]
        (is (= 400 (:status resp)) (str (:body resp)))
        (is (= before (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:spans]}))))))))
