(ns plaid.rest-api.v1.vocab-layers-refusal-test
  "Every bulk vocab write checks write access on each distinct vocab layer its
  entries touch, not only the first entry's (`pra/vocab-layers-refusal`). One
  case per vocab item route that runs the check. The vocab link bulk delete
  runs it too, but a link lives in a project the vocabulary is granted to,
  and a writer there may write the vocabulary, so no request reaches its 403."
  (:require [clojure.string :as str]
            [clojure.test :refer :all]
            [plaid.fixtures :refer [with-db with-mount-states with-rest-handler
                                    admin-request assert-created assert-forbidden
                                    with-admin with-test-users user1-request with-clean-db]]
            [plaid.test-helpers :refer :all]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin with-test-users)
(use-fixtures :each with-clean-db)

(def ^:private user1 "user1@example.com")

(defn- setup
  "user1 writes on project P, which holds V1. V2 is granted to a project user1
  is not on, so user1 may write V1 and not V2."
  []
  (let [proj (create-test-project admin-request "Bug hunt fix META writable")
        other (create-test-project admin-request "Bug hunt fix META other")
        v1 (-> (create-vocab-layer admin-request "V1") :body :id)
        v2 (-> (create-vocab-layer admin-request "V2") :body :id)]
    (link-vocab-to-project admin-request proj v1)
    (link-vocab-to-project admin-request other v2)
    (add-project-writer admin-request proj user1)
    {:proj proj :v1 v1 :v2 v2
     :a (-> (create-vocab-item admin-request v1 "dogs") :body :id)
     :b (-> (create-vocab-item admin-request v2 "run") :body :id)}))

(defn- refuses-v2 [res v2]
  (assert-forbidden res)
  (let [msg (str (-> res :body :error))]
    (is (str/includes? msg "lacks write access to vocab layer(s)") msg)
    (is (str/includes? msg (str v2)) msg)))

(deftest bulk-vocab-item-writes-check-every-layer
  (let [{:keys [v1 v2 a b]} (setup)]
    (testing "bulk create"
      (refuses-v2 (bulk-create-vocab-items user1-request [{:vocab-layer-id v1 :form "x"}
                                                          {:vocab-layer-id v2 :form "y"}])
                  v2))
    (testing "bulk update"
      (refuses-v2 (bulk-update-vocab-items user1-request [{:id a :form "dog"} {:id b :form "ran"}]) v2))
    (testing "bulk delete"
      (refuses-v2 (bulk-delete-vocab-items user1-request [a b]) v2))
    (testing "nothing was written"
      (is (= "dogs" (-> (get-vocab-item admin-request a) :body :vocab-item/form)))
      (is (= "run" (-> (get-vocab-item admin-request b) :body :vocab-item/form))))))
