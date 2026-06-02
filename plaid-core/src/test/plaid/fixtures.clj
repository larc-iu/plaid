(ns plaid.fixtures
  (:require [clojure.test :refer :all]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [plaid.sql.common :as psc]
            [plaid.sql.user :as pxu]
            [ring.middleware.defaults :refer [wrap-defaults]]
            [ring.mock.request :as mock]
            [taoensso.timbre :as log]
            [plaid.rest-api.v1.core :as rest]))

(log/set-min-level! :info)

;; Single shared SQLite datasource for all test namespaces — started once per JVM.
;; Using a file under java.io.tmpdir gives WAL mode + concurrent readers; an
;; in-memory database would force Hikari to a single connection (cache=shared
;; is fragile across JDBC pools).
(defonce ^:private shared-db-file
  (let [f (java.io.File/createTempFile "plaid-test-" ".db")]
    (.deleteOnExit f)
    (.delete f)
    (.getAbsolutePath f)))

(defonce ^:private shared-ds
  (let [ds (psc/build-datasource shared-db-file)]
    (migratus/migrate {:store :database
                       :migration-dir "migrations"
                       :db {:datasource ds}})
    ds))

(def ^:dynamic db nil)
(def ^:dynamic config nil)
(def ^:dynamic rest-handler nil)
(def ^:dynamic admin-token nil)
(def ^:dynamic user1-token nil)
(def ^:dynamic user2-token nil)

(defn with-rest-handler [f]
  (binding [rest-handler
            (-> (rest/rest-handler db "fake-secret")
                (wrap-defaults
                 {:params {:keywordize true
                           :multipart true
                           :nested true
                           :urlencoded true}
                  :cookies false
                  :responses {:absolute-redirects true
                              :content-types true
                              :default-charset "utf-8"
                              :not-modified-responses true}
                  :static {:resources "public"}
                  :session false
                  :security {:anti-forgery false
                             :hsts true
                             :ssl-redirect false
                             :frame-options :sameorigin
                             :xss-protection {:enable? true
                                              :mode :block}}}))]
    (f)))

(defn with-db [f]
  (binding [db shared-ds]
    (f)))

(defn with-mount-states
  "No-op in the SQL port: there's no coordinator to start. Kept as a fixture
  alias so test namespaces using the v2 fixture chain don't need to change."
  [f]
  (f))

;; ============================================================
;; Per-test DB reset (task #90)
;; ============================================================

(def ^:private preserved-test-users
  "Standing test users that survive the per-test TRUNCATE. The JWT tokens
  bound by `with-admin`/`with-test-users` (once-fixtures) carry these
  users' ids + a `:version` claim of 0 (password_changes never bumped),
  so preserving the rows keeps the tokens valid across deftests.

  Anything else in the users table is per-test scratch and gets wiped."
  #{"admin@example.com" "user1@example.com" "user2@example.com"})

;; Tables that must be cleared between tests, listed in FK-safe order
;; (children before parents). `schema_migrations` is INTENTIONALLY absent
;; — it tracks one-time migration state and must persist across tests.
;; `users` is handled separately so the standing test users survive.
(def ^:private tables-to-truncate
  ["audit_writes"
   "operations"
   ;; api_tokens: after operations (operations.token_id → api_tokens) and
   ;; before the users wipe below (api_tokens.user_id → users).
   "api_tokens"
   "entity_metadata"
   "vocab_link_tokens"
   "vocab_links"
   "vocab_items"
   "vocab_maintainers"
   "project_vocabs"
   "vocab_layers"
   "span_tokens"
   "spans"
   "relations"
   "relation_layers"
   "span_layers"
   "tokens"
   "token_layers"
   "texts"
   "text_layers"
   "documents"
   "project_users"
   "projects"])

(defn reset-db!
  "TRUNCATE-equivalent for SQLite: delete all rows from data tables in
  FK-safe order, preserving the standing test users (so JWT tokens
  remain valid) and the `schema_migrations` table.

  Single transaction so it's atomic (a half-truncated DB would leave a
  later test in an inconsistent state)."
  [ds]
  (jdbc/with-transaction [tx ds]
    (doseq [t tables-to-truncate]
      (jdbc/execute! tx [(str "DELETE FROM " t)]))
    ;; Wipe per-test users; keep the standing ones.
    (let [placeholders (clojure.string/join ", " (repeat (count preserved-test-users) "?"))
          sql (str "DELETE FROM users WHERE id NOT IN (" placeholders ")")]
      (jdbc/execute! tx (into [sql] preserved-test-users)))))

(defn- reset-in-memory-state!
  "Reset every in-process atom that survives between deftests inside a
  single JVM run. These atoms are not in the DB, so `reset-db!` alone
  won't clear them — a stuck lock or a tripped rate-limit bucket from
  one deftest would otherwise leak into the next (task #113).

  Uses `requiring-resolve` so each helper is optional: when the owning
  agent hasn't shipped its `reset-state!` yet, the fixture degrades to a
  no-op for that namespace rather than crashing the whole suite."
  []
  ;; Make sure the owning namespaces are loaded before we look up vars
  ;; — `requiring-resolve` does this for us but only if the ns symbol is
  ;; visible to the classloader; an explicit `require` keeps REPL re-runs
  ;; consistent.
  (try (require 'plaid.server.locks
                'plaid.server.events
                'plaid.rest-api.v1.rate-limit)
       (catch Exception _))
  ;; locks: Agent B will add a public `reset-state!` that wipes the
  ;; `^:private` locks atom. Until then, fall back to poking the var
  ;; directly so the regression test in this PR still passes.
  (if-let [reset (requiring-resolve 'plaid.server.locks/reset-state!)]
    (reset)
    (when-let [locks-var (resolve 'plaid.server.locks/locks)]
      (reset! @locks-var {})))
  ;; events: Agent B will add a public `reset-state!` that wipes the
  ;; client/heartbeat/channel atoms + the drop counter. The atoms come
  ;; from `defstate`, so when mount isn't started they're DerefableState
  ;; (not IAtom) and `swap!` would throw — skip in that case.
  (if-let [reset (requiring-resolve 'plaid.server.events/reset-state!)]
    (reset)
    (do
      (when-let [drop-var (resolve 'plaid.server.events/event-bus-drop-count)]
        (let [a @drop-var]
          (when (instance? clojure.lang.IAtom a) (reset! a 0))))
      (doseq [sym '[client-registry channel-mappings heartbeat-registry]]
        (when-let [v (resolve (symbol "plaid.server.events" (name sym)))]
          (let [a @v]
            (when (instance? clojure.lang.IAtom a) (reset! a {})))))))
  ;; rate-limit: `reset-all!` already exists (lines 108-112). Prefer the
  ;; conventional `reset-state!` name if Agent A renames/wraps it.
  (or (when-let [reset (requiring-resolve 'plaid.rest-api.v1.rate-limit/reset-state!)]
        (reset) :ok)
      (when-let [reset (requiring-resolve 'plaid.rest-api.v1.rate-limit/reset-all!)]
        (reset) :ok)))

(defn with-clean-db
  "Each-test fixture: reset the shared DB before every deftest so order-
  independence holds. Cheap (~tens of ms): scoped DELETEs, not file
  recreation, and Hikari + WAL stay warm.

  Also resets in-process state atoms (locks, rate-limit buckets, event
  registries) so test isolation isn't broken by stuck state — see
  `reset-in-memory-state!` and task #113."
  [f]
  (try
    (f)
    (finally
      (reset-db! shared-ds)
      (reset-in-memory-state!))))

(defn- ensure-user! [db email admin? password]
  (try
    (when-not (pxu/get-internal db email)
      (pxu/create db email admin? password))
    (catch clojure.lang.ExceptionInfo _)))

(defn with-admin [f]
  (ensure-user! db "admin@example.com" true "password")
  (let [req (rest-handler (-> (mock/request :post "/api/v1/login")
                              (mock/header "accept" "application/edn")
                              (mock/json-body {:user-id "admin@example.com"
                                               :password "password"})))]
    (binding [admin-token (-> req :body slurp read-string :token)]
      (f))))

(defn with-test-users [f]
  (ensure-user! db "user1@example.com" false "password1")
  (ensure-user! db "user2@example.com" false "password2")
  (let [user1-req (rest-handler (-> (mock/request :post "/api/v1/login")
                                    (mock/header "accept" "application/edn")
                                    (mock/json-body {:user-id "user1@example.com"
                                                     :password "password1"})))
        user2-req (rest-handler (-> (mock/request :post "/api/v1/login")
                                    (mock/header "accept" "application/edn")
                                    (mock/json-body {:user-id "user2@example.com"
                                                     :password "password2"})))]
    (binding [user1-token (-> user1-req :body slurp read-string :token)
              user2-token (-> user2-req :body slurp read-string :token)]
      (f))))

(defn admin-request [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")
      (mock/header "Authorization" (str "Bearer " admin-token))))

(defn user1-request [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")
      (mock/header "Authorization" (str "Bearer " user1-token))))

(defn user2-request [method path]
  (-> (mock/request method path)
      (mock/header "accept" "application/edn")
      (mock/header "Authorization" (str "Bearer " user2-token))))

;; API Testing Helper Functions
(defn parse-response-body
  "Parse the response body from EDN format"
  [response]
  (read-string (slurp (:body response))))

(defn api-call
  "Make an API call using a request map with :method, :path, and optional :body"
  [user-request-fn request-map]
  (let [{:keys [method path body]} request-map
        req (cond-> (user-request-fn method path)
              body (mock/json-body body))
        resp (rest-handler req)]
    {:status (:status resp)
     :headers (:headers resp)
     :body (when-let [response-body (:body resp)]
             (when-not (= response-body "")
               (parse-response-body resp)))}))

;; Assertion Helpers
(defn assert-status
  "Assert that response has expected status code"
  [expected-status response]
  (is (= expected-status (:status response))))

(defn assert-success
  "Assert that response has 2xx status code"
  [response]
  (is (< 199 (:status response) 300)))

(defn assert-created
  "Assert that response has 201 Created status"
  [response]
  (assert-status 201 response))

(defn assert-ok
  "Assert that response has 200 OK status"
  [response]
  (assert-status 200 response))

(defn assert-no-content
  "Assert that response has 204 No Content status"
  [response]
  (assert-status 204 response))

(defn assert-not-found
  "Assert that response has 404 Not Found status"
  [response]
  (assert-status 404 response))

(defn assert-forbidden
  "Assert that response has 403 Forbidden status"
  [response]
  (assert-status 403 response))

(defn assert-bad-request
  "Assert that response has 400 Bad Request status"
  [response]
  (assert-status 400 response))
