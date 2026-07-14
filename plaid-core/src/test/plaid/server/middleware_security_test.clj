(ns plaid.server.middleware-security-test
  (:require [clojure.test :refer [deftest is]]
            [plaid.server.config :as config]
            [plaid.server.middleware :as middleware])
  (:import [java.nio.file FileVisitOption Files Path]
           [java.nio.file.attribute FileAttribute]))

(defn- delete-tree! [^Path root]
  (when (Files/exists root (make-array java.nio.file.LinkOption 0))
    (with-open [paths (Files/walk root (make-array FileVisitOption 0))]
      (doseq [^Path path (reverse (vec (.toList paths)))]
        (Files/deleteIfExists path)))))

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
