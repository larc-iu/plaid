(ns plaid.rest-api.v1.create-parent-elsewhere-test
  "A create in one's own project that names a parent in another project (a
  document for a text, a text for a token, tokens for a span, spans for a
  relation) gets the gate's 403 `unresolved`, naming nothing of that
  project, before any version or lock check on that parent's document
  (ACL1-1, ACL3-1, and the id echo of ACL2-1 and ACL10-5).
  Before, it answered 423 with the other document's lock holder, 409 for
  every version but the real one, and 400 messages quoting the other
  project's ids."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    user2-request api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer create-span-layer create-relation-layer
                                        create-text create-token create-span create-relation
                                        add-project-writer acquire-lock release-lock]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- world [label]
  (let [project (create-test-project admin-request label)
        document (create-test-document admin-request project (str "doc " label))
        text-layer (id (create-text-layer admin-request project "TL"))
        token-layer (id (create-token-layer admin-request text-layer "Words"))
        span-layer (id (create-span-layer admin-request token-layer "Spans"))
        relation-layer (id (create-relation-layer admin-request span-layer "Rels"))
        text (id (create-text admin-request text-layer document "alpha beta"))
        t1 (id (create-token admin-request token-layer text 0 5))
        t2 (id (create-token admin-request token-layer text 6 10))
        s1 (id (create-span admin-request span-layer [t1] "a"))
        s2 (id (create-span admin-request span-layer [t2] "b"))]
    {:project project :document document :text-layer text-layer :token-layer token-layer
     :span-layer span-layer :relation-layer relation-layer :text text :tokens [t1 t2] :spans [s1 s2]}))

(defn- creates
  "Each create route, as [label path body], writing into `p`'s layers and
  naming `q`'s rows."
  [p q]
  (let [u (fn [k] (k q))
        us u]
    [["text" "/api/v1/texts" {:text-layer-id (:text-layer p) :document-id (u :document) :body "x"}]
     ["token" "/api/v1/tokens" {:token-layer-id (:token-layer p) :text (u :text) :begin 0 :end 1}]
     ["span" "/api/v1/spans" {:span-layer-id (:span-layer p) :tokens [(first (us :tokens))] :value "v"}]
     ["relation" "/api/v1/relations" {:relation-layer-id (:relation-layer p) :source (first (us :spans))
                                      :target (second (us :spans)) :value "v"}]
     ["bulk tokens" "/api/v1/tokens/bulk" [{:token-layer-id (:token-layer p) :text (u :text) :begin 0 :end 1}]]
     ["bulk spans" "/api/v1/spans/bulk" [{:span-layer-id (:span-layer p) :tokens [(first (us :tokens))] :value "v"}]]
     ["bulk relations" "/api/v1/relations/bulk" [{:relation-layer-id (:relation-layer p) :source (first (us :spans))
                                                  :target (second (us :spans)) :value "v"}]]]))

(defn- post [who path body]
  (api-call who {:method :post :path path :body body}))

(defn- version-of [doc]
  (-> (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc)}) :body :document/version))

(deftest a-create-naming-another-projects-parent-is-refused-naming-nothing-of-it
  (let [p (world "P")
        q (world "Q")
        q-version (version-of (:document q))
        lock (atom nil)]
    ;; user1 writes in P and has no role in Q. user2 maintains Q.
    (assert-status 204 (add-project-writer admin-request (:project p) "user1@example.com"))
    (assert-status 204 (api-call admin-request {:method :post :path (str "/api/v1/projects/" (:project q)
                                                                         "/maintainers/user2@example.com")}))
    (assert-status 403 (api-call user1-request {:method :get :path (str "/api/v1/documents/" (:document q))}))
    (testing "Q's maintainer holds the lock on Q's document"
      (reset! lock (acquire-lock user2-request (:document q)))
      (assert-status 200 @lock)
      (doseq [[label path body] (creates p q)]
        (testing label
          (let [a (post user1-request path body)
                said (str (:body a))]
            (is (= 403 (:status a)) (pr-str a))
            (is (true? (-> a :body :unresolved)))
            (doseq [fact [(:document q) (:project q) (:text-layer q) (:token-layer q) (:span-layer q)
                          "user2@example.com"]]
              (is (not (clojure.string/includes? said (str fact))) (str "names " fact)))))))
    (assert-status 204 (release-lock user2-request (:document q) (-> @lock :body :lock-id)))
    (testing "no document version is told apart from another"
      (doseq [[label path body] (creates p q)
              n (range 1 (+ 3 q-version))]
        (testing (str label " ?document-version=" n)
          (is (= 403 (:status (post user1-request (str path "?document-version=" n) body)))))))
    (testing "a bulk create with one entry naming Q among entries naming P"
      (let [r (post user1-request "/api/v1/tokens/bulk"
                    [{:token-layer-id (:token-layer p) :text (:text p) :begin 0 :end 1}
                     {:token-layer-id (:token-layer p) :text (:text q) :begin 0 :end 1}])]
        (is (= 403 (:status r)))))
    (testing "nothing was written in Q"
      (is (= q-version (version-of (:document q)))))
    (testing "creates naming P's own rows still work"
      (assert-status 201 (create-token user1-request (:token-layer p) (:text p) 0 2))
      (assert-status 201 (create-span user1-request (:span-layer p) [(first (:tokens p))] "w"))
      (assert-status 201 (create-relation user1-request (:relation-layer p) (first (:spans p)) (second (:spans p)) "w"))
      (assert-status 201 (post user1-request "/api/v1/tokens/bulk"
                               [{:token-layer-id (:token-layer p) :text (:text p) :begin 0 :end 3}])))))
