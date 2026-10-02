(ns plaid.rest-api.v1.batch-keyless-route-refusal-test
  "A write to a route that refuses an Idempotency-Key (login and logout,
  minting an API token or an invite, `/admin`, uploads, private user data,
  the service routes) cannot be an operation of a batch. A keyed batch would
  otherwise keep the answer, a secret among them, for 24 hours and replay it
  (H6-CORE-API-1). The batch is refused with a 400 before any of it runs,
  keyed or not."
  (:require [clojure.data.json :as json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db rest-handler admin-request
                                    with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db]]
            [plaid.rest-api.v1.idempotency :as idem-mw]
            [plaid.sql.common :as psc]
            [plaid.sql.idempotency :as idem]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        get-document update-document-metadata]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- batch
  "POST `ops` to /batch as admin, with Idempotency-Key `key` when given."
  [key ops]
  (let [req (cond-> (-> (admin-request :post "/api/v1/batch")
                        (mock/header "accept" "application/json")
                        (mock/json-body ops))
              key (mock/header "Idempotency-Key" key))
        resp (rest-handler req)]
    {:status (:status resp)
     :headers (:headers resp)
     :body (when-let [b (:body resp)]
             (let [s (if (string? b) b (slurp b))]
               (when-not (= "" s) (json/read-str s :key-fn keyword))))}))

(defn- count-rows [table]
  (-> (psc/q1 db {:select [[[:count :*] :n]] :from [table]}) :n))

(defn- meta-op [doc v]
  {:path (str "/api/v1/documents/" doc "/metadata") :method "put" :body {:k v}})

(defn- stored-k [doc]
  (-> (get-document admin-request doc) :body :metadata (get "k")))

(def ^:private refused-ops
  [["minting an API token" {:path "/api/v1/users/admin@example.com/tokens" :method "post" :body {:name "t"}}]
   ["minting an invite" {:path "/api/v1/invites" :method "POST" :body {}}]
   ["logging in" {:path "/api/v1/login" :method "post"
                  :body {:user-id "user1@example.com" :password "password1"}}]
   ["logging out" {:path "/api/v1/logout" :method "post"}]
   ["an admin action" {:path "/api/v1/admin/rate-limits" :method "delete"}]
   ["private user data" {:path "/api/v1/users/admin@example.com/data/x" :method "put" :body {:v 1}}]])

(deftest a-write-that-refuses-a-key-refuses-the-batch
  (let [proj (create-test-project admin-request "P")
        doc (create-test-document admin-request proj "D")]
    (update-document-metadata admin-request doc {:k "before"})
    (doseq [[label op] refused-ops
            key [nil (str (psc/new-uuid))]]
      (testing (str label (if key ", keyed" ", not keyed"))
        (let [tokens (count-rows :api_tokens)
              invites (count-rows :invites)
              r (batch key [(meta-op doc "after") op])]
          (is (= 400 (:status r)))
          (is (= (str "Operation 1 (" (.toUpperCase ^String (:method op)) " " (:path op)
                      ") cannot be part of a batch. Send it on its own.")
                 (-> r :body :error)))
          (is (= "before" (stored-k doc)) "the operation before it was not written")
          (is (= tokens (count-rows :api_tokens)) "no token was minted")
          (is (= invites (count-rows :invites)) "no invite was minted")
          (is (zero? (count-rows :idempotency_keys)) "no answer was kept"))))))

(deftest a-read-of-such-a-route-is-still-carried
  (let [proj (create-test-project admin-request "P")
        doc (create-test-document admin-request proj "D")
        r (batch (str (psc/new-uuid))
                 [(meta-op doc "after")
                  {:path "/api/v1/users/admin@example.com/tokens" :method "get"}])]
    (is (= 200 (:status r)))
    (is (= 200 (get-in r [:body 1 :status])))
    (is (= "after" (stored-k doc)))))

(deftest the-lock-routes-keep-their-own-refusal
  (let [proj (create-test-project admin-request "P")
        doc (create-test-document admin-request proj "D")
        r (batch nil [{:path (str "/api/v1/documents/" doc "/lock") :method "post"}])]
    (is (= 400 (:status r)))
    (is (re-find #"^Operation 0 takes or releases a document lock" (-> r :body :error)))))

(deftest an-answer-kept-before-the-refusal-is-not-replayed
  (let [ops [{:path "/api/v1/users/admin@example.com/tokens" :method "post" :body {:name "t"}}]
        k (str (psc/new-uuid))
        fp (idem-mw/fingerprint {:request-method :post :uri "/api/v1/batch" :body-params ops} true)]
    ;; A row as a keyed batch stored it before batches refused the mint.
    (idem/store! db "admin@example.com" k
                 {:fingerprint fp :method "POST" :path "/api/v1/batch" :status 200
                  :body (json/write-str [{:status 201 :body {:token "SECRET"}}])})
    (let [r (batch k ops)]
      (is (= 400 (:status r)))
      (is (nil? (get-in r [:headers "Idempotent-Replayed"])))
      (is (not (re-find #"SECRET" (pr-str (:body r))))))))
