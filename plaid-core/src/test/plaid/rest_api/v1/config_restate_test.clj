(ns plaid.rest-api.v1.config-restate-test
  "A config write of the value a cell already holds writes nothing and leaves
  no audit row. With `?if-unchanged=true` and the value read as both
  `expected` and `value`, it states what a batch read: the batch is refused
  (409) when the cell changed since, and goes through otherwise with only its
  other writes recorded (REV6-WIRE-1, a settings save states the tagsets it
  read)."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project create-test-document]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private tagsets {"Leipzig" {"mode" "closed" "values" [{"value" "PL"}] "delimiters" ".-"}})

(defn- audit-ops [pid]
  (->> (api-call admin-request {:method :get :path (str "/api/v1/projects/" pid "/audit")})
       :body :entries (mapcat :audit/ops)
       (map #(subs (str (:op/type %)) 1))
       vec))

(defn- put-cas [pid k expected value]
  {:path (str "/api/v1/projects/" pid "/config/igt/" k "?if-unchanged=true")
   :method "PUT"
   :body {:expected expected :value value}})

(defn- project-config [pid]
  (:config (:body (api-call admin-request {:method :get :path (str "/api/v1/projects/" pid)}))))

(deftest a-restating-write-leaves-no-row
  (let [pid (create-test-project admin-request "Restate")
        base (str "/api/v1/projects/" pid "/config/igt/tagsets")]
    (assert-status 204 (api-call admin-request {:method :put :path base :body tagsets}))
    (let [before (audit-ops pid)]
      (testing "the same value, plain or compare-and-set, writes nothing"
        (assert-status 204 (api-call admin-request {:method :put :path base :body tagsets}))
        (assert-status 204 (api-call admin-request (assoc (put-cas pid "tagsets" tagsets tagsets)
                                                          :method :put)))
        (is (= before (audit-ops pid))))
      (testing "a different value is still written and recorded"
        (assert-status 204 (api-call admin-request {:method :put :path base :body {}}))
        (is (= (inc (count before)) (count (audit-ops pid))))))))

(deftest a-batch-states-the-tagsets-it-read
  (let [pid (create-test-project admin-request "Stated")
        doc (create-test-document admin-request pid "D")]
    (assert-status 204 (api-call admin-request {:method :put
                                                :path (str "/api/v1/projects/" pid "/config/igt/tagsets")
                                                :body tagsets}))
    (testing "unchanged: the batch goes through and only its own write is recorded"
      (let [before (count (audit-ops pid))
            resp (api-call admin-request
                           {:method :post :path "/api/v1/batch"
                            :body [(put-cas pid "tagsets" tagsets tagsets)
                                   {:path (str "/api/v1/documents/" doc) :method "PATCH" :body {:name "E"}}]})]
        (assert-status 200 resp)
        (is (= (inc before) (count (audit-ops pid))))
        (is (= "document/update" (last (audit-ops pid))))))
    (testing "changed since the read: the batch is refused whole"
      (let [read-before tagsets]
        (assert-status 204 (api-call admin-request {:method :put
                                                    :path (str "/api/v1/projects/" pid "/config/igt/tagsets")
                                                    :body {"L2" (get tagsets "Leipzig")}}))
        (let [resp (api-call admin-request
                             {:method :post :path "/api/v1/batch"
                              :body [(put-cas pid "tagsets" read-before read-before)
                                     {:path (str "/api/v1/documents/" doc) :method "PATCH" :body {:name "F"}}]})]
          (assert-status 409 resp)
          (is (= {"L2" (get tagsets "Leipzig")} (get-in (project-config pid) ["igt" "tagsets"])))
          (is (= "E" (:document/name (:body (api-call admin-request {:method :get
                                                                     :path (str "/api/v1/documents/" doc)}))))))))))

(deftest a-delete-of-an-absent-cell-states-it-was-absent
  (let [pid (create-test-project admin-request "Absent")
        sl-path (str "/api/v1/projects/" pid "/config/igt/tagset?if-unchanged=true")
        before (audit-ops pid)]
    (testing "absent, expected null: nothing written, no row"
      (assert-status 204 (api-call admin-request {:method :delete :path sl-path :body {:expected nil}}))
      (is (= before (audit-ops pid)))
      (is (not (contains? (get (project-config pid) "igt" {}) "tagset"))))
    (testing "set since, expected null: refused"
      (assert-status 204 (api-call admin-request {:method :put
                                                  :path (str "/api/v1/projects/" pid "/config/igt/tagset")
                                                  :body "Leipzig"}))
      (assert-status 409 (api-call admin-request {:method :delete :path sl-path :body {:expected nil}}))
      (is (= "Leipzig" (get-in (project-config pid) ["igt" "tagset"]))))))
