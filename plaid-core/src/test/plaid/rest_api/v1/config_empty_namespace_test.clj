(ns plaid.rest-api.v1.config-empty-namespace-test
  "Removing the last key of a config namespace removes the namespace, so a
  layer, vocabulary or project whose settings were all unset reads as one that
  never had any (ROUNDTRIP-PROD class 2 and 5: a native import that writes and
  then clears its record left `igt: {}` behind)."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- namespaces [config]
  (set (map name (keys config))))

(deftest unsetting-the-last-key-removes-the-namespace
  (let [pid (create-test-project admin-request "Empty namespace")
        base (str "/api/v1/projects/" pid "/config/")
        read #(:config (:body (api-call admin-request {:method :get :path (str "/api/v1/projects/" pid)})))]
    (assert-status 204 (api-call admin-request {:method :put :path (str base "igt/a") :body 1}))
    (assert-status 204 (api-call admin-request {:method :put :path (str base "igt/b") :body 2}))
    (assert-status 204 (api-call admin-request {:method :put :path (str base "other/c") :body 3}))
    (testing "a namespace keeps its other keys"
      (assert-status 204 (api-call admin-request {:method :delete :path (str base "igt/a")}))
      (is (= #{"igt" "other"} (namespaces (read)))))
    (testing "the last key takes the namespace with it"
      (assert-status 204 (api-call admin-request {:method :delete :path (str base "igt/b")}))
      (is (= #{"other"} (namespaces (read)))))))

(deftest a-vocabulary-unset-whole-has-no-namespace
  (let [vid (:id (:body (api-call admin-request {:method :post :path "/api/v1/vocab-layers"
                                                 :body {:name "Lex"}})))
        base (str "/api/v1/vocab-layers/" vid "/config/igt/fields")
        read #(:config (:body (api-call admin-request {:method :get :path (str "/api/v1/vocab-layers/" vid)})))]
    (assert-status 204 (api-call admin-request {:method :put :path base :body {:gloss {:inline true}}}))
    (assert-status 204 (api-call admin-request {:method :delete :path base}))
    (is (= #{} (namespaces (read))))))
