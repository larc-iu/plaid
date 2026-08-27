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
         ;; One global sweep = one prune-all! per bucket map, and there are
         ;; three: per-(ip,user), per-ip, and per-ip invite attempts. What
         ;; this test pins is the CADENCE — a sweep happens once per
         ;; interval, not once per attempt — so the counts move in steps of
         ;; three, not that the number three is itself meaningful.
         (rate-limit/record-failure! request "first" 100000)
         (rate-limit/record-failure! request "second" 100001)
         (is (= 3 @prune-count)
             "The first failure sweeps all three maps; the second only prunes its active buckets")
         (rate-limit/record-failure! request "third" 160000)
         (is (= 6 @prune-count)
             "All three maps are swept again after the interval")))))

(deftest active-bucket-still-expires-between-global-sweeps
  (let [request {:remote-addr "192.0.2.2"}]
    (dotimes [n 10]
      (rate-limit/record-failure! request "user" n))
    (is (rate-limit/over-limit? request "user" 10))
    (rate-limit/record-failure! request "user" 900001)
    (is (not (rate-limit/over-limit? request "user" 900001)))))
