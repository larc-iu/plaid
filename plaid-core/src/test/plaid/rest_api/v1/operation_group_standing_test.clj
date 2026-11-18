(ns plaid.rest-api.v1.operation-group-standing-test
  "Who may read and relabel an operation group, as a matrix over the actor.
  The creator only while they still read (GET) or write (PATCH) every
  project its writes were filed under (ACL8-2, ACL10-1), and an unknown id
  gets a non-admin the 403 a real group of another person gets, with
  `unresolved` (ACL8-3, ACL10-4)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    user2-request api-call assert-status]]
            [plaid.rest-api.v1.job-helpers :as jh]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer create-span-layer create-text create-token
                                        create-span get-project-audit]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- role! [method project role email]
  (assert-status 204 (api-call admin-request {:method method
                                              :path (str "/api/v1/projects/" project "/" role "/" email)})))

(defn- write-under [who span g]
  (assert-status 200 (api-call who {:method :patch
                                    :path (str "/api/v1/spans/" span "?group-id=" g "&group-message=Gloss")
                                    :body {:value (str "v" (random-uuid))}})))

(defn- relabel [who g message]
  (api-call who {:method :patch :path (str "/api/v1/operation-groups/" g) :body {:message message}}))

(defn- read-group [who g]
  (api-call who {:method :get :path (str "/api/v1/operation-groups/" g)}))

(deftest the-creator-reads-and-relabels-only-while-they-hold-the-role
  (let [p (create-test-project admin-request "P")
        doc (create-test-document admin-request p "d")
        tl (id (create-text-layer admin-request p "TL"))
        wl (id (create-token-layer admin-request tl "W"))
        sl (id (create-span-layer admin-request wl "S"))
        txt (id (create-text admin-request tl doc "alpha"))
        span (id (create-span admin-request sl [(id (create-token admin-request wl txt 0 5))] "a"))
        z (jh/user! "z@example.com")
        k (jh/user! "kept@example.com")
        [g-removed g-demoted g-kept] (repeatedly 3 random-uuid)]
    (role! :post p "writers" "user1@example.com")
    (role! :post p "maintainers" "z@example.com")
    (role! :post p "writers" "kept@example.com")
    (write-under user1-request span g-removed)
    (write-under z span g-demoted)
    (write-under k span g-kept)
    (role! :delete p "writers" "user1@example.com")
    (role! :post p "readers" "z@example.com")
    (doseq [[label who g read relabel-status]
            [["removed from P" user1-request g-removed 403 403]
             ["lowered to reader" z g-demoted 200 403]
             ["still a writer" k g-kept 200 200]
             ["another member, on someone's group" k g-demoted 403 403]
             ["the admin" admin-request g-removed 200 200]]]
      (testing label
        (is (= read (:status (read-group who g))))
        (is (= relabel-status (:status (relabel who g (str "rewritten by " label)))))))
    (testing "P's History keeps the labels the lapsed creators gave"
      (let [messages (set (keep :audit/message (:entries (:body (get-project-audit admin-request p)))))]
        (is (not (contains? messages "rewritten by removed from P")))
        (is (not (contains? messages "rewritten by lowered to reader")))
        (is (contains? messages "rewritten by still a writer"))))))

(deftest an-unknown-group-gets-a-non-admin-the-answer-a-real-one-gets
  (let [p (create-test-project user2-request "Q")
        g (random-uuid)
        unknown (random-uuid)]
    (assert-status 201 (api-call user2-request {:method :post :path (str "/api/v1/documents?group-id=" g)
                                                :body {:project-id p :name "doc"}}))
    (doseq [[label call] [["GET" read-group] ["PATCH" #(relabel %1 %2 "x")]]]
      (testing label
        (let [a (call user1-request g)
              b (call user1-request unknown)]
          (is (= 403 (:status a) (:status b)))
          (is (= (:error (:body a)) (:error (:body b))))
          (is (true? (-> b :body :unresolved))))
        (is (= 404 (:status (call admin-request unknown))))))))
