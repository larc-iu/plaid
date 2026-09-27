(ns plaid.history.as-of-bound-once-test
  "A document GET at a time resolves the time's batch bound once, although
  both the permission check (for a document deleted since) and the handler
  read the document at that time."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request with-admin api-call
                                    assert-ok assert-no-content with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest a-deleted-document-read-at-a-time-resolves-the-bound-once
  (let [proj (create-test-project admin-request "Bound once")
        doc-id (create-test-document admin-request proj "Doc")
        t (str (java.time.Instant/now))
        _ (Thread/sleep 5)
        _ (assert-no-content (api-call admin-request {:method :delete
                                                      :path (str "/api/v1/documents/" doc-id)}))
        calls (atom 0)
        real @#'hread/effective-bound]
    (with-redefs [hread/effective-bound (fn [& args] (swap! calls inc) (apply real args))]
      (doseq [body? [false true]]
        (reset! calls 0)
        (let [resp (api-call admin-request
                             {:method :get
                              :path (str "/api/v1/documents/" doc-id "?as-of="
                                         (java.net.URLEncoder/encode t "UTF-8")
                                         (when body? "&include-body=true"))})]
          (assert-ok resp)
          (is (= (str doc-id) (str (-> resp :body :document/id))))
          (is (= 1 @calls) (str "include-body " body?)))))))
