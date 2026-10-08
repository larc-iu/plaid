(ns plaid.rest-api.v1.scoped-project-admin-test
  "A delegated (scoped) token cannot do what needs maintainer rights on a whole
  project, even for a requester who maintains it or is an admin: no member
  added or removed, no rename, no delete, no project or layer config, no
  layer created, renamed, deleted or moved, no constraints declared or
  removed, no whole-layer repair, and none of the maintainers' reads (the
  activity tally, the telemetry events). It is refused as a vocabulary-wide
  action is (H9-ACL-1, 2026-10-08). Restoring one document stays open to it,
  since the assistants plan it. Sessions are unaffected. See
  `plaid.rest-api.v1.auth` \"Scoped tokens\"."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request user2-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.rest-api.v1.core :as rest-core]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]
            [reitit.core :as r]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private refusal
  (str "A delegated token cannot change a project's members, name, settings or layers, "
       "delete it, or read its activity tally or telemetry."))

(defn- id [resp] (-> resp :body :id))

(defn- scoped [user-id & project-ids]
  (let [token (auth/issue-delegated-token! fix/db "fake-secret" user-id project-ids)]
    (fn [method path]
      (-> (mock/request method path)
          (mock/header "accept" "application/edn")
          (mock/header "Authorization" (str "Bearer " token))))))

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} (some? body) (assoc :body body))))

(defn- ok? [resp] (< 199 (:status resp) 300))

(defn- enc [ts] (java.net.URLEncoder/encode (str ts) "UTF-8"))

(defn- world!
  "Project P maintained by user2, with user1 a writer, a project config
  value, a text layer, two token layers and a document."
  []
  (let [p (h/create-test-project admin-request "Scoped P")
        _ (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" p "/maintainers/user2@example.com")))
        _ (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" p "/writers/user1@example.com")))
        _ (fix/assert-no-content (call admin-request :put (str "/api/v1/projects/" p "/config/igt/colour") "red"))
        tl (id (h/create-text-layer admin-request p "Text"))
        tkl (id (h/create-token-layer admin-request tl "Words"))
        tkl2 (id (h/create-token-layer admin-request tl "Morphemes"))
        sl (id (h/create-span-layer admin-request tkl "Lemma"))
        doc (h/create-test-document admin-request p "Doc")
        _ (h/create-text admin-request tl doc "kaj")]
    (is (every? some? [p tl tkl tkl2 sl doc]) "the world was built")
    {:p p :tl tl :tkl tkl :tkl2 tkl2 :sl sl :doc doc :ts (java.time.Instant/now)}))

(defn- project-actions
  "Every action that needs maintainer rights on the whole project, as
  [label method path body], on `w`."
  [{:keys [p tl tkl tkl2 sl]}]
  (let [pp (str "/api/v1/projects/" p)
        tlp (str "/api/v1/text-layers/" tl)
        tkp (str "/api/v1/token-layers/" tkl)
        slp (str "/api/v1/span-layers/" sl)
        constraint [{:type "single-span"}]]
    [["add a reader" :post (str pp "/readers/user1@example.com") nil]
     ["add a writer" :post (str pp "/writers/admin@example.com") nil]
     ["add a maintainer" :post (str pp "/maintainers/user1@example.com") nil]
     ["remove a writer" :delete (str pp "/writers/user1@example.com") nil]
     ["remove a maintainer" :delete (str pp "/maintainers/user2@example.com") nil]
     ["rename the project" :patch pp {:name "Renamed"}]
     ["set a project config value" :put (str pp "/config/igt/colour") "blue"]
     ["switch telemetry on" :put (str pp "/config/plaid/research.telemetry") true]
     ["remove a project config value" :delete (str pp "/config/igt/colour") nil]
     ["create a text layer" :post "/api/v1/text-layers" {:project-id p :name "More"}]
     ["create a token layer" :post "/api/v1/token-layers" {:text-layer-id tl :name "More"}]
     ["rename a layer" :patch tlp {:name "Renamed"}]
     ["move a layer" :post (str tkp "/shift") {:direction "down"}]
     ["set a layer config value" :put (str tkp "/config/igt/role") "word"]
     ["declare constraints" :put (str slp "/constraints/igt") {:constraints constraint}]
     ["check constraints" :post (str slp "/constraints/check") {:constraints constraint}]
     ["repair a whole layer" :post (str slp "/constraints/repair") {:constraints constraint}]
     ["read the activity tally" :get (str pp "/audit/tally") nil]
     ["read the telemetry events" :get (str pp "/events") nil]
     ["delete a layer" :delete (str "/api/v1/token-layers/" tkl2) nil]
     ["delete the project" :delete pp nil]]))

(defn- project-state
  "What the actions would change, read straight from the database."
  [p]
  {:project (psc/q1 fix/db {:select [:name :config] :from [:projects] :where [:= :id p]})
   :members (set (psc/q fix/db {:select [:user_id :role] :from [:project_users] :where [:= :project_id p]}))
   :text-layers (set (psc/q fix/db {:select [:id :name :config] :from [:text_layers] :where [:= :project_id p]}))
   :token-layers (set (psc/q fix/db {:select [:id :name :config] :from [:token_layers] :where [:= :project_id p]}))})

(deftest a-scoped-token-cannot-act-on-a-project-as-a-whole
  (doseq [[requester user-id] [["a maintainer of the project" "user2@example.com"]
                               ["an admin" "admin@example.com"]]]
    (testing requester
      (let [{:keys [p] :as w} (world!)
            token (scoped user-id p)
            before (project-state p)]
        (doseq [[label method path body] (project-actions w)]
          (testing (str label ", as its own request")
            (let [resp (call token method path body)]
              (is (= 403 (:status resp)) (str label " answered " (:status resp) " " (:body resp)))
              (is (= refusal (-> resp :body :error)))))
          (when-not (= :get method)
            (testing (str label ", inside a batch")
              (let [resp (call token :post "/api/v1/batch"
                               [(cond-> {:path path :method (name method)} (some? body) (assoc :body body))])]
                (is (= 403 (:status resp)) (str label " in a batch answered " (:status resp)))
                (is (= refusal (-> resp :body :error)))))))
        (is (= before (project-state p)) "nothing about the project changed")))))

(deftest a-scoped-token-still-restores-a-document
  (doseq [[requester user-id] [["a maintainer" "user2@example.com"]
                               ["an admin" "admin@example.com"]]]
    (testing requester
      (let [{:keys [p doc ts]} (world!)
            token (scoped user-id p)
            path (str "/api/v1/documents/" doc "/restore?as-of=" (enc ts))]
        (is (= 200 (:status (call token :post (str path "&dry-run=true")))))
        (is (= 200 (:status (call token :post path))))))))

(deftest a-writer-scoped-token-still-meets-the-maintainer-gate-first
  ;; Someone with no maintainer rights is told so, as without the token.
  (let [{:keys [p]} (world!)
        token (scoped "user1@example.com" p)
        resp (call token :patch (str "/api/v1/projects/" p) {:name "Renamed"})]
    (is (= 403 (:status resp)))
    (is (not= refusal (-> resp :body :error)))))

(deftest sessions-still-act-on-a-project-as-a-whole
  (doseq [[requester session] [["the maintainer's session" user2-request]
                               ["the admin's session" admin-request]]]
    (testing requester
      (let [{:keys [p] :as w} (world!)]
        (doseq [[label method path body] (project-actions w)
                ;; Removing the maintainer would leave user2 without rights
                ;; for what follows.
                :when (not= label "remove a maintainer")]
          (let [resp (call session method path body)]
            (is (ok? resp) (str label " answered " (:status resp) " " (:body resp)))))
        (is (nil? (psc/q1 fix/db {:select [:id] :from [:projects] :where [:= :id p]})))))))

(deftest only-document-restore-opts-out-of-the-refusal
  ;; Every route behind the project maintainer gate refuses a delegated token
  ;; unless it carries `:plaid/document-maintainer`. A route that gains the
  ;; mark shows here.
  (let [routes (r/routes (r/router [(rest-core/routes)] {:conflicts nil}))
        marked (set (for [[path data] routes
                          method [:get :post :put :patch :delete]
                          :when (get data method)
                          :when (or (:plaid/document-maintainer data)
                                    (get-in data [method :plaid/document-maintainer]))]
                      [method path]))]
    (is (= #{[:post "/api/v1/documents/:document-id/restore"]} marked))))
