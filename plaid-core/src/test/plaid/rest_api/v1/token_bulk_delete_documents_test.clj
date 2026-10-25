(ns plaid.rest-api.v1.token-bulk-delete-documents-test
  "A token bulk delete reaching two documents of one project is refused with
  its message and writes nothing, and one within a document deletes every id
  it was sent."
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request api-call]]
            [plaid.test-helpers :refer [create-test-project create-test-document create-text-layer
                                        create-token-layer create-text create-token]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- id [resp] (-> resp :body :id))

(defn- token-exists? [t]
  (= 200 (:status (api-call admin-request {:method :get :path (str "/api/v1/tokens/" t)}))))

(deftest a-token-bulk-delete-across-two-documents-is-refused
  (let [project (create-test-project admin-request "P")
        d1 (create-test-document admin-request project "D1")
        d2 (create-test-document admin-request project "D2")
        tl (id (create-text-layer admin-request project "TL"))
        kl (id (create-token-layer admin-request tl "Words"))
        x1 (id (create-text admin-request tl d1 "alpha beta"))
        x2 (id (create-text admin-request tl d2 "gamma delta"))
        a (id (create-token admin-request kl x1 0 5))
        b (id (create-token admin-request kl x2 0 5))
        resp (api-call admin-request {:method :delete :path "/api/v1/tokens/bulk" :body [a b]})]
    (is (= 400 (:status resp)))
    (is (= "Not all tokens belong to the same document" (-> resp :body :error)))
    (is (token-exists? a))
    (is (token-exists? b))))

(deftest a-token-bulk-delete-deletes-every-id-it-was-sent
  (let [project (create-test-project admin-request "P")
        d1 (create-test-document admin-request project "D1")
        tl (id (create-text-layer admin-request project "TL"))
        kl (id (create-token-layer admin-request tl "Words"))
        x1 (id (create-text admin-request tl d1 "alpha beta"))
        a (id (create-token admin-request kl x1 0 5))
        b (id (create-token admin-request kl x1 6 10))
        resp (api-call admin-request {:method :delete :path "/api/v1/tokens/bulk" :body [a b a]})]
    (is (<= 200 (:status resp) 299))
    (is (not (token-exists? a)))
    (is (not (token-exists? b)))))
