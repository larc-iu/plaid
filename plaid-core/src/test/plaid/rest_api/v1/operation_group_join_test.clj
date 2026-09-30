(ns plaid.rest-api.v1.operation-group-join-test
  "D26: a write may join only an operation group its own caller created, so
  History never shows one caller's writes under another's entry. The same
  user may join with any session or named token. A delegated token may join
  only a group its own writes created. A service joins the group its
  requester handed it, for as long as the request runs."
  (:require [buddy.sign.jwt :as jwt]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request user1-request
                                            user2-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.server.events :as events]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]
            [ring.mock.request :as mock]))

(defn- with-rpc-state-started [f]
  (mount/start #'plaid.server.events/service-channels
               #'plaid.server.events/inflight-requests)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users
  with-rpc-state-started)
(use-fixtures :each with-clean-db)

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} body (assoc :body body))))

(defn- world! []
  (let [p (h/create-test-project admin-request "Join P")]
    (doseq [u ["user1@example.com" "user2@example.com"]]
      (call admin-request :post (str "/api/v1/projects/" p "/writers/" u)))
    p))

(defn- write-in [p who gid name]
  (call who :post (str "/api/v1/documents?group-id=" gid "&group-message=Work")
        {:project-id p :name name}))

(defn- docs-named [name]
  (count (psc/q fix/db {:select [:id] :from [:documents] :where [:= :name name]})))

(defn- group-row [gid]
  (psc/fetch-by-id fix/db :operation_groups gid))

(defn- jti [token]
  (:jti (jwt/unsign token "fake-secret")))

(deftest a-write-joins-only-its-own-callers-group
  (let [p (world!)
        user1-named (:token (auth/issue-api-token! fix/db "fake-secret" "user1@example.com" "t" "user1@example.com"))
        d1 (auth/issue-delegated-token! fix/db "fake-secret" "user1@example.com" [p])
        d2 (auth/issue-delegated-token! fix/db "fake-secret" "user1@example.com" [p])
        g1 (random-uuid)
        gd (random-uuid)]
    (is (= 201 (:status (write-in p user1-request g1 "first"))))
    (is (= 201 (:status (write-in p (as d1) gd "first by d1"))))
    (testing "another user naming the group is refused and writes nothing"
      (let [r (write-in p user2-request g1 "intruder")]
        (is (= 403 (:status r)))
        (is (= 0 (docs-named "intruder")))))
    (testing "an admin is no exception"
      (is (= 403 (:status (write-in p admin-request g1 "admin intruder")))))
    (testing "the same user's named token and session join each other's groups"
      (is (= 201 (:status (write-in p (as user1-named) g1 "named"))))
      (is (= 201 (:status (write-in p user1-request gd "session in d1's")))))
    (testing "a delegated token joins its own group, and no other"
      (is (= 201 (:status (write-in p (as d1) gd "d1 again"))))
      (is (= 403 (:status (write-in p (as d2) gd "d2 in d1's"))))
      (is (= 403 (:status (write-in p (as d1) g1 "d1 in session's"))))
      (is (= 0 (docs-named "d2 in d1's"))))
    (testing "the rows keep their creators"
      (is (= "user1@example.com" (:user_id (group-row g1))))
      (is (nil? (:scoped_token (group-row g1))))
      (is (= (jti d1) (:scoped_token (group-row gd)))))))

(deftest a-batch-is-checked-like-a-single-write
  (let [p (world!)
        g1 (random-uuid)]
    (is (= 201 (:status (write-in p user1-request g1 "first"))))
    (testing "the group on the batch request"
      (call user2-request :post (str "/api/v1/batch?group-id=" g1)
            [{:path "/api/v1/documents" :method "post" :body {:project-id p :name "outer"}}])
      (is (= 0 (docs-named "outer"))))
    (testing "the group on a sub-operation's path"
      (call user2-request :post "/api/v1/batch"
            [{:path "/api/v1/documents" :method "post" :body {:project-id p :name "fine"}}
             {:path (str "/api/v1/documents?group-id=" g1) :method "post" :body {:project-id p :name "sub"}}])
      (is (= 0 (docs-named "sub")))
      (is (= 0 (docs-named "fine")) "the batch is all or nothing"))))

(defn- grant! [request-id grant]
  (events/track-request! request-id nil (random-uuid) "svc" (:owner grant) (:grantee-user grant))
  (events/grant-group! request-id grant))

(deftest a-service-joins-the-group-it-was-handed-while-the-request-runs
  (events/reset-state!)
  (let [p (world!)
        g (random-uuid)
        fresh (random-uuid)]
    (is (= 201 (:status (write-in p user1-request g "requester first"))))
    (grant! "r1" {:group-id g :project-id p :owner "user1@example.com" :owner-token nil
                  :grantee-user "user2@example.com" :grantee-token nil})
    (grant! "r2" {:group-id fresh :project-id p :owner "user1@example.com" :owner-token nil
                  :grantee-user "user2@example.com" :grantee-token nil})
    (testing "the service's account joins the handed group"
      (is (= 201 (:status (write-in p user2-request g "service")))))
    (testing "a group the service starts is the requester's"
      (is (= 201 (:status (write-in p user2-request fresh "service first"))))
      (is (= "user1@example.com" (:user_id (group-row fresh))))
      (is (= 200 (:status (call user1-request :patch (str "/api/v1/operation-groups/" fresh)
                                {:message "Relabelled"}))))
      (is (= 201 (:status (write-in p user1-request fresh "requester after")))))
    (testing "the grant reaches only the handed group"
      (let [other (random-uuid)]
        (is (= 201 (:status (write-in p user1-request other "requester other"))))
        (is (= 403 (:status (write-in p user2-request other "service other"))))))
    (testing "a finished request grants nothing"
      (events/finish-request! "r1" "result" {})
      (is (= 403 (:status (write-in p user2-request g "service late"))))
      (is (= 0 (docs-named "service late"))))))

(deftest a-delegating-service-joins-with-its-own-token-only
  (events/reset-state!)
  (let [p (world!)
        requester-d (auth/issue-delegated-token! fix/db "fake-secret" "user1@example.com" [p])
        service-d (auth/issue-delegated-token! fix/db "fake-secret" "user1@example.com" [p])
        other-d (auth/issue-delegated-token! fix/db "fake-secret" "user1@example.com" [p])
        g (random-uuid)]
    (grant! "r1" {:group-id g :project-id p :owner "user1@example.com" :owner-token (jti requester-d)
                  :grantee-user "user1@example.com" :grantee-token (jti service-d)})
    (testing "the service's token starts the group as the requesting token's"
      (is (= 201 (:status (write-in p (as service-d) g "service first"))))
      (is (= (jti requester-d) (:scoped_token (group-row g)))))
    (testing "so the requesting token may write into it and relabel it"
      (is (= 201 (:status (write-in p (as requester-d) g "requester after"))))
      (is (= 200 (:status (call (as requester-d) :patch (str "/api/v1/operation-groups/" g)
                                {:message "Partly"})))))
    (testing "a third token of the same user may not"
      (is (= 403 (:status (write-in p (as other-d) g "other")))))))

(deftest a-request-cannot-hand-a-group-that-is-not-its-callers
  (events/reset-state!)
  (let [p (world!)
        g (random-uuid)]
    (is (= 201 (:status (write-in p user1-request g "first"))))
    (events/register-service-channel!
     (parse-uuid (str p)) "svc" (Object.)
     {:service-name "S" :db fix/db
      :token-id (:id (auth/issue-api-token! fix/db "fake-secret" "admin@example.com" "svc" "admin@example.com"))}
     "admin@example.com")
    (let [r (call user2-request :post (str "/api/v1/projects/" p "/services/svc/requests")
                  {:operation-group {:id (str g) :message "Work"}})]
      (is (= 403 (:status r)))
      (is (empty? @events/inflight-requests) "the service was never asked"))))

;; D27 (conc-2026-09-29 REV-W-AUDIT D-1): a grant covers only writes in the
;; project its request was made in. Before, the service wrote into another
;; project under the requester's group, and the requester's relabel then
;; showed in that project's History.
(deftest a-grant-covers-only-the-project-its-request-was-made-in
  (events/reset-state!)
  (let [p (world!)
        q (h/create-test-project admin-request "Join Q")
        g (random-uuid)
        own (random-uuid)]
    (call admin-request :post (str "/api/v1/projects/" q "/writers/user2@example.com"))
    (is (= 201 (:status (write-in p user1-request g "requester first"))))
    (grant! "r1" {:group-id g :project-id p :owner "user1@example.com" :owner-token nil
                  :grantee-user "user2@example.com" :grantee-token nil})
    (testing "the service joins the group in the request's project"
      (is (= 201 (:status (write-in p user2-request g "service in p")))))
    (testing "and not in another project, where it writes nothing"
      (let [r (write-in q user2-request g "service in q")]
        (is (= 403 (:status r)))
        (is (re-find #"was handed to this service by a request in project" (str (-> r :body :error))))
        (is (= 0 (docs-named "service in q")))))
    (testing "nor with a write that is in no project"
      (is (= 201 (:status (call user2-request :post "/api/v1/vocab-layers" {:name "Lex alone"})))
          "the same write outside the group lands")
      (let [r (call user2-request :post (str "/api/v1/vocab-layers?group-id=" g) {:name "Lex under g"})]
        (is (= 403 (:status r)))
        (is (= 0 (count (psc/q fix/db {:select [:id] :from [:vocab_layers]
                                       :where [:= :name "Lex under g"]}))))))
    (testing "a grantee writing into its own group elsewhere is not held to the grant"
      (is (= 201 (:status (write-in q user2-request own "own first"))))
      (grant! "r2" {:group-id own :project-id p :owner "user2@example.com" :owner-token nil
                    :grantee-user "user2@example.com" :grantee-token nil})
      (is (= 201 (:status (write-in q user2-request own "own in q")))))))

(deftest a-write-after-its-request-ended-is-told-so
  (events/reset-state!)
  (let [p (world!)
        g (random-uuid)
        other (random-uuid)]
    (is (= 201 (:status (write-in p user1-request g "requester first"))))
    (is (= 201 (:status (write-in p user1-request other "requester other"))))
    (grant! "r1" {:group-id g :project-id p :owner "user1@example.com" :owner-token nil
                  :grantee-user "user2@example.com" :grantee-token nil})
    (events/finish-request! "r1" "error" {:error "Service disconnected"})
    (let [r (write-in p user2-request g "late")]
      (is (= 403 (:status r)))
      (is (re-find #"by a request that has ended" (str (-> r :body :error)))))
    (testing "a group it was never handed is another caller's"
      (let [r (write-in p user2-request other "never handed")]
        (is (= 403 (:status r)))
        (is (re-find #"started by another user or token" (str (-> r :body :error))))))))

(deftest a-grant-is-not-handed-on-into-another-project
  (events/reset-state!)
  (let [p (world!)
        q (h/create-test-project admin-request "Join Q")
        g (random-uuid)]
    (call admin-request :post (str "/api/v1/projects/" q "/writers/user2@example.com"))
    (is (= 201 (:status (write-in p user1-request g "requester first"))))
    (grant! "r1" {:group-id g :project-id p :owner "user1@example.com" :owner-token nil
                  :grantee-user "user2@example.com" :grantee-token nil})
    (events/register-service-channel!
     (parse-uuid (str q)) "svc" (Object.)
     {:service-name "S" :db fix/db
      :token-id (:id (auth/issue-api-token! fix/db "fake-secret" "admin@example.com" "svc" "admin@example.com"))}
     "admin@example.com")
    (let [r (call user2-request :post (str "/api/v1/projects/" q "/services/svc/requests")
                  {:operation-group {:id (str g) :message "Work"}})]
      (is (= 403 (:status r)))
      (is (re-find #"in another project" (str (-> r :body :error))))
      (is (= #{"r1"} (set (keys @events/inflight-requests))) "the service was never asked"))))

;; conc-2026-09-29 REV-W-TAIL: one requester writing in two projects hands
;; one open operation to a service in each, run by the same account. Each
;; service's write was checked against whichever of the two grants the
;; registry found first, so one of the two was refused as another project's.
(deftest one-operation-handed-into-two-projects-joins-in-each
  (events/reset-state!)
  (let [p (world!)
        q (h/create-test-project admin-request "Join Q")
        g (random-uuid)]
    (doseq [u ["user1@example.com" "user2@example.com"]]
      (call admin-request :post (str "/api/v1/projects/" q "/writers/" u)))
    (is (= 201 (:status (write-in p user1-request g "requester first"))))
    (grant! "in-p" {:group-id g :project-id p :owner "user1@example.com" :owner-token nil
                    :grantee-user "user2@example.com" :grantee-token nil})
    (grant! "in-q" {:group-id g :project-id q :owner "user1@example.com" :owner-token nil
                    :grantee-user "user2@example.com" :grantee-token nil})
    (testing "the service in each project joins with a write in its own project"
      (is (= 201 (:status (write-in p user2-request g "service in p"))))
      (is (= 201 (:status (write-in q user2-request g "service in q"))))
      (is (= #{"user1@example.com"} (set (map :user_id (psc/q fix/db {:select [:user_id]
                                                                      :from [:operation_groups]
                                                                      :where [:= :id g]}))))))))
