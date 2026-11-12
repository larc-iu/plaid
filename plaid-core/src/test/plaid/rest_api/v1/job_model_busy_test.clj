(ns plaid.rest-api.v1.job-model-busy-test
  "`GET /jobs/model-busy?pool=NAME` (CONTRACT 3.14): the requests to connected
  services that declare `model-pool` NAME in their extras, unfinished, and
  when the last one finished. A service with no pool, or another, is not
  counted."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [org.httpkit.server :as http-kit]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            admin-request user1-request]]
            [plaid.rest-api.v1.job-helpers :refer [call]]
            [plaid.server.events :as events]
            [plaid.test-helpers :as h :refer [with-rpc-state-started]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users
  with-rpc-state-started)
(use-fixtures :each with-clean-db)

(defn- live-ch []
  (reify http-kit/Channel
    (open? [_] true)
    (send! [_ _] true)
    (send! [_ _ _] true)))

(defn- service! [project service-id extras]
  (events/register-service-channel! project service-id (live-ch)
                                    {:service-name service-id :description "" :extras extras}
                                    "admin@example.com"))

(defn- busy [pool]
  (:body (call admin-request :get (str "/api/v1/jobs/model-busy?pool=" pool))))

(deftest counts-the-requests-of-services-in-the-pool
  (let [p (h/create-test-project admin-request "Busy P")
        q (h/create-test-project admin-request "Busy Q")]
    (service! p "assist" {:model-pool "reallms" :delegation true})
    (service! q "translate" {:model-pool "reallms"})
    (service! p "parse" {})
    (service! p "other" {:model-pool "local"})
    (is (= {:in-flight 0 :last-finished-at nil} (busy "reallms")) "nothing yet")
    (events/track-request! "r1" nil p "assist" "user1@example.com")
    (events/track-request! "r2" nil q "translate" "user1@example.com")
    (events/track-request! "r3" nil p "parse" "user1@example.com")
    (events/track-request! "r4" nil p "other" "user1@example.com")
    (testing "two in flight, across projects, and none of another pool or none"
      (is (= {:in-flight 2 :last-finished-at nil} (busy "reallms")))
      (is (= 1 (:in-flight (busy "local"))))
      (is (= 0 (:in-flight (busy "none")))))
    (testing "a finished request is no longer in flight and says when it ended"
      (events/finish-request! "r1" "result" {})
      (let [b (busy "reallms")]
        (is (= 1 (:in-flight b)))
        (is (string? (:last-finished-at b)))))
    (testing "a request to a service with no pool finishing says nothing"
      (events/finish-request! "r2" "result" {})
      (let [before (busy "local")]
        (events/finish-request! "r3" "error" {})
        (is (= before (busy "local")))))
    (testing "the latest finish is the one given"
      (let [first-end (:last-finished-at (busy "reallms"))]
        (Thread/sleep 5)
        (events/track-request! "r5" nil p "assist" "user1@example.com")
        (events/finish-request! "r5" "result" {})
        (is (pos? (compare (:last-finished-at (busy "reallms")) first-end)))))
    (testing "a service that disconnects is not counted"
      (events/track-request! "r6" nil q "translate" "user1@example.com")
      (is (= 1 (:in-flight (busy "reallms"))))
      (events/unregister-service-channel! q "translate" (events/get-service-channel q "translate"))
      (is (= 0 (:in-flight (busy "reallms")))))))

(deftest the-pool-is-required-and-the-route-is-the-admins
  (is (= 400 (:status (call admin-request :get "/api/v1/jobs/model-busy"))))
  (is (= 403 (:status (call user1-request :get "/api/v1/jobs/model-busy?pool=reallms")))))
