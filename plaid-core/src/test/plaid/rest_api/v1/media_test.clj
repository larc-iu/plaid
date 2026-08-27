(ns plaid.rest-api.v1.media-test
  (:require [clojure.test :refer [deftest is testing]]
            [plaid.rest-api.v1.media :as media])
  (:import [java.nio.charset StandardCharsets]
           [java.nio.file Files]
           [java.nio.file.attribute FileAttribute]))

(defn- body-string [response]
  (with-open [body (:body response)]
    (String. (.readAllBytes body) StandardCharsets/UTF_8)))

(deftest byte-range-responses-are-bounded
  (let [path (Files/createTempFile "plaid-range-" ".txt" (make-array FileAttribute 0))
        file (.toFile path)
        content "abcdefghij"]
    (try
      (Files/writeString path content (make-array java.nio.file.OpenOption 0))
      (testing "closed range"
        (let [response (media/stream-file-response file "text/plain" 10 "bytes=0-2")]
          (is (= 206 (:status response)))
          (is (= "3" (get-in response [:headers "Content-Length"])))
          (is (= "bytes 0-2/10" (get-in response [:headers "Content-Range"])))
          (is (= "private, max-age=3600" (get-in response [:headers "Cache-Control"])))
          (is (= "abc" (body-string response)))))
      (testing "open-ended range"
        (is (= "hij" (body-string
                      (media/stream-file-response file "text/plain" 10 "bytes=7-")))))
      (testing "read(byte[]) — the arity http-kit streams a body with"
        ;; Browsers always send `Range: bytes=0-`; the proxy stream used to
        ;; lack this arity and every ranged media request 500'd.
        (with-open [body (:body (media/stream-file-response file "text/plain" 10 "bytes=0-"))]
          (let [buf (byte-array 4)
                n (.read body buf)]
            (is (= 4 n))
            (is (= "abcd" (String. buf 0 n StandardCharsets/UTF_8)))
            (is (= 6 (.read body (byte-array 100))))
            (is (= -1 (.read body (byte-array 100)))))))
      (testing "suffix range"
        (is (= "ij" (body-string
                     (media/stream-file-response file "text/plain" 10 "bytes=-2")))))
      (testing "malformed and unsatisfiable ranges"
        (doseq [header ["garbage" "bytes=20-30" "bytes=4-2" "bytes=0-1,4-5" "bytes=-0"]]
          (let [response (media/stream-file-response file "text/plain" 10 header)]
            (is (= 416 (:status response)) header)
            (is (= "bytes */10" (get-in response [:headers "Content-Range"])) header))))
      (finally
        (Files/deleteIfExists path)))))
