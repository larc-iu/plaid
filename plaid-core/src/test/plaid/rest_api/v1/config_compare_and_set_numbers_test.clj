(ns plaid.rest-api.v1.config-compare-and-set-numbers-test
  "The value a config compare-and-set expects is JSON, and JSON has one kind
  of number. A whole number stored as 1.0 (a Python writer sends `1.0`) is
  read by a JavaScript page as 1 and sent back as `1`, so the check must hold
  the two equal, or that page is refused on every save of the key (D6)."
  (:require [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    with-admin with-test-users with-clean-db
                                    admin-request api-call assert-status]]
            [plaid.test-helpers :refer [create-test-project]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(defn- put-config
  ([pid k value]
   (api-call admin-request {:method :put :path (str "/api/v1/projects/" pid "/config/t/" k) :body value}))
  ([pid k expected value]
   (api-call admin-request {:method :put
                            :path (str "/api/v1/projects/" pid "/config/t/" k "?if-unchanged=true")
                            :body {:expected expected :value value}})))

(deftest a-whole-number-matches-whatever-its-spelling
  (let [pid (create-test-project admin-request "CAS numbers")]
    (testing "stored 1.0, expected 1"
      (assert-status 204 (put-config pid "w" {"weight" 1.0 "xs" [2.0 3]}))
      (assert-status 204 (put-config pid "w" {"weight" 1 "xs" [2 3]} {"weight" 2})))
    (testing "stored 2, expected 2.0"
      (assert-status 204 (put-config pid "w" {"weight" 2.0} 7)))
    (testing "a different number is still refused"
      (assert-status 409 (put-config pid "w" 7.5 8))
      (assert-status 409 (put-config pid "w" "7" 8)))
    (testing "a list of another length or a map with another key is still refused"
      (assert-status 204 (put-config pid "l" nil [1 2]))
      (assert-status 409 (put-config pid "l" [1 2 3] 0))
      (assert-status 409 (put-config pid "l" [1] 0))
      (assert-status 204 (put-config pid "m" nil {"a" 1}))
      (assert-status 409 (put-config pid "m" {"a" 1 "b" nil} 0))
      (assert-status 409 (put-config pid "m" {"b" 1} 0)))))
