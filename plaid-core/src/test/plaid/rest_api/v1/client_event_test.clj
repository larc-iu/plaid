(ns plaid.rest-api.v1.client-event-test
  "Client events, the opt-in research telemetry: the switch (off means
  off), the closed set of types, the per-request cap, who may write and
  read, pagination, and the table's place outside the audit log and inside
  the project's cascade."
  (:require [clojure.string]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [ring.mock.request :as mock]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request user1-request user2-request
                                    api-call assert-status db rest-handler]]
            [plaid.sql.common :as psc]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        add-project-reader add-project-writer]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- set-telemetry! [project on?]
  (assert-status 204 (api-call admin-request {:method :put
                                              :path (str "/api/v1/projects/" project "/config/plaid/research")
                                              :body {:telemetry on?}})))

(defn- post-events [req project events]
  (api-call req {:method :post :path (str "/api/v1/projects/" project "/events") :body events}))

(defn- query-string [query]
  (when (seq query)
    (str "?" (clojure.string/join "&" (map (fn [[k v]] (str (name k) "=" v)) query)))))

(defn- list-events [req project & {:as query}]
  (api-call req {:method :get :path (str "/api/v1/projects/" project "/events" (query-string query))}))

(defn- row-count
  ([] (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:client_events]})))
  ([where] (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:client_events] :where where}))))

(defn- shown [target value]
  {:type "suggestion.shown" :target-id target :data {:value value :source "precedent" :field "Gloss"}
   :client-ts "2026-09-29T10:00:00.000Z"})

(defn- setup [name]
  (let [proj (create-test-project admin-request name)
        doc (create-test-document admin-request proj "Doc")]
    (add-project-writer admin-request proj "user1@example.com")
    (add-project-reader admin-request proj "user2@example.com")
    {:project proj :document doc}))

;; ============================================================
;; The switch
;; ============================================================

(deftest a-project-without-the-switch-refuses-events
  (let [{:keys [project]} (setup "Off")]
    (testing "never set: refused, nothing stored"
      (let [resp (post-events user1-request project [(shown "t1" "dog")])]
        (assert-status 403 resp)
        (is (re-find #"telemetry is off" (-> resp :body :error)))
        (is (= 0 (row-count)))))
    (testing "set to false: refused the same way"
      (set-telemetry! project false)
      (assert-status 403 (post-events user1-request project [(shown "t1" "dog")]))
      (is (= 0 (row-count))))
    (testing "an admin is refused too: the switch is about the project, not the caller"
      (assert-status 403 (post-events admin-request project [(shown "t1" "dog")])))
    (testing "a truthy value that is not true is off"
      (assert-status 204 (api-call admin-request {:method :put
                                                  :path (str "/api/v1/projects/" project "/config/plaid/research")
                                                  :body {:telemetry "yes"}}))
      (assert-status 403 (post-events user1-request project [(shown "t1" "dog")])))
    (testing "switched on, then off again: refused again"
      (set-telemetry! project true)
      (assert-status 201 (post-events user1-request project [(shown "t1" "dog")]))
      (set-telemetry! project false)
      (assert-status 403 (post-events user1-request project [(shown "t2" "cat")]))
      (is (= 1 (row-count))))))

;; ============================================================
;; Writing
;; ============================================================

(deftest a-writer-records-events-stamped-by-the-server
  (let [{:keys [project document]} (setup "On")]
    (set-telemetry! project true)
    (let [resp (post-events user1-request project
                            [(assoc (shown "t1" "dog") :document-id document)
                             {:type "suggestion.adopted" :document-id document :target-id "t1"
                              :data {:value "dog" :source "precedent" :field "Gloss"}}
                             {:type "plan.opened" :target-id "plan-7" :data {:conversation "c1"}}])]
      (assert-status 201 resp)
      (is (= 3 (-> resp :body :count))))
    (let [entries (-> (list-events admin-request project) :body :entries)
          [a b c] entries]
      (is (= ["suggestion.shown" "suggestion.adopted" "plan.opened"] (mapv :client-event/type entries))
          "arrival order")
      (is (every? #(= "user1@example.com" (:client-event/user-id %)) entries)
          "the user is the caller")
      (is (every? #(some? (:client-event/ts %)) entries) "the server stamps its time")
      (is (= "2026-09-29T10:00:00.000Z" (:client-event/client-ts a)))
      (is (= (str document) (str (:client-event/document-id a))))
      (is (= "t1" (:client-event/target-id b)))
      (is (= {"value" "dog" "source" "precedent" "field" "Gloss"} (:client-event/data a)))
      (is (nil? (:client-event/document-id c))))))

(deftest a-body-cannot-name-the-user-or-the-time
  (let [{:keys [project]} (setup "Stamp")]
    (set-telemetry! project true)
    (assert-status 201 (post-events user1-request project
                                    [(assoc (shown "t1" "dog") :user-id "user2@example.com"
                                            :ts "2000-01-01T00:00:00Z")]))
    (let [[e] (-> (list-events admin-request project) :body :entries)]
      (is (= "user1@example.com" (:client-event/user-id e)))
      (is (not= "2000-01-01T00:00:00Z" (:client-event/ts e))))))

(deftest only-the-closed-set-of-types-is-accepted
  (let [{:keys [project]} (setup "Types")]
    (set-telemetry! project true)
    (doseq [t ["keystroke" "click" "focus" "suggestion.hovered" ""]]
      (let [resp (post-events user1-request project [(shown "t1" "dog") (assoc (shown "t2" "x") :type t)])]
        (assert-status 400 resp)
        (is (re-find #"Event 1" (-> resp :body :error)) "the refusal names the event")))
    (assert-status 400 (post-events user1-request project [(dissoc (shown "t1" "dog") :type)]))
    (is (= 0 (row-count)) "all or nothing: the good event in a refused request is not stored")))

(deftest bad-fields-are-refused
  (let [{:keys [project]} (setup "Fields")
        other (create-test-project admin-request "Other")
        other-doc (create-test-document admin-request other "Elsewhere")]
    (set-telemetry! project true)
    (testing "a document of another project"
      (assert-status 400 (post-events user1-request project [(assoc (shown "t" "v") :document-id other-doc)])))
    (testing "data that is not an object"
      (assert-status 400 (post-events user1-request project [(assoc (shown "t" "v") :data ["a"])])))
    (testing "a data value past the ceiling"
      (assert-status 400 (post-events user1-request project
                                      [(assoc (shown "t" "v") :data {:value (apply str (repeat 5000 "a"))})])))
    (testing "a target id past the ceiling"
      (assert-status 400 (post-events user1-request project [(shown (apply str (repeat 300 "a")) "v")])))
    (testing "a body that is not an array"
      (assert-status 400 (post-events user1-request project (shown "t" "v"))))
    (is (= 0 (row-count)))))

(deftest a-request-holds-at-most-500-events
  (let [{:keys [project]} (setup "Cap")]
    (set-telemetry! project true)
    (let [resp (post-events user1-request project (vec (for [i (range 501)] (shown (str "t" i) "v"))))]
      (assert-status 400 resp)
      (is (re-find #"500" (-> resp :body :error))))
    (is (= 0 (row-count)))
    (assert-status 201 (post-events user1-request project (vec (for [i (range 500)] (shown (str "t" i) "v")))))
    (is (= 500 (row-count)))
    (testing "an empty array is fine and stores nothing"
      (let [resp (post-events user1-request project [])]
        (assert-status 201 resp)
        (is (= 0 (-> resp :body :count)))))))

(deftest writing-takes-a-writer
  (let [{:keys [project]} (setup "Roles")
        outsider (create-test-project admin-request "Outsider")]
    (set-telemetry! project true)
    (set-telemetry! outsider true)
    (testing "a reader is refused"
      (assert-status 403 (post-events user2-request project [(shown "t" "v")])))
    (testing "a non-member is refused"
      (assert-status 403 (post-events user1-request outsider [(shown "t" "v")])))
    (testing "a writer and an admin may"
      (assert-status 201 (post-events user1-request project [(shown "t" "v")]))
      (assert-status 201 (post-events admin-request project [(shown "t" "v")])))))

;; ============================================================
;; Reading
;; ============================================================

(deftest reading-takes-a-maintainer
  (let [{:keys [project]} (setup "Read")]
    (set-telemetry! project true)
    (post-events user1-request project [(shown "t" "v")])
    (assert-status 403 (list-events user1-request project))
    (assert-status 403 (list-events user2-request project))
    (assert-status 200 (list-events admin-request project))
    (api-call admin-request {:method :post
                             :path (str "/api/v1/projects/" project "/maintainers/user2@example.com")})
    (is (= 1 (count (-> (list-events user2-request project) :body :entries))) "a maintainer reads")))

(deftest reading-still-works-once-the-switch-is-off
  (let [{:keys [project]} (setup "Later")]
    (set-telemetry! project true)
    (post-events user1-request project [(shown "t" "v")])
    (set-telemetry! project false)
    (is (= 1 (count (-> (list-events admin-request project) :body :entries))))))

(deftest the-list-pages-in-arrival-order-across-digit-boundaries
  ;; The cursor carries the integer id as a string: a string compare would
  ;; put 10 before 9 and 100 before 99, skipping or repeating events.
  (let [{:keys [project]} (setup "Pages")]
    (set-telemetry! project true)
    (post-events user1-request project (vec (for [i (range 205)] (shown (str "t" i) "v"))))
    (loop [cursor nil pages 0 seen []]
      (let [resp (if cursor
                   (list-events admin-request project :limit 7 :cursor cursor)
                   (list-events admin-request project :limit 7))
            {:keys [entries next-cursor]} (:body resp)
            seen (into seen (map :client-event/target-id) entries)]
        (if next-cursor
          (recur next-cursor (inc pages) seen)
          (do (is (= (mapv #(str "t" %) (range 205)) seen) "every event once, in order")
              (is (= 30 (inc pages)) "29 full pages of 7 and one of 2")))))
    (assert-status 400 (list-events admin-request project :cursor "garbage!"))))

(deftest the-list-filters-by-type-and-time
  (let [{:keys [project]} (setup "Filter")]
    (set-telemetry! project true)
    (post-events user1-request project [(shown "t1" "v")
                                        {:type "suggestion.adopted" :target-id "t1"}
                                        {:type "suggestion.dismissed" :target-id "t2"}])
    (Thread/sleep 5)
    (let [mid (psc/now-iso)]
      (Thread/sleep 5)
      (post-events user1-request project [{:type "plan.opened" :target-id "p1"}])
      (let [types-of (fn [resp] (mapv :client-event/type (-> resp :body :entries)))]
        (is (= ["suggestion.adopted" "suggestion.dismissed"]
               (types-of (list-events admin-request project :types "suggestion.adopted,suggestion.dismissed"))))
        (is (= ["plan.opened"] (types-of (list-events admin-request project :start-time mid))))
        (is (= 3 (count (types-of (list-events admin-request project :end-time mid)))))
        (is (= ["plan.opened"]
               (types-of (list-events admin-request project :types "plan.opened" :start-time mid))))
        (let [resp (list-events admin-request project :types "keystroke")]
          (assert-status 400 resp)
          (is (re-find #"keystroke" (-> resp :body :error))))))))

;; ============================================================
;; Outside the record, inside the cascade
;; ============================================================

(deftest events-are-not-audited-and-bump-no-version
  (let [{:keys [project document]} (setup "Inert")]
    (set-telemetry! project true)
    (let [ops (fn [] (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:operations]})))
          writes (fn [] (:n (psc/q1 db {:select [[[:count :*] :n]] :from [:audit_writes]})))
          version (fn [] (:version (psc/q1 db {:select [:version] :from [:documents] :where [:= :id document]})))
          before [(ops) (writes) (version)]]
      (assert-status 201 (post-events user1-request project [(assoc (shown "t" "v") :document-id document)]))
      (is (= before [(ops) (writes) (version)])))))

(deftest a-deleted-project-takes-its-events
  (let [{:keys [project]} (setup "Gone")
        keep (create-test-project admin-request "Kept")]
    (set-telemetry! project true)
    (set-telemetry! keep true)
    (post-events admin-request project [(shown "t" "v")])
    (post-events admin-request keep [(shown "t" "v")])
    (assert-status 204 (api-call admin-request {:method :delete :path (str "/api/v1/projects/" project)}))
    (is (= 0 (row-count [:= :project_id project])))
    (is (= 1 (row-count [:= :project_id keep])))))

(deftest a-deleted-document-leaves-its-events
  ;; Deleting a document is audited and can be looked back at, so its events
  ;; keep the id that joins them to that history.
  (let [{:keys [project document]} (setup "DocGone")]
    (set-telemetry! project true)
    (post-events user1-request project [(assoc (shown "t" "v") :document-id document)])
    (assert-status 204 (api-call admin-request {:method :delete :path (str "/api/v1/documents/" document)}))
    (let [[e] (-> (list-events admin-request project) :body :entries)]
      (is (= (str document) (str (:client-event/document-id e)))))))

(deftest a-keepalive-post-without-edn-accept-works
  ;; The browser's pagehide flush sends JSON and reads nothing back.
  (let [{:keys [project]} (setup "Json")]
    (set-telemetry! project true)
    (let [resp (rest-handler (-> (user1-request :post (str "/api/v1/projects/" project "/events"))
                                 (mock/header "accept" "application/json")
                                 (mock/json-body [(shown "t" "v")])))]
      (is (= 201 (:status resp))))))

(deftest an-unknown-project-answers-an-admin-404-and-anyone-else-403
  ;; The core ruling on unknown ids: a non-member must not learn whether the
  ;; id is real, and an admin is told it is not. Before, an admin's POST got
  ;; the switch's 403 ("telemetry is off") and a GET an empty page.
  (let [unknown (str (random-uuid))]
    (assert-status 404 (post-events admin-request unknown [(shown "t" "v")]))
    (assert-status 404 (list-events admin-request unknown))
    (assert-status 403 (post-events user1-request unknown [(shown "t" "v")]))
    (assert-status 403 (list-events user1-request unknown))
    (is (= 0 (row-count)))))

(deftest each-type-takes-only-its-own-data-keys
  ;; "Nothing else is recorded" is kept by the server, not only by the apps:
  ;; each type has a fixed set of `data` keys, each a string or a number of
  ;; bounded length.
  (let [{:keys [project]} (setup "Keys")
        adopted {:type "suggestion.adopted" :target-id "t1"
                 :data {:value "dog" :source "precedent" :field "Gloss"}}
        dismissed {:type "suggestion.dismissed" :target-id "t1"
                   :data {:value "dog" :source "precedent" :field "Gloss" :written "cat"}}
        opened {:type "plan.opened" :target-id "plan-7" :data {:conversation "c1"}}
        refused (fn [event key]
                  (let [resp (post-events user1-request project [(shown "t0" "v") event])]
                    (assert-status 400 resp)
                    (is (re-find #"Event 1" (-> resp :body :error)) "the refusal names the event")
                    (is (clojure.string/includes? (-> resp :body :error) (str "'" key "'"))
                        "the refusal names the key")))]
    (set-telemetry! project true)
    (testing "every documented key of every type is taken"
      (assert-status 201 (post-events user1-request project
                                      [(shown "t1" "dog") adopted dismissed opened
                                       (assoc (shown "t2" 7) :data {:value 7})
                                       (dissoc opened :data)]))
      (is (= 6 (row-count))))
    (testing "a key outside the type's set"
      (refused (assoc-in (shown "t1" "dog") [:data :written] "cat") "written")
      (refused (assoc-in adopted [:data :written] "cat") "written")
      (refused (assoc-in dismissed [:data :conversation] "c1") "conversation")
      (refused (assoc-in opened [:data :value] "dog") "value")
      (refused (assoc-in (shown "t1" "dog") [:data :keys] "abc") "keys")
      (refused (assoc-in opened [:data :dwell-ms] 1200) "dwell-ms"))
    (testing "a value that is not a string or a number"
      (refused (assoc-in (shown "t1" "dog") [:data :value] {:nested "x"}) "value")
      (refused (assoc-in (shown "t1" "dog") [:data :value] ["x"]) "value")
      (refused (assoc-in (shown "t1" "dog") [:data :value] true) "value")
      (refused (assoc-in opened [:data :conversation] nil) "conversation"))
    (testing "a value past 200 characters"
      (refused (assoc-in (shown "t1" "dog") [:data :value] (apply str (repeat 201 "a"))) "value")
      (assert-status 201 (post-events user1-request project
                                      [(assoc-in (shown "t3" "dog") [:data :value]
                                                 (apply str (repeat 200 "𐐷")))])))
    (is (= 7 (row-count)) "all or nothing: nothing from a refused request is stored")))
