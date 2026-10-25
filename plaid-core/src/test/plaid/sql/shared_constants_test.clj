(ns plaid.sql.shared-constants-test
  "Two of core's constants as case files the other packages read, so none of
  them scrapes core's source (beta review R2-TEST-12). The operation kinds
  have their own, `plaid.sql.operation-kinds-test`."
  (:require [clojure.data.json :as json]
            [clojure.java.io :as io]
            [clojure.test :refer [deftest is]]
            [plaid.query.clauses :as clauses]
            [plaid.sql.document :as doc]))

(defn- case-file [file]
  (json/read-str (slurp (io/file "src/test/plaid/sql" file))))

(deftest the-case-file-holds-the-regex-cap
  (is (= clauses/regex-max-len (get (case-file "regex_max_len.json") "max"))
      (str "src/test/plaid/sql/regex_max_len.json is stale: write plaid.query.clauses/regex-max-len "
           "into it, then SERVER_PATTERN_MAX in plaid-ui and plaid-agent follows")))

(deftest the-case-file-holds-the-metadata-reference-kinds
  (is (= (mapv name doc/metadata-reference-kinds)
         (get (case-file "metadata_reference_kinds.json") "kinds"))
      (str "src/test/plaid/sql/metadata_reference_kinds.json is stale: write "
           "plaid.sql.document/metadata-reference-kinds into it in the same order, then "
           "plaid-igt's REFERENCE_KINDS (src/import/native/references.js) follows")))
