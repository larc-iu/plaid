(ns plaid.rest-api.v1.media-route-test
  "The media route's cache contract, end to end through the handler: the
  document's `media-url` carries the file's version, a versioned GET is
  immutable, a bare GET revalidates by ETag, and replacing the file changes
  the version. This is what keeps a browser from serving a deleted recording."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    rest-handler with-admin with-test-users
                                    admin-request with-clean-db parse-response-body]]
            [plaid.media.storage]
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
  extension carries it), which is all the route needs to exercise."
  ^File [content]
  (let [file (File/createTempFile "plaid-media-route-" ".mp3")]
    (spit file content)
    (.deleteOnExit file)
    file))

(defn- close-body! [response]
  (when-let [body (:body response)]
    (when (instance? java.io.Closeable body) (.close ^java.io.Closeable body)))
  response)

(deftest media-url-names-the-file-version-and-the-route-honors-it
  (let [tmp (Files/createTempDirectory "plaid-media-route-" (make-array FileAttribute 0))
        cfg {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
             :plaid.media/config {:max-file-size-mb 200}}]
    (try
      (with-redefs [config/config cfg]
        (let [pid (create-test-project admin-request "Media URL project")
              did (create-test-document admin-request pid "Media document")
              media-path (str "/api/v1/documents/" did "/media")
              upload! (fn [content]
                        (let [file (temp-clip! content)]
                          (rest-handler (-> (admin-request :put media-path)
                                            (assoc :multipart-params
                                                   {"file" {:filename "clip.mp3"
                                                            :tempfile file
                                                            :size (.length file)}})))))
              media-url (fn []
                          (let [body (parse-response-body
                                      (rest-handler (admin-request :get (str "/api/v1/documents/" did))))]
                            (some body [:document/media-url :media-url])))]
          (testing "a document without media has no media-url"
            (is (nil? (media-url))))

          (is (= 201 (:status (upload! "first"))))
          (let [url1 (media-url)
                [_ version1] (re-find #"\?v=(\d+-\d+)$" (or url1 ""))]
            (is (= media-path (first (str/split url1 #"\?"))))
            (is (some? version1) "the media-url carries the file's version")

            (testing "a bare GET must revalidate and carries the version as its ETag"
              (let [bare (close-body! (rest-handler (admin-request :get media-path)))]
                (is (= 200 (:status bare)))
                (is (= "private, no-cache" (get-in bare [:headers "Cache-Control"])))
                (is (= (str "\"" version1 "\"") (get-in bare [:headers "ETag"])))))

            (testing "a versioned GET may be cached for good"
              (let [versioned (close-body! (rest-handler (admin-request :get url1)))]
                (is (= 200 (:status versioned)))
                (is (= "private, max-age=31536000, immutable"
                       (get-in versioned [:headers "Cache-Control"])))))

            (testing "a blank ?v= names no particular file, so it is not immutable"
              (let [blank (close-body! (rest-handler (admin-request :get (str media-path "?v="))))]
                (is (= "private, no-cache" (get-in blank [:headers "Cache-Control"])))))

            (testing "a matching If-None-Match is a 304"
              (let [resp (rest-handler (-> (admin-request :get media-path)
                                           (assoc-in [:headers "if-none-match"]
                                                     (str "\"" version1 "\""))))]
                (is (= 304 (:status resp)))
                (is (= (str "\"" version1 "\"") (get-in resp [:headers "ETag"])))))

            (testing "a range request keeps the same cache contract"
              (let [ranged (close-body! (rest-handler (-> (admin-request :get url1)
                                                          (assoc-in [:headers "range"] "bytes=0-1"))))]
                (is (= 206 (:status ranged)))
                (is (= "private, max-age=31536000, immutable"
                       (get-in ranged [:headers "Cache-Control"])))))

            (testing "delete and re-upload changes the version, so the URL changes"
              (is (= 204 (:status (rest-handler (admin-request :delete media-path)))))
              (is (nil? (media-url)))
              (is (= 201 (:status (upload! "second, and longer"))))
              (let [url2 (media-url)]
                (is (some? url2))
                (is (not= url1 url2)))))))
      (finally
        (delete-tree! tmp)))))

(deftest a-refusal-says-what-happened-and-not-where-the-server-keeps-its-files
  ;; The route used to pick its status by matching on the message string that
  ;; came back from storage, and that message was the exception's own on any
  ;; filesystem failure: a NoSuchFileException's message is an absolute server
  ;; path, and it went to the client under a 400. The kind decides the status
  ;; now, and the message is written for a person.
  (let [tmp (Files/createTempDirectory "plaid-media-kind-" (make-array FileAttribute 0))
        cfg {:plaid.server.sql/config {:main-db-path (str (.resolve tmp "plaid.db"))}
             :plaid.media/config {:max-file-size-mb 200}}]
    (try
      (with-redefs [config/config cfg]
        (let [pid (create-test-project admin-request "Media kind project")
              did (create-test-document admin-request pid "Media document")
              media-path (str "/api/v1/documents/" did "/media")
              upload! (fn [filename content]
                        (let [file (File/createTempFile "plaid-media-kind-" ".tmp")]
                          (spit file content)
                          (.deleteOnExit file)
                          (rest-handler (-> (admin-request :put media-path)
                                            (assoc :multipart-params
                                                   {"file" {:filename filename
                                                            :tempfile file
                                                            :size (.length file)}})))))]

          (testing "no media yet: a read and a delete are both 404"
            (is (= 404 (:status (close-body! (rest-handler (admin-request :get media-path))))))
            (is (= 404 (:status (rest-handler (admin-request :delete media-path))))))

          (testing "a file that is not media at all is 415"
            (let [res (upload! "notes.txt" "this is not a recording")]
              (is (= 415 (:status res)))
              (is (string? (-> res parse-response-body :error)))))

          (is (= 201 (:status (upload! "clip.mp3" "first"))))

          (testing "a second upload is 409 while the first is still there"
            (is (= 409 (:status (upload! "clip.mp3" "second")))))

          (testing "over the configured limit is 413, and says what the limit is"
            (is (= 204 (:status (rest-handler (admin-request :delete media-path)))))
            (with-redefs [config/config (assoc-in cfg [:plaid.media/config :max-file-size-mb] 0)]
              (let [res (upload! "clip.mp3" "any size at all is over a zero limit")
                    body (parse-response-body res)]
                (is (= 413 (:status res)))
                (is (= 0 (:max-bytes body)))
                (is (pos? (:size body))))))

          (is (= 201 (:status (upload! "clip.mp3" "back again"))))

          (testing "a filesystem failure is a server fault, and its message stays here"
            (let [secret "/srv/plaid/data/media/whoever-this-is.mp3"]
              (with-redefs [plaid.media.storage/get-media-info
                            (fn [_] (throw (java.nio.file.NoSuchFileException. secret)))]
                (let [res (close-body! (rest-handler (admin-request :get media-path)))
                      body (parse-response-body res)]
                  (is (= 500 (:status res))
                      "a failed read used to answer 404, and an upload 400")
                  (is (not (str/includes? (str body) secret))
                      "the exception's own message names a path on the server")))))))
      (finally
        (delete-tree! tmp)))))
