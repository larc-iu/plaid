(ns plaid.rest-api.v1.misc-test
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db
                                    with-mount-states with-rest-handler admin-request
                                    assert-ok
                                    with-admin with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest health-endpoint
  (testing "GET /health returns 200 with status"
    (let [res (get-health)]
      (assert-ok res)
      (is (= "healthy" (-> res :body :status)))
      (is (some? (-> res :body :timestamp))))))

(deftest info-endpoint
  (testing "GET /info reports the limits, unauthenticated"
    (let [res (get-info)
          limits (-> res :body :limits)]
      (assert-ok res)
      ;; The limits that are code constants are always reported. The ones that
      ;; come from configuration are reported when configured and omitted when
      ;; not, so a client reads absence as "unknown" rather than as zero.
      (doseq [k [:batch-operations :metadata-depth :metadata-key-count
                 :metadata-string-length :metadata-total-bytes
                 :user-data-value-bytes]]
        (is (pos-int? (get limits k)) (str k " should be a positive number")))
      (doseq [[k v] limits]
        (is (pos-int? v) (str k " should be a positive number, not " (pr-str v))))
      (is (not-any? nil? (vals limits)) "an unset limit is omitted, never null"))))

(deftest openapi-endpoint
  (testing "GET /openapi.json returns valid spec structure"
    (let [res (get-openapi admin-request)]
      (assert-ok res)
      (is (some? (-> res :body :openapi)))
      (is (some? (-> res :body :paths)))
      (is (some? (-> res :body :info))))))
