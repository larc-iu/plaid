(ns plaid.rest-api.v1.media-delete-version-test
  "A delete of a document's recording names the recording it means
  (`?media-version=`, the `?v=` of the `media-url` the caller holds). A page
  still showing a recording someone else has since replaced used to delete
  the newer one, which nothing brings back (H36-SETTINGS-LIVE-1). The delete
  is refused 409 with the current `media-url` instead, on its own and inside
  a batch. Uploads take no such check."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    rest-handler with-admin with-test-users
                                    admin-request api-call
                                    with-clean-db parse-response-body]]
            [plaid.server.config :as config]
            [plaid.test-helpers :refer [create-test-project create-test-document]])
  (:import [java.io File]
           [java.nio.file FileVisitOption Files]
           [java.nio.file.attribute FileAttribute]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- delete-tree! [root]
  (when (Files/exists root (make-array java.nio.file.LinkOption 0))
    (with-open [paths (Files/walk root (make-array FileVisitOption 0))]
      (doseq [path (reverse (vec (.toList paths)))]
        (Files/deleteIfExists path)))))

(defn- with-media-dir [f]
  (let [tmp (Files/createTempDirectory "plaid-media-delver-" (make-array FileAttribute 0))]
    (try
      (with-redefs [config/config {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
                                   :plaid.media/config {:max-file-size-mb 200}}]
        (f))
      (finally (delete-tree! tmp)))))

(defn- upload! [did content]
  (let [file (File/createTempFile "plaid-media-delver-" ".mp3")]
    (spit file content)
    (.deleteOnExit file)
    (rest-handler (-> (admin-request :put (str "/api/v1/documents/" did "/media"))
                      (assoc :multipart-params {"file" {:filename "clip.mp3"
                                                        :tempfile file
                                                        :size (.length file)}})))))

(defn- media-url [did]
  (:document/media-url (parse-response-body
                        (rest-handler (admin-request :get (str "/api/v1/documents/" did))))))

(defn- version-of [url]
  (second (re-find #"\?v=([^&]+)$" (or url ""))))

(defn- delete! [did media-version]
  (rest-handler (admin-request :delete (str "/api/v1/documents/" did "/media"
                                            (when media-version
                                              (str "?media-version=" media-version))))))

(deftest a-delete-naming-a-replaced-recording-is-refused
  (with-media-dir
    (fn []
      (let [pid (create-test-project admin-request "Media delete version")
            did (create-test-document admin-request pid "Story")]
        (is (= 201 (:status (upload! did "first"))))
        (let [old (version-of (media-url did))]
          (is (some? old))
          ;; Someone else replaces it.
          (is (= 204 (:status (delete! did old))))
          (is (= 201 (:status (upload! did "second, and longer"))))
          (let [current (media-url did)]
            (testing "the stale page's delete is refused and names the current recording"
              (let [r (delete! did old)
                    body (parse-response-body r)]
                (is (= 409 (:status r)))
                (is (true? (:media-changed body)))
                (is (= current (:media-url body)))
                (is (= current (media-url did)) "the newer recording stays")))
            (testing "inside a batch too, and the batch rolls back"
              (let [path (str "/api/v1/documents/" did "/media?media-version=" old)
                    r (api-call admin-request {:method :post :path "/api/v1/batch"
                                               :body [{:path path :method "delete"}]})]
                (is (= 409 (:status r)))
                (is (= current (media-url did)))))
            (testing "a delete naming the stored recording goes through"
              (is (= 204 (:status (delete! did (version-of current)))))
              (is (nil? (media-url did))))))))))

(deftest a-delete-without-a-version-takes-what-is-stored
  (with-media-dir
    (fn []
      (let [pid (create-test-project admin-request "Media delete bare")
            did (create-test-document admin-request pid "Story")]
        (is (= 201 (:status (upload! did "first"))))
        (is (= 204 (:status (delete! did nil))))
        (is (nil? (media-url did)))
        (testing "with nothing stored, a delete naming a version is 404"
          (is (= 404 (:status (delete! did "1-1")))))))))
