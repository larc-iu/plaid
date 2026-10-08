(ns plaid.server.client-js-test
  "GET /client/plaid-client.js serves the JavaScript client, here from the
  working tree's plaid-client-js (the dev core's source). The jar's copy under
  resources/client/ is checked by the build's smoke test."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.server.middleware :as middleware]
            [ring.middleware.not-modified :refer [wrap-not-modified]]))

(def ^:private client-dir "../plaid-client-js")

(defn- body-str [{:keys [body]}]
  (when (some? body) (slurp body)))

(defn- with-client-handler [f]
  (let [prop middleware/client-js-dir-property
        before (System/getProperty prop)]
    (System/setProperty prop client-dir)
    (try
      (f (middleware/wrap-client-js (constantly {:status 404 :body "fallthrough"})))
      (finally
        (if before
          (System/setProperty prop before)
          (System/clearProperty prop))))))

(defn- get-uri [handler uri]
  (handler {:request-method :get :uri uri}))

(deftest serves-the-entry-module
  (with-client-handler
    (fn [handler]
      (let [r (get-uri handler "/client/plaid-client.js")]
        (is (= 200 (:status r)))
        (is (= "text/javascript; charset=utf-8" (get-in r [:headers "Content-Type"]))
            "a module script needs a JavaScript type or the browser refuses it")
        (is (= "no-cache" (get-in r [:headers "Cache-Control"])))
        (is (= (slurp (io/file client-dir "src/index.js")) (body-str r))
            "the entry is the package's src/index.js as it is"))
      (let [r (get-uri handler "/client/plaid-client.d.ts")]
        (is (= 200 (:status r)))
        (is (= "text/plain; charset=utf-8" (get-in r [:headers "Content-Type"])))
        (is (= (slurp (io/file client-dir "index.d.ts")) (body-str r)))))))

(deftest every-relative-import-resolves
  (testing "each module a client module imports is served beside the entry"
    (with-client-handler
      (fn [handler]
        (let [srcs (->> (.listFiles (io/file client-dir "src"))
                        (filter #(str/ends-with? (.getName ^java.io.File %) ".js")))
              imported (->> srcs
                            (mapcat #(re-seq #"from\s+[\"']\./([^\"']+)[\"']" (slurp %)))
                            (map second)
                            set)]
          (is (seq imported))
          (doseq [m imported]
            (is (not= "index.js" m) "no module imports the entry by its file name")
            (is (= 200 (:status (get-uri handler (str "/client/" m))))
                (str "/client/" m " must serve, the entry imports it"))))))))

(deftest only-client-files-are-served
  (with-client-handler
    (fn [handler]
      (doseq [uri ["/client/index.js"
                   "/client/package.json"
                   "/client/../deps.edn"
                   "/client/..%2Fpackage.js"
                   "/client/src/index.js"
                   "/client/test/client.test.js"
                   "/client/nope.js"
                   "/client/"
                   "/client"]]
        (is (= "fallthrough" (:body (get-uri handler uri))) uri))
      (is (= "fallthrough" (:body (handler {:request-method :post
                                            :uri "/client/plaid-client.js"})))))))

(deftest revalidates-by-content
  (testing "a browser holding the same bytes gets a 304, whatever the dates say"
    (with-client-handler
      (fn [handler]
        (let [h (wrap-not-modified handler)
              r (h {:request-method :get :uri "/client/http.js"})
              etag (get-in r [:headers "ETag"])]
          (is (re-matches #"\"[0-9a-f]{64}\"" etag))
          (is (nil? (get-in r [:headers "Last-Modified"]))
              "a jar answers with its file date, so a rollback would look unmodified")
          (is (= 304 (:status (h {:request-method :get :uri "/client/http.js"
                                  :headers {"if-none-match" etag}}))))
          (is (= 200 (:status (h {:request-method :get :uri "/client/http.js"
                                  :headers {"if-none-match" "\"other\""}}))))
          (is (not= etag (get-in (h {:request-method :get :uri "/client/ids.js"})
                                 [:headers "ETag"]))))))))

(deftest revalidates-a-star-a-weak-tag-and-a-list
  ;; If-None-Match compares weakly, and `*` matches any current copy (H9-ACL
  ;; notes). Both answered 200 before.
  (with-client-handler
    (fn [handler]
      (let [etag (get-in (get-uri handler "/client/http.js") [:headers "ETag"])
            status (fn [inm] (:status (handler {:request-method :get :uri "/client/http.js"
                                                :headers {"if-none-match" inm}})))]
        (is (= 304 (status "*")))
        (is (= 304 (status (str "W/" etag))))
        (is (= 304 (status (str "\"other\", W/" etag))))
        (is (= 304 (status etag)))
        (is (= 200 (status "W/\"other\"")))
        (let [r (handler {:request-method :get :uri "/client/http.js"
                          :headers {"if-none-match" "*"}})]
          (is (= etag (get-in r [:headers "ETag"])))
          (is (nil? (:body r))))
        (testing "a miss still falls through, whatever the header"
          (is (= 404 (:status (handler {:request-method :get :uri "/client/nope.js"
                                        :headers {"if-none-match" "*"}})))))))))

(deftest head-answers-the-headers
  (with-client-handler
    (fn [handler]
      (let [g (get-uri handler "/client/plaid-client.js")
            r (handler {:request-method :head :uri "/client/plaid-client.js"})]
        (is (= 200 (:status r)))
        (is (nil? (:body r)))
        (is (= (:headers g) (:headers r)))))))
