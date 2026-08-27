(ns plaid.rest-api.v1.user-avatar-test
  "Coverage for the profile-picture endpoints on /users/:id/avatar.

  Multipart parsing itself is Ring's, not ours, so these tests inject
  `:multipart-params` directly (ring's `wrap-multipart-params` leaves a request
  whose content type is not multipart untouched) and exercise everything from
  the handler inward: authorization, normalization, storage, cache headers."
  (:require [clojure.java.io :as io]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    rest-handler with-admin with-test-users
                                    admin-request user1-request user2-request
                                    with-clean-db parse-response-body]]
            [plaid.media.avatar :as avatar]
            [plaid.server.config :as config]
            [plaid.sql.common :as psc])
  (:import [java.awt Color]
           [java.awt.image BufferedImage]
           [java.io ByteArrayInputStream File]
           [javax.imageio ImageIO]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

;; --- helpers ---------------------------------------------------------------

(defn- temp-image!
  "Write a `w`x`h` test image to a temp file and return it. `type` is a
  BufferedImage image type, so callers can ask for an alpha channel."
  ^File [w h image-type]
  (let [img (BufferedImage. (int w) (int h) (int image-type))
        g (.createGraphics img)
        file (File/createTempFile "plaid-avatar-test-" ".png")]
    (.setColor g Color/RED)
    (.fillRect g 0 0 w h)
    (.setColor g Color/BLUE)
    (.fillOval g 0 0 (quot w 2) (quot h 2))
    (.dispose g)
    (ImageIO/write img "png" file)
    (.deleteOnExit file)
    file))

(defn- temp-file-with!
  "Write `content` (a string) to a temp file, for the not-an-image cases."
  ^File [content]
  (let [file (File/createTempFile "plaid-avatar-test-" ".bin")]
    (spit file content)
    (.deleteOnExit file)
    file))

(defn- upload
  "PUT `file` as `target-id`'s picture, authenticated as `request-fn`."
  [request-fn target-id ^File file]
  (rest-handler (-> (request-fn :put (str "/api/v1/users/" target-id "/avatar"))
                    (assoc :multipart-params
                           {"file" {:filename (.getName file)
                                    :tempfile file
                                    :size (.length file)}}))))

(defn- body-bytes
  "Drain a binary response body to a byte array."
  ^bytes [response]
  (with-open [in (io/input-stream (:body response))
              out (java.io.ByteArrayOutputStream.)]
    (io/copy in out)
    (.toByteArray out)))

;; --- tests -----------------------------------------------------------------

(deftest upload-normalizes-to-a-square
  (testing "a wide opaque image comes back as a square JPEG at the configured edge"
    (let [resp (upload user1-request "user1@example.com" (temp-image! 1200 400 BufferedImage/TYPE_INT_RGB))]
      (is (= 200 (:status resp)))
      (is (some? (:user/avatar-hash (parse-response-body resp)))
          "the updated user record comes back, carrying the new hash"))

    (let [resp (rest-handler (user1-request :get "/api/v1/users/user1@example.com/avatar"))
          bytes (body-bytes resp)
          decoded (ImageIO/read (ByteArrayInputStream. bytes))]
      (is (= 200 (:status resp)))
      (is (= "image/jpeg" (get-in resp [:headers "Content-Type"]))
          "no alpha in the source, so JPEG rather than a much larger PNG")
      (is (= (avatar/size-px) (.getWidth decoded)))
      (is (= (avatar/size-px) (.getHeight decoded))
          "center-cropped, not squashed"))))

(deftest upload-preserves-transparency-as-png
  (upload user1-request "user1@example.com" (temp-image! 300 300 BufferedImage/TYPE_INT_ARGB))
  (let [resp (rest-handler (user1-request :get "/api/v1/users/user1@example.com/avatar"))]
    (is (= 200 (:status resp)))
    (is (= "image/png" (get-in resp [:headers "Content-Type"])))))

(deftest hash-appears-on-the-user-record
  (let [upload-resp (upload user1-request "user1@example.com" (temp-image! 600 600 BufferedImage/TYPE_INT_RGB))
        hash (:user/avatar-hash (parse-response-body upload-resp))
        get-resp (rest-handler (user2-request :get "/api/v1/users/user1@example.com"))]
    (is (= hash (:user/avatar-hash (parse-response-body get-resp)))
        "any logged-in user can see that a picture exists, matching GET /users/:id")))

(deftest caching-is-keyed-on-the-content-hash
  (let [hash (-> (upload user1-request "user1@example.com" (temp-image! 600 600 BufferedImage/TYPE_INT_RGB))
                 parse-response-body
                 :user/avatar-hash)
        etag (str "\"" hash "\"")]
    (testing "the hash is served as the ETag"
      (let [resp (rest-handler (user1-request :get "/api/v1/users/user1@example.com/avatar"))]
        (is (= etag (get-in resp [:headers "ETag"])))
        (is (= "private, max-age=60" (get-in resp [:headers "Cache-Control"]))
            "a bare URL could go stale, so it gets a short window")))

    (testing "a URL carrying the hash is immutable"
      (let [resp (rest-handler (user1-request :get (str "/api/v1/users/user1@example.com/avatar?v=" hash)))]
        (is (= "private, max-age=31536000, immutable" (get-in resp [:headers "Cache-Control"])))))

    (testing "a blank ?v= names no particular picture, so it is not immutable"
      (let [resp (rest-handler (user1-request :get "/api/v1/users/user1@example.com/avatar?v="))]
        (is (= "private, max-age=60" (get-in resp [:headers "Cache-Control"])))))

    (testing "a matching If-None-Match is a 304"
      (let [resp (rest-handler (-> (user1-request :get "/api/v1/users/user1@example.com/avatar")
                                   (assoc-in [:headers "if-none-match"] etag)))]
        (is (= 304 (:status resp)))))

    (testing "replacing the picture changes the hash"
      (let [new-hash (-> (upload user1-request "user1@example.com" (temp-image! 400 900 BufferedImage/TYPE_INT_RGB))
                         parse-response-body
                         :user/avatar-hash)]
        (is (not= hash new-hash))))))

(deftest authorization
  (testing "a user may not set someone else's picture"
    (let [resp (upload user1-request "user2@example.com" (temp-image! 300 300 BufferedImage/TYPE_INT_RGB))]
      (is (= 403 (:status resp)))))

  (testing "an admin may set anyone's, which is the only moderation lever"
    (let [resp (upload admin-request "user1@example.com" (temp-image! 300 300 BufferedImage/TYPE_INT_RGB))]
      (is (= 200 (:status resp)))))

  (testing "a user may not delete someone else's"
    (is (= 403 (:status (rest-handler (user2-request :delete "/api/v1/users/user1@example.com/avatar"))))))

  (testing "an admin may delete anyone's"
    (is (= 204 (:status (rest-handler (admin-request :delete "/api/v1/users/user1@example.com/avatar")))))))

(deftest delete-clears-both-the-bytes-and-the-hash
  (upload user1-request "user1@example.com" (temp-image! 600 600 BufferedImage/TYPE_INT_RGB))
  (is (= 204 (:status (rest-handler (user1-request :delete "/api/v1/users/user1@example.com/avatar")))))
  (is (= 404 (:status (rest-handler (user1-request :get "/api/v1/users/user1@example.com/avatar")))))
  (is (nil? (:user/avatar-hash (parse-response-body
                                (rest-handler (user1-request :get "/api/v1/users/user1@example.com"))))))
  (testing "deleting again is a 404, not a silent success"
    (is (= 404 (:status (rest-handler (user1-request :delete "/api/v1/users/user1@example.com/avatar")))))))

(deftest get-on-a-user-without-a-picture-is-404
  (is (= 404 (:status (rest-handler (user1-request :get "/api/v1/users/user1@example.com/avatar"))))))

(deftest rejects-what-it-cannot-store
  (testing "a file that is not an image at all"
    (let [resp (upload user1-request "user1@example.com" (temp-file-with! "this is not an image"))]
      (is (= 415 (:status resp)))))

  (testing "an image past the upload cap"
    ;; 0 MB makes every upload oversized, which is the cheapest way to prove
    ;; the cap is consulted without writing a multi-megabyte fixture.
    (with-redefs [config/config {:plaid.media/config {:avatar-max-upload-mb 0}}]
      (let [resp (upload user1-request "user1@example.com" (temp-image! 300 300 BufferedImage/TYPE_INT_RGB))]
        (is (= 413 (:status resp))))))

  (testing "no file in the request"
    (let [resp (rest-handler (user1-request :put "/api/v1/users/user1@example.com/avatar"))]
      (is (= 400 (:status resp)))))

  (testing "a picture for a user who does not exist"
    (let [resp (upload admin-request "nobody@example.com" (temp-image! 300 300 BufferedImage/TYPE_INT_RGB))]
      (is (= 404 (:status resp))))))

(deftest audit-records-the-change-but-not-the-pixels
  (upload user1-request "user1@example.com" (temp-image! 600 600 BufferedImage/TYPE_INT_RGB))
  (let [rows (psc/q db {:select [:target_table :change_type :post_image]
                        :from :audit_writes
                        :where [:= :target_id "user1@example.com"]})
        images (map :post_image rows)]
    (is (seq rows) "setting a picture is an audited change to the user row")
    (is (every? #(= "users" (:target_table %)) rows)
        "user_avatars is written outside the audited helpers on purpose")
    (is (some #(re-find #"avatar_hash" (str %)) images)
        "the hash is in the audit image, so the change is visible in history")
    (is (every? #(< (count (str %)) 2000) images)
        "the image is a user row plus a 64-char digest, never a copy of the picture")))
