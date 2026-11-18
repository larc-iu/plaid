(ns plaid.rest-api.v1.audit-names-readable-documents-test
  "A History entry names a document only to a reader of its project, as it
  names a project (ACL8-1). An undo of P's rows was filed under the project
  of the entry's first operation, Q, and Q's maintainer, who has no role in
  P, then read the name of P's document in `:audit/documents`."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler with-admin
                                    with-test-users with-clean-db admin-request user1-request
                                    user2-request api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer create-span-layer create-text create-token
                                        create-span get-project-audit]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- world [label]
  (let [project (create-test-project admin-request label)
        document (create-test-document admin-request project (str "doc of " label))
        text-layer (id (create-text-layer admin-request project "TL"))
        token-layer (id (create-token-layer admin-request text-layer "Words"))
        span-layer (id (create-span-layer admin-request token-layer "Spans"))
        text (id (create-text admin-request text-layer document "alpha"))
        token (id (create-token admin-request token-layer text 0 5))
        span (id (create-span admin-request span-layer [token] "a"))]
    {:project project :document document :span span}))

(defn- grant! [project role email]
  (assert-status 204 (api-call admin-request {:method :post
                                              :path (str "/api/v1/projects/" project "/" role "/" email)})))

(defn- names-in [entries]
  (set (concat (mapcat #(map :document/name (:audit/documents %)) entries)
               (keep #(-> % :op/document :document/name) (mapcat :audit/ops entries)))))

(deftest an-entry-names-a-document-only-to-a-reader-of-its-project
  (let [q (world "Q")
        p (world "P")
        g (random-uuid)]
    (grant! (:project p) "maintainers" "user1@example.com")
    (grant! (:project q) "maintainers" "user2@example.com")
    ;; one entry that wrote in Q first, then in P
    (doseq [w [q p]]
      (assert-status 200 (api-call admin-request {:method :patch
                                                  :path (str "/api/v1/spans/" (:span w) "?group-id=" g
                                                             "&group-message=fix%20both")
                                                  :body {:value "changed"}})))
    (testing "P's maintainer undoes the part they may"
      (assert-status 200 (api-call user1-request {:method :post :path (str "/api/v1/audit/entries/" g "/undo")})))
    (testing "Q's maintainer reads Q's History and no P document is named there"
      (let [r (get-project-audit user2-request (:project q))]
        (assert-status 200 r)
        (is (not (contains? (names-in (:entries (:body r))) "doc of P")))))
    (testing "the admin reads every name"
      (let [all (concat (:entries (:body (get-project-audit admin-request (:project q))))
                        (:entries (:body (get-project-audit admin-request (:project p)))))]
        (is (contains? (names-in all) "doc of P"))))))
