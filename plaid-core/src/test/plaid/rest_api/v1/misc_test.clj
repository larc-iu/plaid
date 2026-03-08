(ns plaid.rest-api.v1.misc-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-xtdb
                                    with-mount-states with-rest-handler admin-request
                                    assert-ok
                                    with-admin]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-xtdb with-mount-states with-rest-handler with-admin)

(deftest health-endpoint
  (testing "GET /health returns 200 with status"
    (let [res (get-health)]
      (assert-ok res)
      (is (= "healthy" (-> res :body :status)))
      (is (some? (-> res :body :timestamp))))))

(deftest openapi-endpoint
  (testing "GET /openapi.json returns valid spec structure"
    (let [res (get-openapi admin-request)]
      (assert-ok res)
      (is (some? (-> res :body :openapi)))
      (is (some? (-> res :body :paths)))
      (is (some? (-> res :body :info))))))
