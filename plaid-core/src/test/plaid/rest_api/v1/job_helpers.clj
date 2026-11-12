(ns plaid.rest-api.v1.job-helpers
  "Shared set-up for the job tests: a project with every role the role matrix
  of the jobs SPEC names, callers for each, and the worker's calls."
  (:require [plaid.fixtures :as fix :refer [api-call admin-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.sql.common :as psc]
            [plaid.sql.user :as pxu]
            [plaid.test-helpers :as h]
            [ring.mock.request :as mock]))

(defn as
  "A request fn signed with `token`."
  [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn user!
  "A new account `email` and a request fn with its session token."
  ([email] (user! email false))
  ([email admin?]
   (pxu/create fix/db email admin? "password-for-jobs" nil)
   (as (auth/issue-session-token! fix/db "fake-secret" email))))

(defn call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} body (assoc :body body))))

(defn grant! [project role email]
  (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" project "/" role "/" email))))

(defn world!
  "Project P with two documents, and a caller per column of the role matrix:
  `:st` the starter (a writer), `:w` another writer, `:m` a maintainer, `:r` a
  reader, `:n` signed in with no role, `:a` the admin (the standing admin), and
  `:s` a delegated token of the maintainer scoped to P. Also project Q with
  one document, which nobody but the admin holds."
  []
  (let [p (h/create-test-project admin-request "Jobs P")
        d1 (h/create-test-document admin-request p "b doc")
        d2 (h/create-test-document admin-request p "a doc")
        q (h/create-test-project admin-request "Jobs Q")
        dq (h/create-test-document admin-request q "q doc")
        st (user! "starter@example.com")
        w (user! "writer@example.com")
        m (user! "maintainer@example.com")
        r (user! "reader@example.com")
        n (user! "nobody@example.com")]
    (grant! p "writers" "starter@example.com")
    (grant! p "writers" "writer@example.com")
    (grant! p "maintainers" "maintainer@example.com")
    (grant! p "readers" "reader@example.com")
    {:p (str p) :q (str q) :d1 (str d1) :d2 (str d2) :dq (str dq)
     :st st :w w :m m :r r :n n :a admin-request
     :s (as (auth/issue-delegated-token! fix/db "fake-secret" "maintainer@example.com" [p]))}))

(defn start!
  "Start a job on `project` as `who`. Returns the response."
  ([who project] (start! who project {}))
  ([who project body]
   (call who :post (str "/api/v1/projects/" project "/jobs")
         (merge {:app "igt" :tasks ["gloss"]} body))))

(defn job-id [resp] (-> resp :body :job/id))

(def worker-a #uuid "0197d1a0-0000-7000-8000-00000000000a")
(def worker-b #uuid "0197d1a0-0000-7000-8000-00000000000b")

(defn claim!
  "The admin worker `worker` asks for a job."
  ([worker] (claim! worker ["igt"]))
  ([worker apps]
   (call admin-request :post "/api/v1/jobs/claim" {:worker-id worker :model "m1" :apps apps})))

(defn heartbeat! [job worker & [fields]]
  (call admin-request :post (str "/api/v1/jobs/" job "/heartbeat") (merge {:worker-id worker} fields)))

(defn finish! [job worker state & [extra]]
  (call admin-request :post (str "/api/v1/jobs/" job "/finish")
        (merge {:worker-id worker :state state :report {:state state}} extra)))

(defn lapse!
  "Make job `job`'s lease lapse, as if its worker had stopped beating."
  [job]
  (psc/execute! fix/db {:update :jobs :set {:heartbeat_at "2020-01-01T00:00:00.000000000Z"}
                        :where [:= :id (str job)]}))

(defn job-row [job]
  (psc/q1 fix/db {:select [:*] :from [:jobs] :where [:= :id (str job)]}))
