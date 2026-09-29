(ns plaid.rest-api.v1.config-compare-and-set-test
  "A config write with `?if-unchanged=true` carries the value its writer read
  and is refused with a 409 when another save came in between, so a settings
  page opened before someone else's save cannot write over it (D6)."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-token-layer
                                        create-span-layer]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- config-path [base ns k] (str base "/config/" ns "/" k))

(defn- put-config
  ([base ns k value]
   (api-call admin-request {:method :put :path (config-path base ns k) :body value}))
  ([base ns k expected value]
   (api-call admin-request {:method :put
                            :path (str (config-path base ns k) "?if-unchanged=true")
                            :body {:expected expected :value value}})))

(defn- delete-config [base ns k expected]
  (api-call admin-request {:method :delete
                           :path (str (config-path base ns k) "?if-unchanged=true")
                           :body {:expected expected}}))

(defn- project-config [project-id]
  (:config (:body (api-call admin-request {:method :get :path (str "/api/v1/projects/" project-id)}))))

(def ^:private tagsets
  {"Cases" {"mode" "closed" "values" ["NOM" "ACC"] "note" nil}
   "Ay" {"mode" "open" "values" [] "weight" 1.5 "n" 3}})

(deftest put-with-the-value-read-succeeds-and-a-stale-one-is-refused
  (let [pid (create-test-project admin-request "CAS")
        base (str "/api/v1/projects/" pid)]
    (testing "an absent cell is expected as null"
      (assert-status 204 (put-config base "igt" "tagsets" nil tagsets))
      (is (= tagsets (get-in (project-config pid) ["igt" "tagsets"]))))

    (testing "the value read back, nested maps, numbers and nulls included, matches"
      (let [read-back (get-in (project-config pid) ["igt" "tagsets"])
            next-value (assoc tagsets "Cx" {"mode" "open" "values" []})]
        (assert-status 204 (put-config base "igt" "tagsets" read-back next-value))
        (is (= next-value (get-in (project-config pid) ["igt" "tagsets"])))))

    (testing "a page that read before another save is refused and writes nothing"
      (let [stale tagsets
            before (get-in (project-config pid) ["igt" "tagsets"])
            resp (put-config base "igt" "tagsets" stale (assoc stale "Ay" {"mode" "closed" "values" []}))]
        (assert-status 409 resp)
        (is (string? (get-in resp [:body :error])))
        (is (= before (get-in (project-config pid) ["igt" "tagsets"])))))

    (testing "expecting null over a stored value is refused"
      (assert-status 409 (put-config base "igt" "tagsets" nil {})))

    (testing "another key of the same namespace is not compared"
      (assert-status 204 (put-config base "igt" "languages" nil {"object" "Lezgian"}))
      (assert-status 204 (put-config base "igt" "languages" {"object" "Lezgian"} {"object" "Lezgian" "meta" "English"})))

    (testing "without if-unchanged the body is the value, as before"
      (assert-status 204 (put-config base "igt" "compose" {"sw" "ə"}))
      (is (= {"sw" "ə"} (get-in (project-config pid) ["igt" "compose"]))))))

(deftest delete-with-the-value-read
  (let [pid (create-test-project admin-request "CAS delete")
        base (str "/api/v1/projects/" pid)]
    (assert-status 204 (put-config base "ud" "language" "en"))
    (testing "a stale delete is refused and the value stays"
      (assert-status 409 (delete-config base "ud" "language" "cop"))
      (is (= "en" (get-in (project-config pid) ["ud" "language"]))))
    (testing "a delete with the value read goes through"
      (assert-status 204 (delete-config base "ud" "language" "en"))
      (is (nil? (get-in (project-config pid) ["ud" "language"]))))))

(deftest a-malformed-envelope-is-a-400
  (let [pid (create-test-project admin-request "CAS 400")
        path (str "/api/v1/projects/" pid "/config/igt/x?if-unchanged=true")]
    (assert-status 400 (api-call admin-request {:method :put :path path :body {:value 1}}))
    (assert-status 400 (api-call admin-request {:method :put :path path :body {:expected nil}}))
    (assert-status 400 (api-call admin-request {:method :put :path path :body ["expected" 1]}))
    (assert-status 400 (api-call admin-request {:method :delete :path path}))))

(deftest every-config-route-checks
  (let [pid (create-test-project admin-request "CAS layers")
        txtl (-> (create-text-layer admin-request pid "T") :body :id)
        tokl (-> (create-token-layer admin-request txtl "W") :body :id)
        sl (-> (create-span-layer admin-request tokl "Gloss") :body :id)
        vocab (-> (api-call admin-request {:method :post :path "/api/v1/vocab-layers" :body {:name "Lex"}}) :body :id)]
    (doseq [base [(str "/api/v1/text-layers/" txtl)
                  (str "/api/v1/token-layers/" tokl)
                  (str "/api/v1/span-layers/" sl)
                  (str "/api/v1/vocab-layers/" vocab)]]
      (testing base
        (assert-status 204 (put-config base "igt" "k" nil {"a" 1}))
        (assert-status 409 (put-config base "igt" "k" nil {"a" 2}))
        (assert-status 204 (put-config base "igt" "k" {"a" 1} {"a" 2}))))))

(deftest a-refused-check-rolls-back-its-batch
  (let [pid (create-test-project admin-request "CAS batch")
        doc (create-test-document admin-request pid "D")
        base (str "/api/v1/projects/" pid)]
    (assert-status 204 (put-config base "igt" "languages" {"object" "Lezgian"}))
    (let [resp (api-call admin-request
                         {:method :post
                          :path "/api/v1/batch"
                          :body [{:path (str "/api/v1/documents/" doc) :method "PATCH" :body {:name "Renamed"}}
                                 {:path (str base "/config/igt/languages?if-unchanged=true")
                                  :method "PUT"
                                  :body {:expected {"object" "Lezgi"} :value {"object" "X"}}}]})]
      (assert-status 409 resp)
      (is (= {"object" "Lezgian"} (get-in (project-config pid) ["igt" "languages"])))
      (is (= "D" (:document/name (:body (api-call admin-request {:method :get :path (str "/api/v1/documents/" doc)}))))))))
