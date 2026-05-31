(ns plaid.server.config-test
  "Regression for #8: --config with a filesystem path must work, and an
   explicitly-passed path that resolves to nothing must fail loudly instead of
   silently producing a nil config that NPEs later."
  (:require [clojure.java.io :as io]
            [clojure.test :refer :all]
            [plaid.server.config :as config])
  (:import (java.io File)))

;; deep-merge is private; reach it for direct nil-safety testing.
(def ^:private deep-merge #'config/deep-merge)

(defn- temp-edn ^File [content]
  (let [f (File/createTempFile "plaid-config-" ".edn")]
    (.deleteOnExit f)
    (spit f content)
    f))

(deftest classpath-resource-still-loads
  ;; config/defaults.edn ships on the classpath; the no-arg/default path must
  ;; keep loading exactly as before.
  (let [cfg (config/load-config! {:config-path "config/dev.edn" :explicit? false})]
    (is (map? cfg))
    (is (contains? cfg :org.httpkit.server/config))
    (is (integer? (get-in cfg [:org.httpkit.server/config :port])))))

(deftest absolute-filesystem-path-loads
  (let [f (temp-edn (pr-str {:org.httpkit.server/config {:port 9999}
                             :my.test/marker :present}))]
    (try
      (let [cfg (config/load-config! {:config-path (.getAbsolutePath f) :explicit? true})]
        (is (map? cfg))
        ;; overlay merged on top of defaults
        (is (= 9999 (get-in cfg [:org.httpkit.server/config :port])))
        (is (= :present (:my.test/marker cfg))))
      (finally (.delete f)))))

(deftest missing-explicit-path-throws
  (let [bogus "/nonexistent/path/to/plaid-config-does-not-exist.edn"]
    (let [ex (try
               (config/load-config! {:config-path bogus :explicit? true})
               nil
               (catch clojure.lang.ExceptionInfo e e))]
      (is (some? ex) "Should throw, not return nil")
      (is (instance? clojure.lang.ExceptionInfo ex))
      (is (re-find #"not found" (.getMessage ex)))
      (is (re-find (re-pattern bogus) (.getMessage ex))
          "Error message should name the offending path")
      (is (= bogus (:config-path (ex-data ex)))))))

(deftest missing-default-path-tolerated
  ;; A non-explicit (default) path that doesn't resolve degrades to defaults
  ;; rather than throwing, preserving prior behavior.
  (let [cfg (config/load-config! {:config-path "config/this-default-does-not-exist.edn"
                                  :explicit? false})]
    (is (map? cfg))
    (is (contains? cfg :org.httpkit.server/config))))

(deftest deep-merge-nil-overlay-returns-base
  (let [base {:a 1 :b {:c 2}}]
    (is (= base (deep-merge base nil))))
  (is (= {:a 1} (deep-merge {:a 1} nil)))
  ;; nested nil overlay leaves the base subtree intact
  (is (= {:a 1 :b {:c 2}} (deep-merge {:a 1 :b {:c 2}} {:b nil}))))
