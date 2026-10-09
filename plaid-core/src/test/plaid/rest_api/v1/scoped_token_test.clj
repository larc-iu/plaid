(ns plaid.rest-api.v1.scoped-token-test
  "A delegated token (the one core hands a delegating service for each request)
  is scoped to the projects it was issued for, and core refuses it on every
  route outside them: other projects, admin and user routes, listings,
  vocabularies no project in scope links. See `plaid.rest-api.v1.auth`
  \"Scoped tokens\"."
  (:require [buddy.sign.jwt :as jwt]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.rest-api.v1.core :as rest-core]
            [plaid.rest-api.v1.message :as msg]
            [plaid.test-helpers :as h]
            [reitit.core :as r]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- as [token]
  (fn [method path]
    (-> (mock/request method path)
        (mock/header "accept" "application/edn")
        (mock/header "Authorization" (str "Bearer " token)))))

(defn- scoped [user-id & project-ids]
  (as (auth/issue-delegated-token! fix/db "fake-secret" user-id project-ids)))

(defn- call [who method path & [body]]
  (api-call who (cond-> {:method method :path path} body (assoc :body body))))

(defn- ok? [resp] (< 199 (:status resp) 300))

(defn- world!
  "Two projects, each with a document, and three vocabularies: one linked to
  P, one linked to Q, one linked to both. user2 reads P and writes Q."
  []
  (let [p (h/create-test-project admin-request "Scoped P")
        q (h/create-test-project admin-request "Scoped Q")
        doc-p (h/create-test-document admin-request p "doc p")
        doc-q (h/create-test-document admin-request q "doc q")
        vocab (fn [name & pids]
                (let [v (id (call admin-request :post "/api/v1/vocab-layers" {:name name}))]
                  (doseq [pid pids]
                    (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" pid "/vocabs/" v))))
                  v))
        v-p (vocab "v p" p)
        v-q (vocab "v q" q)
        v-pq (vocab "v pq" p q)]
    (call admin-request :post (str "/api/v1/projects/" p "/readers/user2@example.com"))
    (call admin-request :post (str "/api/v1/projects/" q "/writers/user2@example.com"))
    {:p p :q q :doc-p doc-p :doc-q doc-q :v-p v-p :v-q v-q :v-pq v-pq}))

(deftest the-token-names-its-projects
  (let [{:keys [p q]} (world!)
        token (auth/issue-delegated-token! fix/db "fake-secret" "user2@example.com" [p (str/upper-case (str q)) p])
        claims (jwt/unsign token "fake-secret")]
    (is (= [(str p) (str q)] (:scope/projects claims)) "lower-cased, each once")))

(deftest a-scoped-token-works-inside-its-project
  (let [{:keys [p doc-p v-p]} (world!)
        admin (scoped "admin@example.com" p)]
    (is (= 200 (:status (call admin :get (str "/api/v1/projects/" p)))))
    (is (= 200 (:status (call admin :get (str "/api/v1/documents/" doc-p)))))
    (is (= 201 (:status (call admin :post "/api/v1/documents" {:project-id p :name "new"}))))
    (is (= 200 (:status (call admin :get (str "/api/v1/vocab-layers/" v-p)))))
    (is (= 201 (:status (call admin :post "/api/v1/vocab-items" {:vocab-layer-id v-p :form "kai"}))))
    (testing "the query, naming its project"
      (is (= 200 (:status (call admin :post "/api/v1/query"
                                {:find ["?d"] :where [["document" "?d" {}]]
                                 :scope {:project-ids [(str p)]}})))))
    (testing "the user's own data, under a key that names the project"
      (let [k (str "igt:assistant:" p ":conv:1")]
        (is (= 200 (:status (call admin :put (str "/api/v1/users/admin@example.com/data/" k) {:messages []}))))
        (is (= 200 (:status (call admin :get (str "/api/v1/users/admin@example.com/data/" k)))))))
    (testing "a listing of the user's own data by a prefix naming the project as a whole segment"
      (let [k (str "igt:assistant:" p ":file:c1:f1:part:0")
            prefix (str "igt:assistant:" p ":file:c1:")]
        (is (= 200 (:status (call admin :put (str "/api/v1/users/admin@example.com/data/" k) "x"))))
        (let [resp (call admin :get (str "/api/v1/users/admin@example.com/data?prefix=" prefix))]
          (is (= 200 (:status resp)))
          (is (= [k] (mapv :key (-> resp :body :entries)))))))
    (testing "a batch of operations inside the project"
      (is (= 200 (:status (call admin :post "/api/v1/batch"
                                [{:path (str "/api/v1/projects/" p) :method "get"}])))))))

(deftest a-scoped-token-is-refused-on-another-project
  (let [{:keys [p q doc-q v-q]} (world!)
        admin (scoped "admin@example.com" p)]
    (is (= 403 (:status (call admin :get (str "/api/v1/projects/" q)))))
    (is (= 403 (:status (call admin :get (str "/api/v1/documents/" doc-q)))))
    (is (= 403 (:status (call admin :post "/api/v1/documents" {:project-id q :name "new"}))))
    (is (= 403 (:status (call admin :delete (str "/api/v1/projects/" q)))))
    (is (= 403 (:status (call admin :get (str "/api/v1/vocab-layers/" v-q)))) "a vocabulary no project in scope links")
    (is (= 403 (:status (call admin :post "/api/v1/vocab-items" {:vocab-layer-id v-q :form "kai"}))))
    (testing "the query must name its projects, all in scope"
      (is (= 403 (:status (call admin :post "/api/v1/query" {:find ["?d"] :where [["document" "?d" {}]]}))))
      (is (= 403 (:status (call admin :post "/api/v1/query"
                                {:find ["?d"] :where [["document" "?d" {}]]
                                 :scope {:project-ids [(str p) (str q)]}})))))
    (testing "the user's data under a key naming another project, and a listing"
      (is (= 403 (:status (call admin :get (str "/api/v1/users/admin@example.com/data/igt:assistant:" q ":conv:1")))))
      (is (= 403 (:status (call admin :get "/api/v1/users/admin@example.com/data"))))
      (is (= 403 (:status (call admin :get (str "/api/v1/users/admin@example.com/data?prefix=igt:assistant:" q ":")))))
      (testing "a prefix whose project is cut short, or a pattern beside it, reaches past the project"
        (is (= 403 (:status (call admin :get (str "/api/v1/users/admin@example.com/data?prefix=igt:assistant:" p)))))
        (is (= 403 (:status (call admin :get (str "/api/v1/users/admin@example.com/data?prefix=igt:assistant:" p
                                                  ":&pattern=*")))))))
    (testing "a batch reaching another project fails whole"
      (is (not (ok? (call admin :post "/api/v1/batch"
                          [{:path (str "/api/v1/projects/" p) :method "get"}
                           {:path (str "/api/v1/projects/" q) :method "get"}])))))
    (testing "the same admin's own session reaches both"
      (is (= 200 (:status (call admin-request :get (str "/api/v1/projects/" q))))))))

(deftest a-scoped-token-is-refused-on-admin-and-user-routes
  (let [{:keys [p]} (world!)
        admin (scoped "admin@example.com" p)]
    (doseq [[method path body] [[:get "/api/v1/projects"]
                                [:post "/api/v1/projects" {:name "another"}]
                                [:get "/api/v1/users"]
                                [:get "/api/v1/users/user2@example.com"]
                                [:patch "/api/v1/users/admin@example.com" {:display-name "Renamed"}]
                                [:delete "/api/v1/users/admin@example.com"]
                                [:post "/api/v1/users" {:email "x@example.com" :password "password123" :is-admin true}]
                                [:post "/api/v1/users/admin@example.com/tokens" {:name "forever"}]
                                [:get "/api/v1/users/admin@example.com/tokens"]
                                [:get "/api/v1/users/user2@example.com/data/x"]
                                [:get "/api/v1/vocab-layers"]
                                [:post "/api/v1/vocab-layers" {:name "another"}]
                                [:get "/api/v1/admin/server"]
                                [:get "/api/v1/admin/logs"]
                                [:post "/api/v1/logout"]]]
      (let [resp (call admin method path body)]
        (is (= 403 (:status resp)) (str (name method) " " path " answered " (:status resp)))))
    (testing "the admin's session is untouched: the logout above was refused"
      (is (= 200 (:status (call admin-request :get "/api/v1/users")))))))

(deftest a-scoped-token-reads-its-own-user-record
  ;; How a service acting for the user learns that core counts them a
  ;; maintainer in the projects in scope (A1-IGT-2): an admin who maintains no
  ;; lexicon was told only a maintainer may merge, which core allows.
  (let [{:keys [p]} (world!)
        admin (scoped "admin@example.com" p)
        user2 (scoped "user2@example.com" p)]
    (let [resp (call admin :get "/api/v1/users/admin@example.com")]
      (is (= 200 (:status resp)))
      (is (true? (-> resp :body :user/is-admin))))
    (let [resp (call user2 :get "/api/v1/users/user2@example.com")]
      (is (= 200 (:status resp)))
      (is (false? (-> resp :body :user/is-admin))))
    (is (= 403 (:status (call user2 :get "/api/v1/users/admin@example.com"))) "another user's record")
    (let [resp (call user2 :get "/api/v1/users/USER2@example.com")]
      (is (= 200 (:status resp)) "an id in another case is the same user")
      (is (= "user2@example.com" (-> resp :body :user/id))))
    (is (= 403 (:status (call user2 :get "/api/v1/users/ADMIN@example.com")))
        "and another user's, in any case, is still refused")))

(deftest a-role-counts-only-on-a-project-in-scope
  ;; user2 reads P and writes Q, and v-pq is linked to both. Scoped to P,
  ;; user2 reads v-pq but cannot write it: the write would come through Q.
  (let [{:keys [p q v-pq]} (world!)
        user2 (scoped "user2@example.com" p)
        user2-in-q (scoped "user2@example.com" q)]
    (is (= 200 (:status (call user2 :get (str "/api/v1/vocab-layers/" v-pq)))))
    (is (= 403 (:status (call user2 :post "/api/v1/vocab-items" {:vocab-layer-id v-pq :form "kai"}))))
    (is (= 201 (:status (call user2-in-q :post "/api/v1/vocab-items" {:vocab-layer-id v-pq :form "kai"}))))
    (is (= 201 (:status (call fix/user2-request :post "/api/v1/vocab-items" {:vocab-layer-id v-pq :form "kai"})))
        "the unscoped session writes as before")))

(deftest a-scoped-token-reaches-several-projects
  (let [{:keys [p q doc-p doc-q]} (world!)
        admin (scoped "admin@example.com" p q)]
    (is (= 200 (:status (call admin :get (str "/api/v1/documents/" doc-p)))))
    (is (= 200 (:status (call admin :get (str "/api/v1/documents/" doc-q)))))
    (is (= 200 (:status (call admin :post "/api/v1/query"
                              {:find ["?d"] :where [["document" "?d" {}]]
                               :scope {:project-ids [(str p) (str q)]}}))))))

(def ^:private public-paths
  "The routes that need no login, and so never look at who is asking."
  #{"/api/v1/login" "/api/v1/info" "/api/v1/health" "/api/v1/invites/lookup"
    "/api/v1/invites/redeem" "/api/v1/openapi.json" "/api/v1/docs/*"})

(deftest no-route-answers-a-scoped-token-outside-its-project
  ;; Every route and method the router has, called with a token scoped to P
  ;; and every path parameter pointing at Q (or at the admin, for a user id):
  ;; nothing may succeed. A new route with no project gate is refused without
  ;; being listed anywhere, and this sweep is what shows it.
  (let [{:keys [p q]} (world!)
        admin (scoped "admin@example.com" p)
        routes (r/routes (r/router [(rest-core/routes)] {:conflicts nil}))
        fill (fn [path]
               (str/replace path #":([a-z-]+)|\*"
                            (fn [[_ param]]
                              (case param
                                ("user-id") "admin@example.com"
                                ("key") "k"
                                (str q)))))
        tried (atom 0)]
    (doseq [[path data] routes
            :when (not (public-paths path))
            method [:get :post :put :patch :delete]
            :when (get data method)]
      (swap! tried inc)
      (let [resp (call admin method (fill path) (when-not (= method :get) {}))]
        (is (not (ok? resp)) (str (name method) " " path " answered " (:status resp)))))
    (is (< 100 @tried) "the sweep saw the router's routes")))

(deftest the-delegated-projects-are-home-plus-the-readable-joined
  (let [{:keys [p q]} (world!)
        stranger (h/create-test-project admin-request "Not user2's")
        req (fn [token-scope]
              (cond-> {:db fix/db
                       :jwt-data {:user/id "user2@example.com"}
                       :user/record {:user/id "user2@example.com" :user/is-admin false}}
                token-scope (assoc :auth/token-scope {:user-id "user2@example.com"
                                                      :projects (set (map str token-scope))
                                                      :admin? false
                                                      :passed (volatile! false)})))
        projects #'msg/delegated-projects]
    (is (= [(str p) (str q)]
           (projects (req nil) fix/db p [(str q) (str p) (str q) (str stranger) (str (random-uuid))]))
        "home first, then each readable joined project once; unreadable and unknown ones left out")
    (is (= [(str p)] (projects (req nil) fix/db p [])))
    (is (= [(str p)] (projects (req [p]) fix/db p [(str q)]))
        "a request made with a scoped token never widens it")))

(deftest a-scoped-token-relabels-only-the-groups-it-created
  ;; D24: a group names no project, so the scope gate refused every relabel by
  ;; a delegated token, and an assistant plan that stopped partway kept its
  ;; whole plan's label in History.
  (let [{:keys [p]} (world!)
        token-a (auth/issue-delegated-token! fix/db "fake-secret" "admin@example.com" [p])
        a (as token-a)
        b (scoped "admin@example.com" p)
        group-write (fn [who gid]
                      (call who :post (str "/api/v1/documents?group-id=" gid "&group-message=Plan")
                            {:project-id p :name (str "doc " gid)}))
        relabel (fn [who gid] (call who :patch (str "/api/v1/operation-groups/" gid) {:message "Partly"}))
        mine (random-uuid)
        by-session (random-uuid)]
    (is (= 201 (:status (group-write a mine))))
    (is (= 201 (:status (group-write admin-request by-session))))
    (testing "the token that created the group relabels it"
      (let [r (relabel a mine)]
        (is (= 200 (:status r)))
        (is (= "Partly" (-> r :body :operation-group/message)))))
    (testing "another delegated token of the same user, in the same project, does not"
      (is (= 403 (:status (relabel b mine)))))
    (testing "nor may the token relabel a group a session created"
      (is (= 403 (:status (relabel a by-session)))))
    (testing "reading the group stays refused to it"
      (is (= 403 (:status (call a :get (str "/api/v1/operation-groups/" mine))))))
    (testing "the user's own session still relabels both"
      (is (= 200 (:status (relabel admin-request mine))))
      (is (= 200 (:status (relabel admin-request by-session)))))))
