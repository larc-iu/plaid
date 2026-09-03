(ns plaid.server.gzip-test
  (:require [clojure.test :refer [deftest is testing]]
            [clojure.java.io :as io]
            [plaid.server.middleware :as mw])
  (:import [java.io ByteArrayInputStream ByteArrayOutputStream]
           [java.util.zip GZIPInputStream]))

(def ^:private json-body (str "{\"items\": [" (apply str (repeat 500 "\"abcdefgh\",")) "1]}"))

(defn- gunzip [^bytes b]
  (with-open [in (GZIPInputStream. (ByteArrayInputStream. b))
              out (ByteArrayOutputStream.)]
    (io/copy in out)
    (String. (.toByteArray out) "UTF-8")))

(defn- app [resp] (mw/wrap-gzip-response (fn [_] resp)))
(def ^:private accepting {:headers {"accept-encoding" "gzip, deflate, br"}})

(deftest gzips-json-for-a-client-that-accepts-it
  (let [resp ((app {:status 200 :headers {"Content-Type" "application/json"} :body json-body}) accepting)]
    (is (= "gzip" (get-in resp [:headers "Content-Encoding"])))
    (is (= "Accept-Encoding" (get-in resp [:headers "Vary"])))
    (is (= json-body (gunzip (:body resp))))
    (testing "an InputStream body too, and Content-Length is dropped"
      (let [resp ((app {:status 200
                        :headers {"Content-Type" "application/json; charset=utf-8"
                                  "Content-Length" (str (count json-body))}
                        :body (ByteArrayInputStream. (.getBytes json-body "UTF-8"))})
                  accepting)]
        (is (= "gzip" (get-in resp [:headers "Content-Encoding"])))
        (is (nil? (get-in resp [:headers "Content-Length"])))
        (is (= json-body (gunzip (:body resp))))))))

(deftest leaves-everything-else-alone
  (let [untouched (fn [req resp] (is (= resp ((app resp) req))))]
    (untouched {:headers {}} {:status 200 :headers {"Content-Type" "application/json"} :body json-body})
    (untouched accepting {:status 200 :headers {"Content-Type" "audio/mpeg"} :body json-body})
    (untouched accepting {:status 200 :headers {"Content-Type" "text/event-stream"} :body json-body})
    (untouched accepting {:status 206 :headers {"Content-Type" "application/json" "Content-Range" "bytes 0-1/2"} :body json-body})
    (untouched accepting {:status 304 :headers {"Content-Type" "application/json"} :body nil})
    (untouched accepting {:status 200 :headers {"Content-Type" "application/json"} :body "{}"})
    (untouched accepting {:status 200 :headers {"Content-Type" "application/json" "Content-Encoding" "br"} :body json-body})))
