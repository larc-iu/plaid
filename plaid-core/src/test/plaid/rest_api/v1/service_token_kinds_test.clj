(ns plaid.rest-api.v1.service-token-kinds-test
  "Which credentials may speak to a service. A job's token sends no request
  to a service, so no delegated token minted from it writes as the starter
  after the job ended (ACL7-2). A delegated token answers no request: it is
  held by another member's service, not by the account running the one the
  request went to (ACL7-3).

  ring-mock cannot hold an SSE channel, so `http-kit/as-channel` is redefined
  to open the REAL handler onto a stub channel, as in
  `delegated-token-lifetime-test`."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [org.httpkit.server :as http-kit]
            [plaid.fixtures :as fix
             :refer [with-db with-mount-states with-rest-handler with-admin
                     with-test-users with-clean-db api-call admin-request]]
            [plaid.rest-api.v1.job-helpers :as jh]
            [plaid.server.events :as events]
            [plaid.test-helpers :as h :refer [with-rpc-state-started]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin
  with-test-users with-rpc-state-started)
(use-fixtures :each with-clean-db)

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- stub-channel [sent]
  (reify http-kit/Channel
    (open? [_] true)
    (websocket? [_] false)
    (close [_] true)
    (send! [_ data] (swap! sent conj data) true)
    (send! [_ data _] (swap! sent conj data) true)
    (on-receive [_ _])
    (on-ping [_ _])
    (on-close [_ _])))

(defn- open-service!
  "Open service `sid` on `pid` with `token`, delegating when `delegating?`.
  Returns the atom of what was sent down it."
  [token pid sid delegating?]
  (let [sent (atom [])]
    (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                        (on-open (stub-channel sent))
                                        {:status 200 :body ""})]
      (fix/rest-handler ((as token) :get
                                    (str "/api/v1/projects/" pid "/services/" sid
                                         "/requests?service-name=" sid
                                         (when delegating?
                                           (str "&extras=" (java.net.URLEncoder/encode
                                                            (json/write-str {:delegation true}) "UTF-8")))))))
    sent))

(defn- submit!
  "Submit work to `sid` on `pid` with `token`, as request `request-id`."
  [token pid sid request-id]
  (with-redefs [http-kit/as-channel (fn [_ {:keys [on-open]}]
                                      (on-open (stub-channel (atom [])))
                                      {:status 200 :body ""})]
    (fix/rest-handler (-> ((as token) :post (str "/api/v1/projects/" pid "/services/" sid
                                                 "/requests?request-id=" request-id))
                          (mock/json-body {:q 1})))))

(defn- handed-token [sent]
  (when-let [frame (last (filter #(and (string? %) (str/starts-with? % "event: service_request")) @sent))]
    (:delegated-token (json/read-str (second (re-find #"(?m)^data: (.*)$" frame)) :key-fn keyword))))

(defn- token-of [email]
  (plaid.rest-api.v1.auth/issue-session-token! fix/db "fake-secret" email))

(deftest a-jobs-token-sends-no-request-to-a-service
  (events/reset-state!)
  (let [{:keys [p st]} (jh/world!)
        sent (open-service! (token-of "maintainer@example.com") p "helper" true)
        _ (jh/start! st p)
        job-token (-> (jh/claim! jh/worker-a) :body :token)]
    (is (string? job-token))
    (is (= 403 (:status (submit! job-token p "helper" (random-uuid)))))
    (is (nil? (handed-token sent)) "no token went down the channel")
    (testing "the starter's own session still may"
      (is (= 200 (:status (submit! (token-of "starter@example.com") p "helper" (random-uuid)))))
      (is (string? (handed-token sent))))))

(deftest a-delegated-token-answers-no-request
  (events/reset-state!)
  (let [{:keys [p]} (jh/world!)
        helper (open-service! (token-of "maintainer@example.com") p "helper" true)
        _ (open-service! (token-of "writer@example.com") p "wplain" false)
        ;; the writer asks the maintainer's delegating helper, which is handed
        ;; a delegated token of the writer's
        _ (is (= 200 (:status (submit! (token-of "writer@example.com") p "helper" (random-uuid)))))
        delegated (handed-token helper)
        rid (random-uuid)
        report (fn [token]
                 (:status (api-call (as token) {:method :post
                                                :path (str "/api/v1/projects/" p "/service-requests/" rid "/events")
                                                :body {:status "completed" :data {:forged "yes"}}})))]
    (is (string? delegated))
    ;; someone else sends a request to the writer's own service
    (is (= 200 (:status (submit! fix/admin-token p "wplain" rid))))
    (testing "the writer's delegated token, held by the helper, may not answer it"
      (is (= 403 (report delegated))))
    (testing "the writer's service's own credential may"
      (is (= 200 (report (token-of "writer@example.com")))))))
