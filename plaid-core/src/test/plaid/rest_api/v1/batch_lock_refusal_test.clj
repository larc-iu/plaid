(ns plaid.rest-api.v1.batch-lock-refusal-test
  "A document lock lives outside the database, so a batch's rollback cannot
  give back a lock one of its operations took. Taking, renewing or
  releasing a lock inside a batch is refused with a 400 before any of the
  batch runs (REV-F-CORE-LOCK)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-test-users
                                    api-call assert-status assert-ok with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        get-document check-lock acquire-lock
                                        release-lock update-document-metadata]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- batch [ops]
  (api-call admin-request {:method :post :path "/api/v1/batch" :body ops}))

(defn- meta-op [doc v]
  {:path (str "/api/v1/documents/" doc "/metadata") :method "put" :body {:k v}})

(defn- stored-k [doc]
  (-> (get-document admin-request doc) :body :metadata (get "k")))

(deftest a-lock-acquire-in-a-batch-is-refused-and-nothing-is-written
  (let [proj (create-test-project admin-request "P")
        doc (create-test-document admin-request proj "D")]
    (update-document-metadata admin-request doc {:k "before"})
    (doseq [[label op] [["an acquire" {:path (str "/api/v1/documents/" doc "/lock") :method "post"}]
                        ["an acquire with a client id"
                         {:path (str "/api/v1/documents/" doc "/lock?new-lock-id=" (random-uuid))
                          :method "POST"}]
                        ["a release" {:path (str "/api/v1/documents/" doc "/lock") :method "delete"}]
                        ["an admin's drop" {:path (str "/api/v1/admin/locks/" doc) :method "delete"}]]]
      (testing label
        (let [r (batch [(meta-op doc "after") op])]
          (assert-status 400 r)
          (is (re-find #"^Operation 1 takes or releases a document lock" (-> r :body :error))))
        (is (= "before" (stored-k doc)) "the operation before it was not written")
        (assert-status 204 (check-lock admin-request doc))))
    (testing "a batch whose later operation fails leaves no lock behind"
      (let [r (batch [{:path (str "/api/v1/documents/" doc "/lock") :method "post"}
                      {:path (str "/api/v1/documents/" (random-uuid)) :method "delete"}])]
        (assert-status 400 r))
      (assert-status 204 (check-lock admin-request doc)))))

(deftest a-lock-held-outside-is-not-released-by-a-batch
  (let [proj (create-test-project admin-request "P")
        doc (create-test-document admin-request proj "D")
        lock-id (-> (acquire-lock admin-request doc) :body :lock-id)]
    (assert-status 400 (batch [{:path (str "/api/v1/documents/" doc "/lock?lock-id=" lock-id)
                                :method "delete"}]))
    (assert-ok (check-lock admin-request doc))
    (release-lock admin-request doc lock-id)))

(deftest reading-a-lock-in-a-batch-still-works
  (let [proj (create-test-project admin-request "P")
        doc (create-test-document admin-request proj "D")
        r (batch [(meta-op doc "after")
                  {:path (str "/api/v1/documents/" doc "/lock") :method "get"}])]
    (assert-ok r)
    (is (= 204 (get-in r [:body 1 :status])))
    (is (= "after" (stored-k doc)))))
