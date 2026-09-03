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
