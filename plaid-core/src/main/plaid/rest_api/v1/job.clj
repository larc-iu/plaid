(ns plaid.rest-api.v1.job
  "REST surface for assistant jobs. See `plaid.sql.job` for what a job is and
  its states, and the manual's \"Assistant jobs\" for the protocol.

  ## Who may

  - Start: a writer of the project (`wrap-writer-required`, which an admin
    passes too).
  - Read a job, list a project's jobs, read its active one: a reader.
  - Stop: the starter while they still write the project, a maintainer, an
    admin.
  - A delegated (scoped) token may neither start nor stop a job: a job
    outlives any delegated token, and starting one is a person's decision.
  - The worker's routes are an admin's (`wrap-admin-required`): the worker
    sees the jobs of every project and the model load of every project's
    services. It writes into documents only with the tokens core mints for
    each job's starter (`pra/issue-job-token!`).
  - `GET /jobs/worker` is open to anyone signed in, and refused to a scoped
    token, as every route with no project behind it is.

  A job id that names nothing, or a job of a project being deleted, answers a
  non-admin 403 with `unresolved` and an admin 404, as every unknown id does.

  ## Signals, not edits

  None of these writes is an operation: nothing is audited, no document is
  bumped. The worker's routes carry `:plaid/idempotency false`, as the
  heartbeat of a lock does: each is a signal of the moment, never replayed."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.server.events :as events]
            [plaid.sql.common :as psc]
            [plaid.sql.job :as job])
  (:import (java.time Instant)))

;; ============================================================
;; Gates
;; ============================================================

(defn- job-project-id
  "The project of the job the path names, or nil when there is no such job
  or its project is being deleted."
  [{db :db params :parameters}]
  (some->> (-> params :path :job-id) (job/project-id db)))

(def ^:private delegated-refusal
  {:status 403 :body {:error "A delegated token cannot start or stop a job."}})

(defn- wrap-no-delegated
  "Refuse a scoped token before any other gate."
  [handler]
  (fn [request]
    (if (:auth/token-scope request)
      delegated-refusal
      (handler request))))

(defn- answer
  "Run `f`, answering a refusal `plaid.sql.job` throws with its status and
  body, and one of the shared checks (an id already used, an id that is not
  a UUIDv7) with its code and body."
  [f]
  (try (f)
       (catch clojure.lang.ExceptionInfo e
         (let [{:keys [code] body :plaid/body} (ex-data e)]
           (or (job/refusal e)
               (when (and (int? code) (<= 400 code 499))
                 {:status code :body (or body {:error (ex-message e)})})
               (throw e))))))

(defn- not-found []
  {:status 404 :body {:error "Job not found"}})

(defn- job-token
  "A job token for the starter of `job-id` on `project-id`, minted for the
  worker `worker-id` whose `request` asks (`pra/issue-job-token!`). It
  works while that worker holds the job and the job runs."
  [{db :db :as request} project-id job-id worker-id starter]
  (pra/issue-job-token! db (:secret-key request) starter project-id job-id worker-id
                        (-> request :jwt-data :exp)
                        (:user/id request)
                        (or (:api-token/id request) (-> request :jwt-data :delegated/api-token))))

(defn- iso [ms]
  (when ms (psc/instant->iso (Instant/ofEpochMilli ms))))

;; ============================================================
;; Bodies
;; ============================================================

(def ^:private worker-only {:plaid/idempotency false
                            :middleware [pra/wrap-admin-required]})

(def ^:private document-body
  [:map
   [:worker-id :uuid]
   [:state {:optional true} (into [:enum] (sort job/document-states))]
   [:sentences {:optional true} [:maybe [:int {:min 0}]]]
   [:targets {:optional true} [:maybe [:int {:min 0}]]]
   [:done {:optional true} [:maybe [:int {:min 0}]]]
   [:last-sentence {:optional true} [:maybe :string]]
   [:defers {:optional true} [:int {:min 0}]]
   [:counts {:optional true} [:map-of :any :any]]
   [:skipped {:optional true} [:sequential :any]]
   [:gloss-group {:optional true} [:maybe :string]]
   [:harmonize-group {:optional true} [:maybe :string]]])

;; ============================================================
;; Routes
;; ============================================================

(def job-routes
  [["/projects/:id/jobs"
    {:openapi {:security [{:auth []}]}
     :parameters {:path [:map [:id :uuid]]}}

    [""
     {:post {:summary (str "Start a job on the project, for the signed-in writer. <body>app</body> names "
                           "the app (`igt`), <body>documents</body> the documents in order (left out: "
                           "every document of the project, by name), <body>instructions</body> what the job "
                           "is to do, required. 409 with <code>job-active</code> while the project has a job that has "
                           "not ended. Refused to a delegated token.")
             :middleware [wrap-no-delegated [pra/wrap-writer-required (fn [r] (-> r :parameters :path :id))]]
             :parameters {:body [:map
                                 [:id {:optional true} :uuid]
                                 [:app :string]
                                 [:documents {:optional true} [:vector :uuid]]
                                 [:instructions {:optional true} [:maybe :string]]]}
             :handler (fn [{{{:keys [id]} :path body :body} :parameters db :db user-id :user/id}]
                        (answer #(hash-map :status 201
                                           :body (job/create! db id body user-id))))}

      :get {:summary "List the project's jobs, newest first; keyset-paginated. Entries carry no documents or report, and count their documents."
            :middleware [[pra/wrap-reader-required (fn [r] (-> r :parameters :path :id))]]
            :parameters {:query (into [:map] pagination/query-params)}
            :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                       (pagination/list-response query #(job/list-page db id %)))}}]

    ["/active"
     {:get {:summary "The project's job that has not ended, with its documents, or 204 when there is none."
            :middleware [[pra/wrap-reader-required (fn [r] (-> r :parameters :path :id))]]
            :handler (fn [{{{:keys [id]} :path} :parameters db :db}]
                       (if-let [j (job/active db id)]
                         {:status 200 :body j}
                         {:status 204}))}}]]

   ["/jobs"
    {:openapi {:security [{:auth []}]}}

    ["/claim"
     {:conflicting true
      :post (merge worker-only
                   {:summary (str "Worker: take the next job, or 204 when there is none or one is running. "
                                  "Answers the job, a token for its starter and the heartbeat interval. Admin only.")
                    :parameters {:body [:map
                                        [:worker-id :uuid]
                                        [:model :string]
                                        [:apps [:vector :string]]]}
                    :handler (fn [{{{:keys [worker-id model apps]} :body} :parameters db :db user-id :user/id :as request}]
                               (events/record-job-worker! model)
                               (if-let [j (job/claim! db {:worker-id worker-id :worker-user user-id
                                                          :model model :apps apps})]
                                 {:status 200
                                  :body {:job j
                                         :token (job-token request (:job/project j) (:job/id j) worker-id (:job/started-by j))
                                         :heartbeat-s 30}}
                                 {:status 204}))})}]

    ["/worker"
     {:conflicting true
      :get {:summary (str "When a job worker last asked for work or reported, since the server started, "
                          "and the model it runs, with the longest instructions and the most documents a job takes.")
            :handler (fn [_]
                       (let [{:keys [seen-at model]} (events/job-worker-seen)]
                         {:status 200 :body {:seen-at (iso seen-at)
                                             :model model
                                             :instructions-max-chars job/instructions-max-chars
                                             :documents-max job/documents-max}}))}}]

    ["/model-busy"
     {:conflicting true
      :get (merge worker-only
                  {:summary (str "Worker: how many requests to services drawing on model pool "
                                 "<query>pool</query> are running, and when the last one finished. Admin only.")
                   :parameters {:query [:map [:pool [:string {:min 1}]]]}
                   :handler (fn [{{{:keys [pool]} :query} :parameters}]
                              (let [{:keys [in-flight last-finished-at]} (events/model-pool-load pool)]
                                {:status 200 :body {:in-flight in-flight
                                                    :last-finished-at (iso last-finished-at)}}))})}]

    ["/:job-id"
     {:conflicting true
      :parameters {:path [:map [:job-id :uuid]]}}

     [""
      {:get {:summary "Read a job, with its documents and its report."
             :middleware [[pra/wrap-reader-required job-project-id]]
             :handler (fn [{{{:keys [job-id]} :path} :parameters db :db}]
                        (if-let [j (job/get db job-id)]
                          {:status 200 :body j}
                          (not-found)))}}]

     ["/cancel"
      {:post {:summary (str "Stop a job. A waiting job ends at once, a running one stops after the work in "
                            "hand. For the person who started it while they write the project, a maintainer, "
                            "an admin. Refused to a delegated token.")
              :middleware [wrap-no-delegated [pra/wrap-reader-required job-project-id]]
              :handler (fn [{{{:keys [job-id]} :path} :parameters db :db user-id :user/id :as request}]
                         (if-let [j (job/get db job-id)]
                           (if (or (pra/privileged? request :project/maintainers job-project-id)
                                   (and (= user-id (:job/started-by j))
                                        (pra/privileged? request :project/writers job-project-id)))
                             (answer #(hash-map :status 200 :body (job/cancel! db job-id user-id)))
                             {:status 403
                              :body {:error "Only the person who started a job or a maintainer can stop it."}})
                           (not-found)))}}]

     ["/heartbeat"
      {:post (merge worker-only
                    {:summary "Worker: report on a job and renew its lease. Answers its state and a fresh token."
                     :parameters {:body [:map
                                         [:worker-id :uuid]
                                         [:phase {:optional true} [:maybe (into [:enum] (sort job/phases))]]
                                         [:message {:optional true} [:maybe [:string {:max job/message-max-chars}]]]
                                         [:waiting-for {:optional true} [:maybe (into [:enum] (sort job/waiting-fors))]]
                                         [:current-document {:optional true} [:maybe :uuid]]]}
                     :handler (fn [{{{:keys [job-id]} :path {:keys [worker-id] :as body} :body} :parameters
                                    db :db :as request}]
                                (events/record-job-worker! nil)
                                (answer
                                 (fn []
                                   (let [r (job/heartbeat! db job-id worker-id (dissoc body :worker-id))]
                                     (if (= r ::job/starter-access)
                                       {:status 409
                                        :body {:error "The person who started this job can no longer write in this project."
                                               :code "job-failed"
                                               :reason "starter-access"}}
                                       {:status 200
                                        :body {:state (:state r)
                                               :token (job-token request (:project-id r) job-id worker-id (:started-by r))
                                               :lease-s job/lease-s}})))))})}]

     ["/documents/:document-id"
      {:parameters {:path [:map [:job-id :uuid] [:document-id :uuid]]}
       :put (merge worker-only
                   {:summary "Worker: set what it reports of one document of the job."
                    :parameters {:body document-body}
                    :handler (fn [{{{:keys [job-id document-id]} :path {:keys [worker-id] :as body} :body} :parameters
                                   db :db}]
                               (answer #(hash-map :status 200
                                                  :body (job/update-document! db job-id document-id worker-id
                                                                              (dissoc body :worker-id)))))})}]

     ["/finish"
      {:post (merge worker-only
                    {:summary "Worker: end the job as done, cancelled or failed, with its report."
                     :parameters {:body [:map
                                         [:worker-id :uuid]
                                         [:state [:enum "done" "cancelled" "failed"]]
                                         [:reason {:optional true} [:maybe :string]]
                                         [:report [:map-of :any :any]]]}
                     :handler (fn [{{{:keys [job-id]} :path {:keys [worker-id] :as body} :body} :parameters db :db}]
                                (answer #(hash-map :status 200
                                                   :body (job/finish! db job-id worker-id body))))})}]

     ["/decisions"
      {:post (merge worker-only
                    {:summary "Worker: add to the counts of how the job analysed each form."
                     :parameters {:body [:map
                                         [:worker-id :uuid]
                                         [:decisions [:vector [:map
                                                               [:form :string]
                                                               [:key :string]
                                                               [:analysis :string]
                                                               [:count [:int {:min 0}]]
                                                               [:document-id {:optional true} [:maybe :string]]
                                                               [:sentence-id {:optional true} [:maybe :string]]]]]]}
                     :handler (fn [{{{:keys [job-id]} :path {:keys [worker-id decisions]} :body} :parameters db :db}]
                                (answer (fn []
                                          (job/add-decisions! db job-id worker-id decisions)
                                          {:status 204})))})
       :get (merge worker-only
                   {:summary "Worker: every decision of the job, by form; keyset-paginated."
                    :parameters {:query (into [:map] pagination/query-params)}
                    :handler (fn [{{{:keys [job-id]} :path query :query} :parameters db :db}]
                               (if (job/project-id db job-id)
                                 (pagination/list-response query #(job/decisions-page db job-id %))
                                 (not-found)))})}]

     ["/decisions/lookup"
      {:post (merge worker-only
                    {:summary "Worker: every decision of the job on the forms named, by form, then count."
                     :parameters {:body [:map [:forms [:vector :string]]]}
                     :handler (fn [{{{:keys [job-id]} :path {:keys [forms]} :body} :parameters db :db}]
                                (cond
                                  (empty? forms)
                                  {:status 400 :body {:error "forms: give at least one form."}}

                                  (> (count forms) job/decisions-per-call)
                                  {:status 400 :body {:error (str "forms: at most " job/decisions-per-call
                                                                  " in one call.")}}

                                  (nil? (job/project-id db job-id))
                                  (not-found)

                                  :else
                                  {:status 200 :body (job/lookup-decisions db job-id forms)}))})}]]]])
