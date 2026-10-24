(ns e2e
  "`bb e2e`: each app's Playwright suite on a core of its own.

  Per suite: a plaid-core from this checkout's source on a free port with a
  fresh database, an API token minted on it for a@b.com, the app's Vite dev
  server on another free port with its /api proxy sent to that core, then
  Playwright, one worker. The specs and fixture builders read the core from
  PLAID_CORE_URL and the token from PLAID_E2E_TOKEN (plaid-ui/e2e/appFixtures.js),
  so nothing reaches the shared dev core on :8085 or the app's `.token`.

  Each run gets a directory of its own (under PLAID_E2E_DIR when set, else the
  system temp dir) holding the core's, Vite's and Playwright's logs and the
  Playwright output, kept afterwards. What it removes at the end is only what
  it made in this run: the database directory and the Vite dependency cache."
  (:require [babashka.fs :as fs]
            [babashka.http-client :as http]
            [babashka.process :as p]
            [cheshire.core :as json]
            [clojure.string :as str]
            [pipeline :as pl]))

(def ^:private apps ["igt" "ud" "umr"])

;; The admin the specs sign in as (`signInAdmin`), made by the core at its
;; first boot from PLAID_ADMIN_EMAIL and PLAID_ADMIN_PASSWORD.
(def ^:private admin {:email "a@b.com" :password "password"})

(def ^:private core-boot-seconds 600)

(defn- free-port []
  (with-open [s (java.net.ServerSocket. 0)]
    (.getLocalPort s)))

(defn- config-toml [port db-dir]
  (str "[server]\nport = " port "\n\n"
       "[logging]\nlevel = \"info\"\nlibrary_level = \"warn\"\n\n"
       "[database]\npath = \"" (fs/path db-dir "plaid.db") "\"\n\n"
       "[backup]\nenabled = false\n"))

(defn- login [core]
  (try
    (let [r (http/post (str core "/api/v1/login")
                       {:headers {"content-type" "application/json"}
                        :version :http1.1 :timeout 10000
                        :body (json/generate-string {"user-id" (:email admin) "password" (:password admin)})
                        :throw false})]
      (when (= 200 (:status r))
        (get (json/parse-string (:body r)) "token")))
    (catch Exception _ nil)))

(defn- wait-for-core! [core proc]
  (let [deadline (+ (System/currentTimeMillis) (* 1000 core-boot-seconds))]
    (loop []
      (cond
        (not (p/alive? proc)) (throw (ex-info "plaid-core exited before it answered a login" {}))
        (> (System/currentTimeMillis) deadline) (throw (ex-info (str "plaid-core did not answer a login in " core-boot-seconds " s") {}))
        :else (or (login core) (do (Thread/sleep 2000) (recur)))))))

;; The named API token the specs use, as `.token` holds one on the dev core.
(defn- mint-token! [core session]
  (let [r (http/post (str core "/api/v1/users/" (:email admin) "/tokens")
                     {:headers {"content-type" "application/json"
                                "authorization" (str "Bearer " session)}
                      :version :http1.1 :timeout 10000
                      :body (json/generate-string {"name" "e2e"})
                      :throw false})]
    (when-not (<= 200 (:status r) 299)
      (throw (ex-info (str "minting the e2e token answered " (:status r) ": " (:body r)) {})))
    (get (json/parse-string (:body r)) "token")))

(defn- wait-for-vite! [url proc]
  (loop [i 0]
    (cond
      (not (p/alive? proc)) (throw (ex-info "Vite exited before it answered" {}))
      (>= i 120) (throw (ex-info (str "Vite did not answer at " url " in 120 s") {}))
      ;; HTTP/1.1: Java's client asks a cleartext server to upgrade to h2c,
      ;; and Vite holds every upgrade request open for its HMR socket.
      :else (when-not (try (= 200 (:status (http/get url {:throw false :version :http1.1 :timeout 5000})))
                           (catch Exception _ false))
              (Thread/sleep 1000)
              (recur (inc i))))))

(defn- stop! [proc]
  (when (and proc (p/alive? proc))
    (p/destroy-tree proc)
    (when (= ::timeout (deref proc 30000 ::timeout))
      (.destroyForcibly ^Process (:proc proc)))))

(defn- run-root []
  (let [dir (System/getenv "PLAID_E2E_DIR")]
    (when (not-empty dir) (fs/create-dirs dir) dir)))

(defn- python-env
  "PLAID_AGENT_PYTHON for the spec that starts the real igt assistant: the
  pipeline's one interpreter. Without one that spec skips and says why."
  []
  (try {"PLAID_AGENT_PYTHON" (pl/python-exe)} (catch Exception _ {})))

(defn- run-suite!
  "One app's suite. Answers {:app :exit :dir}."
  [app pw-args]
  (let [app-dir  (str "plaid-" app)
        run-dir  (str (fs/create-temp-dir (cond-> {:prefix (str "plaid-e2e-" app "-")}
                                            (run-root) (assoc :dir (run-root)))))
        db-dir   (str (fs/create-dirs (fs/path run-dir "db")))
        cport    (free-port)
        vport    (free-port)
        core     (str "http://127.0.0.1:" cport)
        base     (str "http://localhost:" vport)
        cache    (str (fs/absolutize (fs/path app-dir "node_modules" (str ".vite-e2e-" (fs/file-name run-dir)))))
        cfg      (str (fs/path db-dir "config.toml"))
        log      (fn [n] (fs/file run-dir n))
        core-p   (atom nil)
        vite-p   (atom nil)]
    (pl/step (str "e2e " app ": core on " cport ", Vite on " vport ", logs in " run-dir))
    (spit cfg (config-toml cport db-dir))
    (try
      (reset! core-p (p/process ["clojure" "-J-Xmx4g"
                                 "-J--add-opens=java.base/java.nio=ALL-UNNAMED"
                                 "-J--enable-native-access=ALL-UNNAMED"
                                 "-M" "-m" "plaid.server.main" "--config" cfg]
                                {:dir "plaid-core"
                                 :extra-env {"PLAID_ADMIN_EMAIL" (:email admin)
                                             "PLAID_ADMIN_PASSWORD" (:password admin)}
                                 :out (log "core.log") :err :out}))
      (let [session (wait-for-core! core @core-p)
            token   (mint-token! core session)
            env     (merge {"PLAID_CORE_URL" core
                            "PLAID_E2E_PRIVATE_CORE" core
                            "PLAID_E2E_TOKEN" token
                            "PLAYWRIGHT_BASE_URL" base}
                           (python-env))]
        (println "  core up, token minted")
        (reset! vite-p (p/process ["node" "node_modules/vite/bin/vite.js"
                                   "--config" "../plaid-ui/e2e/vite.e2e.config.js"
                                   "--port" (str vport) "--strictPort"]
                                  {:dir app-dir
                                   :extra-env (assoc env "PLAID_E2E_VITE_CACHE" cache)
                                   :out (log "vite.log") :err :out}))
        (wait-for-vite! base @vite-p)
        (println "  Vite up, running Playwright")
        (let [r (apply p/shell {:dir app-dir :continue true :extra-env env}
                       (concat ["node" "node_modules/@playwright/test/cli.js" "test"
                                (str "--output=" (fs/path run-dir "playwright"))
                                "--trace=off" "--reporter=list" "--workers=1"]
                               pw-args))]
          {:app app :exit (:exit r) :dir run-dir}))
      (catch Exception e
        (binding [*out* *err*]
          (println (str "✗ e2e " app ": " (ex-message e) " (see " run-dir ")")))
        {:app app :exit 1 :dir run-dir})
      (finally
        (stop! @vite-p)
        (stop! @core-p)
        (pl/rm-rf db-dir)
        (pl/rm-rf cache)))))

(defn run-e2e!
  "Usage: bb e2e [igt|ud|umr ...] [-- <playwright args>]. With no app it runs
  all three, one after another."
  [args]
  (pl/ensure-repo-root!)
  (pl/ensure-node!)
  (when-not (fs/which "clojure")
    (pl/fail "clojure not found on PATH: each suite boots a plaid-core from source"))
  (let [[mine more] (split-with #(not= "--" %) args)
        pw-args     (rest more)
        chosen      (if (seq mine) (vec mine) apps)]
    (doseq [a chosen]
      (when-not (some #{a} apps)
        (pl/fail (str "unknown app '" a "': use " (str/join ", " apps))))
      (doseq [f ["node_modules/@playwright/test/cli.js" "node_modules/vite/bin/vite.js"]]
        (when-not (fs/exists? (fs/path (str "plaid-" a) f))
          (pl/fail (str "plaid-" a "/" f " is missing: install the app first (`npm ci` there)")))))
    (let [results (mapv #(run-suite! % pw-args) chosen)]
      (pl/step "e2e summary")
      (doseq [{:keys [app exit dir]} results]
        (println (str "  " (if (zero? exit) "✓" "✗") " " app "  (" dir ")")))
      (when (some (comp pos? :exit) results)
        (System/exit 1)))))
