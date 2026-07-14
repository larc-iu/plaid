(ns plaid.rest-api.v1.rate-limit-test
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.rest-api.v1.rate-limit :as rate-limit]))

(defn- reset-rate-limit [f]
  (rate-limit/reset-all!)
  (try (f) (finally (rate-limit/reset-all!))))

(use-fixtures :each reset-rate-limit)

(deftest global-pruning-is-rate-limited
  (let [prune-count (atom 0)
        original (var-get #'rate-limit/prune-all!)
        request {:remote-addr "192.0.2.1"}]
    (with-redefs-fn {#'rate-limit/prune-all!
                     (fn [buckets now]
                       (swap! prune-count inc)
                       (original buckets now))}
      #(do
         (rate-limit/record-failure! request "first" 100000)
         (rate-limit/record-failure! request "second" 100001)
         (is (= 2 @prune-count)
             "The first failure sweeps both maps; the second only prunes its active buckets")
         (rate-limit/record-failure! request "third" 160000)
         (is (= 4 @prune-count)
             "Both maps are swept again after the interval")))))

(deftest active-bucket-still-expires-between-global-sweeps
  (let [request {:remote-addr "192.0.2.2"}]
    (dotimes [n 10]
      (rate-limit/record-failure! request "user" n))
    (is (rate-limit/over-limit? request "user" 10))
    (rate-limit/record-failure! request "user" 900001)
    (is (not (rate-limit/over-limit? request "user" 900001)))))
