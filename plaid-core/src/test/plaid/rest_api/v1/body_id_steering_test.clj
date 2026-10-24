(ns plaid.rest-api.v1.body-id-steering-test
  "A route that names its entity in the path is gated on that entity's
  project, whatever the body says. Before, the resolvers of texts and the
  four layer kinds read a parent id from the body first, so on a route whose
  body is `any?` (and so not stripped) a caller could add the id of a layer
  in a project of their own and pass the writer or maintainer gate there,
  while the handler wrote the entity the path named (C1-1, C1-2)."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [mount.core :as mount]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request user1-request user2-request api-call
                                    assert-status]]
            [plaid.rest-api.v1.core :as rest]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer create-span-layer create-relation-layer
                                        create-text create-token create-span create-relation
                                        create-vocab-layer create-vocab-item add-project-reader
                                        add-project-writer get-text]]
            [reitit.core :as rc]))

(defn- with-service-channels-started
  "The service submit route reads the live service channels, a mount state
  the fixture chain does not start and another test namespace may have
  stopped."
  [f]
  (mount/start #'plaid.server.events/service-channels)
  (f))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users
  with-service-channels-started)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- world
  "A project owned by `req`'s user with one of everything in it."
  [req label]
  (let [project (create-test-project req label)
        document (create-test-document req project "Doc")
        text-layer (id (create-text-layer req project "TL"))
        token-layer (id (create-token-layer req text-layer "Words"))
        span-layer (id (create-span-layer req token-layer "Spans"))
        relation-layer (id (create-relation-layer req span-layer "Rels"))
        text (id (create-text req text-layer document "alpha beta"))
        t1 (id (create-token req token-layer text 0 5))
        t2 (id (create-token req token-layer text 6 10))
        s1 (id (create-span req span-layer [t1] "a"))
        s2 (id (create-span req span-layer [t2] "b"))
        relation (id (create-relation req relation-layer s1 s2 "r"))
        vocab (id (create-vocab-layer req (str label " vocab")))
        _ (assert-status 204 (api-call req {:method :post
                                            :path (str "/api/v1/projects/" project "/vocabs/" vocab)}))
        item (id (create-vocab-item req vocab "alpha"))]
    {:project project :document document :text-layer text-layer :token-layer token-layer
     :span-layer span-layer :relation-layer relation-layer :text text :tokens [t1 t2]
     :spans [s1 s2] :relation relation :vocab vocab :item item}))

(defn- foreign-keys
  "Every body key a resolver anywhere reads, each naming an entity of world `w`."
  [w]
  {:project-id (:project w)
   :text-layer-id (:text-layer w)
   :token-layer-id (:token-layer w)
   :span-layer-id (:span-layer w)
   :relation-layer-id (:relation-layer w)
   :document-id (:document w)
   :text (:text w)
   :tokens (:tokens w)
   :source (first (:spans w))
   :target (second (:spans w))
   :span-id (first (:spans w))
   :vocab-layer-id (:vocab w)
   :vocab-item (:item w)})

(defn- layer-config [kind layer-id]
  (:config (:body (api-call admin-request {:method :get :path (str "/api/v1/" kind "-layers/" layer-id)}))))

;; ---------------------------------------------------------------------------
;; One test per route class the C1 probe passed
;; ---------------------------------------------------------------------------

(deftest a-text-patch-is-gated-on-the-texts-own-project
  (let [a (world admin-request "A")
        b (world user1-request "B")]
    (assert-status 204 (add-project-reader admin-request (:project a) "user1@example.com"))
    (testing "a reader of A naming a text layer of their own project B"
      (assert-status 403 (api-call user1-request {:method :patch
                                                  :path (str "/api/v1/texts/" (:text a))
                                                  :body {:body "pwned" :text-layer-id (:text-layer b)}}))
      (is (= "alpha beta" (-> (get-text admin-request (:text a)) :body :text/body))))
    (testing "a non-member naming a text layer of their own project"
      (let [c (world user2-request "C")]
        (assert-status 403 (api-call user2-request {:method :patch
                                                    :path (str "/api/v1/texts/" (:text a))
                                                    :body {:body "pwned" :text-layer-id (:text-layer c)}}))
        (is (= "alpha beta" (-> (get-text admin-request (:text a)) :body :text/body)))))))

(deftest a-text-patch-checks-the-version-of-the-texts-own-document
  ;; `get-document-id` read `:document-id` from the body first, so a writer
  ;; could point the OCC check at a document of their own.
  (let [a (world admin-request "A")
        b (world user1-request "B")
        _ (assert-status 204 (add-project-writer admin-request (:project a) "user1@example.com"))
        version-of (fn [doc] (-> (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc)})
                                 :body :document/version))
        ;; B's document moves on, so the two versions differ.
        _ (dotimes [i 3]
            (assert-status 200 (api-call user1-request {:method :patch
                                                        :path (str "/api/v1/documents/" (:document b))
                                                        :body {:name (str "B" i)}})))
        b-version (version-of (:document b))]
    (is (not= b-version (version-of (:document a))))
    (assert-status 409 (api-call user1-request {:method :patch
                                                :path (str "/api/v1/texts/" (:text a)
                                                           "?document-version=" b-version)
                                                :body {:body "alpha beta gamma" :document-id (:document b)}}))
    (is (= "alpha beta" (-> (get-text admin-request (:text a)) :body :text/body)))))

(deftest a-layer-config-write-is-gated-on-the-layers-own-project
  (let [a (world admin-request "A")
        b (world user1-request "B")]
    (assert-status 204 (add-project-reader admin-request (:project a) "user1@example.com"))
    (doseq [[kind layer-key] [["text" :text-layer] ["token" :token-layer]
                              ["span" :span-layer] ["relation" :relation-layer]]]
      (testing (str kind " layer")
        (let [path (str "/api/v1/" kind "-layers/" (layer-key a) "/config/igt/roles")]
          (assert-status 204 (api-call admin-request {:method :put :path path :body {:keep "me"}}))
          (testing "PUT with every parent key naming B"
            (assert-status 403 (api-call user1-request {:method :put :path path
                                                        :body (assoc (foreign-keys b) :pwned true)}))
            (is (= {"keep" "me"} (get-in (layer-config kind (layer-key a)) ["igt" "roles"]))))
          (testing "PUT with if-unchanged and the keys beside the envelope"
            (assert-status 403 (api-call user1-request {:method :put :path (str path "?if-unchanged=true")
                                                        :body (assoc (foreign-keys b)
                                                                     :expected {:keep "me"}
                                                                     :value {:pwned true})}))
            (is (= {"keep" "me"} (get-in (layer-config kind (layer-key a)) ["igt" "roles"]))))
          (testing "DELETE with every parent key naming B"
            (assert-status 403 (api-call user1-request {:method :delete :path path :body (foreign-keys b)}))
            (is (= {"keep" "me"} (get-in (layer-config kind (layer-key a)) ["igt" "roles"])))))))))

;; ---------------------------------------------------------------------------
;; The router walk
;; ---------------------------------------------------------------------------

(defn- any-body-routes
  "[method path-template] for every route whose body schema is `any?`, so a
  key the caller adds reaches the resolvers unstripped."
  []
  (for [[path data] (rc/routes (rc/router [(rest/routes)] {:conflicts nil}))
        method [:get :post :put :patch :delete]
        :let [md (get data method)]
        :when (and md (identical? any? (or (-> md :parameters :body) (-> data :parameters :body))))]
    [method path]))

(defn- fill
  "The path for `template` with each parameter naming an entity of world `w`
  (or, for a parameter that names no entity, a fixed value). A parameter this
  does not know fails the test, so a new route of this kind is covered or
  noticed."
  [template w user]
  (str/replace template #":([a-z-]+)"
               (fn [[_ param]]
                 (str (case param
                        "id" (cond (str/starts-with? template "/api/v1/projects/") (:project w)
                                   (str/starts-with? template "/api/v1/vocab-layers/") (:vocab w)
                                   :else (throw (ex-info "no filler" {:template template :param param})))
                        "text-id" (:text w)
                        "text-layer-id" (:text-layer w)
                        "token-layer-id" (:token-layer w)
                        "span-layer-id" (:span-layer w)
                        "relation-layer-id" (:relation-layer w)
                        "document-id" (:document w)
                        "user-id" user
                        ("key" "namespace" "config-key") "k"
                        "service-id" "svc"
                        (throw (ex-info "no filler" {:template template :param param})))))))

(deftest the-walk-finds-the-routes-it-is-about
  ;; If the walk found nothing it would pass on nothing.
  (let [routes (set (any-body-routes))]
    (is (contains? routes [:patch "/api/v1/texts/:text-id"]))
    (doseq [kind ["text" "token" "span" "relation"]]
      (is (contains? routes [:put (str "/api/v1/" kind "-layers/:" kind "-layer-id/config/:namespace/:config-key")])))))

(deftest no-foreign-body-id-changes-the-project-a-route-checks
  (let [a (world admin-request "A")]
    (assert-status 204 (add-project-reader admin-request (:project a) "user1@example.com"))
    (doseq [[req user label] [[user1-request "user1@example.com" "a reader of A"]
                              [user2-request "user2@example.com" "a non-member of A"]]
            :let [own (world req (str "Own of " user))]
            [method template] (any-body-routes)
            :let [path (fill template a user)
                  base {:body "x"}
                  steered (api-call req {:method method :path path :body (merge base (foreign-keys own))})
                  plain (api-call req {:method method :path path :body base})]]
      (testing (str label ": " (name method) " " template)
        (is (= (:status plain) (:status steered))
            (str "plain " (:status plain) " " (:body plain) ", steered " (:status steered) " " (:body steered)))))))
