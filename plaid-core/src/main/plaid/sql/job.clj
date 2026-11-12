(ns plaid.sql.job
  "Assistant jobs: unattended glossing a writer starts and a worker process
  carries out. A job names a project, an app, its tasks, its documents in
  order and an optional note. One worker, run by an admin, takes jobs one at
  a time across the server, in the order they were made, and reports on each
  document as it goes. See the migration `20261113120000-jobs.up.sql` for the
  tables and `plaid.rest-api.v1.job` for who may do what.

  OUTSIDE THE RECORD. Like client events and service claims, every write here
  is a raw statement, not an operation: no audit row, no document version
  bump, nothing time-travelable. What a job writes into documents goes
  through the ordinary routes, under the starter's name, and is audited
  there.

  States. `waiting`, `running` and `stopping` are ACTIVE, and a project has at
  most one active job. `done`, `cancelled` and `failed` are final. A
  `running` or `stopping` job holds a LEASE while its worker's heartbeats
  arrive, and the lease lapses `lease-s` seconds after the last one. Every
  change of state runs in one write transaction, so two workers, or a worker
  and a person stopping the job, never both see the state they act on."
  (:refer-clojure :exclude [get list])
  (:require [clojure.string :as str]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [plaid.sql.pagination :as pg]
            [plaid.sql.project :as prj]
            [plaid.sql.user :as user]
            [plaid.util.codepoint :as cp])
  (:import (java.time Instant)
           (java.util Locale)))

;; ============================================================
;; Constants (CONTRACT 1, core's rows)
;; ============================================================

(def apps
  "The apps a job may be made for, each with its tasks in the order a job
  lists them. Closed: an app adds a row when it has a worker."
  {"igt" ["translate" "gloss" "link"]})

(def slots
  "How many jobs hold a lease at once, server-wide."
  1)

(def lease-s
  "Seconds after its last heartbeat that a job's lease lapses."
  120)

(def documents-max
  "The most documents one job takes."
  500)

(def note-max-chars
  "The longest note, in characters. The note goes with every stretch the
  worker sends the model, so it is bounded like any part of the prompt."
  2000)

(def report-max-bytes
  "The largest report, as JSON text in UTF-8."
  1000000)

(def analysis-max-chars
  "The longest decision `analysis`, in characters."
  4000)

(def key-max-chars
  "The longest decision `key`, in characters."
  128)

(def decisions-per-call
  "The most decisions one call adds, and the most forms one lookup names."
  1000)

(def skipped-per-document
  "The most skipped sentences a document row lists."
  500)

(def message-max-chars
  "The longest message line a worker sets."
  300)

(def active-states #{"waiting" "running" "stopping"})
(def final-states #{"done" "cancelled" "failed"})
(def phases #{"checking" "glossing" "harmonizing" "reporting"})
(def waiting-fors #{"people" "model"})
(def document-states #{"waiting" "working" "deferred" "done" "in-use" "gone" "not-reached"})

;; ============================================================
;; Refusals
;; ============================================================

(defn- refuse
  "Throw a refusal the REST layer answers with `status` and `body`."
  [status body]
  (throw (ex-info (str (:error body)) {::status status ::body body})))

(defn refusal
  "The `{:status :body}` a refusal thrown here carries, or nil for any other
  exception."
  [e]
  (when-let [status (::status (ex-data e))]
    {:status status :body (::body (ex-data e))}))

(defn- grouped
  "`n` with a comma between each three digits: 2,412."
  [n]
  (String/format Locale/US "%,d" (object-array [n])))

(def ^:private gone-body {:error "Job not found"})
(def ^:private taken-body {:error "Another worker holds this job." :code "job-taken"})
(def ^:private finished-body {:error "This job has ended." :code "job-finished"})
(def ^:private starter-body
  {:error "The person who started this job can no longer write in this project."
   :code "job-failed"
   :reason "starter-access"})

;; ============================================================
;; Time and the lease
;; ============================================================

(defn- lease-live?
  "Has the job's worker sent a heartbeat within `lease-s` of `now`?"
  [row ^Instant now]
  (boolean
   (when-let [hb (:heartbeat_at row)]
     (.isAfter (.plusSeconds (Instant/parse hb) lease-s) now))))

(defn starter-writes?
  "May `user-id` still write project `project-id`: active, the project not
  being deleted, and an admin or a writer or maintainer of it. A job writes
  with its starter's rights, so it goes on only while they hold them."
  [db project-id user-id]
  (let [account (user/get-internal db user-id)]
    (boolean (and account
                  (nil? (:user/deactivated-at account))
                  (not (prj/hidden? db project-id))
                  (or (user/admin? account)
                      (#{:project/writers :project/maintainers}
                       (prj/role-of db project-id user-id)))))))

;; ============================================================
;; Reads
;; ============================================================

(defn- job-row [db id]
  (psc/q1 db {:select [:j.*]
              :from [[:jobs :j]]
              :join [[:projects :p] [:= :p.id :j.project_id]]
              :where [:and [:= :j.id (str id)] [:= :p.deleted_at nil]]}))

(defn project-id
  "The project of job `id`, or nil when there is no such job or its project
  is being deleted. A job of a hidden project answers as an unknown one."
  [db id]
  (some-> (job-row db id) :project_id str))

(defn- document-rows [db job-id]
  (psc/q db {:select [:jd.* [:d.name :name]]
             :from [[:job_documents :jd]]
             :left-join [[:documents :d] [:= :d.id :jd.document_id]]
             :where [:= :jd.job_id (str job-id)]
             :order-by [:jd.position]}))

(defn- row->document
  "A document row as the wire carries it, with the document's live name."
  [row]
  {:document-id (str (:document_id row))
   :name (:name row)
   :position (:position row)
   :state (:state row)
   :sentences (:sentences row)
   :targets (:targets row)
   :done (:done row)
   :last-sentence (:last_sentence row)
   :defers (:defers row)
   :counts (psc/read-json (:counts row))
   :skipped (psc/read-json (:skipped row))
   :gloss-group (:gloss_group row)
   :harmonize-group (:harmonize_group row)
   :updated-at (:updated_at row)})

(defn- ahead
  "For a waiting job, the active jobs created before it on the server, its
  place in the queue. Nil for any other state."
  [db row]
  (when (= "waiting" (:state row))
    (:n (psc/q1 db {:select [[[:count :*] :n]]
                    :from [[:jobs :j]]
                    :join [[:projects :p] [:= :p.id :j.project_id]]
                    :where [:and
                            [:in :j.state (vec active-states)]
                            [:= :p.deleted_at nil]
                            [:or
                             [:< :j.created_at (:created_at row)]
                             [:and [:= :j.created_at (:created_at row)] [:< :j.id (str (:id row))]]]]}))))

(defn- display-name [db user-id]
  (:display_name (psc/q1 db {:select [:display_name] :from [:users] :where [:= :id user-id]})))

(defn- row->job
  "A job as the wire carries it. `parts` says what to add: `:documents`, the
  document rows, `:report`, the stored report."
  [db row parts]
  (when row
    (cond-> {:job/id (str (:id row))
             :job/project (str (:project_id row))
             :job/app (:app row)
             :job/tasks (vec (psc/read-json (:tasks row)))
             :job/note (:note row)
             :job/started-by (:started_by row)
             :job/started-by-name (display-name db (:started_by row))
             :job/state (:state row)
             :job/phase (:phase row)
             :job/reason (:reason row)
             :job/message (:message row)
             :job/waiting-for (:waiting_for row)
             :job/current-document (:current_document row)
             :job/cancelled-by (:cancelled_by row)
             :job/model (:model row)
             :job/created-at (:created_at row)
             :job/started-at (:started_at row)
             :job/heartbeat-at (:heartbeat_at row)
             :job/finished-at (:finished_at row)
             :job/lease-s lease-s
             :job/ahead (ahead db row)}
      (:documents parts) (assoc :job/documents (mapv row->document (document-rows db (:id row))))
      (:report parts) (assoc :job/report (psc/read-json (:report row))))))

(defn get
  "Job `id` with its document rows and report, or nil when there is no such
  job or its project is being deleted."
  [db id]
  (row->job db (job-row db id) #{:documents :report}))

(defn active
  "Project `project-id`'s active job with its document rows and a null
  report, or nil when it has none."
  [db project-id]
  (some-> (psc/q1 db {:select [:*]
                      :from [:jobs]
                      :where [:and [:= :project_id (str project-id)]
                              [:in :state (vec active-states)]]
                      :order-by [:created_at :id]
                      :limit 1})
          (as-> row (assoc (row->job db row #{:documents}) :job/report nil))))

(defn list-page
  "One page of project `project-id`'s jobs, newest first by `(created_at,
  id)`, each without its documents and report, with `:job/document-count`,
  the number of documents the job holds."
  [db project-id {:keys [limit cursor-vals]}]
  (let [lim (pg/clamp-limit limit)
        seek (pg/keyset-where [:created_at :id] cursor-vals :desc)
        rows (psc/q db {:select [:j.* [{:select [[[:count :*]]]
                                        :from [[:job_documents :jd]]
                                        :where [:= :jd.job_id :j.id]}
                                       :document_count]]
                        :from [[:jobs :j]]
                        :where (cond-> [:and [:= :j.project_id (str project-id)]]
                                 seek (conj seek))
                        :order-by [[:j.created_at :desc] [:j.id :desc]]
                        :limit lim})]
    {:entries (mapv #(assoc (row->job db % #{}) :job/document-count (:document_count %)) rows)
     :next-cursor (when (= (count rows) lim)
                    (let [r (peek rows)] [(:created_at r) (str (:id r))]))}))

;; ============================================================
;; Start
;; ============================================================

(defn- live-documents
  "The ids of project `project-id`'s documents, by name then id."
  [db project-id]
  (mapv (comp str :id)
        (psc/q db {:select [:id] :from [:documents]
                   :where [:= :project_id (str project-id)]
                   :order-by [:name :id]})))

(defn- check-start!
  "The start body's tasks in `apps` order and its document ids, or a 400 for
  the first rule it breaks (CONTRACT 3.1)."
  [db project-id {:keys [app tasks documents note]}]
  (let [known (clojure.core/get apps app)]
    (when-not known
      (refuse 400 {:error (str "Unknown app: " app ".")}))
    (when (or (empty? tasks) (not-every? (set known) tasks))
      (refuse 400 {:error (str "tasks: give at least one of " (str/join ", " known) ".")}))
    (when (and (some #{"link"} tasks) (not (some #{"gloss"} tasks)))
      (refuse 400 {:error "tasks: link needs gloss."}))
    (let [ordered-tasks (filterv (set tasks) known)
          docs (if (some? documents)
                 (let [_ (when (empty? documents)
                           (refuse 400 {:error "documents: give at least one document, or leave them out for all."}))
                       ids (vec (distinct (map (comp str/lower-case str) documents)))
                       in-project (set (live-documents db project-id))
                       outside (count (remove in-project ids))]
                   (when (pos? outside)
                     (refuse 400 {:error (str "documents: " outside
                                              (if (= 1 outside) " is not a document" " are not documents")
                                              " of this project.")}))
                   ids)
                 (live-documents db project-id))]
      (when (> (count docs) documents-max)
        (refuse 400 {:error (str "A job takes at most " documents-max " documents. This one names "
                                 (grouped (count docs)) ".")}))
      (when (and note (> (cp/cp-count note) note-max-chars))
        (refuse 400 {:error (str "The note is " (grouped (cp/cp-count note)) " characters. A job's note is at most "
                                 (grouped note-max-chars) ".")}))
      (when (empty? docs)
        (refuse 400 {:error "This project has no documents."}))
      [ordered-tasks docs])))

(defn create!
  "Start a job on project `project-id` for `user-id`. `body` is `{:id :app
  :tasks :documents :note}`. Left out, `documents` is every document of the
  project, by name then id. Returns the job. Refuses with 400 for a body
  that breaks a rule, 409 `job-active` while the project has an active job,
  and 409 `id-taken` for an id used before."
  [db project-id {:keys [id note] :as body} user-id]
  (psd/with-tx [tx db]
    (let [[tasks docs] (check-start! tx project-id body)]
      (when-let [other (psc/q1 tx {:select [:id] :from [:jobs]
                                   :where [:and [:= :project_id (str project-id)]
                                           [:in :state (vec active-states)]]})]
        (refuse 409 {:error "This project already has a job." :code "job-active" :job (str (:id other))}))
      (psc/claim-ids! tx :jobs "job" [id])
      (let [job-id (str (or id (psc/new-uuid)))
            now (psc/now-iso)]
        (psc/execute! tx {:insert-into :jobs
                          :values [{:id job-id
                                    :project_id (str project-id)
                                    :app (:app body)
                                    :tasks (psc/write-json tasks)
                                    :note (when-not (str/blank? note) note)
                                    :started_by user-id
                                    :state "waiting"
                                    :created_at now}]})
        (doseq [chunk (partition-all 500 (map-indexed vector docs))]
          (psc/execute! tx {:insert-into :job_documents
                            :values (for [[i d] chunk]
                                      {:job_id job-id :document_id d :position i
                                       :state "waiting" :updated_at now})}))
        (get tx job-id)))))

;; ============================================================
;; The report core writes itself
;; ============================================================

(def ^:private empty-harmonize {:changed [] :left [] :changed-more 0 :left-more 0})
(def ^:private empty-entries {:created [] :deleted [] :unlinked []
                              :created-more 0 :deleted-more 0 :unlinked-more 0
                              :lexicons []})

(defn- settle-rows!
  "Mark every document row a job did not finish `not-reached`."
  [tx job-id now]
  (psc/execute! tx {:update :job_documents
                    :set {:state "not-reached" :updated_at now}
                    :where [:and [:= :job_id (str job-id)]
                            [:in :state ["waiting" "working" "deferred"]]]}))

(defn- core-report
  "The report core writes for a job no worker finished (CONTRACT 5.3): the
  counts are the document rows', harmonize and entries are empty, and the
  time paused is not known. Call after the job's row and its documents' rows
  are settled."
  [tx job-id stopped]
  (let [row (psc/q1 tx {:select [:*] :from [:jobs] :where [:= :id (str job-id)]})
        docs (mapv row->document (document-rows tx job-id))
        count-of (fn [k] (reduce + 0 (keep #(clojure.core/get (:counts %) k) docs)))
        skipped (mapcat :skipped docs)
        skipped-of (fn [reason] (count (filter #(= reason (:reason %)) skipped)))
        in-state (fn [s] (count (filter #(= s (:state %)) docs)))]
    {:state (:state row)
     :reason (:reason row)
     :tasks (vec (psc/read-json (:tasks row)))
     :note (:note row)
     :started-by (:started_by row)
     :model (:model row)
     :started-at (:started_at row)
     :finished-at (:finished_at row)
     :paused-for-people-s nil
     :paused-for-model-s nil
     :stopped stopped
     :totals {:documents-done (in-state "done")
              :documents-in-use (in-state "in-use")
              :documents-gone (in-state "gone")
              :documents-not-reached (in-state "not-reached")
              :sentences (reduce + 0 (keep :done docs))
              :translations (count-of :translations)
              :refreshed (count-of :refreshed)
              :words (count-of :words)
              :links (count-of :links)
              :entries (count-of :entries)
              :skipped-too-long (skipped-of "too-long")
              :skipped-failed (skipped-of "failed")
              :skipped-changed (skipped-of "changed")
              :changed (count-of :changed)
              :protected (count-of :protected)}
     :documents (mapv #(select-keys % [:document-id :name :state :sentences :targets :done
                                       :counts :skipped :gloss-group :harmonize-group])
                      docs)
     :harmonize empty-harmonize
     :entries empty-entries}))

(defn- settle!
  "End job `job-id` as core decides it: `state` with `reason`, its unfinished
  rows `not-reached`, and the report core writes (`stopped` is the report's
  `stopped`). `extra` is more columns to set. Every end core decides clears
  `message`, the worker's last line, so the apps word the end by its reason."
  [tx job-id state reason stopped extra]
  (let [now (psc/now-iso)]
    (psc/execute! tx {:update :jobs
                      :set (merge {:state state :reason reason :finished_at now
                                   :message nil :current_document nil :waiting_for nil}
                                  extra)
                      :where [:= :id (str job-id)]})
    (settle-rows! tx job-id now)
    (psc/execute! tx {:update :jobs
                      :set {:report (psc/write-json (core-report tx job-id stopped))}
                      :where [:= :id (str job-id)]})))

;; ============================================================
;; Cancel
;; ============================================================

(defn cancel!
  "Stop job `job-id` for `user-id` (CONTRACT 3.5). A waiting job is cancelled
  at once, a running one with a live lease becomes `stopping` and its worker
  ends it, and one whose lease has lapsed is cancelled by core with the
  report of its rows. 409 `job-finished` on a final state. Returns the job.
  Who may is the REST layer's."
  [db job-id user-id]
  (psd/with-tx [tx db]
    (let [row (or (job-row tx job-id) (refuse 404 gone-body))
          now (Instant/now)
          by {:cancelled_by (or (:cancelled_by row) user-id)}]
      (case (:state row)
        "waiting"
        (psc/execute! tx {:update :jobs
                          :set (merge by {:state "cancelled" :reason "cancelled" :message nil
                                          :finished_at (psc/instant->iso now)})
                          :where [:= :id (str job-id)]})

        ("running" "stopping")
        (if (lease-live? row now)
          (when (= "running" (:state row))
            (psc/execute! tx {:update :jobs :set (merge by {:state "stopping"})
                              :where [:= :id (str job-id)]}))
          (settle! tx job-id "cancelled" "cancelled" "without-worker" by))

        (refuse 409 finished-body))
      (get tx job-id))))

;; ============================================================
;; The worker: claim and heartbeat
;; ============================================================

(defn- take-job!
  [tx row {:keys [worker-id worker-user model]} now]
  (psc/execute! tx {:update :jobs
                    :set (cond-> {:worker_id (str worker-id)
                                  :worker_user worker-user
                                  :model model
                                  :heartbeat_at now
                                  :state (if (= "stopping" (:state row)) "stopping" "running")}
                           (nil? (:started_at row)) (assoc :started_at now))
                    :where [:= :id (str (:id row))]}))

(defn claim!
  "Give the asking worker the next job, or nil (CONTRACT 3.6). Nil while any
  job holds a live lease (`slots` is 1). Otherwise the oldest running or
  stopping job whose lease has lapsed, then the oldest waiting job, among
  jobs of `apps` whose project is not being deleted. A candidate whose
  starter can no longer write the project is failed with `starter-access`
  and the report of its rows, and the next one taken. `worker` is
  `{:worker-id :worker-user :model :apps}`. Returns the job taken."
  [db {:keys [apps] :as worker}]
  (psd/with-tx [tx db]
    (let [now (Instant/now)
          rows (psc/q tx {:select [:j.*]
                          :from [[:jobs :j]]
                          :join [[:projects :p] [:= :p.id :j.project_id]]
                          :where [:and [:in :j.state (vec active-states)] [:= :p.deleted_at nil]]
                          :order-by [:j.created_at :j.id]})
          running (filter #(#{"running" "stopping"} (:state %)) rows)]
      (when (> slots (count (filter #(lease-live? % now) running)))
        (let [wanted (set apps)
              candidates (filter #(wanted (:app %))
                                 (concat (remove #(lease-live? % now) running)
                                         (filter #(= "waiting" (:state %)) rows)))]
          (loop [[row & more] candidates]
            (when row
              (if (starter-writes? tx (:project_id row) (:started_by row))
                (do (take-job! tx row worker (psc/instant->iso now))
                    (get tx (:id row)))
                (do (settle! tx (:id row) "failed" "starter-access" nil {})
                    (recur more))))))))))

(defn- worker-row!
  "Job `job-id` for a write by worker `worker-id`, or a refusal: 404 for no
  such job or a hidden project, 409 `job-taken` for another worker's job."
  [tx job-id worker-id]
  (let [row (or (job-row tx job-id) (refuse 404 gone-body))]
    (when (not= (str worker-id) (:worker_id row))
      (refuse 409 taken-body))
    row))

(def ^:private heartbeat-columns
  {:phase :phase :message :message :waiting-for :waiting_for :current-document :current_document})

(defn heartbeat!
  "Record a heartbeat of worker `worker-id` on job `job-id` (CONTRACT 3.7).
  `fields` holds any of `:phase :message :waiting-for :current-document`,
  each setting its column, nil clearing it. A job whose starter can no longer
  write the project is failed with `starter-access`, its report left for the
  worker to send, and refused 409 `job-failed`. Returns the job's state."
  [db job-id worker-id fields]
  (psd/with-tx [tx db]
    (let [row (worker-row! tx job-id worker-id)]
      (cond
        (and (= "failed" (:state row)) (= "starter-access" (:reason row)) (nil? (:report row)))
        (refuse 409 starter-body)

        (final-states (:state row))
        (refuse 409 finished-body)

        (not (starter-writes? tx (:project_id row) (:started_by row)))
        (do (psc/execute! tx {:update :jobs
                              :set {:state "failed" :reason "starter-access" :message nil
                                    :finished_at (psc/now-iso)
                                    :current_document nil :waiting_for nil}
                              :where [:= :id (str job-id)]})
            ;; Committed, then refused: the worker learns of it from the
            ;; answer, and the job stays failed whatever it does next.
            ::starter-access)

        :else
        (do (psc/execute! tx {:update :jobs
                              :set (into {:heartbeat_at (psc/now-iso)}
                                         (for [[k col] heartbeat-columns
                                               :when (contains? fields k)]
                                           [col (some-> (clojure.core/get fields k) str)]))
                              :where [:= :id (str job-id)]})
            {:state (:state row)
             :project-id (str (:project_id row))
             :started-by (:started_by row)})))))

;; ============================================================
;; The worker: document rows
;; ============================================================

(def ^:private document-columns
  {:state :state :sentences :sentences :targets :targets :done :done
   :last-sentence :last_sentence :defers :defers :counts :counts :skipped :skipped
   :gloss-group :gloss_group :harmonize-group :harmonize_group})

(defn update-document!
  "Set what worker `worker-id` reports of document `document-id` in job
  `job-id` (CONTRACT 3.8). Each key of `fields` replaces its column. Returns
  the row."
  [db job-id document-id worker-id fields]
  (when (> (count (:skipped fields)) skipped-per-document)
    (refuse 400 {:error (str "skipped: a document lists at most " skipped-per-document " sentences.")}))
  (psd/with-tx [tx db]
    (worker-row! tx job-id worker-id)
    (let [where [:and [:= :job_id (str job-id)] [:= :document_id (str/lower-case (str document-id))]]]
      (when-not (psc/q1 tx {:select [:job_id] :from [:job_documents] :where where})
        (refuse 404 {:error "Document not in job"}))
      (psc/execute! tx {:update :job_documents
                        :set (into {:updated_at (psc/now-iso)}
                                   (for [[k col] document-columns
                                         :when (contains? fields k)
                                         :let [v (clojure.core/get fields k)]]
                                     [col (cond
                                            (#{:counts :skipped} k) (psc/write-json (or v (if (= k :counts) {} [])))
                                            (some? v) (if (number? v) v (str v))
                                            :else nil)]))
                        :where where})
      (row->document (psc/q1 tx {:select [:jd.* [:d.name :name]]
                                 :from [[:job_documents :jd]]
                                 :left-join [[:documents :d] [:= :d.id :jd.document_id]]
                                 :where [:and [:= :jd.job_id (str job-id)]
                                         [:= :jd.document_id (str/lower-case (str document-id))]]})))))

;; ============================================================
;; The worker: finish
;; ============================================================

(defn- may-end?
  "May a job in `row`'s state end as `state` (CONTRACT 3.10)?"
  [row state]
  (case state
    "done" (= "running" (:state row))
    "cancelled" (contains? #{"running" "stopping"} (:state row))
    "failed" (or (contains? #{"running" "stopping"} (:state row))
                 (and (= "failed" (:state row)) (nil? (:report row))))
    false))

(defn finish!
  "End job `job-id` as worker `worker-id` reports it: `state` (`done`,
  `cancelled` or `failed`), `reason` and the `report` it wrote (CONTRACT
  3.10). Returns the job."
  [db job-id worker-id {:keys [state reason report]}]
  (let [text (psc/write-json report)
        bytes (alength (.getBytes ^String text "UTF-8"))]
    (when (> bytes report-max-bytes)
      (refuse 400 {:error (str "The report is " (grouped bytes) " bytes. A job's report is at most "
                               (grouped report-max-bytes) ".")}))
    (psd/with-tx [tx db]
      (let [row (worker-row! tx job-id worker-id)]
        (when-not (may-end? row state)
          (refuse 409 {:error (str "This job cannot end as " state " now.") :code "job-state"}))
        (psc/execute! tx {:update :jobs
                          :set {:state state
                                :reason (or reason
                                            (when (= "failed" (:state row)) (:reason row))
                                            (when (= "cancelled" state) "cancelled"))
                                :report text
                                :finished_at (or (when (= "failed" (:state row)) (:finished_at row))
                                                 (psc/now-iso))
                                :current_document nil
                                :waiting_for nil}
                          :where [:= :id (str job-id)]})
        (get tx job-id)))))

;; ============================================================
;; The worker: decisions
;; ============================================================

(defn add-decisions!
  "Add worker `worker-id`'s `decisions` to job `job-id` (CONTRACT 3.11):
  each `count` is added to its `(form, key)` row's, and a new row records
  where the analysis was first written."
  [db job-id worker-id decisions]
  (when (> (count decisions) decisions-per-call)
    (refuse 400 {:error (str "decisions: at most " (grouped decisions-per-call) " in one call.")}))
  (doseq [[i {:keys [key analysis]}] (map-indexed vector decisions)]
    (when (> (cp/cp-count analysis) analysis-max-chars)
      (refuse 400 {:error (str "decisions[" i "]: the analysis is " (grouped (cp/cp-count analysis))
                               " characters. An analysis is at most " (grouped analysis-max-chars) ".")}))
    (when (> (cp/cp-count key) key-max-chars)
      (refuse 400 {:error (str "decisions[" i "]: the key is longer than " key-max-chars " characters.")})))
  (psd/with-tx [tx db]
    (worker-row! tx job-id worker-id)
    (doseq [{:keys [form key analysis count document-id sentence-id]} decisions]
      (psc/execute! tx [(str "INSERT INTO job_decisions "
                             "(job_id, form, key, analysis, count, first_document, first_sentence) "
                             "VALUES (?, ?, ?, ?, ?, ?, ?) "
                             "ON CONFLICT (job_id, form, key) DO UPDATE SET count = count + excluded.count")
                        (str job-id) form key analysis count
                        (some-> document-id str) (some-> sentence-id str)]))))

(defn- row->decision [row]
  {:form (:form row)
   :key (:key row)
   :analysis (:analysis row)
   :count (:count row)
   :first-document (:first_document row)
   :first-sentence (:first_sentence row)})

(defn lookup-decisions
  "Every decision of job `job-id` on one of `forms`, by form, then count
  descending, then key."
  [db job-id forms]
  (mapv row->decision
        (psc/q db {:select [:*] :from [:job_decisions]
                   :where [:and [:= :job_id (str job-id)] [:in :form (vec (distinct forms))]]
                   :order-by [:form [:count :desc] :key]})))

(defn decisions-page
  "One page of job `job-id`'s decisions by `(form, key)`."
  [db job-id {:keys [limit cursor-vals]}]
  (pg/paginate db {:from :job_decisions
                   :base-where [:= :job_id (str job-id)]
                   :order-by [:form :key]
                   :limit limit
                   :cursor-vals cursor-vals
                   :row->entity row->decision}))
