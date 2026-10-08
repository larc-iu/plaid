(ns plaid.rest-api.v1.delegation-runner-test
  "A delegating service acts for members other than its runner only where
  the runner is a maintainer, or anywhere when the runner is an admin (Luke,
  2026-10-08: \"if a maintainer runs a service I think all writers should be
  able to use that service\"). The token it is handed reaches the requester's
  projects intersected with the runner's maintained ones, asked again on
  every request, so a runner demoted or removed mid-session loses it at once.
  A writer's service still serves its runner. Discovery says who runs each
  service and whether it would take the caller's requests.

  ring-mock cannot hold an SSE channel, so `http-kit/as-channel` is redefined
  to open the REAL handler onto a stub channel, as in
  `delegated-token-lifetime-test`."
  (:require [buddy.sign.jwt :as jwt]
            [clojure.data.json :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [org.httpkit.server :as http-kit]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call admin-request]]
            [plaid.server.events :as events]
            [plaid.test-helpers :as h]
            [ring.mock.request :as mock]))

(defn with-rpc-state-started [f]
  (mount/start #'plaid.server.events/service-channels
               #'plaid.server.events/inflight-requests
               #'plaid.server.events/client-registry
               #'plaid.server.events/channel-mappings
               #'plaid.server.events/heartbeat-registry)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(def ^:private u1 "user1@example.com")
(def ^:private u2 "user2@example.com")

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} body (assoc :body body))))

(defn- stub-channel [closed sent]
  (reify http-kit/Channel
    (open? [_] (not @closed))
    (websocket? [_] false)
    (close [_] (reset! closed true) true)
    (send! [_ data] (swap! sent conj data) (not @closed))
    (send! [_ data _] (swap! sent conj data) (not @closed))
    (on-receive [_ _])
    (on-ping [_ _])
    (on-close [_ _])))

(defn- open-service!
  "Open delegating service `sid` on `pid` with `token`. Returns
  {:closed atom :sent atom}."
  [token pid sid]
  (let [closed (atom false)
        sent (atom [])
        ch (stub-channel closed sent)]
    (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                        (on-open ch)
                                        {:status 200 :body ""})]
      (fix/rest-handler ((as token) :get
                                    (str "/api/v1/projects/" pid "/services/" sid
                                         "/requests?service-name=" sid
                                         "&extras=" (java.net.URLEncoder/encode
                                                     (json/write-str {:delegation true}) "UTF-8")))))
    {:closed closed :sent sent}))

(defn- submit!
  "Submit work to `sid` on `pid` with `token`, joining `joined` projects.
  Returns the response, its body parsed when it is a refusal."
  [token pid sid & joined]
  (let [resp (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                                 (on-open (stub-channel (atom false) (atom [])))
                                                 {:status 200 :body ""})]
               (fix/rest-handler
                (-> ((as token) :post (str "/api/v1/projects/" pid "/services/" sid "/requests"
                                           (when (seq joined)
                                             (str "?project-ids=" (str/join "," joined)))))
                    (mock/json-body {:q 1}))))]
    (cond-> resp
      (not= 200 (:status resp)) (update :body #(when % (fix/parse-response-body resp))))))

(defn- handed
  "The last service_request event sent down `sent`, parsed."
  [sent]
  (when-let [frame (last (filter #(and (string? %) (str/starts-with? % "event: service_request")) @sent))]
    (json/read-str (second (re-find #"(?m)^data: (.*)$" frame)) :key-fn keyword)))

(defn- role! [pid role email]
  (call admin-request :post (str "/api/v1/projects/" pid "/" role "/" email)))

(defn- unrole! [pid role email]
  (call admin-request :delete (str "/api/v1/projects/" pid "/" role "/" email)))

(defn- status-with [token path]
  (:status (call (as token) :get path)))

(deftest a-maintainers-service-serves-every-member
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Runner P")
        _ (role! p "maintainers" u1)
        _ (role! p "writers" u2)
        {:keys [sent]} (open-service! fix/user1-token p "helper")]
    (is (= 200 (:status (submit! fix/user2-token p "helper"))))
    (let [{:keys [delegated-token requester-id]} (handed sent)]
      (is (= u2 requester-id))
      (is (= u1 (:scope/runner (jwt/unsign delegated-token "fake-secret")))
          "the token names who runs the service")
      (is (= 200 (status-with delegated-token (str "/api/v1/projects/" p)))))))

(deftest a-writers-service-serves-only-its-runner
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Writer P")
        _ (role! p "writers" u1)
        _ (role! p "writers" u2)
        {:keys [sent]} (open-service! fix/user1-token p "helper")]
    (testing "another writer is refused, and told who runs it"
      (let [resp (submit! fix/user2-token p "helper")]
        (is (= 403 (:status resp)))
        (is (= "helper is run by user1, who is not a maintainer of this project, so it acts only for user1 here."
               (-> resp :body :error)))
        (is (nil? (handed sent)) "the service was handed nothing")))
    (testing "an admin is refused too"
      (is (= 403 (:status (submit! fix/admin-token p "helper"))))
      (is (nil? (handed sent))))
    (testing "its runner still uses it, with a token that names no runner"
      (is (= 200 (:status (submit! fix/user1-token p "helper"))))
      (let [{:keys [delegated-token]} (handed sent)]
        (is (nil? (:scope/runner (jwt/unsign delegated-token "fake-secret"))))
        (is (= 200 (status-with delegated-token (str "/api/v1/projects/" p))))))))

(deftest an-admins-service-serves-every-member-everywhere-they-read
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Admin P")
        q (h/create-test-project admin-request "Admin Q")
        _ (role! p "writers" u2)
        _ (role! q "readers" u2)
        {:keys [sent]} (open-service! fix/admin-token p "helper")]
    (is (= 200 (:status (submit! fix/user2-token p "helper" q))))
    (let [{:keys [delegated-token delegated-projects]} (handed sent)]
      (is (= [(str p) (str q)] delegated-projects))
      (is (= 200 (status-with delegated-token (str "/api/v1/projects/" q)))
          "an admin runner maintains nothing, and still reaches every project the requester reads"))))

(deftest the-reach-is-the-intersection
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Home P")
        q (h/create-test-project admin-request "Kept Q")
        r (h/create-test-project admin-request "Writer R")
        s (h/create-test-project admin-request "Unread S")]
    (role! p "maintainers" u1)
    (role! q "maintainers" u1)
    (role! r "writers" u1)
    (role! s "maintainers" u1)
    (role! p "readers" u2)
    (role! q "readers" u2)
    (role! r "readers" u2)
    (let [{:keys [sent]} (open-service! fix/user1-token p "helper")]
      (testing "a project the runner does not maintain is refused, by name"
        (let [resp (submit! fix/user2-token p "helper" q r)]
          (is (= 403 (:status resp)))
          (is (= (str "helper is run by user1, who is not a maintainer of Writer R. "
                      "Remove Writer R from this conversation to go on.")
                 (-> resp :body :error)))
          (is (nil? (handed sent)))))
      (testing "the runner maintains it but the requester cannot read it: left out, as before"
        (is (= 200 (:status (submit! fix/user2-token p "helper" q s))))
        (let [{:keys [delegated-token delegated-projects]} (handed sent)]
          (is (= [(str p) (str q)] delegated-projects))
          (is (= 200 (status-with delegated-token (str "/api/v1/projects/" q))))
          (is (= 403 (status-with delegated-token (str "/api/v1/projects/" r))))
          (is (= 403 (status-with delegated-token (str "/api/v1/projects/" s)))))))))

(deftest a-runner-demoted-mid-session-takes-the-reach-with-them
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Demote P")
        q (h/create-test-project admin-request "Demote Q")]
    (role! p "maintainers" u1)
    (role! q "maintainers" u1)
    (role! p "writers" u2)
    (role! q "writers" u2)
    (let [{:keys [sent closed]} (open-service! fix/user1-token p "helper")]
      (is (= 200 (:status (submit! fix/user2-token p "helper" q))))
      (let [{token :delegated-token} (handed sent)]
        (is (= 200 (status-with token (str "/api/v1/projects/" q))))
        (testing "demoted to writer on Q: the token no longer reaches Q, still P"
          (role! q "writers" u1)
          (unrole! q "maintainers" u1)
          (is (= 403 (status-with token (str "/api/v1/projects/" q))))
          (is (= 403 (:status (call (as token) :post "/api/v1/documents" {:project-id q :name "late"}))))
          (is (= 200 (status-with token (str "/api/v1/projects/" p)))))
        (testing "demoted on P: the channel stays open (a writer may run one), the token stops, and so do new requests"
          (role! p "writers" u1)
          (unrole! p "maintainers" u1)
          (is (false? @closed))
          (is (= 403 (status-with token (str "/api/v1/projects/" p))))
          (is (= 403 (:status (submit! fix/user2-token p "helper")))))
        (testing "made maintainer again: the same token reaches P again within its hour"
          (role! p "maintainers" u1)
          (is (= 200 (status-with token (str "/api/v1/projects/" p)))))
        (testing "removed from P: the channel closes and the token stops"
          (unrole! p "maintainers" u1)
          (unrole! p "writers" u1)
          (is (true? @closed))
          (is (= 403 (status-with token (str "/api/v1/projects/" p))))
          (is (= 503 (:status (submit! fix/user2-token p "helper")))))))))

(deftest a-runner-deactivated-takes-the-reach-with-them
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Deactivate P")
        runner "runner3@example.com"
        _ (call admin-request :post "/api/v1/users" {:email runner :password "runner-pass-3" :is-admin false})
        runner-token (-> (fix/rest-handler (-> (mock/request :post "/api/v1/login")
                                               (mock/header "accept" "application/edn")
                                               (mock/json-body {:user-id runner :password "runner-pass-3"})))
                         fix/parse-response-body
                         :token)]
    (role! p "maintainers" runner)
    (role! p "writers" u2)
    (let [{:keys [sent]} (open-service! runner-token p "helper")]
      (is (= 200 (:status (submit! fix/user2-token p "helper"))))
      (let [{token :delegated-token} (handed sent)]
        (is (= 200 (status-with token (str "/api/v1/projects/" p))))
        (is (= 204 (:status (call admin-request :delete (str "/api/v1/users/" runner)))))
        (is (= 403 (status-with token (str "/api/v1/projects/" p))))))))

;; REV-FX9-DELEG: what the per-request check does not see.

(deftest two-refused-projects-are-named-together
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Two P")
        q (h/create-test-project admin-request "Two Q")
        r (h/create-test-project admin-request "Two R")]
    (role! p "maintainers" u1)
    (doseq [x [p q r]] (role! x "readers" u2))
    (let [{:keys [sent]} (open-service! fix/user1-token p "helper")
          resp (submit! fix/user2-token p "helper" q r)]
      (is (= 403 (:status resp)))
      (is (= (str "helper is run by user1, who is not a maintainer of Two Q and Two R. "
                  "Remove them from this conversation to go on.")
             (-> resp :body :error)))
      (is (nil? (handed sent))))))

(deftest a-listen-stream-on-a-handed-token-closes-with-the-runners-reach
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Listen P")
        listen! (fn [token]
                  (let [closed (atom false)
                        ch (stub-channel closed (atom []))]
                    (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                                        (on-open ch)
                                                        {:status 200 :body ""})]
                      (fix/rest-handler ((as token) :get (str "/api/v1/projects/" p "/listen"))))
                    (is (contains? @events/channel-mappings ch) "the stream opened")
                    closed))]
    (role! p "maintainers" u1)
    (role! p "writers" u2)
    (let [{:keys [sent]} (open-service! fix/user1-token p "helper")]
      (is (= 200 (:status (submit! fix/user2-token p "helper"))))
      (let [{token :delegated-token} (handed sent)
            on-token (listen! token)
            on-session (listen! fix/user2-token)]
        (is (not @on-token))
        (testing "the runner demoted: the stream the handed token opened closes, the requester's own stays"
          (role! p "writers" u1)
          (unrole! p "maintainers" u1)
          (is @on-token)
          (is (not @on-session)))))))

(deftest a-channel-another-account-took-before-the-push-is-handed-nothing
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Takeover P")]
    (role! p "maintainers" u1)
    (role! p "writers" u2)
    (open-service! fix/user1-token p "helper")
    (let [thief-sent (atom [])
          thief (stub-channel (atom false) thief-sent)
          requester-sent (atom [])
          resp (with-redefs [http-kit/as-channel
                             (fn [_ {:keys [on-open]}]
                               ;; Between the checks and the push, the maintainer's
                               ;; channel is gone and another account holds the id.
                               (events/register-service-channel!
                                p "helper" thief {:service-name "helper" :extras {:delegation true}}
                                "user3@example.com")
                               (on-open (stub-channel (atom false) requester-sent))
                               {:status 200 :body ""})]
                 (fix/rest-handler
                  (-> ((as fix/user2-token) :post (str "/api/v1/projects/" p "/services/helper/requests"))
                      (mock/json-body {:q 1}))))]
      (is (= 200 (:status resp)))
      (is (nil? (handed thief-sent)) "the token naming user1 never reached user3's channel")
      (is (some #(and (string? %) (str/includes? % "Service unavailable")) @requester-sent)))))

(deftest discovery-says-who-runs-a-service-and-whom-it-serves
  (events/reset-state!)
  (let [p (h/create-test-project admin-request "Discovery P")
        services (fn [token]
                   (->> (call (as token) :get (str "/api/v1/projects/" p "/services"))
                        :body
                        (filter :online)
                        (map (juxt :service-id #(select-keys % [:runner-name :run-by-you :serves-you])))
                        (into {})))]
    (role! p "maintainers" u1)
    (role! p "writers" u2)
    (open-service! fix/user1-token p "by-maintainer")
    (open-service! fix/user2-token p "by-writer")
    (is (= {"by-maintainer" {:runner-name "user1" :run-by-you false :serves-you true}
            "by-writer" {:runner-name "user2" :run-by-you false :serves-you false}}
           (services fix/admin-token)))
    (is (= {"by-maintainer" {:runner-name "user1" :run-by-you false :serves-you true}
            "by-writer" {:runner-name "user2" :run-by-you true :serves-you true}}
           (services fix/user2-token)))
    (testing "the maintainer demoted: their service no longer serves others"
      (role! p "writers" u1)
      (unrole! p "maintainers" u1)
      (is (= {:runner-name "user1" :run-by-you false :serves-you false}
             (get (services fix/user2-token) "by-maintainer"))))))
