(ns plaid.rest-api.v1.layer-config-routes-test
  "`layer-config-routes` takes the SQL table its rows live in. A table with no
  editor `:config` column is a route-definition mistake, and every caller
  builds its routes in a `def`, so it is caught at namespace load rather than
  on the first config write."
  (:require [clojure.test :refer :all]
            [plaid.rest-api.v1.layer :as layer]
            [plaid.sql.project :as prj]))

(deftest config-routes-reject-a-table-without-a-config-column
  (testing "a table outside config-tables throws where the route is built"
    (is (thrown-with-msg? clojure.lang.ExceptionInfo
                          #"Not a table that carries editor config"
                          (layer/layer-config-routes :tokens :id)))
    (is (thrown-with-msg? clojure.lang.ExceptionInfo
                          #"Not a table that carries editor config"
                          (layer/layer-config-routes :tokens :id (constantly nil)))))

  (testing "every table that carries one builds a route"
    (doseq [table prj/config-tables]
      (is (vector? (layer/layer-config-routes table :id)))
      (is (vector? (layer/layer-config-routes table :id (constantly nil)))))))
