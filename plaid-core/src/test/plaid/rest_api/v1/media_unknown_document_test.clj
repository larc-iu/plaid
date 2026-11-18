(ns plaid.rest-api.v1.media-unknown-document-test
  "A recording upload to a document that does not exist, or was deleted,
  answers an admin 404 as every other document route does, and a member
  the gate's 403. Before, an admin got 500 from the duration row written
  for no document (ACL1-2)."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler rest-handler with-admin
                                    with-test-users admin-request user1-request with-clean-db]]
            [plaid.server.config :as config]
            [plaid.test-helpers :refer [create-test-project create-test-document mp3-file]])
  (:import [java.nio.file Files]
           [java.nio.file.attribute FileAttribute]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(deftest an-upload-to-no-document-is-a-404-to-an-admin
  (let [tmp (Files/createTempDirectory "plaid-media-unknown-" (make-array FileAttribute 0))
        cfg {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
             :plaid.media/config {:max-file-size-mb 200}}]
    (with-redefs [config/config cfg]
      (let [upload! (fn [who doc]
                      (let [file (mp3-file "clip")]
                        (:status (rest-handler (-> (who :put (str "/api/v1/documents/" doc "/media"))
                                                   (assoc :multipart-params
                                                          {"file" {:filename "clip.mp3" :tempfile file
                                                                   :size (.length file)}}))))))
            pid (create-test-project admin-request "P")
            gone (create-test-document admin-request pid "gone")]
        (is (= 204 (:status (rest-handler (admin-request :delete (str "/api/v1/documents/" gone))))))
        (testing "the admin"
          (is (= 404 (upload! admin-request (random-uuid))))
          (is (= 404 (upload! admin-request gone))))
        (testing "a member of nothing"
          (is (= 403 (upload! user1-request (random-uuid))))
          (is (= 403 (upload! user1-request gone))))))))
