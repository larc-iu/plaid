(ns plaid.rest-api.v1.scoped-vocabulary-admin-test
  "A delegated (scoped) token cannot act on a vocabulary as a whole, even for a
  requester who maintains it or is an admin: no rename or delete of the
  vocabulary, no maintainer added or removed, no link to or unlink from a
  project, no restore of an entry, no config change (REV-R-SEC Q1, ruled (c)
  2026-09-27). Entry-level rename, merge and delete stay open to it, so an
  assistant can still tidy a shared lexicon. Sessions are unaffected. See
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
  "A delegated token cannot rename or delete a vocabulary, change its maintainers or settings, link or unlink it, or restore its entries.")

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
  "Projects P and P2, both maintained by user2. A vocabulary V that user2
  created (so user2 maintains it and the admin does not), with user1 as a
  second maintainer, a config value, linked to P only. Entries kai, kaj,
  kak and kal, and a token in P linked to kaj."
  []
  (let [p (h/create-test-project admin-request "Scoped P")
        p2 (h/create-test-project admin-request "Scoped P2")
        _ (doseq [pid [p p2]]
            (fix/assert-no-content (call admin-request :post (str "/api/v1/projects/" pid "/maintainers/user2@example.com"))))
        v (id (h/create-vocab-layer user2-request "Lexicon"))
        _ (fix/assert-no-content (call user2-request :post (str "/api/v1/vocab-layers/" v "/maintainers/user1@example.com")))
        _ (fix/assert-no-content (call user2-request :put (str "/api/v1/vocab-layers/" v "/config/igt/colour") "red"))
        _ (fix/assert-no-content (h/link-vocab-to-project admin-request p v))
        entry (fn [form] (id (call user2-request :post "/api/v1/vocab-items" {:vocab-layer-id v :form form})))
        [kai kaj kak kal] (mapv entry ["kai" "kaj" "kak" "kal"])
        tl (id (h/create-text-layer admin-request p "Text"))
        tkl (id (h/create-token-layer admin-request tl "Words"))
        doc (h/create-test-document admin-request p "Doc")
        text (id (h/create-text admin-request tl doc "kaj"))
        tok (id (h/create-token admin-request tkl text 0 3))
        link (id (call user2-request :post "/api/v1/vocab-links" {:vocab-item kaj :tokens [tok]}))]
    (is (every? some? [v kai kaj kak kal tok link]) "the world was built")
    {:p p :p2 p2 :v v :kai kai :kaj kaj :kak kak :kal kal :tok tok :link link
     :ts (java.time.Instant/now)}))

(defn- vocabulary-actions
  "Every vocabulary-level action, as [label method path body], on `w`."
  [{:keys [p p2 v kai ts]}]
  (let [vl (str "/api/v1/vocab-layers/" v)]
    [["rename the vocabulary" :patch vl {:name "Renamed"}]
     ["delete the vocabulary" :delete vl nil]
     ["add a maintainer" :post (str vl "/maintainers/admin@example.com") nil]
     ["remove a maintainer" :delete (str vl "/maintainers/user1@example.com") nil]
     ["set a config value" :put (str vl "/config/igt/colour") "blue"]
     ["remove a config value" :delete (str vl "/config/igt/colour") nil]
     ["link it to a project" :post (str "/api/v1/projects/" p2 "/vocabs/" v) nil]
     ["unlink it from a project" :delete (str "/api/v1/projects/" p "/vocabs/" v) nil]
     ["restore an entry" :post (str vl "/items/" kai "/restore?as-of=" (enc ts)) nil]
     ["preview an entry's restore" :post (str vl "/items/" kai "/restore?as-of=" (enc ts) "&dry-run=true") nil]]))

(defn- vocabulary-state
  "What the vocabulary-level actions would change, read straight from the
  database."
  [v]
  {:name (:name (psc/q1 fix/db {:select [:name] :from [:vocab_layers] :where [:= :id v]}))
   :config (:config (psc/q1 fix/db {:select [:config] :from [:vocab_layers] :where [:= :id v]}))
   :maintainers (set (map :user_id (psc/q fix/db {:select [:user_id] :from [:vocab_maintainers]
                                                  :where [:= :vocab_layer_id v]})))
   :projects (set (map :project_id (psc/q fix/db {:select [:project_id] :from [:project_vocabs]
                                                  :where [:= :vocab_layer_id v]})))})

(deftest a-scoped-token-cannot-act-on-a-vocabulary-as-a-whole
  (doseq [[requester user-id] [["a maintainer of the vocabulary and both projects" "user2@example.com"]
                               ["an admin" "admin@example.com"]]]
    (testing requester
      (let [{:keys [p p2 v] :as w} (world!)
            token (scoped user-id p p2)
            before (vocabulary-state v)]
        (doseq [[label method path body] (vocabulary-actions w)]
          (testing (str label ", as its own request")
            (let [resp (call token method path body)]
              (is (= 403 (:status resp)) (str label " answered " (:status resp)))
              (is (= refusal (-> resp :body :error)))))
          (testing (str label ", inside a batch")
            (let [resp (call token :post "/api/v1/batch"
                             [(cond-> {:path path :method (name method)} (some? body) (assoc :body body))])]
              (is (= 403 (:status resp)) (str label " in a batch answered " (:status resp)))
              (is (= refusal (-> resp :body :error))))))
        (is (= before (vocabulary-state v)) "nothing about the vocabulary changed")))))

(deftest a-scoped-token-still-renames-merges-and-deletes-entries
  (doseq [[requester user-id] [["a maintainer" "user2@example.com"]
                               ["an admin" "admin@example.com"]]]
    (testing requester
      (let [{:keys [p kai kaj kak kal tok link]} (world!)
            token (scoped user-id p)]
        (testing "rename an entry"
          (is (= 200 (:status (call token :patch (str "/api/v1/vocab-items/" kai) {:form "kaii"})))))
        (testing "merge kaj into kai: move its link, then delete it"
          (is (= 200 (:status (call token :post "/api/v1/batch"
                                    [{:path (str "/api/v1/vocab-links/" link) :method "delete"}
                                     {:path "/api/v1/vocab-links" :method "post"
                                      :body {:vocab-item kai :tokens [tok]}}
                                     {:path (str "/api/v1/vocab-items/" kaj) :method "delete"}])))))
        (testing "delete an entry"
          (is (= 204 (:status (call token :delete (str "/api/v1/vocab-items/" kak))))))
        (testing "delete entries in bulk"
          (is (ok? (call token :delete "/api/v1/vocab-items/bulk" [kal]))))
        (is (empty? (psc/q fix/db {:select [:id] :from [:vocab_items] :where [:in :id [kaj kak kal]]})))))))

(deftest sessions-still-act-on-a-vocabulary-as-a-whole
  (doseq [[requester session] [["the maintainer's session" user2-request]
                               ["the admin's session" admin-request]]]
    (testing requester
      (let [{:keys [v] :as w} (world!)
            ;; Deleting the vocabulary goes last, and the maintainer added
            ;; is the admin, whom user2 then still has beside them.
            actions (let [[rename del & more] (vocabulary-actions w)]
                      (concat [rename] more [del]))]
        (doseq [[label method path body] actions]
          (let [resp (call session method path body)]
            (is (ok? resp) (str label " answered " (:status resp) " " (:body resp)))))
        (is (nil? (psc/q1 fix/db {:select [:id] :from [:vocab_layers] :where [:= :id v]})))))))

(def ^:private flagged
  "The routes that act on a vocabulary as a whole, as [method template]."
  #{[:patch "/api/v1/vocab-layers/:id"]
    [:delete "/api/v1/vocab-layers/:id"]
    [:post "/api/v1/vocab-layers/:id/maintainers/:user-id"]
    [:delete "/api/v1/vocab-layers/:id/maintainers/:user-id"]
    [:put "/api/v1/vocab-layers/:id/config/:namespace/:config-key"]
    [:delete "/api/v1/vocab-layers/:id/config/:namespace/:config-key"]
    [:post "/api/v1/vocab-layers/:id/items/:item-id/restore"]
    [:post "/api/v1/projects/:id/vocabs/:vocab-id"]
    [:delete "/api/v1/projects/:id/vocabs/:vocab-id"]})

(deftest the-vocabulary-routes-are-marked-and-no-others
  ;; The refusal keys on `:plaid/vocabulary-admin` in the route data. A route
  ;; that loses the mark, or gains it, shows here.
  (let [routes (r/routes (r/router [(rest-core/routes)] {:conflicts nil}))
        marked (set (for [[path data] routes
                          method [:get :post :put :patch :delete]
                          :when (get data method)
                          :when (or (:plaid/vocabulary-admin data)
                                    (get-in data [method :plaid/vocabulary-admin]))]
                      [method path]))]
    (is (= flagged marked))))
