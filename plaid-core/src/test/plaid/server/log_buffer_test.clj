(ns plaid.server.log-buffer-test
  "The in-memory log buffers behind the admin Logs screen. The contract worth
  pinning is the reason there are two of them: a flood of requests must not
  be able to evict an error."
  (:require [clojure.test :refer :all]
            [plaid.server.log-buffer :as lb]
            [taoensso.timbre :as log]))

(defn- with-buffer-appender
  "Run `f` with the buffer appender installed and both buffers empty. Bound
  rather than set: `*config*` is dynamic, and a test that reconfigured
  logging for the whole JVM would take the console away from every other
  namespace's output."
  [f]
  (binding [log/*config* (merge log/*config*
                                {:min-level :debug
                                 :appenders {:println {:enabled? false}
                                             :buffer lb/appender}})]
    (try
      (lb/clear!)
      (f)
      (finally (lb/clear!)))))

(use-fixtures :each with-buffer-appender)

(defn- log-request! [record]
  (log/with-context+ {lb/context-key record}
    (log/info "access line")))

(def ^:private ok
  {:method "GET" :path "/api/v1/projects" :query nil :status 200 :ms 10
   :user "ada@example.com" :ip "127.0.0.1" :token nil :error nil})

(deftest requests-and-events-are-kept-apart
  (log/error "the needle")
  (dotimes [i (+ lb/request-capacity 50)]
    (log-request! (assoc ok :ms i)))

  (testing "The request buffer holds its capacity and no more"
    (let [{:keys [held capacity matched]} (lb/requests {})]
      (is (= capacity held))
      (is (= lb/request-capacity matched))))

  (testing "A flood of requests does not evict an event"
    (let [{:keys [entries held]} (lb/events {})]
      (is (= 1 held))
      (is (= "the needle" (:message (first entries)))))))

(deftest a-request-flood-evicts-oldest-first
  (dotimes [i (+ lb/request-capacity 3)]
    (log-request! (assoc ok :ms i)))
  (testing "Newest first, and the three oldest are gone"
    (let [ms (map :ms (:entries (lb/requests {:limit lb/request-capacity})))]
      (is (= (+ lb/request-capacity 2) (first ms)))
      (is (= 3 (last ms))))))

(deftest filters-narrow-what-comes-back
  (log-request! ok)
  (log-request! (assoc ok :user "grace@example.com" :status 404 :path "/api/v1/projects/nope"))
  (log-request! (assoc ok :user "grace@example.com" :status 500 :method "POST"))
  (log-request! (assoc ok :status nil :error "java.lang.NullPointerException"))

  (testing "By account"
    (is (= 2 (:matched (lb/requests {:user "grace@example.com"})))))
  (testing "By status class"
    (is (= 1 (:matched (lb/requests {:status "4xx"}))))
    (is (= 1 (:matched (lb/requests {:status "500"})))))
  (testing "Failures are the 4xx, the 5xx and the request that threw"
    (is (= 3 (:matched (lb/requests {:status "failures"})))))
  (testing "By method"
    (is (= 1 (:matched (lb/requests {:method "post"})))))
  (testing "Search reads every field of the line"
    (is (= 1 (:matched (lb/requests {:q "projects/nope"}))))
    (is (= 2 (:matched (lb/requests {:q "ADA@example"})))))
  (testing "A capped list still says how many matched"
    (let [{:keys [entries matched]} (lb/requests {:limit 2})]
      (is (= 2 (count entries)))
      (is (= 4 matched)))))

(deftest stats-describe-the-filtered-set
  (doseq [ms [10 20 30 40 50 60 70 80 90 100]]
    (log-request! (assoc ok :ms ms)))
  (log-request! (assoc ok :user "grace@example.com" :ms 5000 :status 500))

  (testing "Percentiles and failures cover only what passed the filters"
    (let [{:keys [stats]} (lb/requests {:user "ada@example.com"})]
      (is (= 10 (:count stats)))
      (is (= 0 (:failures stats)))
      (is (= 100 (:max stats)))
      (is (<= 50 (:p50 stats) 60))))
  (testing "Narrowed to the slow one, the numbers are the slow one's"
    (let [{:keys [stats]} (lb/requests {:user "grace@example.com"})]
      (is (= 1 (:count stats)))
      (is (= 1 (:failures stats)))
      (is (= 1 (:server-errors stats)))
      (is (= 5000 (:max stats))))))

(deftest events-carry-level-and-trace
  (log/info "routine")
  (log/warn "odd")
  (log/error (ex-info "boom" {}) "handler blew up")

  (testing "A minimum level narrows, and the tally counts what search matched"
    (let [{:keys [entries matched by-level]} (lb/events {:level "warn"})]
      (is (= 2 matched))
      (is (= "handler blew up" (:message (first entries))))
      (is (= {:info 1 :warn 1 :error 1} by-level))))

  (testing "The exception comes with the entry that reported it"
    (let [entry (first (:entries (lb/events {:level "error"})))]
      (is (re-find #"boom" (:trace entry)))
      (is (re-find #"clojure.lang.ExceptionInfo" (:trace entry)))))

  (testing "Search reads the trace as well as the message"
    (is (= 1 (:matched (lb/events {:q "ExceptionInfo"}))))))

(deftest debug-is-not-buffered
  (testing "Two dumps per request at debug would evict every warning there is"
    (log/debug "a dump")
    (log/info "not a dump")
    (is (= ["not a dump"] (map :message (:entries (lb/events {})))))))

(deftest a-broken-entry-never-takes-the-log-call-with-it
  (testing "An appender that throws would lose the line it was appending"
    (is (nil? (lb/append! {:level :info :instant :not-a-date
                           :?ns-str "x" :msg_ (delay (throw (Exception. "nope")))})))))
