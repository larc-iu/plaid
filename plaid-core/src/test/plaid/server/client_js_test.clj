(ns plaid.server.client-js-test
  "GET /client/plaid-client.js serves the JavaScript client, here from the
  working tree's plaid-client-js (the dev core's source). The jar's copy under
  resources/client/ is checked by the build's smoke test."
  (:require [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.server.middleware :as middleware]))

(def ^:private client-dir "../plaid-client-js")

(defn- body-str [{:keys [body]}]
  (cond
    (instance? java.io.File body) (slurp body)
    (string? body) body
    (some? body) (slurp body)))

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
