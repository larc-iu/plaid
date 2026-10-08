(ns plaid.rest-api.v1.scoped-comment-delete-test
  "A delegated token deletes only its own user's comments, never another
  member's, even when its user maintains the project or the vocabulary or
  is an admin (ruled 2026-10-08). Sessions keep the maintainer's recourse."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :as fix :refer [with-db with-mount-states with-clean-db
                                            with-rest-handler with-admin with-test-users
                                            api-call admin-request user1-request user2-request]]
            [plaid.rest-api.v1.auth :as auth]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :as h]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private refusal "A delegated token can delete only its own user's comments.")

(defn- scoped [user-id & project-ids]
  (let [token (auth/issue-delegated-token! fix/db "fake-secret" user-id project-ids)]
    (fn [method path]
      (-> (mock/request method path)
          (mock/header "accept" "application/edn")
          (mock/header "Authorization" (str "Bearer " token))))))

(defn- post-comment [req entity-type entity-id body]
  (-> (api-call req {:method :post :path "/api/v1/comments"
                     :body {:entity-type entity-type :entity-id entity-id :body body}})
      :body :comment/id))

(defn- del [req cid]
  (api-call req {:method :delete :path (str "/api/v1/comments/" cid)}))

(defn- del-in-batch [req cid]
  (api-call req {:method :post :path "/api/v1/batch"
                 :body [{:path (str "/api/v1/comments/" cid) :method "delete"}]}))

(defn- exists? [cid]
  (some? (psc/q1 fix/db {:select [:id] :from [:comments] :where [:= :id cid]})))

(defn- world!
  "A project with a span, user2 its maintainer and user1 a writer."
  []
  (let [p (h/create-test-project admin-request "Comment P")
        doc (h/create-test-document admin-request p "Doc")
        tl (-> (h/create-text-layer admin-request p "TL") :body :id)
        text (-> (h/create-text admin-request tl doc "hello") :body :id)
        tkl (-> (h/create-token-layer admin-request tl "Words") :body :id)
        tok (-> (h/create-token admin-request tkl text 0 5) :body :id)
        sl (-> (h/create-span-layer admin-request tkl "SL") :body :id)
        span (-> (h/create-span admin-request sl [tok] "s") :body :id)]
    (h/add-project-writer admin-request p "user1@example.com")
    (fix/assert-no-content (api-call admin-request {:method :post
                                                    :path (str "/api/v1/projects/" p "/maintainers/user2@example.com")}))
    {:p p :span span}))

(deftest a-delegated-token-cannot-delete-another-members-comment
  (doseq [[requester user-id] [["a maintainer of the project" "user2@example.com"]
                               ["an admin" "admin@example.com"]]]
    (testing requester
      (let [{:keys [p span]} (world!)
            cid (post-comment user1-request "span" span "the writer's")
            token (scoped user-id p)]
        (let [resp (del token cid)]
          (is (= 403 (:status resp)))
          (is (= refusal (-> resp :body :error))))
        (let [resp (del-in-batch token cid)]
          (is (= 403 (:status resp)))
          (is (= refusal (-> resp :body :error))))
        (is (exists? cid) "the comment is still there")))))

(deftest a-delegated-token-deletes-its-own-users-comment
  (doseq [[requester user-id session] [["a writer" "user1@example.com" user1-request]
                                       ["a maintainer" "user2@example.com" user2-request]]]
    (testing requester
      (let [{:keys [p span]} (world!)
            cid (post-comment session "span" span "mine")]
        (is (= 204 (:status (del (scoped user-id p) cid))))
        (is (not (exists? cid)))))))

(deftest a-vocabulary-maintainers-delegated-token-cannot-delete-another-members-comment
  (let [vocab (-> (h/create-vocab-layer admin-request "V") :body :id)
        item (-> (h/create-vocab-item admin-request vocab "gam") :body :id)
        p (h/create-test-project admin-request "V Proj")]
    (h/link-vocab-to-project admin-request p vocab)
    (h/add-project-writer admin-request p "user1@example.com")
    (h/add-project-writer admin-request p "user2@example.com")
    (h/add-vocab-maintainer admin-request vocab "user2@example.com")
    (let [cid (post-comment user1-request "vocab-item" item "the writer's")
          resp (del (scoped "user2@example.com" p) cid)]
      (is (= 403 (:status resp)))
      (is (= refusal (-> resp :body :error)))
      (is (exists? cid))
      (testing "the maintainer's session still may"
        (is (= 204 (:status (del user2-request cid))))))))

(deftest a-maintainers-session-still-deletes-another-members-comment
  (let [{:keys [span]} (world!)
        cid (post-comment user1-request "span" span "the writer's")]
    (is (= 204 (:status (del user2-request cid))))
    (is (not (exists? cid)))))
