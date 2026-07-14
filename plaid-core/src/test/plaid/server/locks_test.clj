(ns plaid.server.locks-test
  (:require [clojure.test :refer [deftest is use-fixtures]]
            [plaid.server.locks :as locks]))

(defn- clean-locks [f]
  (locks/reset-state!)
  (try (f) (finally (locks/reset-state!))))

(use-fixtures :each clean-locks)

(deftest acquire-result-reflects-the-atomic-transition
  (is (= :acquired (locks/acquire-lock! :document :first-user)))
  (is (= :refreshed (locks/acquire-lock! :document :first-user)))
  (is (= :conflict (locks/acquire-lock! :document :second-user)))
  (is (= :first-user (:user-id (locks/get-lock-info :document)))))
