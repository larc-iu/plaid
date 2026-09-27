(ns plaid.sql.query.exec-queue-test
  "Counting queries (an aggregate, or `return count`) take their turn in a
  queue of `heavy-query-permits`, and wait for it WITHOUT a pooled
  connection. On a 374k-word corpus twelve of igt's project-wide counts at
  once took every connection, and a 5 ms read waited 11.6 s for one."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-clean-db
                                    with-rest-handler with-admin with-test-users
                                    db admin-request]]
            [plaid.test-helpers :as h]
            [plaid.rest-api.v1.query :as rq]
            [plaid.sql.query.exec :as qe]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [r] (-> r :body :id))

(defn- build! []
  (let [pid  (h/create-test-project admin-request "QueueProj")
        txtl (id (h/create-text-layer admin-request pid "text"))
        tokl (id (h/create-token-layer admin-request txtl "words"))
        doc  (h/create-test-document admin-request pid "d1")
        text (id (h/create-text admin-request txtl doc "a b c"))]
    (doseq [[b e] [[0 1] [2 3] [4 5]]]
      (h/create-token admin-request tokl text b e))
    {:tokl tokl}))

(def ^:private permits @#'qe/heavy-queries)
(def ^:private permit-count @#'qe/heavy-query-permits)

(defn- aggregate-body [tokl]
  {"where" [["token" "?t" {"layer" tokl}]]
   "return" {"group" ["?t.value"] "aggregates" [["count"]]}})

(defn- count-body [tokl]
  {"find" ["?t"] "where" [["token" "?t" {"layer" tokl}]] "return" "count"})

(defn- rows-body [tokl]
  {"find" ["?t"] "where" [["token" "?t" {"layer" tokl}]]})

(defn- with-every-permit-taken [f]
  (.acquire permits permit-count)
  (try (f) (finally (.release permits permit-count))))

(defn- run-code [body]
  (try (qe/run db "admin@example.com" body) nil
       (catch clojure.lang.ExceptionInfo e (:code (ex-data e)))))

(deftest a-counting-query-waits-for-its-turn-and-a-row-query-does-not
  (let [{:keys [tokl]} (build!)]
    (with-every-permit-taken
      (fn []
        (binding [qe/*heavy-query-wait-ms* 100]
          (testing "an aggregate and a count with no turn free are refused with 503"
            (is (= 503 (run-code (aggregate-body tokl))))
            (is (= 503 (run-code (count-body tokl)))))
          (testing "a row query does not queue"
            (is (= 3 (:count (qe/run db "admin@example.com" (rows-body tokl)))))))))
    (testing "with the turns free again the same queries run"
      (is (= 3 (count (:results (qe/run db "admin@example.com" (aggregate-body tokl))))))
      (is (= 3 (:count (qe/run db "admin@example.com" (count-body tokl))))))
    (is (= permit-count (.availablePermits permits)) "every turn taken is given back")))

(deftest a-waiting-query-holds-no-connection-and-runs-once-a-turn-frees
  (let [{:keys [tokl]} (build!)
        pool (.getHikariPoolMXBean db)]
    (.acquire permits permit-count)
    (let [released? (atom false)]
      (try
        (let [active-before (.getActiveConnections pool)
              waiting (future (qe/run db "admin@example.com" (aggregate-body tokl)))]
          (Thread/sleep 200)
          (is (not (realized? waiting)) "the query waits while every turn is taken")
          (is (= active-before (.getActiveConnections pool))
              "and holds no pooled connection while it waits")
          (.release permits 1)
          (reset! released? true)
          (is (= 3 (count (:results (deref waiting 10000 nil))))
              "one turn freed, the waiting query runs"))
        (finally
          (.release permits (if @released? (dec permit-count) permit-count)))))
    (is (= permit-count (.availablePermits permits)))))

(deftest the-rest-route-answers-503-with-a-message
  (let [{:keys [tokl]} (build!)
        handler (get-in rq/query-routes [0 1 :post :handler])]
    (with-every-permit-taken
      (fn []
        (binding [qe/*heavy-query-wait-ms* 50]
          (let [resp (handler {:db db :user/id "admin@example.com"
                               :parameters {:body (aggregate-body tokl)}})]
            (is (= 503 (:status resp)))
            (is (re-find #"busy" (-> resp :body :error)))))))))
