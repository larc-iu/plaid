(ns plaid.rest-api.v1.unresolved-refusal-test
  "A 403 for an id the core cannot place (deleted since the caller read it,
  or never there) carries `unresolved: true` in its body, in every gate that
  resolves an id: the project gate and the vocabulary reader, writer and
  maintainer gates. The status stays 403 (the core ruling on unknown ids).
  A client reads the field as \"changed or removed by someone else\" (D23),
  so a rewording of any of these messages can no longer turn that into a
  plain \"no permission\". A real refusal never carries the field."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request user1-request
                                    with-admin with-test-users
                                    api-call assert-status assert-no-content with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-vocab-layer
                                        create-vocab-item delete-vocab-item
                                        link-vocab-to-project add-project-writer
                                        add-vocab-maintainer]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private user1 "user1@example.com")

(defn- unresolved? [r]
  (true? (-> r :body :unresolved)))

(defn- setup!
  "Vocabulary Lex, linked to project P, where user1 writes and maintains
  Lex, with entry dog. Vocabulary Other, linked to nothing user1 is in,
  with entry cat. Project Q, user1 not a member."
  []
  (let [lex (-> (create-vocab-layer admin-request "Lex") :body :id)
        other (-> (create-vocab-layer admin-request "Other") :body :id)
        p (create-test-project admin-request "P")
        q (create-test-project admin-request "Q")
        _ (assert-no-content (link-vocab-to-project admin-request p lex))
        _ (assert-no-content (add-project-writer admin-request p user1))
        _ (assert-no-content (add-vocab-maintainer admin-request lex user1))
        dog (-> (create-vocab-item admin-request lex "dog") :body :id)
        cat (-> (create-vocab-item admin-request other "cat") :body :id)]
    {:q q :dog dog :cat cat}))

(deftest the-project-gate
  (let [{:keys [q]} (setup!)]
    (testing "an entity that resolves to no project"
      (let [r (api-call user1-request {:method :get :path (str "/api/v1/spans/" (random-uuid))})]
        (assert-status 403 r)
        (is (unresolved? r))))
    (testing "a project the user is not in"
      (let [r (api-call user1-request {:method :get :path (str "/api/v1/projects/" q)})]
        (assert-status 403 r)
        (is (not (contains? (:body r) :unresolved)))))))

(deftest the-vocab-reader-gate
  (let [{:keys [cat]} (setup!)]
    (testing "an entry that is gone"
      (let [r (api-call user1-request {:method :get :path (str "/api/v1/vocab-items/" (random-uuid))})]
        (assert-status 403 r)
        (is (unresolved? r))))
    (testing "an entry of a vocabulary the user cannot read"
      (let [r (api-call user1-request {:method :get :path (str "/api/v1/vocab-items/" cat)})]
        (assert-status 403 r)
        (is (not (contains? (:body r) :unresolved)))))))

(deftest the-vocab-writer-gate
  (let [{:keys [dog cat]} (setup!)]
    (assert-no-content (delete-vocab-item admin-request dog))
    (testing "an entry deleted since it was read"
      (let [r (api-call user1-request {:method :patch :path (str "/api/v1/vocab-items/" dog)
                                       :body {:form "hound"}})]
        (assert-status 403 r)
        (is (unresolved? r))))
    (testing "an entry of a vocabulary the user cannot write"
      (let [r (api-call user1-request {:method :patch :path (str "/api/v1/vocab-items/" cat)
                                       :body {:form "kitten"}})]
        (assert-status 403 r)
        (is (not (contains? (:body r) :unresolved)))))))

(deftest the-vocab-maintainer-gate
  (let [{:keys [dog cat]} (setup!)]
    (assert-no-content (delete-vocab-item admin-request dog))
    (testing "a delete of an entry deleted since it was read"
      (let [r (delete-vocab-item user1-request dog)]
        (assert-status 403 r)
        (is (unresolved? r))))
    (testing "inside a batch, the field comes through"
      (let [r (api-call user1-request {:method :post :path "/api/v1/batch"
                                       :body [{:path (str "/api/v1/vocab-items/" dog)
                                               :method "delete"}]})]
        (assert-status 403 r)
        (is (unresolved? r))))
    (testing "a delete in a vocabulary the user does not maintain"
      (let [r (delete-vocab-item user1-request cat)]
        (assert-status 403 r)
        (is (not (contains? (:body r) :unresolved)))))
    (testing "an admin is told 404"
      (is (= 404 (:status (delete-vocab-item admin-request (random-uuid))))))))
