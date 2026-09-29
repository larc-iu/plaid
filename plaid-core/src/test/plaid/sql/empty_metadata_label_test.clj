(ns plaid.sql.empty-metadata-label-test
  "An operation's description names metadata keys only when there are some.
  An empty metadata map read \"with 0 metadata keys\" in History."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is use-fixtures]]
            [plaid.sql.common :as psc]
            [plaid.fixtures :refer [db with-db with-mount-states with-rest-handler
                                    admin-request with-admin with-clean-db]]
            [plaid.test-helpers :refer [create-test-project create-test-document
                                        create-text-layer create-text]]))

(use-fixtures :once with-db with-mount-states with-rest-handler with-admin)
(use-fixtures :each with-clean-db)

(defn- description-of [op-type]
  (:description (psc/q1 db {:select [:description] :from [:operations]
                            :where [:= :op_type op-type]
                            :order-by [[:ts :desc]] :limit 1})))

(deftest a-create-with-empty-metadata-names-no-metadata-keys
  (let [p (create-test-project admin-request "Labels")
        d (create-test-document admin-request p "Doc")
        tl (-> (create-text-layer admin-request p "Text") :body :id)]
    (create-text admin-request tl d "hello" {})
    (let [desc (description-of "text/create")]
      (is (str/starts-with? desc "Create text in layer"))
      (is (not (str/includes? desc "metadata keys")) desc))))

(deftest a-create-with-metadata-still-counts-its-keys
  (let [p (create-test-project admin-request "Labels")
        d (create-test-document admin-request p "Doc")
        tl (-> (create-text-layer admin-request p "Text") :body :id)]
    (create-text admin-request tl d "hello" {:source "x"})
    (is (str/ends-with? (description-of "text/create") " with 1 metadata keys"))))
