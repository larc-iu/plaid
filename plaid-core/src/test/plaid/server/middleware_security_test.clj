(ns plaid.server.middleware-security-test
  (:require [clojure.test :refer [deftest is]]
            [plaid.test-helpers :refer [delete-tree!]]
            [plaid.server.config :as config]
            [plaid.server.middleware :as middleware]
            [ring.middleware.defaults :refer [wrap-defaults]])
  (:import [java.nio.file FileVisitOption Files Path]
           [java.nio.file.attribute FileAttribute]))

(deftest static-resources-rejects-canonical-sibling
  (let [tmp (Files/createTempDirectory "plaid-static-test-" (make-array FileAttribute 0))
        root (.resolve tmp "www")
        sibling (.resolve tmp "www-secret")]
    (try
      (Files/createDirectories root (make-array FileAttribute 0))
      (Files/createDirectories sibling (make-array FileAttribute 0))
      (Files/writeString (.resolve root "public.txt") "public"
                         (make-array java.nio.file.OpenOption 0))
      (Files/writeString (.resolve sibling "secret.txt") "secret"
                         (make-array java.nio.file.OpenOption 0))
      (with-redefs [config/config {:plaid.server.middleware/static-resources-path
                                   (.toString root)}]
        (let [handler (middleware/wrap-static-resources
                       (constantly {:status 418 :body "fallback"}))]
          (is (= 200 (:status (handler {:request-method :get
                                        :uri "/public.txt"}))))
          (is (= 418 (:status (handler {:request-method :get
                                        :uri "/../www-secret/secret.txt"})))
              "A canonical sibling must not pass the static-root containment check")))
      (finally
        (delete-tree! tmp)))))

(deftest chunked-structured-bodies-require-content-length
  (let [handler (middleware/wrap-json-body-cap
                 (constantly {:status 204})
                 1024)]
    (is (= 411 (:status (handler {:headers {"content-type" "application/json"
                                            "transfer-encoding" "chunked"}}))))
    (is (= 204 (:status (handler {:headers {"content-type" "multipart/form-data; boundary=x"
                                            "transfer-encoding" "chunked"}})))
        "Multipart uploads continue to use the outer media-size cap")
    (is (= 204 (:status (handler {:headers {"content-type" "application/json"
                                            "content-length" "12"}}))))))

(deftest every-response-says-nosniff
  ;; SEC-1: a browser that sniffs may run as a page what was served as
  ;; something else. Every response through the server's defaults says
  ;; nosniff, and a static file keeps the type its extension names, which a
  ;; script or stylesheet needs to load under nosniff.
  (let [tmp (Files/createTempDirectory "plaid-nosniff-test-" (make-array FileAttribute 0))
        root (.resolve tmp "www")
        defaults (:ring.middleware/defaults-config (config/load-config! {:config-path nil :explicit? false}))]
    (try
      (Files/createDirectories root (make-array FileAttribute 0))
      (doseq [name ["app.js" "worker.mjs" "app.css" "ort.wasm"]]
        (Files/writeString (.resolve root name) "x" (make-array java.nio.file.OpenOption 0)))
      (with-redefs [config/config {:plaid.server.middleware/static-resources-path (.toString root)}]
        (let [handler (-> (constantly {:status 200 :headers {"Content-Type" "application/json"} :body "{}"})
                          middleware/wrap-static-resources
                          (wrap-defaults defaults))]
          (doseq [[uri type] [["/api/v1/anything" "application/json"]
                              ["/app.js" "text/javascript"]
                              ["/worker.mjs" "text/javascript"]
                              ["/app.css" "text/css"]
                              ["/ort.wasm" "application/wasm"]]]
            (let [res (handler {:request-method :get :uri uri :headers {}})]
              (is (= "nosniff" (get-in res [:headers "X-Content-Type-Options"])) uri)
              (is (= type (first (.split (str (get-in res [:headers "Content-Type"])) ";"))) uri)))))
      (finally
        (delete-tree! tmp)))))
