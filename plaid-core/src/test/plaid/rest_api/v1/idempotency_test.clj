(ns plaid.rest-api.v1.idempotency-test
  "A write sent with an Idempotency-Key is answered once and replayed after:
  the same key and request get the first answer back, with
  `Idempotent-Replayed: true`, and nothing is written again. Only 2xx
  answers are kept, so a refused write runs again when resent."
  (:require [clojure.data.json :as json]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [plaid.fixtures :refer [db rest-handler admin-request user1-request
                                    with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    api-call parse-response-body assert-created]]
            [plaid.rest-api.v1.idempotency :as idem-mw]
            [plaid.server.events :as events]
            [plaid.sql.common :as psc]
            [plaid.sql.idempotency :as idem]
            [plaid.test-helpers :refer [create-test-project create-text-layer
                                        create-token-layer create-text create-token
                                        create-span-layer create-span get-document
                                        add-project-writer acquire-lock release-lock]]
            [ring.mock.request :as mock]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- keyed
  "Send `method path body` as `request-fn`'s user with Idempotency-Key `key`
  (none when nil). Answers {:status :headers :body}."
  ([request-fn key method path body] (keyed request-fn key method path body {}))
  ([request-fn key method path body headers]
   (let [req (cond-> (-> (request-fn method path)
                         (mock/header "accept" "application/json"))
               key (mock/header "Idempotency-Key" key)
               (some? body) (mock/json-body body))
         req (reduce-kv mock/header req headers)
         resp (rest-handler req)]
     {:status (:status resp)
      :headers (:headers resp)
      :body (when-let [b (:body resp)]
              (let [s (if (string? b) b (slurp b))]
                (when-not (= "" s) (json/read-str s :key-fn keyword))))})))

(defn- setup!
  []
  (let [proj (create-test-project admin-request "Idem")
        tl (-> (create-text-layer admin-request proj "T") :body :id)
        tkl (-> (create-token-layer admin-request tl "W") :body :id)
        sl (-> (create-span-layer admin-request tkl "S") :body :id)
        doc (-> (api-call admin-request {:method :post :path "/api/v1/documents"
                                         :body {:project-id proj :name "D"}})
                :body :id)
        text (-> (create-text admin-request tl doc "dog barks") :body :id)
        tok (-> (create-token admin-request tkl text 0 3) :body :id)]
    {:proj proj :doc doc :tok tok :sl sl :tkl tkl :text text}))

(defn- version [doc] (-> (get-document admin-request doc) :body :document/version))

(defn- count-rows [table & [where]]
  (-> (psc/q1 db (cond-> {:select [[[:count :*] :n]] :from [table]} where (assoc :where where))) :n))

(defn- key-rows [] (count-rows :idempotency_keys))

(defn- new-key [] (str (psc/new-uuid)))

(defn- span-body [{:keys [sl tok]} value]
  {:span-layer-id sl :tokens [tok] :value value})

(deftest keyed-create-is-answered-once
  (let [{:keys [doc sl] :as s} (setup!)
        k (new-key)
        v0 (version doc)
        ops0 (count-rows :operations)
        first-send (keyed admin-request k :post "/api/v1/spans" (span-body s "N"))
        v1 (version doc)
        again (keyed admin-request k :post "/api/v1/spans" (span-body s "N"))]
    (is (= 201 (:status first-send)))
    (is (nil? (get-in first-send [:headers "Idempotent-Replayed"])))
    (testing "the resend gets the first answer back and writes nothing"
      (is (= 201 (:status again)))
      (is (= "true" (get-in again [:headers "Idempotent-Replayed"])))
      (is (= (:body first-send) (:body again)))
      (is (= (get-in first-send [:headers "X-Document-Versions"])
             (get-in again [:headers "X-Document-Versions"])))
      (is (= 1 (count-rows :spans [:= :span_layer_id (str sl)])))
      (is (= (inc ops0) (count-rows :operations)))
      (is (= (inc v0) v1 (version doc))))))

(deftest replay-comes-before-the-version-check
  (let [{:keys [doc] :as s} (setup!)
        span (-> (keyed admin-request nil :post "/api/v1/spans" (span-body s "A")) :body :id)
        v (version doc)
        k (new-key)
        path (str "/api/v1/spans/" span "?document-version=" v)
        first-send (keyed admin-request k :patch path {:value "B"})]
    (is (= 200 (:status first-send)))
    ;; Someone else moves the document on.
    (is (= 200 (:status (keyed admin-request nil :patch (str "/api/v1/spans/" span) {:value "C"}))))
    (let [again (keyed admin-request k :patch path {:value "B"})]
      (testing "a strict resend of a write that landed is replayed, not refused as stale"
        (is (= 200 (:status again)))
        (is (= "true" (get-in again [:headers "Idempotent-Replayed"])))
        (is (= (get-in first-send [:headers "X-Document-Versions"])
               (get-in again [:headers "X-Document-Versions"]))))
      (testing "and it wrote nothing: the later value stands"
        (is (= "C" (-> (api-call admin-request {:method :get :path (str "/api/v1/spans/" span)})
                       :body :span/value)))))))

(deftest same-key-other-request
  (let [{:keys [doc] :as s} (setup!)
        k (new-key)]
    (assert-created (keyed admin-request k :post "/api/v1/spans" (span-body s "N")))
    (testing "another body is refused with 422"
      (let [r (keyed admin-request k :post "/api/v1/spans" (span-body s "M"))]
        (is (= 422 (:status r)))
        (is (true? (get-in r [:body :idempotency-key-reused])))))
    (testing "another document-version is another request"
      (is (= 422 (:status (keyed admin-request k :post
                                 (str "/api/v1/spans?document-version=" (version doc))
                                 (span-body s "N"))))))
    (testing "labels are not part of the request"
      (let [r (keyed admin-request k :post
                     (str "/api/v1/spans?group-id=" (random-uuid) "&audit-message=relabel")
                     (span-body s "N"))]
        (is (= 201 (:status r)))
        (is (= "true" (get-in r [:headers "Idempotent-Replayed"])))))
    (testing "another user's key of the same name is theirs"
      (add-project-writer admin-request (:proj s) "user1@example.com")
      (let [r (keyed user1-request k :post "/api/v1/spans" (span-body s "N"))]
        (is (= 201 (:status r)))
        (is (nil? (get-in r [:headers "Idempotent-Replayed"])))))))

(deftest refusals-are-not-kept
  (let [{:keys [doc tok] :as s} (setup!)]
    (testing "a 409 runs again when resent"
      (let [k (new-key)
            path (str "/api/v1/spans?document-version=" (dec (version doc)))]
        (is (= 409 (:status (keyed admin-request k :post path (span-body s "N")))))
        (is (zero? (key-rows)))
        (is (= 409 (:status (keyed admin-request k :post path (span-body s "N")))))))
    (testing "a 400 runs again"
      (let [k (new-key)
            body {:span-layer-id (:sl s) :tokens [] :value "N"}]
        (is (= 400 (:status (keyed admin-request k :post "/api/v1/spans" body))))
        (is (zero? (key-rows)))))
    (testing "a 423 runs again once the lock is gone"
      (add-project-writer admin-request (:proj s) "user1@example.com")
      (let [lock (-> (acquire-lock user1-request doc) :body)
            k (new-key)]
        (is (= 423 (:status (keyed admin-request k :post "/api/v1/spans" (span-body s "L")))))
        (is (zero? (key-rows)))
        (release-lock user1-request doc (:lock-id lock))
        (let [r (keyed admin-request k :post "/api/v1/spans" (span-body s "L"))]
          (is (= 201 (:status r)))
          (is (nil? (get-in r [:headers "Idempotent-Replayed"]))))))
    (is (some? tok))))

(deftest keyed-batch
  (let [{:keys [sl tok doc] :as s} (setup!)
        ops [{:path "/api/v1/spans" :method "POST" :body (span-body s "1")}
             {:path (str "/api/v1/spans?group-id=" (random-uuid)) :method "POST" :body (span-body s "2")}]]
    (testing "a keyed batch is replayed whole"
      (let [k (new-key)
            first-send (keyed admin-request k :post "/api/v1/batch" ops)
            ;; The same batch, with a relabelled operation.
            again (keyed admin-request k :post "/api/v1/batch"
                         (assoc-in ops [1 :path] (str "/api/v1/spans?group-id=" (random-uuid))))]
        (is (= 200 (:status first-send)))
        (is (= 200 (:status again)))
        (is (= "true" (get-in again [:headers "Idempotent-Replayed"])))
        (is (= (:body first-send) (:body again)))
        (is (= 2 (count-rows :spans [:= :span_layer_id (str sl)])))))
    (testing "a batch refused on its third operation keeps no key, and runs again"
      (let [k (new-key)
            bad (conj ops {:path "/api/v1/spans" :method "POST"
                           :body {:span-layer-id sl :tokens [] :value "x"}})]
        (is (= 400 (:status (keyed admin-request k :post "/api/v1/batch" bad))))
        (is (= 1 (key-rows)))
        (is (= 2 (count-rows :spans [:= :span_layer_id (str sl)])))
        (let [good (keyed admin-request k :post "/api/v1/batch" (vec (take 2 bad)))]
          (is (= 200 (:status good)))
          (is (nil? (get-in good [:headers "Idempotent-Replayed"]))))))
    (is (some? [tok doc]))))

(deftest one-key-sent-twice-at-once
  (let [s (setup!)
        k (new-key)
        sends (doall (repeatedly 2 #(future (keyed admin-request k :post "/api/v1/spans" (span-body s "Z")))))
        answers (mapv deref sends)]
    (is (= [201 201] (mapv :status answers)))
    (is (= 1 (count (filter #(get-in % [:headers "Idempotent-Replayed"]) answers))))
    (is (= 1 (count-rows :spans [:= :value (psc/write-json "Z")])))))

(deftest routes-that-refuse-a-key
  (let [{:keys [doc]} (setup!)]
    (doseq [[what method path body] [["a lock" :post (str "/api/v1/documents/" doc "/lock") nil]
                                     ["an API token" :post "/api/v1/users/admin@example.com/tokens" {:name "t"}]
                                     ["an invite" :post "/api/v1/invites" {}]
                                     ["logging out" :post "/api/v1/logout" nil]]]
      (testing what
        (let [r (keyed admin-request (new-key) method path body)]
          (is (= 400 (:status r)))
          (is (re-find #"does not take an Idempotency-Key" (str (get-in r [:body :error])))))))
    (testing "a malformed key"
      (is (= 400 (:status (keyed admin-request "short" :post "/api/v1/projects" {:name "P"})))))
    (testing "a GET ignores the key"
      (is (= 200 (:status (keyed admin-request (new-key) :get (str "/api/v1/documents/" doc) nil)))))))

(deftest retention
  (let [s (setup!)
        k (new-key)]
    (assert-created (keyed admin-request k :post "/api/v1/spans" (span-body s "R")))
    (testing "an answer past retention is not replayed: the resend runs"
      (psc/execute! db {:update :idempotency_keys :set {:created_at "2020-01-01T00:00:00.000000000Z"}})
      (let [r (keyed admin-request k :post "/api/v1/spans" (span-body s "R"))]
        (is (= 201 (:status r)))
        (is (nil? (get-in r [:headers "Idempotent-Replayed"])))))
    (testing "the sweep deletes old rows in chunks"
      (psc/execute! db {:update :idempotency_keys :set {:created_at "2020-01-01T00:00:00.000000000Z"}})
      (with-redefs [idem/prune-chunk 1]
        (dotimes [_ 2] (assert-created (keyed admin-request (new-key) :post "/api/v1/spans" (span-body s "Q"))))
        (psc/execute! db {:update :idempotency_keys :set {:created_at "2020-01-01T00:00:00.000000000Z"}})
        (is (= 3 (idem/prune! db)))
        (is (zero? (key-rows)))))))

(deftest comment-in-a-refused-batch-announces-nothing
  (let [{:keys [doc]} (setup!)
        published (atom [])]
    (with-redefs [events/publish-message! (fn [& args] (swap! published conj args))]
      (let [r (keyed admin-request nil :post "/api/v1/batch"
                     [{:path "/api/v1/comments" :method "POST"
                       :body {:entity-type "document" :entity-id doc :body "hi"}}
                      {:path "/api/v1/spans" :method "POST" :body {:span-layer-id (random-uuid) :tokens [] :value 1}}])]
        (is (<= 400 (:status r)))
        (is (empty? @published))
        (is (zero? (count-rows :comments))))
      (testing "and a comment that lands is announced once, after the commit"
        (assert-created (keyed admin-request (new-key) :post "/api/v1/comments"
                               {:entity-type "document" :entity-id doc :body "hi"}))
        (is (= 1 (count @published)))))))

(deftest fingerprint-ignores-labels-only
  (let [req (fn [qs body] {:request-method :post :uri "/api/v1/spans" :query-string qs :body-params body})]
    (is (= (idem-mw/fingerprint (req "group-id=a&document-version=3" {:a 1 :b 2}) false)
           (idem-mw/fingerprint (req "document-version=3&audit-message=x" {:b 2 :a 1}) false)))
    (is (not= (idem-mw/fingerprint (req "document-version=3" {:a 1}) false)
              (idem-mw/fingerprint (req "document-version=4" {:a 1}) false)))))
