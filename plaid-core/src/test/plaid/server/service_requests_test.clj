(ns plaid.server.service-requests-test
  "The in-flight request registry behind server-mediated service RPC: a
  request outlives its requester's connection, keeps its result for a
  returning requester, and forgets it after a while."
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.server.events :as events]))

(defmacro with-registry [& body]
  `(with-redefs [events/inflight-requests (atom {})]
     ~@body))

(deftest a-request-survives-its-requester-leaving
  (with-registry
    (events/track-request! "r1" :ch1 "p" "svc" "u")
    (events/detach-request! "r1" :ch1)
    (let [entry (events/get-request "r1")]
      (is (some? entry) "detaching does not end the request")
      (is (= #{} (:requesters entry)))
      (is (nil? (:result entry))))
    (testing "progress recorded while nobody listens is replayed on attach"
      (is (= #{} (events/record-progress! "r1" {:percent 40 :message "Reading"})))
      (let [entry (events/attach-request! "r1" :ch2)]
        (is (= #{:ch2} (:requesters entry)))
        (is (= {:percent 40 :message "Reading"} (:last-progress entry)))))
    (testing "finishing releases the watchers and stores the result"
      (let [before (events/finish-request! "r1" "result" {:data {:kind "turn"}})]
        (is (= #{:ch2} (:requesters before)) "the channels to tell")
        (let [after (events/get-request "r1")]
          (is (= #{} (:requesters after)))
          (is (= {:event "result" :data {:data {:kind "turn"}}} (:result after)))
          (is (number? (:finished-at after))))))
    (testing "a late attach gets the stored result and is not registered"
      (let [entry (events/attach-request! "r1" :ch3)]
        (is (= "result" (get-in entry [:result :event])))
        (is (= #{} (:requesters entry)))))
    (testing "finishing twice is a no-op"
      (is (nil? (events/finish-request! "r1" "error" {:error "late"})))
      (is (= "result" (get-in (events/get-request "r1") [:result :event]))))))

(deftest several-connections-may-watch-one-request
  (with-registry
    (events/track-request! "r1" :a "p" "svc" "u")
    (events/attach-request! "r1" :b)
    (is (= #{:a :b} (events/record-progress! "r1" {:percent 1})))
    (events/detach-request! "r1" :a)
    (is (= #{:b} (:requesters (events/finish-request! "r1" "error" {:error "x"}))))))

(deftest cancel-marks-an-unfinished-request-only
  (with-registry
    (events/track-request! "r1" :a "p" "svc" "u")
    (is (some? (events/cancel-request! "r1")))
    (is (true? (:cancelled (events/get-request "r1"))))
    (events/finish-request! "r1" "result" {:data nil})
    (is (nil? (events/cancel-request! "r1")) "a finished request cannot be cancelled")
    (is (nil? (events/cancel-request! "nope")))))

(deftest requests-for-service-lists-only-unfinished-ones
  (with-registry
    (events/track-request! "r1" :a "p" "svc" "u")
    (events/track-request! "r2" :b "p" "svc" "u")
    (events/track-request! "r3" :c "p" "other" "u")
    (events/finish-request! "r2" "result" {:data nil})
    (is (= #{"r1"} (set (map key (events/requests-for-service "p" "svc")))))))

(deftest finished-requests-expire-and-are-capped
  (with-registry
    (events/track-request! "old" :a "p" "svc" "u")
    (events/finish-request! "old" "result" {:data nil})
    (swap! events/inflight-requests assoc-in ["old" :finished-at]
           (- (System/currentTimeMillis) events/finished-request-ttl-ms 1000))
    (events/track-request! "new" :b "p" "svc" "u")
    (is (nil? (events/get-request "old")) "swept on the next track")
    (is (some? (events/get-request "new")))
    (testing "the oldest finished requests go beyond the cap"
      (with-redefs [events/max-finished-requests 2]
        (doseq [i (range 3)]
          (events/track-request! (str "f" i) :c "p" "svc" "u")
          (events/finish-request! (str "f" i) "result" {:data nil})
          ;; Recent, but f0 the oldest of the three.
          (swap! events/inflight-requests assoc-in [(str "f" i) :finished-at]
                 (- (System/currentTimeMillis) (* 1000 (- 3 i)))))
        (events/track-request! "trigger" :d "p" "svc" "u")
        (is (nil? (events/get-request "f0")))
        (is (some? (events/get-request "f1")))
        (is (some? (events/get-request "f2")))
        (is (some? (events/get-request "new")) "unfinished requests are never swept")))))

(deftest forget-drops-a-request-outright
  (with-registry
    (events/track-request! "r1" :a "p" "svc" "u")
    (is (some? (events/forget-request! "r1")))
    (is (nil? (events/get-request "r1")))
    (is (nil? (events/forget-request! "r1")))))
