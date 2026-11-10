(ns plaid.rest-api.v1.media-test
  (:require [clojure.test :refer [deftest is testing]]
            [org.httpkit.server :as http-kit]
            [plaid.rest-api.v1.media :as media])
  (:import [java.lang.management BufferPoolMXBean ManagementFactory]
           [java.net URI]
           [java.net.http HttpClient HttpRequest HttpResponse$BodyHandlers]
           [java.nio ByteBuffer]
           [java.nio.charset StandardCharsets]
           [java.nio.file Files]
           [java.nio.file.attribute FileAttribute]
           [java.util Arrays Random]))

(defn- body-bytes ^bytes [response]
  (let [^ByteBuffer body (.duplicate ^ByteBuffer (:body response))
        out (byte-array (.remaining body))]
    (.get body out)
    out))

(defn- body-string [response]
  (String. (body-bytes response) StandardCharsets/UTF_8))

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
          (is (= "abc" (body-string response)))))
      (testing "open-ended range"
        (is (= "hij" (body-string
                      (media/stream-file-response file "text/plain" 10 "bytes=7-")))))
      (testing "bytes=0-, what browsers send"
        (is (= "abcdefghij" (body-string
                             (media/stream-file-response file "text/plain" 10 "bytes=0-")))))
      (testing "no range"
        (let [response (media/stream-file-response file "text/plain" 10 nil)]
          (is (= 200 (:status response)))
          (is (= "10" (get-in response [:headers "Content-Length"])))
          (is (= "abcdefghij" (body-string response)))))
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

(defn- direct-pool ^BufferPoolMXBean []
  (some #(when (= "direct" (.getName ^BufferPoolMXBean %)) %)
        (ManagementFactory/getPlatformMXBeans BufferPoolMXBean)))

(deftest serving-a-file-copies-none-of-it
  ;; A body http-kit read whole (an InputStream) cost the file's size in heap,
  ;; and NIO copied that into a direct buffer of the same size again to write
  ;; it, which a burst of recordings opened at once exhausted. The body is the
  ;; file mapped read-only, which is written from the page cache as it is.
  (let [size (* 24 1024 1024)
        content (let [b (byte-array size)] (.nextBytes (Random. 7) b) b)
        path (Files/createTempFile "plaid-serve-" ".wav" (make-array FileAttribute 0))
        file (.toFile path)
        stop (http-kit/run-server
              (fn [req] (media/stream-file-response file "audio/wav" size (get-in req [:headers "range"])))
              {:ip "127.0.0.1" :port 0 :legacy-return-value? true})
        port (:local-port (meta stop))
        client (HttpClient/newHttpClient)
        fetch (fn [range]
                (.send client
                       (cond-> (HttpRequest/newBuilder (URI. (str "http://127.0.0.1:" port "/m")))
                         range (.header "Range" range)
                         true (.build))
                       (HttpResponse$BodyHandlers/ofByteArray)))
        pool (direct-pool)
        peak (atom (.getMemoryUsed pool))
        base @peak
        sampling (atom true)
        sampler (future (while @sampling
                          (swap! peak max (.getMemoryUsed pool))
                          (Thread/sleep 1)))]
    (try
      (Files/write path content (make-array java.nio.file.OpenOption 0))
      (testing "the bytes, whole and in ranges"
        (let [r (fetch nil)]
          (is (= 200 (.statusCode r)))
          (is (Arrays/equals content ^bytes (.body r))))
        (let [r (fetch "bytes=0-99")]
          (is (= 206 (.statusCode r)))
          (is (Arrays/equals (Arrays/copyOfRange content 0 100) ^bytes (.body r))))
        (let [r (fetch (str "bytes=" (quot size 2) "-"))]
          (is (= 206 (.statusCode r)))
          (is (= (str "bytes " (quot size 2) "-" (dec size) "/" size)
                 (.orElse (.firstValue (.headers r) "content-range") nil)))
          (is (Arrays/equals (Arrays/copyOfRange content (quot size 2) size) ^bytes (.body r)))))
      (testing "no direct buffer the size of the file"
        (reset! sampling false)
        @sampler
        (is (< (- @peak base) (quot size 4))
            (str "direct buffer memory grew by " (- @peak base) " bytes serving " size)))
      (finally
        (reset! sampling false)
        (stop)
        (Files/deleteIfExists path)))))
