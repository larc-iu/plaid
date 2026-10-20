(ns plaid.sql.audit-slim-images-test
  "An audit image is stored without the row's `id` and `document_id`, which
  the audit row's own columns hold, and every read of the log puts them
  back."
  (:require [clojure.data.json :as json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin assert-ok assert-no-content with-clean-db]]
            [plaid.history.read :as hread]
            [plaid.history.unrecorded-rows-test :as unrec]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(deftest images-leave-out-what-the-row-columns-hold
  (let [{:keys [doc spans tokens]} (unrec/build-document "Slim")
        made (latest-op-ts)
        at-made (doc/get-with-layer-data db doc)]
    (assert-ok (update-span admin-request (first spans) :value "v2"))
    (assert-no-content (delete-token admin-request (last tokens)))
    (let [images (keep :post_image (psc/q db ["SELECT post_image FROM audit_writes"]))]
      (testing "no image holds an id or a document"
        (is (< 20 (count images)))
        (is (not-any? #(contains? (json/read-str %) "id") images))
        (is (not-any? #(contains? (json/read-str %) "document_id") images))))
    (testing "every read puts them back"
      (is (= at-made (hread/get-with-layer-data-at db doc made)))
      (is (= (doc/get-with-layer-data db doc) (hread/get-with-layer-data-at db doc (latest-op-ts))))
      (is (= (str doc) (str (:id (:document (hread/document-rows-at db doc made))))))
      (is (every? #(= doc (:document_id %)) (:spans (hread/document-rows-at db doc made)))))))
