(ns plaid.sql.query.sql-snapshot-test
  "The SQL the query language runs, for every query the query tests run, held
  in a fixture: a change to the compiler that changes no SQL is a pure move,
  and this says so. Each test of `corpus` runs here as it runs on its own,
  each statement a query sends to SQLite is kept under the test that sent it,
  with every id written <id> (ids are new on each run), and the whole is
  compared with `fixture`. A compiler change that is meant to change the SQL
  writes the fixture again: run this namespace with PLAID_WRITE_SQL_SNAPSHOT=1
  and read the diff."
  (:require [clojure.edn :as edn]
            [clojure.java.io :as io]
            [clojure.pprint :as pprint]
            [clojure.string :as str]
            [clojure.test :as test :refer [deftest is]]
            [plaid.sql.common :as psc]
            [plaid.sql.query.exec :as qe]))

(def ^:private corpus
  "Every namespace of query tests whose queries are the same on each run: not
  the property and oracle tests (random queries), the scale test (slow) or
  the queue test (queries from several threads at once)."
  '[plaid.rest-api.v1.query-test
    plaid.rest-api.v1.query-keyed-and-batched-test
    plaid.sql.query.exec-aggregate-test
    plaid.sql.query.exec-attrpred-test
    plaid.sql.query.exec-bindings-test
    plaid.sql.query.exec-canonical-paths-test
    plaid.sql.query.exec-closure-paths-test
    plaid.sql.query.exec-closure-test
    plaid.sql.query.exec-document-test
    plaid.sql.query.exec-fieldpath-test
    plaid.sql.query.exec-layerrel-test
    plaid.sql.query.exec-layervar-test
    plaid.sql.query.exec-link-test
    plaid.sql.query.exec-literal-rules-test
    plaid.sql.query.exec-m2-test
    plaid.sql.query.exec-m3-test
    plaid.sql.query.exec-m4-test
    plaid.sql.query.exec-metadata-test
    plaid.sql.query.exec-not-test
    plaid.sql.query.exec-or-test
    plaid.sql.query.exec-orderby-test
    plaid.sql.query.exec-reference-test
    plaid.sql.query.exec-regex-test
    plaid.sql.query.exec-review2-test
    plaid.sql.query.exec-scalar-test
    plaid.sql.query.exec-scope-test
    plaid.sql.query.exec-spantopo-test
    plaid.sql.query.exec-test])

(def ^:private fixture "src/test/plaid/sql/query/sql_snapshot.edn")

(def ^:private uuid-re
  #"(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")

(defn- scrub [x]
  (cond
    (uuid? x) "<id>"
    (string? x) (str/replace x uuid-re "<id>")
    :else (pr-str x)))

(def ^:private ^:dynamic *in-query* false)

(defn- run-corpus
  "Run every test of `corpus`, as `{\"ns/test\" [[sql & params] ...]}`, and
  the failures and errors they reported."
  []
  (let [seen (atom (sorted-map))
        problems (atom [])
        q psc/q
        on-connection @#'qe/run-on-connection]
    (with-redefs [psc/q (fn [& [_ query :as args]]
                          (when *in-query*
                            (let [k (some-> (first test/*testing-vars*) symbol str)]
                              (swap! seen update k (fnil conj [])
                                     (mapv scrub (psc/format-sql query)))))
                          (binding [*in-query* false] (apply q args)))
                  qe/run-on-connection (fn [conn f deadline]
                                         (on-connection conn
                                                        (fn [c] (binding [*in-query* true] (f c)))
                                                        deadline))]
      (binding [test/report (fn [m]
                              (when (#{:fail :error} (:type m))
                                (swap! problems conj (select-keys m [:type :message :expected :actual]))))]
        (doseq [n corpus]
          (require n)
          (test/test-vars (->> (ns-interns n) vals (filter (comp :test meta)) (sort-by str))))))
    {:seen @seen :problems @problems}))

(defn- write! [seen]
  (with-open [w (io/writer fixture)]
    (binding [*out* w, pprint/*print-right-margin* 120]
      (println ";; Written by plaid.sql.query.sql-snapshot-test. Do not edit by hand.")
      (pprint/pprint seen))))

(deftest every-query-runs-the-sql-the-fixture-holds
  (let [{:keys [seen problems]} (run-corpus)]
    (is (empty? problems) "a test of the corpus failed on its own")
    (is (< 500 (reduce + (map count (vals seen)))) "the corpus ran its queries")
    (if (System/getenv "PLAID_WRITE_SQL_SNAPSHOT")
      (write! seen)
      (let [held (edn/read-string (slurp fixture))
            differ (remove #(= (get held %) (get seen %)) (distinct (concat (keys held) (keys seen))))]
        (is (empty? differ)
            (str "the SQL differs under " (count differ) " test(s), first " (first differ)
                 ": held " (pr-str (get held (first differ)))
                 " ran " (pr-str (get seen (first differ)))))))))
