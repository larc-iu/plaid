(ns plaid.sql.metadata-op-cases-test
  "Runs the shared metadata op case table against the server's op rules.
  plaid-client-js and plaid-client-py run the same file against their
  optimistic mirrors, so a rule changed here and not there fails a suite."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.string :as str]
            [clojure.test :refer [deftest is testing]]
            [plaid.sql.metadata :as psm]))

(def cases
  (-> (io/resource "plaid/sql/metadata_op_cases.json") slurp json/read-str (get "cases")))

(defn- ->op
  "A case's op as the REST layer hands it over: keyword top-level keys, and
  :value only when the case has one."
  [o]
  (cond-> {:op (get o "op") :path (get o "path")}
    (contains? o "value") (assoc :value (get o "value"))))

(deftest the-shared-case-table-is-there
  (is (< 40 (count cases))))

(deftest every-shared-case-holds-on-the-server
  (doseq [{:strs [name metadata ops result error] :as c} cases]
    (testing name
      (let [run #(psm/apply-metadata-ops metadata (mapv ->op ops))]
        (if (contains? c "error")
          (let [e (try (run) nil (catch clojure.lang.ExceptionInfo e e))]
            (is (some? e) "refused")
            (when e
              (is (= 400 (:code (ex-data e))))
              (is (str/includes? (ex-message e) error) (ex-message e))))
          (is (= result (run))))))))
