(ns plaid.rest-api.v1.job-lifecycle-test
  "A job's life: start and its refusals, one active job per project, the claim
  order across projects with one slot server-wide, the lease and its
  takeover, every cancel path, every finish transition, decisions, `ahead`,
  and what a project or document delete leaves (CONTRACT 3, SPEC 1 and 12)."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            admin-request]]
            [plaid.rest-api.v1.job-helpers :as jh :refer [call start! job-id claim! heartbeat! finish! lapse!]]
            [plaid.server.project-removal :as removal]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- get-job [j] (:body (call admin-request :get (str "/api/v1/jobs/" j))))

;; ------------------------------------------------------------------
;; Start
;; ------------------------------------------------------------------

(deftest a-started-job-waits-with-its-documents-in-order
  (let [{:keys [p d1 d2 st]} (jh/world!)
        resp (start! st p {:instructions "Gloss kin terms as in the guide."})
        j (:body resp)]
    (is (= 201 (:status resp)))
    (is (= "waiting" (:job/state j)))
    (is (= "Gloss kin terms as in the guide." (:job/instructions j)))
    (is (not (contains? j :job/tasks)) "a job has no task types")
    (is (= "starter@example.com" (:job/started-by j)))
    (is (= "starter" (:job/started-by-name j)))
    (is (= 120 (:job/lease-s j)))
    (is (= 0 (:job/ahead j)))
    (is (nil? (:job/report j)))
    (is (= [d2 d1] (mapv :document-id (:job/documents j))) "every document, by name")
    (is (= ["a doc" "b doc"] (mapv :name (:job/documents j))))
    (is (= [0 1] (mapv :position (:job/documents j))))
    (is (every? #(= "waiting" (:state %)) (:job/documents j)))
    (is (= {} (:counts (first (:job/documents j)))))
    (is (= [] (:skipped (first (:job/documents j)))))
    (testing "documents named keep their order"
      (fix/assert-ok (call admin-request :post (str "/api/v1/jobs/" (:job/id j) "/cancel")))
      (let [j2 (:body (start! st p {:documents [d1 d2 d1]}))]
        (is (= [d1 d2] (mapv :document-id (:job/documents j2))) "each once")))))

(deftest start-refusals
  (let [{:keys [p st]} (jh/world!)
        empty-project (str (h/create-test-project admin-request "Empty"))
        refused (fn [project body]
                  (let [r (start! admin-request project body)]
                    (is (= 400 (:status r)))
                    (-> r :body :error)))]
    (is (= "Unknown app: ud." (refused p {:app "ud"})))
    (is (= "instructions: say what the job is to do." (refused p {:instructions nil})))
    (is (= "instructions: say what the job is to do." (refused p {:instructions "  \n "})))
    (is (= "documents: 2 are not documents of this project."
           (refused p {:documents ["0197d1a0-0000-7000-8000-0000000000f1" "0197d1a0-0000-7000-8000-0000000000f2"]})))
    (is (= "The instructions are 2,412 characters. A job's instructions are at most 2,000."
           (refused p {:instructions (apply str (repeat 2412 "é"))})))
    (is (= "documents: give at least one document, or leave them out for all." (refused p {:documents []})))
    (is (= "This project has no documents." (refused empty-project {})))
    (testing "2,000 characters of instructions are taken"
      (is (= 201 (:status (start! st p {:instructions (apply str (repeat 2000 "x"))})))))))

(deftest at-most-five-hundred-documents
  (let [p (str (h/create-test-project admin-request "Big"))]
    (doseq [i (range 501)]
      (h/create-test-document admin-request p (str "d" i)))
    (let [r (start! admin-request p)]
      (is (= 400 (:status r)))
      (is (= "A job takes at most 500 documents. This one names 501." (-> r :body :error))))))

(deftest one-active-job-per-project
  (let [{:keys [p q st w]} (jh/world!)
        first-job (job-id (start! st p))
        r (start! w p)]
    (is (= 409 (:status r)))
    (is (= {:error "This project already has a job." :code "job-active" :job first-job} (:body r)))
    (is (= 201 (:status (start! admin-request q))) "another project is not held up")
    (testing "a claimed job is still the active one"
      (is (= 200 (:status (claim! jh/worker-a))))
      (is (= 409 (:status (start! w p)))))
    (testing "an ended one is not"
      (fix/assert-ok (finish! first-job jh/worker-a "done"))
      (is (= 201 (:status (start! w p)))))))

(deftest a-client-minted-id
  (let [{:keys [p q st]} (jh/world!)
        id "0197d1a0-1111-7000-8000-000000000001"]
    (is (= id (job-id (start! st p {:id id}))))
    (fix/assert-ok (call admin-request :post (str "/api/v1/jobs/" id "/cancel")))
    (let [r (start! admin-request q {:id id})]
      (is (= 409 (:status r)))
      (is (= "id-taken" (-> r :body :error))))))

(deftest the-list-is-newest-first-and-paged
  (let [{:keys [p st]} (jh/world!)
        ids (vec (for [_ (range 3)]
                   (let [j (job-id (start! st p))]
                     (fix/assert-ok (call admin-request :post (str "/api/v1/jobs/" j "/cancel")))
                     j)))
        page1 (:body (call st :get (str "/api/v1/projects/" p "/jobs?limit=2")))
        page2 (:body (call st :get (str "/api/v1/projects/" p "/jobs?limit=2&cursor=" (:next-cursor page1))))]
    (is (= (reverse ids) (mapv :job/id (concat (:entries page1) (:entries page2)))))
    (is (nil? (:next-cursor page2)))
    (is (not-any? #(contains? % :job/documents) (:entries page1)) "no documents in the list")
    (is (not-any? #(contains? % :job/report) (:entries page1)) "no report in the list")))

(deftest a-list-entry-counts-its-documents
  (let [{:keys [p d1 st]} (jh/world!)
        all (job-id (start! st p))
        _ (fix/assert-ok (call admin-request :post (str "/api/v1/jobs/" all "/cancel")))
        one (job-id (start! st p {:documents [d1]}))
        entries (:entries (:body (call st :get (str "/api/v1/projects/" p "/jobs"))))]
    (is (= [[one 1] [all 2]] (mapv (juxt :job/id :job/document-count) entries)))))

;; A worker that went silent: every read says the lease has lapsed, by the
;; server's clock, and writes nothing (REV-J-C-3).
(deftest every-read-says-whether-the-lease-has-lapsed
  (let [{:keys [p st]} (jh/world!)
        reads (fn [j]
                [(:job/lapsed (get-job j))
                 (:job/lapsed (:body (call st :get (str "/api/v1/projects/" p "/jobs/active"))))
                 (-> (call st :get (str "/api/v1/projects/" p "/jobs")) :body :entries first :job/lapsed)])
        j (job-id (start! st p))]
    (is (= [false false false] (reads j)) "waiting")
    (claim! jh/worker-a)
    (is (= [false false false] (reads j)) "running, the lease live")
    (lapse! j)
    (is (= [true true true] (reads j)) "running, the lease lapsed")
    (is (= "running" (:job/state (get-job j))) "a read settles nothing")
    (is (= "2020-01-01T00:00:00.000000000Z" (:job/heartbeat-at (get-job j))))
    (fix/assert-ok (heartbeat! j jh/worker-a))
    (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel")))
    (is (= [false false false] (reads j)) "stopping, the lease live")
    (lapse! j)
    (is (= [true true true] (reads j)) "stopping, the lease lapsed")
    (is (= "stopping" (:job/state (get-job j))) "a read settles nothing")
    (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel")))
    (is (= "cancelled" (:job/state (get-job j))) "a second Stop settles it at once")
    (is (false? (:job/lapsed (get-job j))) "an ended job is not lapsed")))

;; ------------------------------------------------------------------
;; Claim
;; ------------------------------------------------------------------

(deftest the-claim-takes-jobs-in-order-one-at-a-time
  (let [{:keys [p q st]} (jh/world!)
        jp (job-id (start! st p))
        jq (job-id (start! admin-request q))]
    (testing "a waiting job behind another says so"
      (is (= 0 (:job/ahead (get-job jp))))
      (is (= 1 (:job/ahead (get-job jq)))))
    (testing "no claim for an app with no job"
      (is (= 204 (:status (claim! jh/worker-a ["ud"])))))
    (let [r (claim! jh/worker-a)]
      (is (= 200 (:status r)))
      (is (= jp (-> r :body :job :job/id)) "the oldest first")
      (is (= "running" (-> r :body :job :job/state)))
      (is (= "m1" (-> r :body :job :job/model)))
      (is (some? (-> r :body :job :job/started-at)))
      (is (string? (-> r :body :token)))
      (is (= 30 (-> r :body :heartbeat-s)))
      (is (nil? (:job/ahead (get-job jp))) "a running job has no place in the queue")
      (is (= 1 (:job/ahead (get-job jq))) "the running one is still ahead"))
    (testing "one slot: no second job while the first holds its lease"
      (is (= 204 (:status (claim! jh/worker-b)))))
    (testing "the next is taken once the first ends"
      (fix/assert-ok (finish! jp jh/worker-a "done"))
      (is (= jq (-> (claim! jh/worker-b) :body :job :job/id))))
    (testing "the worker is seen, with its model"
      (let [w (:body (call admin-request :get "/api/v1/jobs/worker"))]
        (is (string? (:seen-at w)))
        (is (= "m1" (:model w)))))))

(deftest a-lapsed-lease-is-taken-over
  (let [{:keys [p st d1]} (jh/world!)
        j (job-id (start! st p))]
    (is (= 200 (:status (claim! jh/worker-a))))
    (lapse! j)
    (let [r (claim! jh/worker-b)]
      (is (= j (-> r :body :job :job/id)) "taken over")
      (is (= "running" (-> r :body :job :job/state))))
    (testing "the old worker's next write is refused"
      (doseq [r [(heartbeat! j jh/worker-a)
                 (call admin-request :put (str "/api/v1/jobs/" j "/documents/" d1)
                       {:worker-id jh/worker-a :state "done"})
                 (call admin-request :post (str "/api/v1/jobs/" j "/decisions")
                       {:worker-id jh/worker-a :decisions []})
                 (finish! j jh/worker-a "done")]]
        (is (= 409 (:status r)))
        (is (= {:error "Another worker holds this job." :code "job-taken"} (:body r)))))
    (is (= 200 (:status (heartbeat! j jh/worker-b))) "the new one goes on")))

(deftest a-lapsed-stopping-job-is-claimed-stopping
  (let [{:keys [p st]} (jh/world!)
        j (job-id (start! st p))]
    (claim! jh/worker-a)
    (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel")))
    (is (= "stopping" (:job/state (get-job j))))
    (lapse! j)
    (let [r (claim! jh/worker-b)]
      (is (= "stopping" (-> r :body :job :job/state)) "the new worker sees it is to stop"))
    (is (= 200 (:status (finish! j jh/worker-b "cancelled"))))
    (is (= "cancelled" (:job/state (get-job j))))
    (is (= "cancelled" (:job/reason (get-job j))))))

(deftest the-claim-fails-a-job-whose-starter-cannot-write
  (let [{:keys [p q st]} (jh/world!)
        jp (job-id (start! st p))
        jq (job-id (start! admin-request q))]
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/starter@example.com")))
    (jh/grant! p "readers" "starter@example.com")
    (let [r (claim! jh/worker-a)]
      (is (= jq (-> r :body :job :job/id)) "the next job is taken"))
    (let [failed (get-job jp)]
      (is (= "failed" (:job/state failed)))
      (is (= "starter-access" (:job/reason failed)))
      (is (some? (:job/finished-at failed)))
      (is (= "failed" (-> failed :job/report :state)))
      (is (nil? (-> failed :job/report :stopped)))
      (is (= 2 (-> failed :job/report :totals :documents-not-reached)))
      (is (every? #(= "not-reached" (:state %)) (:job/documents failed))))))

;; ------------------------------------------------------------------
;; Heartbeat
;; ------------------------------------------------------------------

(deftest a-heartbeat-sets-what-it-names
  (let [{:keys [p st d1]} (jh/world!)
        j (job-id (start! st p))]
    (claim! jh/worker-a)
    (let [r (heartbeat! j jh/worker-a {:phase "working" :message "Sentences 1 to 5 of 40."
                                       :waiting-for "people" :current-document d1})]
      (is (= 200 (:status r)))
      (is (= "running" (-> r :body :state)))
      (is (= 120 (-> r :body :lease-s)))
      (is (string? (-> r :body :token))))
    (let [job (get-job j)]
      (is (= ["working" "Sentences 1 to 5 of 40." "people" d1]
             ((juxt :job/phase :job/message :job/waiting-for :job/current-document) job))))
    (testing "a key left out is left, a null clears"
      (heartbeat! j jh/worker-a {:waiting-for nil})
      (let [job (get-job j)]
        (is (nil? (:job/waiting-for job)))
        (is (= "working" (:job/phase job)))))
    (testing "a stopped job's heartbeat says so"
      (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel")))
      (is (= "stopping" (-> (heartbeat! j jh/worker-a) :body :state))))
    (testing "a message over 300 characters is refused"
      (is (= 400 (:status (heartbeat! j jh/worker-a {:message (apply str (repeat 301 "x"))})))))
    (testing "an ended job"
      (fix/assert-ok (finish! j jh/worker-a "cancelled"))
      (let [r (heartbeat! j jh/worker-a)]
        (is (= 409 (:status r)))
        (is (= {:error "This job has ended." :code "job-finished"} (:body r)))))))

;; ------------------------------------------------------------------
;; Cancel
;; ------------------------------------------------------------------

(deftest every-cancel-path
  (let [{:keys [p st]} (jh/world!)]
    (testing "a waiting job is cancelled at once, with no report"
      (let [j (job-id (start! st p))
            job (:body (call st :post (str "/api/v1/jobs/" j "/cancel")))]
        (is (= "cancelled" (:job/state job)))
        (is (= "cancelled" (:job/reason job)))
        (is (= "starter@example.com" (:job/cancelled-by job)))
        (is (some? (:job/finished-at job)))
        (is (nil? (:job/report job)))))
    (testing "a running job with a live lease becomes stopping, and a second cancel changes nothing"
      (let [j (job-id (start! st p))]
        (claim! jh/worker-a)
        (is (= "stopping" (:job/state (:body (call st :post (str "/api/v1/jobs/" j "/cancel"))))))
        (let [again (call admin-request :post (str "/api/v1/jobs/" j "/cancel"))]
          (is (= 200 (:status again)))
          (is (= "stopping" (-> again :body :job/state)))
          (is (= "starter@example.com" (-> again :body :job/cancelled-by)) "the first cancel is kept"))
        (fix/assert-ok (finish! j jh/worker-a "cancelled"))))
    (doseq [state ["running" "stopping"]]
      (testing (str "a " state " job with a lapsed lease is cancelled by core, with a report")
        (let [j (job-id (start! st p))
              d (-> (get-job j) :job/documents first :document-id)]
          (claim! jh/worker-b)
          (fix/assert-ok (call admin-request :put (str "/api/v1/jobs/" j "/documents/" d)
                               {:worker-id jh/worker-b :state "done" :sentences 10 :targets 8 :done 8
                                :counts {:words 30 :links 12 :changes 40 :deletions 3 :repeated 2 :skipped-more 4}
                                :skipped [{:sentence "s4" :sentence-id "x" :reason "too-long" :kind nil}
                                          {:sentence "s5" :sentence-id "y" :reason "interrupted" :kind nil}]}))
          (when (= "stopping" state)
            (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel"))))
          (lapse! j)
          (let [job (:body (call st :post (str "/api/v1/jobs/" j "/cancel")))
                report (:job/report job)]
            (is (= "cancelled" (:job/state job)))
            (is (= "without-worker" (:stopped report)))
            (is (= "cancelled" (:state report)))
            (is (= {:changed [] :left [] :changed-more 0 :left-more 0} (:harmonize report)))
            (is (= [] (-> report :entries :created)))
            (is (= [] (-> report :entries :lexicons)) "a report core writes names no lexicon")
            (is (= 1 (-> report :totals :documents-done)))
            (is (= 1 (-> report :totals :documents-not-reached)))
            (is (= 8 (-> report :totals :sentences)))
            (is (= 30 (-> report :totals :words)))
            (is (= 1 (-> report :totals :skipped-too-long)))
            (is (= {:changes 40 :deletions 3 :repeated 2 :skipped-more 4 :skipped-interrupted 1}
                   (select-keys (:totals report) [:changes :deletions :repeated :skipped-more
                                                  :skipped-interrupted]))
                "every total the worker's report holds")
            (is (not (contains? (:entries report) :deleted)) "a job lists no deleted entries")
            (is (= ["done" "not-reached"] (mapv :state (:documents report))))))))
    (testing "an ended job"
      (let [j (job-id (start! st p))]
        (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel")))
        (let [r (call st :post (str "/api/v1/jobs/" j "/cancel"))]
          (is (= 409 (:status r)))
          (is (= {:error "This job has ended." :code "job-finished"} (:body r))))))))

;; ------------------------------------------------------------------
;; Finish
;; ------------------------------------------------------------------

(defn- running-job!
  "A job of `p` claimed by worker A, in `state` (`running` or `stopping`)."
  [st p state]
  (let [j (job-id (start! st p))]
    (claim! jh/worker-a)
    (when (= "stopping" state)
      (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel"))))
    j))

(deftest every-finish-transition
  (let [{:keys [p st d1]} (jh/world!)
        allowed {["running" "done"] true ["running" "cancelled"] true ["running" "failed"] true
                 ["stopping" "done"] false ["stopping" "cancelled"] true ["stopping" "failed"] true}]
    (doseq [[[from to] ok?] allowed]
      (testing (str from " to " to)
        (let [j (running-job! st p from)
              _ (heartbeat! j jh/worker-a {:current-document d1 :waiting-for "model"})
              r (finish! j jh/worker-a to {:reason (when (= "failed" to) "no-lexicon")
                                           :report {:state to :totals {:words 3}}})]
          (if ok?
            (do (is (= 200 (:status r)) (pr-str (:body r)))
                (is (= to (-> r :body :job/state)))
                (is (= {:state to :totals {:words 3}} (-> r :body :job/report)) "stored as sent")
                (is (some? (-> r :body :job/finished-at)))
                (is (nil? (-> r :body :job/current-document)))
                (is (nil? (-> r :body :job/waiting-for))))
            (do (is (= 409 (:status r)))
                (is (= {:error (str "This job cannot end as " to " now.") :code "job-state"} (:body r)))
                (fix/assert-ok (finish! j jh/worker-a "cancelled")))))))
    (testing "an ended job cannot end again"
      (let [j (running-job! st p "running")]
        (fix/assert-ok (finish! j jh/worker-a "done"))
        (doseq [to ["done" "cancelled" "failed"]]
          (is (= "job-state" (-> (finish! j jh/worker-a to) :body :code)) to))))
    (testing "a waiting job cannot be finished"
      (let [j (job-id (start! st p))]
        (is (= 409 (:status (finish! j jh/worker-a "done"))))
        (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel")))))
    (testing "a report over the cap"
      (let [j (running-job! st p "running")
            r (finish! j jh/worker-a "done" {:report {:instructions (apply str (repeat 1000001 "x"))}})]
        (is (= 400 (:status r)))
        (is (str/starts-with? (-> r :body :error) "The report is 1,000,0"))
        (fix/assert-ok (finish! j jh/worker-a "done"))))))

(deftest a-starter-who-loses-the-right-fails-the-job-and-the-worker-reports
  (let [{:keys [p st]} (jh/world!)
        j (running-job! st p "running")]
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/starter@example.com")))
    (let [r (heartbeat! j jh/worker-a)]
      (is (= 409 (:status r)))
      (is (= {:error "The person who started this job can no longer write in this project."
              :code "job-failed" :reason "starter-access"}
             (:body r)))
      (is (nil? (-> r :body :token)) "no token"))
    (is (= "failed" (:job/state (get-job j))))
    (is (= "job-failed" (-> (heartbeat! j jh/worker-a) :body :code)) "said again until the report is in")
    (let [r (finish! j jh/worker-a "failed" {:report {:state "failed" :reason "starter-access"}})]
      (is (= 200 (:status r)))
      (is (= "starter-access" (-> r :body :job/reason)))
      (is (= {:state "failed" :reason "starter-access"} (-> r :body :job/report))))
    (testing "once"
      (is (= "job-state" (-> (finish! j jh/worker-a "failed") :body :code)))
      (is (= "job-finished" (-> (heartbeat! j jh/worker-a) :body :code))))))

;; ------------------------------------------------------------------
;; Document rows and decisions
;; ------------------------------------------------------------------

(deftest the-worker-writes-a-document-row
  (let [{:keys [p st d1 dq]} (jh/world!)
        j (running-job! st p "running")
        put! (fn [d body] (call admin-request :put (str "/api/v1/jobs/" j "/documents/" d)
                                (merge {:worker-id jh/worker-a} body)))
        r (put! d1 {:state "working" :sentences 40 :targets 32 :done 5 :last-sentence "tok-1"
                    :counts {:words 12} :gloss-group "g-1"})]
    (is (= 200 (:status r)))
    (is (= {:document-id d1 :name "b doc" :position 1 :state "working" :sentences 40 :targets 32 :done 5
            :last-sentence "tok-1" :defers 0 :counts {:words 12} :skipped [] :gloss-group "g-1"
            :harmonize-group nil}
           (dissoc (:body r) :updated-at)))
    (testing "a key left out is left"
      (is (= 40 (-> (put! d1 {:done 10}) :body :sentences))))
    (testing "a null clears"
      (is (nil? (-> (put! d1 {:last-sentence nil}) :body :last-sentence))))
    (testing "a document the job does not hold"
      (let [r (put! dq {:state "done"})]
        (is (= 404 (:status r)))
        (is (= {:error "Document not in job"} (:body r)))))
    (testing "an unknown state"
      (is (= 400 (:status (put! d1 {:state "finished"})))))
    (testing "more than 500 skipped sentences"
      (is (= 400 (:status (put! d1 {:skipped (vec (repeat 501 {:sentence "s1" :reason "failed"}))})))))))

(deftest decisions-add-up-and-are-read-back
  (let [{:keys [p st d1]} (jh/world!)
        j (running-job! st p "running")
        add! (fn [ds] (call admin-request :post (str "/api/v1/jobs/" j "/decisions")
                            {:worker-id jh/worker-a :decisions ds}))
        lookup (fn [forms] (call admin-request :post (str "/api/v1/jobs/" j "/decisions/lookup") {:forms forms}))]
    (is (= 204 (:status (add! [{:form "ka" :key "k1" :analysis "{\"a\":1}" :count 2 :document-id d1 :sentence-id "s-1"}
                               {:form "ka" :key "k2" :analysis "{\"a\":2}" :count 1}
                               {:form "mu" :key "k3" :analysis "{\"a\":3}" :count 1}]))))
    (is (= 204 (:status (add! [{:form "ka" :key "k2" :analysis "{\"a\":2}" :count 4 :document-id d1 :sentence-id "s-9"}]))))
    (let [rows (:body (lookup ["ka" "zz"]))]
      (is (= [["ka" "k2" 5] ["ka" "k1" 2]] (mapv (juxt :form :key :count) rows)) "by count descending")
      (is (= "{\"a\":2}" (:analysis (first rows))) "the analysis as sent")
      (is (nil? (:first-document (first rows))) "first set only on insert")
      (is (= d1 (:first-document (second rows))))
      (is (= "s-1" (:first-sentence (second rows)))))
    (testing "every row, by form and key"
      (let [page1 (:body (call admin-request :get (str "/api/v1/jobs/" j "/decisions?limit=2")))
            page2 (:body (call admin-request :get (str "/api/v1/jobs/" j "/decisions?limit=2&cursor="
                                                       (:next-cursor page1))))]
        (is (= ["k1" "k2" "k3"] (mapv :key (concat (:entries page1) (:entries page2)))))))
    (testing "refusals"
      (is (= {:error "forms: give at least one form."} (:body (lookup []))))
      (is (= 400 (:status (lookup (vec (repeat 1001 "ka"))))))
      (let [r (add! [{:form "ka" :key "k1" :analysis "{}" :count 1}
                     {:form "ka" :key "k9" :analysis (apply str (repeat 4001 "x")) :count 1}])]
        (is (= 400 (:status r)))
        (is (str/starts-with? (-> r :body :error) "decisions[1]: ")))
      (is (= 400 (:status (add! (vec (repeat 1001 {:form "ka" :key "k1" :analysis "{}" :count 1})))))))))

(deftest an-ended-job-takes-no-row-or-decision
  ;; REV-J-A-4: a late write from a worker that missed the end would change
  ;; what the job page shows for a finished job.
  (let [{:keys [p st d1]} (jh/world!)
        put! (fn [j] (call admin-request :put (str "/api/v1/jobs/" j "/documents/" d1)
                           {:worker-id jh/worker-a :state "working"}))
        add! (fn [j] (call admin-request :post (str "/api/v1/jobs/" j "/decisions")
                           {:worker-id jh/worker-a :decisions [{:form "ka" :key "k" :analysis "{}" :count 1}]}))
        ended? (fn [r] (and (= 409 (:status r))
                            (= {:error "This job has ended." :code "job-finished"} (:body r))))]
    (doseq [to ["done" "cancelled" "failed"]]
      (testing (str "finished " to " by its worker")
        (let [j (running-job! st p "running")]
          (fix/assert-ok (finish! j jh/worker-a to))
          (is (ended? (put! j)))
          (is (ended? (add! j)))
          (is (= "not-reached" (:state (first (filter #(= d1 (:document-id %)) (:job/documents (get-job j))))))
              "the row as the end left it"))))
    (testing "cancelled by core after its lease lapsed"
      (let [j (running-job! st p "running")]
        (lapse! j)
        (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel")))
        (is (ended? (put! j)))
        (is (ended? (add! j)))))
    (testing "a stopping job still takes them"
      (let [j (running-job! st p "stopping")]
        (is (= 200 (:status (put! j))))
        (is (= 204 (:status (add! j))))
        (fix/assert-ok (finish! j jh/worker-a "cancelled"))))
    (testing "a job core failed takes them until its worker's finish, which its report needs"
      (let [j (running-job! st p "running")]
        (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/starter@example.com")))
        (is (= "job-failed" (-> (heartbeat! j jh/worker-a) :body :code)))
        (is (= 200 (:status (put! j))))
        (is (= 204 (:status (add! j))))
        (fix/assert-ok (finish! j jh/worker-a "failed"))
        (is (ended? (put! j)))
        (is (ended? (add! j)))
        (jh/grant! p "writers" "starter@example.com")))
    (testing "another worker's job is still job-taken"
      (let [j (running-job! st p "running")]
        (fix/assert-ok (finish! j jh/worker-a "done"))
        (is (= "job-taken" (-> (call admin-request :put (str "/api/v1/jobs/" j "/documents/" d1)
                                     {:worker-id jh/worker-b :state "done"})
                               :body :code)))))))

;; ------------------------------------------------------------------
;; What a delete leaves
;; ------------------------------------------------------------------

(deftest a-project-delete-takes-its-jobs
  (let [{:keys [p st]} (jh/world!)
        j (running-job! st p "running")]
    (call admin-request :post (str "/api/v1/jobs/" j "/decisions")
          {:worker-id jh/worker-a :decisions [{:form "ka" :key "k1" :analysis "{}" :count 1}]})
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p)))
    (removal/resume! fix/db)
    (is (= 404 (:status (heartbeat! j jh/worker-a))) "the worker's next write")
    (doseq [t [:jobs :job_documents :job_decisions]]
      (is (empty? (psc/q fix/db {:select [:*] :from [t]})) (name t)))))

(deftest a-deleted-documents-row-is-kept-with-no-name
  (let [{:keys [p st d1]} (jh/world!)
        j (job-id (start! st p))]
    (fix/assert-no-content (call admin-request :delete (str "/api/v1/documents/" d1)))
    (let [row (first (filter #(= d1 (:document-id %)) (:job/documents (get-job j))))]
      (is (some? row))
      (is (nil? (:name row))))))

(deftest every-end-settles-the-rows-it-did-not-finish
  ;; REV-J-A-2: the job page reads the rows, so a job that ended shows no
  ;; document "Waiting" or "Working". A row the worker finished keeps its state.
  (let [{:keys [p st d1 d2]} (jh/world!)
        states (fn [j] (into {} (map (juxt :document-id :state)) (:job/documents (get-job j))))
        put! (fn [j worker d state]
               (fix/assert-ok (call admin-request :put (str "/api/v1/jobs/" j "/documents/" d)
                                    {:worker-id worker :state state})))]
    (testing "a waiting job cancelled"
      (let [j (job-id (start! st p))]
        (fix/assert-ok (call st :post (str "/api/v1/jobs/" j "/cancel")))
        (is (= {d1 "not-reached" d2 "not-reached"} (states j)))))
    (doseq [[from to] [["running" "done"] ["running" "cancelled"] ["running" "failed"]
                       ["stopping" "cancelled"] ["stopping" "failed"]]]
      (testing (str "a " from " job its worker finishes " to)
        (let [j (running-job! st p from)]
          (put! j jh/worker-a d2 "working")
          (is (= {d1 "waiting" d2 "working"} (states j)))
          (fix/assert-ok (finish! j jh/worker-a to))
          (is (= {d1 "not-reached" d2 "not-reached"} (states j))))))
    (testing "a deferred row, and a row the worker finished"
      (let [j (running-job! st p "running")]
        (put! j jh/worker-a d2 "done")
        (put! j jh/worker-a d1 "deferred")
        (fix/assert-ok (finish! j jh/worker-a "done"))
        (is (= {d1 "not-reached" d2 "done"} (states j)))))
    (testing "a job failed at a heartbeat, before its worker sends the report"
      (let [j (running-job! st p "running")]
        (put! j jh/worker-a d2 "working")
        (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/starter@example.com")))
        (is (= "job-failed" (-> (heartbeat! j jh/worker-a) :body :code)))
        (is (= {d1 "not-reached" d2 "not-reached"} (states j)))
        (jh/grant! p "writers" "starter@example.com")
        (fix/assert-ok (finish! j jh/worker-a "failed"))))))

(deftest an-end-core-decides-clears-the-workers-line
  (let [{:keys [p st]} (jh/world!)
        line {:message "Sentences 1 to 5 of 40."}
        demote! (fn [] (fix/assert-no-content (call admin-request :delete (str "/api/v1/projects/" p "/writers/starter@example.com"))))
        restore! (fn [] (jh/grant! p "writers" "starter@example.com"))]
    (testing "a lapsed lease cancelled by core"
      (let [j (running-job! st p "running")]
        (heartbeat! j jh/worker-a line)
        (lapse! j)
        (let [job (:body (call st :post (str "/api/v1/jobs/" j "/cancel")))]
          (is (= "cancelled" (:job/state job)))
          (is (nil? (:job/message job))))))
    (testing "starter-access at the heartbeat"
      (let [j (running-job! st p "running")]
        (heartbeat! j jh/worker-a line)
        (demote!)
        (is (= "job-failed" (-> (heartbeat! j jh/worker-a) :body :code)))
        (is (nil? (:job/message (get-job j))))
        (restore!)
        (fix/assert-ok (finish! j jh/worker-a "failed"))))
    (testing "starter-access at the claim, for a job whose lease lapsed"
      (let [j (running-job! st p "running")]
        (heartbeat! j jh/worker-a line)
        (lapse! j)
        (demote!)
        (is (= 204 (:status (claim! jh/worker-b))))
        (let [job (get-job j)]
          (is (= ["failed" "starter-access"] [(:job/state job) (:job/reason job)]))
          (is (nil? (:job/message job))))))))
