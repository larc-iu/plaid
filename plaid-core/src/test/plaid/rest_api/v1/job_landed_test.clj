(ns plaid.rest-api.v1.job-landed-test
  "What a job worker asks after a lost answer or a crash: which of the writes
  it sent under a seed landed (`POST /jobs/{id}/landed`). Every operation
  keeps the Idempotency-Key it was sent with (`operations.request_key`), for
  as long as the audit log is kept, so the answer is exact at any time."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            admin-request]]
            [plaid.rest-api.v1.job-helpers :as jh :refer [as call start! job-id claim!]]
            [plaid.sql.common :as psc]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- keyed
  "Send `method path body` as `who` with Idempotency-Key `k`. The status."
  [who k method path body]
  (:status (fix/rest-handler (cond-> (mock/header (who method path) "Idempotency-Key" k)
                               body (mock/json-body body)))))

(defn- landed [who j refs]
  (call who :post (str "/api/v1/jobs/" j "/landed") {:refs refs}))

(defn- seed [] (str (random-uuid)))

(deftest the-keys-of-the-writes-that-landed
  (let [{:keys [p] :as world} (jh/world!)
        j (job-id (start! (:st world) p))
        token (as (-> (claim! jh/worker-a) :body :token))
        s1 (seed)
        s2 (seed)]
    (is (= 201 (keyed token (str s1 ".0") :post "/api/v1/documents" {:project-id p :name "one"})))
    (is (= 200 (keyed token (str s1 ".1") :post "/api/v1/batch"
                      [{:path "/api/v1/documents" :method "POST" :body {:project-id p :name "two"}}
                       {:path "/api/v1/documents" :method "POST" :body {:project-id p :name "three"}}])))
    (testing "a write core refused left nothing"
      (is (= 400 (keyed token (str s1 ".2") :post "/api/v1/documents" {:project-id p}))))
    (testing "a key under a longer seed is not one of the seed's"
      (is (= 201 (keyed token (str s1 "0.0") :post "/api/v1/documents" {:project-id p :name "four"}))))
    (testing "the same write sent again is answered from the first, and lands once"
      (is (= 201 (keyed token (str s1 ".0") :post "/api/v1/documents" {:project-id p :name "one"}))))
    (let [r (landed admin-request j [s1 s2])]
      (is (= 200 (:status r)))
      (is (= [(str s1 ".0") (str s1 ".1")] (-> r :body :keys))))
    (testing "every operation of a keyed batch keeps its key"
      (is (= 2 (count (psc/q fix/db {:select [:id] :from [:operations]
                                     :where [:= :request_key (str s1 ".1")]})))))
    (testing "the job's own token asks too"
      (is (= [(str s1 ".0") (str s1 ".1")] (-> (landed token j [s1]) :body :keys))))
    (testing "a seed nothing was sent under"
      (is (= [] (-> (landed admin-request j [s2]) :body :keys))))))

(deftest nothing-of-another-user-or-project
  (let [{:keys [p q] :as world} (jh/world!)
        _ (jh/grant! q "writers" "starter@example.com")
        j (job-id (start! (:st world) p))
        s1 (seed)
        s2 (seed)]
    (is (= 201 (keyed admin-request (str s1 ".0") :post "/api/v1/documents" {:project-id p :name "admin's"})))
    (is (= 201 (keyed (:st world) (str s2 ".0") :post "/api/v1/documents" {:project-id q :name "elsewhere"})))
    (is (= [] (-> (landed admin-request j [s1 s2]) :body :keys))
        "another user's write in the project, and the starter's in another project")))

(deftest who-may-ask
  (let [{:keys [p q] :as world} (jh/world!)
        j (job-id (start! (:st world) p))
        _ (claim! jh/worker-a)
        _ (jh/grant! q "writers" "starter@example.com")
        _ (jh/finish! j jh/worker-a "done")
        other (job-id (start! (:st world) q))
        other-token (as (-> (claim! jh/worker-b) :body :token))]
    (testing "a person of any role, a delegated token, and another job's token are refused"
      (doseq [who [:st :m :r :n :s]]
        (is (= 403 (:status (landed (world who) j [(seed)]))) (name who)))
      (is (= 403 (:status (landed other-token j [(seed)])))))
    (testing "an unknown job"
      (is (= 404 (:status (landed admin-request "0197d1a0-0000-7000-8000-0000000000ff" [(seed)])))))
    (testing "the refs are one to a thousand"
      (is (= 400 (:status (landed admin-request other []))))
      (is (= 400 (:status (landed admin-request other (vec (repeatedly 1001 seed))))))
      (is (= 200 (:status (landed admin-request other (vec (repeatedly 1000 seed)))))))))
