(ns plaid.server.app-csp-test
  "The apps' own pages (each bundled app's index.html and the landing page at /)
  carry a Content-Security-Policy, so a script injected into one cannot run.
  Nothing else the server answers carries it: an app's scripts, styles and
  workers, the API, and the JavaScript client. The setting [server]
  content_security_policy turns it to report-only or off."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [ring.util.response :as response]
            [plaid.server.config :as config]
            [plaid.server.middleware :as middleware])
  (:import (java.io File)))

(def ^:private bundled
  "What the classpath holds for these tests: one app's index.html and a script."
  {"igt/index.html" "<!doctype html><title>Plaid IGT</title>"
   "igt/assets/index-abc.js" "export {};"
   "ud/index.html" "<!doctype html><title>Plaid UD</title>"})

(defn- fake-resource-response [path]
  (when-let [body (get bundled path)]
    {:status 200 :headers {} :body body}))

(defn- app-handler
  "The page-serving part of the middleware stack, with `mode` as the setting,
  over an inner handler that stands for the API and everything else."
  [mode]
  (-> (fn [{:keys [uri]}]
        {:status 200 :headers {"Content-Type" "application/json"} :body (str "{\"uri\":\"" uri "\"}")})
      (middleware/wrap-root-landing mode)
      (middleware/wrap-bundled-spa mode)))

(defn- get-uri [handler uri]
  (with-redefs [response/resource-response fake-resource-response]
    (handler {:request-method :get :uri uri})))

(def ^:private enforce "Content-Security-Policy")
(def ^:private report-only "Content-Security-Policy-Report-Only")

(defn- csp-headers [r]
  (select-keys (:headers r) [enforce report-only]))

(deftest the-policy-forbids-inline-and-remote-script
  (let [p middleware/app-content-security-policy
        directive (fn [n] (some #(when (str/starts-with? % (str n " ")) %)
                                (map str/trim (str/split p #";"))))]
    (is (= "script-src 'self'" (directive "script-src"))
        "no 'unsafe-inline', no 'unsafe-eval', no host")
    (is (= "object-src 'none'" (directive "object-src")))
    (is (= "base-uri 'self'" (directive "base-uri")))
    (is (= "frame-ancestors 'none'" (directive "frame-ancestors")))
    (is (= "default-src 'self'" (directive "default-src")))))

(deftest the-apps-pages-carry-the-policy
  (let [h (app-handler :enforce)]
    (doseq [uri ["/igt" "/igt/" "/igt/index.html" "/ud/" "/"]]
      (let [r (get-uri h uri)]
        (is (= 200 (:status r)) uri)
        (is (= {enforce middleware/app-content-security-policy} (csp-headers r)) uri)))))

(deftest nothing-else-carries-it
  (let [h (app-handler :enforce)]
    (testing "an app's script, and a file the app does not have"
      (is (= {} (csp-headers (get-uri h "/igt/assets/index-abc.js"))))
      (is (= {} (csp-headers (get-uri h "/igt/assets/missing.js")))))
    (testing "the API and anything else the inner handlers answer"
      (doseq [uri ["/api/v1/projects" "/api/v1/media/x" "/plaid.svg" "/elsewhere"]]
        (let [r (get-uri h uri)]
          (is (= {} (csp-headers r)) uri))))))

(deftest report-only-and-off
  (testing "report-only sends the same policy under the report-only name"
    (let [h (app-handler :report-only)]
      (doseq [uri ["/igt/" "/"]]
        (is (= {report-only middleware/app-content-security-policy}
               (csp-headers (get-uri h uri)))
            uri))))
  (testing "off sends neither"
    (let [h (app-handler :off)]
      (doseq [uri ["/igt/" "/"]]
        (is (= {} (csp-headers (get-uri h uri))) uri)))))

(defn- temp-toml ^File [content]
  (let [f (File/createTempFile "plaid-config-" ".toml")]
    (.deleteOnExit f)
    (spit f content)
    f))

(deftest the-setting
  (testing "enforce by default"
    (is (= :enforce (:plaid.server.middleware/content-security-policy
                     (config/load-config! {:config-path nil :explicit? false})))))
  (testing "each value"
    (doseq [[v mode] [["enforce" :enforce] ["report-only" :report-only] ["off" :off]]]
      (let [f (temp-toml (str "[server]\ncontent_security_policy = \"" v "\"\n"))]
        (try
          (is (= mode (:plaid.server.middleware/content-security-policy
                       (config/load-config! {:config-path (.getAbsolutePath f) :explicit? true}))))
          (finally (.delete f))))))
  (testing "anything else refuses to load"
    (doseq [v ["\"on\"" "true" "\"\""]]
      (let [f (temp-toml (str "[server]\ncontent_security_policy = " v "\n"))]
        (try
          (is (thrown-with-msg? clojure.lang.ExceptionInfo
                                #"\[server\] content_security_policy must be \"enforce\", \"report-only\" or \"off\""
                                (config/load-config! {:config-path (.getAbsolutePath f) :explicit? true}))
              v)
          (finally (.delete f)))))))
