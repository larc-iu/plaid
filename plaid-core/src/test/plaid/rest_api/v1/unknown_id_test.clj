(ns plaid.rest-api.v1.unknown-id-test
  "The core ruling on unknown ids, over every route that names a project, a
  document or a vocabulary: an id that names nothing answers an admin 404 and
  anyone else 403, so a non-member never learns from the status whether an id
  is real. Before, an admin passed every project gate on any id and got a 200
  with an empty page (guidelines, comments, documents, the audit reads,
  services), a lock on a document that does not exist, or a 500."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request user1-request api-call
                                    assert-status]]
            [plaid.test-helpers :refer [create-test-project create-test-document]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- project-routes
  "[method path body] for each route that names project `p`."
  [p]
  [[:get (str "/api/v1/projects/" p)]
   [:patch (str "/api/v1/projects/" p) {:name "n"}]
   [:delete (str "/api/v1/projects/" p)]
   [:get (str "/api/v1/projects/" p "/documents")]
   [:get (str "/api/v1/projects/" p "/guidelines")]
   [:post (str "/api/v1/projects/" p "/guidelines") {:title "t"}]
   [:get (str "/api/v1/projects/" p "/comments")]
   [:get (str "/api/v1/projects/" p "/comments/counts")]
   [:get (str "/api/v1/projects/" p "/events")]
   [:post (str "/api/v1/projects/" p "/events") []]
   [:get (str "/api/v1/projects/" p "/audit")]
   [:get (str "/api/v1/projects/" p "/audit/last-edits")]
   [:get (str "/api/v1/projects/" p "/audit/tally")]
   [:get (str "/api/v1/projects/" p "/services")]
   [:get (str "/api/v1/projects/" p "/services/svc/requests")]
   [:post (str "/api/v1/projects/" p "/services/svc/requests") {}]
   [:delete (str "/api/v1/projects/" p "/services/svc")]
   [:post (str "/api/v1/projects/" p "/message") {:hello "there"}]
   [:post (str "/api/v1/projects/" p "/heartbeat") {:client-id "c"}]
   [:get (str "/api/v1/projects/" p "/listen")]
   [:post (str "/api/v1/projects/" p "/readers/user2@example.com")]
   [:delete (str "/api/v1/projects/" p "/readers/user2@example.com")]
   [:put (str "/api/v1/projects/" p "/config/app/key") {:a 1}]
   [:delete (str "/api/v1/projects/" p "/config/app/key")]])

(defn- document-routes
  "[method path body] for each route that names document `d`."
  [d]
  [[:get (str "/api/v1/documents/" d)]
   [:patch (str "/api/v1/documents/" d) {:name "n"}]
   [:delete (str "/api/v1/documents/" d)]
   [:get (str "/api/v1/documents/" d "/audit")]
   [:get (str "/api/v1/documents/" d "/lock")]
   [:post (str "/api/v1/documents/" d "/lock")]
   [:delete (str "/api/v1/documents/" d "/lock?lock-id=x")]
   [:get (str "/api/v1/documents/" d "/media")]
   [:put (str "/api/v1/documents/" d "/metadata") {:a 1}]
   [:post (str "/api/v1/documents/" d "/copy") {:name "c"}]])

(defn- vocab-routes
  "[method path body] for each route that names vocabulary `v`."
  [v]
  [[:get (str "/api/v1/vocab-layers/" v)]
   [:patch (str "/api/v1/vocab-layers/" v) {:name "n"}]
   [:get (str "/api/v1/vocab-layers/" v "/audit")]
   [:get (str "/api/v1/vocab-layers/" v "/comments")]
   [:get (str "/api/v1/vocab-layers/" v "/comments/counts")]])

(defn- call [req [method path body]]
  (api-call req (cond-> {:method method :path path}
                  (some? body) (assoc :body body))))

(deftest an-unknown-id-answers-an-admin-404-and-a-non-member-403
  (doseq [route (concat (project-routes (random-uuid))
                        (document-routes (random-uuid))
                        (vocab-routes (random-uuid)))]
    (testing (str (name (first route)) " " (second route))
      (assert-status 404 (call admin-request route))
      (assert-status 403 (call user1-request route)))))

(deftest a-missing-parent-in-the-body-stays-a-bad-request
  ;; An id the path names is the resource asked for, so naming nothing is a
  ;; 404. A create's parent named in the body is not: it stays the handler's
  ;; 400 to an admin, and a non-member still gets a 403.
  (doseq [route [[:post "/api/v1/documents" {:project-id (random-uuid) :name "d"}]
                 [:post "/api/v1/text-layers" {:project-id (random-uuid) :name "t"}]
                 [:post "/api/v1/vocab-items" {:vocab-layer-id (random-uuid) :form "f"}]]]
    (testing (second route)
      (assert-status 400 (call admin-request route))
      (assert-status 403 (call user1-request route)))))

(deftest a-real-id-still-answers-an-admin
  ;; The existence checks must not turn away the ids they are there to let
  ;; through.
  (let [p (create-test-project admin-request "Real")
        d (create-test-document admin-request p "Doc")]
    (doseq [path [(str "/api/v1/projects/" p "/guidelines")
                  (str "/api/v1/projects/" p "/comments")
                  (str "/api/v1/projects/" p "/documents")
                  (str "/api/v1/projects/" p "/audit")
                  (str "/api/v1/projects/" p "/services")
                  (str "/api/v1/documents/" d "/audit")]]
      (testing path
        (assert-status 200 (api-call admin-request {:method :get :path path}))))
    (assert-status 204 (api-call admin-request {:method :get :path (str "/api/v1/documents/" d "/lock")}))
    (assert-status 200 (api-call admin-request {:method :post :path (str "/api/v1/documents/" d "/lock")}))))

(deftest the-history-of-a-deleted-document-or-vocabulary-stays-readable-to-an-admin
  ;; A deleted document or vocabulary is not an unknown id: its audit log is
  ;; still there, and an admin still reads it.
  (let [p (create-test-project admin-request "Real")
        d (create-test-document admin-request p "Doc")
        v (-> (api-call admin-request {:method :post :path "/api/v1/vocab-layers" :body {:name "V"}})
              :body :id)]
    (assert-status 204 (api-call admin-request {:method :delete :path (str "/api/v1/documents/" d)}))
    (assert-status 204 (api-call admin-request {:method :delete :path (str "/api/v1/vocab-layers/" v)}))
    (let [resp (api-call admin-request {:method :get :path (str "/api/v1/documents/" d "/audit")})]
      (assert-status 200 resp)
      (is (seq (-> resp :body :entries))))
    (let [resp (api-call admin-request {:method :get :path (str "/api/v1/vocab-layers/" v "/audit")})]
      (assert-status 200 resp)
      (is (seq (-> resp :body :entries))))
    (testing "a deleted document's lock is a 404, as the document is gone"
      (assert-status 404 (api-call admin-request {:method :post :path (str "/api/v1/documents/" d "/lock")})))))
