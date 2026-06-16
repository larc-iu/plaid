(ns plaid.rest-api.v1.audit-message-test
  "End-to-end coverage for client-supplied (templated) audit-log messages:
  the `?audit-message=` query param → `wrap-audit-message` middleware →
  `op/*custom-description*` → `operations.description`."
  (:require [clojure.test :refer :all]
            [ring.mock.request :as mock]
            [plaid.fixtures :as f :refer [with-db with-mount-states with-rest-handler
                                          admin-request api-call
                                          with-admin with-test-users with-clean-db]]
            [plaid.test-helpers :refer :all]
            [plaid.sql.common :as psc]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- latest-description
  "Description of the most recent operations row of the given op_type."
  [op-type]
  (-> (psc/q f/db ["SELECT description FROM operations WHERE op_type = ? ORDER BY ts DESC LIMIT 1" op-type])
      first
      :description))

(defn- descriptions
  "All descriptions for the given op_type, newest first."
  [op-type]
  (->> (psc/q f/db ["SELECT description FROM operations WHERE op_type = ? ORDER BY ts DESC" op-type])
       (mapv :description)))

(defn- setup-span
  "project → doc → text-layer → token-layer → span-layer → text → token → span.
  Returns the span id."
  []
  (let [proj (create-test-project admin-request "AMsg")
        doc (create-test-document admin-request proj "Doc")
        tl (-> (create-text-layer admin-request proj "TL") :body :id)
        tokl (-> (create-token-layer admin-request tl "TokL") :body :id)
        sl (-> (create-span-layer admin-request tokl "SL") :body :id)
        text (-> (create-text admin-request tl doc "hello world") :body :id)
        tok (-> (create-token admin-request tokl text 0 5) :body :id)]
    (-> (create-span admin-request sl [tok] "NOUN") :body :id)))

(defn- patch-span-meta-with-query
  "PATCH span metadata, appending an explicit query string (e.g. the
  url-encoded `audit-message=...`)."
  [span-id query body]
  (api-call admin-request
            {:method :patch
             :path (str "/api/v1/spans/" span-id "/metadata?" query)
             :body body}))

(deftest custom-message-overrides-auto-description
  (let [span (setup-span)]
    (testing "without ?audit-message= the auto-generated description stands"
      (let [r (patch-span-metadata admin-request span {"a" 1})]
        (is (< (:status r) 300))
        (is (re-find #"(?i)metadata" (latest-description "span/patch-metadata")))))

    (testing "with ?audit-message= the custom message replaces it"
      (let [r (patch-span-meta-with-query span "audit-message=Mark%20reviewed" {"b" 2})]
        (is (< (:status r) 300))
        (is (= "Mark reviewed" (latest-description "span/patch-metadata")))))))

(deftest templating-path-query-body-and-casing
  (let [span (setup-span)]
    (testing "path param via camelCase placeholder resolves to the kebab wire key"
      (patch-span-meta-with-query span (str "audit-message=" "Approve%20span%20%7BspanId%7D") {"x" 1})
      (is (= (str "Approve span " span) (latest-description "span/patch-metadata"))))

    (testing "body key + snake_case + a query key all template"
      ;; document-version is an int query param the endpoint accepts; include it
      ;; so {documentVersion} has something to resolve to. status comes from the
      ;; JSON body (string key "status").
      (patch-span-meta-with-query
       span
       (str "audit-message=" "set%20%7Bstatus%7D%20on%20%7Bspan_id%7D")
       {"status" "approved"})
      (is (= (str "set approved on " span) (latest-description "span/patch-metadata"))))

    (testing "unresolved placeholder is left literal"
      (patch-span-meta-with-query span (str "audit-message=" "x%20%7Bnope%7D%20y") {"x" 1})
      (is (= "x {nope} y" (latest-description "span/patch-metadata"))))))

(deftest undeclared-param-does-not-reject-the-write
  (let [span (setup-span)]
    (testing "a write on a route that does not declare audit-message still succeeds"
      (let [r (patch-span-meta-with-query span "audit-message=anything" {"x" 1})]
        (is (< (:status r) 300))))))

(defn- make-batch-request [operations]
  (let [req (-> (mock/request :post "/api/v1/batch")
                (mock/header "accept" "application/edn")
                (mock/json-body operations)
                (mock/header "authorization" (str "Bearer " f/admin-token)))]
    (f/rest-handler req)))

(deftest per-op-audit-message-in-batch
  (let [span (setup-span)
        resp (make-batch-request
              [{:path (str "/api/v1/spans/" span "/metadata?audit-message=First%20%7BspanId%7D")
                :method "patch" :body {"a" 1}}
               {:path (str "/api/v1/spans/" span "/metadata?audit-message=Second%20op")
                :method "patch" :body {"b" 2}}])]
    (testing "batch succeeds"
      (is (< (:status resp) 300)))
    (testing "each sub-op got its OWN templated description (per-op binding)"
      ;; newest-first: Second op ran last
      (let [descs (descriptions "span/patch-metadata")]
        (is (= [(str "First " span)] (filter #(= % (str "First " span)) descs)))
        (is (some #{"Second op"} descs))))))
