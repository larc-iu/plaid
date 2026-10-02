(ns plaid.rest-api.v1.media-audit-test
  "Uploading and deleting a recording are operations in the audit log
  (H22-MEDIA-7). Any writer can delete a recording, and nothing recorded who
  or when. Each one also moves the document's version, which is how a page
  holding the document learns that it changed: its next write is refused as
  changed elsewhere and it reads the document again."
  (:require [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    rest-handler with-admin with-test-users
                                    admin-request user1-request api-call
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

(defn- temp-clip!
  "A file that uploads as audio by its name (Tika sees text, the filename
  extension carries it)."
  ^File [content]
  (let [file (File/createTempFile "plaid-media-audit-" ".mp3")]
    (spit file content)
    (.deleteOnExit file)
    file))

(defn- with-media-dir [f]
  (let [tmp (Files/createTempDirectory "plaid-media-audit-" (make-array FileAttribute 0))]
    (try
      (with-redefs [config/config {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
                                   :plaid.media/config {:max-file-size-mb 200}}]
        (f))
      (finally (delete-tree! tmp)))))

(defn- upload! [request-fn did filename content]
  (let [file (temp-clip! content)]
    (rest-handler (-> (request-fn :put (str "/api/v1/documents/" did "/media"))
                      (assoc :multipart-params {"file" {:filename filename
                                                        :tempfile file
                                                        :size (.length file)}})))))

(defn- delete! [request-fn did]
  (rest-handler (request-fn :delete (str "/api/v1/documents/" did "/media"))))

(defn- media-ops
  "The document's audit operations about its recording, in the order the log gives them."
  [did]
  (->> (api-call admin-request {:method :get :path (str "/api/v1/documents/" did "/audit")})
       :body :entries (mapcat :audit/ops)
       (filter #(#{"media/upload" "media/delete"} (subs (str (:op/type %)) 1)))
       (map (fn [op] [(subs (str (:op/type op)) 1) (:op/description op) (-> op :op/user :user/id)]))))

(defn- version [did]
  (:document/version (parse-response-body
                      (rest-handler (admin-request :get (str "/api/v1/documents/" did))))))

(defn- media-url [did]
  (:document/media-url (parse-response-body
                        (rest-handler (admin-request :get (str "/api/v1/documents/" did))))))

(deftest a-recording-change-is-in-the-audit-log-and-moves-the-version
  (with-media-dir
    (fn []
      (let [pid (create-test-project admin-request "Media audit")
            did (create-test-document admin-request pid "Story")
            v0 (version did)]
        (testing "an upload is an operation, named by the file, and the answer carries the new version"
          (let [r (upload! admin-request did "take1.mp3" "first")]
            (is (= 201 (:status r)))
            (is (= (inc v0) (version did)))
            (is (re-find (re-pattern (str "\"" did "\":" (inc v0)))
                         (str (get-in r [:headers "X-Document-Versions"]))))
            (is (= [["media/upload" (str "Upload media file \"take1.mp3\" to document " did)
                     "admin@example.com"]]
                   (media-ops did)))))

        (testing "a refused upload records nothing and moves nothing"
          (is (= 409 (:status (upload! admin-request did "take2.mp3" "second"))))
          (is (= (inc v0) (version did)))
          (is (= 1 (count (media-ops did)))))

        (testing "a delete is an operation, and the file is gone"
          (let [r (delete! admin-request did)]
            (is (= 204 (:status r)))
            (is (some? (get-in r [:headers "X-Document-Versions"]))))
          (is (nil? (media-url did)))
          (is (= (+ 2 v0) (version did)))
          (is (= ["media/upload" "media/delete"] (map first (media-ops did)))))

        (testing "deleting what is not there is refused and records nothing"
          (is (= 404 (:status (delete! admin-request did))))
          (is (= 2 (count (media-ops did)))))))))

(deftest a-refused-operation-leaves-no-file-behind
  (with-media-dir
    (fn []
      (let [pid (create-test-project admin-request "Media lock")
            did (create-test-document admin-request pid "Story")
            _ (api-call admin-request {:method :post
                                       :path (str "/api/v1/projects/" pid "/writers/user1@example.com")})
            ;; Someone else holds the document's lock: every write to it is
            ;; refused, a recording's included.
            lock (api-call user1-request {:method :post :path (str "/api/v1/documents/" did "/lock")})]
        (is (= 200 (:status lock)))
        (let [r (upload! admin-request did "take1.mp3" "first")]
          (is (= 423 (:status r))))
        (is (nil? (media-url did)) "the stored file was taken back out")
        (is (empty? (media-ops did)))))))
