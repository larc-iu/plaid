(ns plaid.sql.get-with-layer-data-perf-test
  "Perf-visibility test for plaid.sql.document/get-with-layer-data.

  The SQL port was MOTIVATED by 1m+ OLTP latency on this single function
  under the v2 backend. Task #52 rewrote the function as a small fixed
  set of batched queries (~11) instead of an O(layers × kinds + rows)
  recursive walker with per-row metadata fetches.

  This test does two things:

   1. Counts the SQL round-trips a single get-with-layer-data issues
      against a non-trivial document. The hard cap is set generously
      (≤ 30) — what matters is that it's CONSTANT in the row count.
      Pre-rewrite this number would have been 100s on the same fixture
      (1 per layer × kind × row).

   2. Measures wall-clock and asserts under 1000ms in the SQLite in-process
      setup. SQLite on a local file routinely returns the same workload
      in 10-50ms; the loose ceiling exists so the test won't flake on
      a CI host under heavy load."
  (:require [clojure.test :refer :all]
            [plaid.sql.document :as doc]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin assert-created assert-ok
                                    assert-no-content with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- with-query-counter
  "Run `f`, returning a map of {:result, :query-count, :elapsed-ms}.
  Wraps psc/q (the only read entry point) so every SQL SELECT issued
  during `f` increments the counter."
  [f]
  (let [n (atom 0)
        orig psc/q]
    (try
      (with-redefs [psc/q (fn [& args]
                            (swap! n inc)
                            (apply orig args))]
        (let [start (System/nanoTime)
              result (f)
              elapsed-ms (/ (- (System/nanoTime) start) 1e6)]
          {:result result
           :query-count @n
           :elapsed-ms elapsed-ms}))
      (catch Exception e
        {:error e :query-count @n}))))

(deftest get-with-layer-data-batched-roundtrip-shape
  (testing "get-with-layer-data issues a CONSTANT (small) number of queries"
    (let [proj  (create-test-project admin-request "PerfProj")
          doc   (create-test-document admin-request proj "PerfDoc")
          tl    (-> (create-text-layer admin-request proj "TL") :body :id)
          tkl   (-> (create-token-layer admin-request tl "TKL") :body :id)
          sl    (-> (create-span-layer admin-request tkl "SL") :body :id)
          rl    (-> (create-relation-layer admin-request sl "RL") :body :id)
          ;; Text long enough to hold 100 non-overlapping 5-char tokens.
          body  (apply str (repeat 100 "abcde"))
          tid   (-> (create-text admin-request tl doc body) :body :id)
          ;; 100 tokens.
          token-rows (mapv (fn [i] {:token-layer-id tkl
                                    :text tid
                                    :begin (* i 5)
                                    :end (+ 5 (* i 5))})
                           (range 100))
          tres  (bulk-create-tokens admin-request token-rows)
          _     (assert-created tres)
          token-ids (vec (-> tres :body :ids))
          ;; 50 spans, each over a single token.
          span-rows (mapv (fn [i] {:span-layer-id sl
                                   :tokens [(nth token-ids i)]
                                   :value (str "S" i)})
                          (range 50))
          sres  (bulk-create-spans admin-request span-rows)
          _     (assert-created sres)
          span-ids (vec (-> sres :body :ids))
          ;; 20 relations between consecutive spans.
          rel-rows (mapv (fn [i] {:relation-layer-id rl
                                  :source (nth span-ids i)
                                  :target (nth span-ids (inc i))
                                  :value (str "R" i)})
                         (range 20))
          rres  (bulk-create-relations admin-request rel-rows)
          _     (assert-created rres)
          {:keys [result query-count elapsed-ms]}
          (with-query-counter #(doc/get-with-layer-data db doc))]

      ;; Shape sanity: the document came back fully hydrated.
      (is (some? result))
      (is (= doc (:document/id result)))
      (let [tx-layer  (-> result :document/text-layers first)
            tok-layer (-> tx-layer :text-layer/token-layers first)
            sp-layer  (-> tok-layer :token-layer/span-layers first)
            rel-layer (-> sp-layer :span-layer/relation-layers first)]
        (is (= 100 (count (:token-layer/tokens tok-layer))))
        (is (= 50  (count (:span-layer/spans sp-layer))))
        (is (= 20  (count (:relation-layer/relations rel-layer)))))

      ;; Hard cap on round-trips. The new shape uses ~11 SELECTs.
      ;; Leaving slack at 30 so a defensible refactor with one or two
      ;; extra queries doesn't false-fail. The old shape would have
      ;; issued 200+ here.
      (try
        (spit (str (System/getProperty "java.io.tmpdir")
                   "/plaid-get-with-layer-data-perf.txt")
              (str ":query-count " query-count
                   " :elapsed-ms " (format "%.2f" elapsed-ms)
                   " :tokens 100 :spans 50 :relations 20\n"))
        (catch Exception _))
      (is (<= query-count 30)
          (str "get-with-layer-data should be O(1) in row count; saw "
               query-count " SELECTs"))
      ;; Wall-clock ceiling. SQLite typically lands well under this;
      ;; the loose 1000ms ceiling keeps the test stable on slow CI.
      (is (< elapsed-ms 1000.0)
          (str "get-with-layer-data took " elapsed-ms "ms — perf regression?")))))
