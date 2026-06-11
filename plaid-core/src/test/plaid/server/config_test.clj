(ns plaid.server.config-test
  "Config loading: the operator-facing TOML format translates onto the internal
   namespaced-keyword map, the bundled template supplies defaults, filesystem
   overlays merge on top, explicit-missing fails loudly, and the template stays
   in lock-step with the translation table (anti-drift)."
  (:require [clojure.java.io :as io]
            [clojure.test :refer :all]
            [plaid.server.config :as config])
  (:import (java.io File)))

;; Private helpers reached for direct testing.
(def ^:private deep-merge (deref #'config/deep-merge))
(def ^:private translate (deref #'config/translate))
(def ^:private unknown-keys (deref #'config/unknown-keys))
(def ^:private read-toml (deref #'config/read-toml))
(def ^:private parse-toml (deref #'config/parse-toml))

(defn- temp-toml ^File [content]
  (let [f (File/createTempFile "plaid-config-" ".toml")]
    (.deleteOnExit f)
    (spit f content)
    f))

(deftest defaults-load-from-bundled-template
  ;; No overlay: the bundled config.toml supplies every default, the
  ;; internal-only plumbing is merged underneath, and friendly values land at
  ;; their internal namespaced keys.
  (let [cfg (config/load-config! {:config-path nil :explicit? false})]
    (is (map? cfg))
    (is (= 8080 (get-in cfg [:org.httpkit.server/config :port])))
    (is (= 10 (get-in cfg [:plaid.server.http-server :max-json-body-mb])))
    (is (= 2592000 (get-in cfg [:plaid.auth :jwt-ttl-seconds])))
    (is (true? (get-in cfg [:plaid.api :expose-openapi?])))
    (is (= 200 (get-in cfg [:plaid.media/config :max-file-size-mb])))
    (is (= "data/plaid.db" (get-in cfg [:plaid.server.sql/config :main-db-path])))
    ;; internal-only plumbing present even though it's not in the TOML
    (is (contains? cfg :ring.middleware/defaults-config))
    (is (= [] (get-in cfg [:taoensso.timbre/logging-config :ns-whitelist])))))

(deftest keyword-and-vector-coercion
  ;; logging level + cors methods are keyword-valued internally but strings in
  ;; TOML; cors origins/headers stay string vectors.
  (let [cfg (config/load-config! {:config-path nil :explicit? false})]
    (is (= :info (get-in cfg [:taoensso.timbre/logging-config :min-level])))
    (is (= [:get :put :post :patch :delete :options]
           (get-in cfg [:plaid.server.middleware/cors-config :access-control-allow-methods])))
    (is (= [] (get-in cfg [:plaid.server.middleware/cors-config :access-control-allow-origin])))
    (is (= ["Authorization" "Content-Type"]
           (get-in cfg [:plaid.server.middleware/cors-config :access-control-allow-headers])))))

(deftest filesystem-overlay-merges
  (let [f (temp-toml "[server]\nport = 9999\n\n[logging]\nlevel = \"debug\"\n")]
    (try
      (let [cfg (config/load-config! {:config-path (.getAbsolutePath f) :explicit? true})]
        ;; overlay wins
        (is (= 9999 (get-in cfg [:org.httpkit.server/config :port])))
        (is (= :debug (get-in cfg [:taoensso.timbre/logging-config :min-level])))
        ;; un-overridden defaults intact
        (is (= 200 (get-in cfg [:plaid.media/config :max-file-size-mb])))
        (is (contains? cfg :ring.middleware/defaults-config)))
      (finally (.delete f)))))

(deftest advanced-pool-override-works
  ;; A normally-commented advanced key still translates when an operator
  ;; uncomments it.
  (let [f (temp-toml "[database]\nmax_pool_size = 20\njournal_mode = \"DELETE\"\n")]
    (try
      (let [cfg (config/load-config! {:config-path (.getAbsolutePath f) :explicit? true})]
        (is (= 20 (get-in cfg [:plaid.sql.common/pool :max-pool-size])))
        (is (= "DELETE" (get-in cfg [:plaid.sql.common/pool :journal-mode]))))
      (finally (.delete f)))))

(deftest missing-explicit-path-throws
  (let [bogus "/nonexistent/path/plaid-config-does-not-exist.toml"
        ex (try
             (config/load-config! {:config-path bogus :explicit? true})
             nil
             (catch clojure.lang.ExceptionInfo e e))]
    (is (some? ex) "Should throw, not return nil")
    (is (re-find #"not found" (.getMessage ex)))
    (is (re-find (re-pattern bogus) (.getMessage ex)))
    (is (= bogus (:config-path (ex-data ex))))))

(deftest missing-default-path-tolerated
  ;; A non-explicit (default) path that doesn't resolve degrades to defaults.
  (let [cfg (config/load-config! {:config-path "this-default-does-not-exist.toml"
                                  :explicit? false})]
    (is (map? cfg))
    (is (= 8080 (get-in cfg [:org.httpkit.server/config :port])))))

(deftest dev-overlay-restores-8085
  ;; The dev overlay (config.dev.toml, loaded by user/start) flips the port to
  ;; 8085, leaving everything else at the bundled defaults.
  (let [cfg (config/load-config! {:config-path "config.dev.toml" :explicit? true})]
    (is (= 8085 (get-in cfg [:org.httpkit.server/config :port])))
    (is (= :debug (get-in cfg [:taoensso.timbre/logging-config :min-level])))
    ;; un-overridden default still present
    (is (= 200 (get-in cfg [:plaid.media/config :max-file-size-mb])))))

(deftest malformed-toml-throws
  (let [f (temp-toml "this is = = not valid toml\n")]
    (try
      (is (thrown-with-msg? clojure.lang.ExceptionInfo #"TOML parse error"
                            (config/load-config! {:config-path (.getAbsolutePath f) :explicit? true})))
      (finally (.delete f)))))

(deftest unknown-keys-detection
  ;; Typo'd keys are surfaced (not silently dropped) so a misspelled setting
  ;; doesn't fail open.
  (is (= [["server" "prot"]] (unknown-keys {"server" {"prot" 8080}})))
  (is (empty? (unknown-keys {"server" {"port" 8080}}))))

(deftest template-has-no-unknown-keys
  ;; Anti-drift: every active key in the bundled template (and the dev overlay)
  ;; is recognized by the translation table. If someone adds a key to one
  ;; without the other, this fails.
  (doseq [resource ["config.toml" "config.dev.toml"]]
    (let [[content src] (read-toml resource)]
      (is (some? content) (str resource " must be on the classpath"))
      (is (empty? (unknown-keys (parse-toml content src)))
          (str resource " has keys the translation table doesn't recognize")))))

(deftest ensure-config-file-writes-then-noops
  (let [dir (File/createTempFile "plaid-cfgdir-" "")
        _ (.delete dir)
        target (File. dir "config.toml")
        path (.getAbsolutePath target)]
    (try
      (is (not (.exists target)))
      (config/ensure-config-file! path)
      (is (.exists target) "writes the template when absent")
      ;; content is the bundled template, verbatim (comments preserved)
      (let [written (slurp target)
            template (slurp (io/resource "config.toml"))]
        (is (= template written)))
      ;; operator edits survive a second call (no clobber)
      (spit target "[server]\nport = 1234\n")
      (config/ensure-config-file! path)
      (is (= "[server]\nport = 1234\n" (slurp target)) "no-op when file exists")
      (finally
        (.delete target)
        (.delete dir)))))

(deftest deep-merge-nil-overlay-returns-base
  (let [base {:a 1 :b {:c 2}}]
    (is (= base (deep-merge base nil))))
  (is (= {:a 1} (deep-merge {:a 1} nil)))
  (is (= {:a 1 :b {:c 2}} (deep-merge {:a 1 :b {:c 2}} {:b nil}))))
