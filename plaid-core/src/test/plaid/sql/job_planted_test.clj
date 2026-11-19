(ns plaid.sql.job-planted-test
  "What the job tests missed when faults were planted in `plaid.sql.job` and
  its routes (campaign PF, 2026-11-19): limits taken at their bound, the
  queue and the start time across a resume, who stopped a job, the report
  core writes, and whether History holds a job's writes."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            admin-request]]
            [plaid.rest-api.v1.job-helpers :as jh :refer [call start! job-id claim! heartbeat! finish! lapse!]]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- get-job [j] (:body (call admin-request :get (str "/api/v1/jobs/" j))))

(defn- cancel! [who j] (call who :post (str "/api/v1/jobs/" j "/cancel")))

(defn- put-row! [j d body]
  (call admin-request :put (str "/api/v1/jobs/" j "/documents/" d) (merge {:worker-id jh/worker-a} body)))

(deftest a-job-takes-exactly-five-hundred-documents
  (let [p (str (h/create-test-project admin-request "Five hundred"))]
    (doseq [i (range 500)]
      (h/create-test-document admin-request p (str "d" i)))
    (let [r (start! admin-request p)]
      (is (= 201 (:status r)) (pr-str (:body r)))
      (is (= 500 (count (-> r :body :job/documents)))))))

(deftest a-stopping-job-still-holds-its-project
  (let [{:keys [p st w]} (jh/world!)
        j (job-id (start! st p))]
    (claim! jh/worker-a)
    (is (= "stopping" (:job/state (:body (cancel! st j)))))
    (let [r (start! w p)]
      (is (= 409 (:status r)))
      (is (= "job-active" (-> r :body :code))))))

(deftest a-resumed-job-keeps-the-time-it-started
  (let [{:keys [p st]} (jh/world!)
        j (job-id (start! st p))
        started (-> (claim! jh/worker-a) :body :job :job/started-at)]
    (Thread/sleep 5)
    (lapse! j)
    (is (= j (-> (claim! jh/worker-b) :body :job :job/id)) "taken up again")
    (is (= started (:job/started-at (get-job j))))))

(deftest the-first-to-stop-a-job-is-named-when-core-ends-it
  (let [{:keys [p st m]} (jh/world!)
        j (job-id (start! st p))]
    (claim! jh/worker-a)
    (fix/assert-ok (cancel! st j))
    (lapse! j)
    (let [job (:body (cancel! m j))]
      (is (= "cancelled" (:job/state job)))
      (is (= "starter@example.com" (:job/cancelled-by job))))))

(deftest the-report-core-writes-counts-each-state-and-reason-apart
  (let [{:keys [p st d1 d2]} (jh/world!)
        j (job-id (start! st p))
        skip (fn [n reason] (for [i (range n)] {:sentence (str reason i) :sentence-id (str reason i) :reason reason}))]
    (claim! jh/worker-a)
    (fix/assert-ok (put-row! j d1 {:state "in-use" :skipped (vec (concat (skip 1 "failed") (skip 2 "changed")))}))
    (fix/assert-ok (put-row! j d2 {:state "gone"}))
    (lapse! j)
    (let [totals (-> (cancel! st j) :body :job/report :totals)]
      (is (= {:documents-done 0 :documents-in-use 1 :documents-gone 1 :documents-not-reached 0
              :skipped-failed 1 :skipped-changed 2 :skipped-too-long 0}
             (select-keys totals [:documents-done :documents-in-use :documents-gone :documents-not-reached
                                  :skipped-failed :skipped-changed :skipped-too-long]))))))

(deftest a-document-row-lists-five-hundred-skipped-sentences
  (let [{:keys [p st d1]} (jh/world!)
        j (job-id (start! st p))]
    (claim! jh/worker-a)
    (let [r (put-row! j d1 {:skipped (vec (repeat 500 {:sentence "s1" :reason "failed"}))})]
      (is (= 200 (:status r)) (pr-str (:body r)))
      (is (= 500 (count (-> r :body :skipped)))))))

(deftest a-thousand-decisions-go-in-one-call
  (let [{:keys [p st]} (jh/world!)
        j (job-id (start! st p))]
    (claim! jh/worker-a)
    (let [r (call admin-request :post (str "/api/v1/jobs/" j "/decisions")
                  {:worker-id jh/worker-a
                   :decisions (vec (for [i (range 1000)] {:form "ka" :key (str "k" i) :analysis "{}" :count 1}))})]
      (is (= 204 (:status r)) (pr-str (:body r))))))

(deftest a-job-core-failed-keeps-the-time-core-failed-it
  (let [{:keys [p st]} (jh/world!)
        j (job-id (start! st p))]
    (claim! jh/worker-a)
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/starter@example.com")))
    (is (= "job-failed" (-> (heartbeat! j jh/worker-a) :body :code)))
    (let [failed-at (:job/finished-at (get-job j))]
      (is (some? failed-at))
      (Thread/sleep 5)
      (fix/assert-ok (finish! j jh/worker-a "failed"))
      (is (= failed-at (:job/finished-at (get-job j)))))))

(deftest a-deactivated-admins-job-fails-at-the-claim
  (let [{:keys [p]} (jh/world!)
        admin2 (jh/user! "admin2@example.com" true)
        j (job-id (start! admin2 p))]
    (fix/assert-no-content (call admin-request :delete "/api/v1/users/admin2@example.com"))
    (is (= 204 (:status (claim! jh/worker-a))) "nothing taken")
    (is (= ["failed" "starter-access"] ((juxt :job/state :job/reason) (get-job j))))))

(deftest a-job-that-wrote-only-in-its-harmonize-pass-wrote
  (let [{:keys [p st d1]} (jh/world!)
        j (job-id (start! st p))
        gid (str (random-uuid))]
    (claim! jh/worker-a)
    (fix/assert-created (call admin-request :post (str "/api/v1/documents?group-id=" gid
                                                       "&group-message=Assistant%20job&group-kind=job")
                              {:project-id p :name "harmonized"}))
    (fix/assert-ok (put-row! j d1 {:state "done" :harmonize-group gid}))
    (fix/assert-ok (finish! j jh/worker-a "done"))
    (is (true? (:job/wrote (get-job j))))))
