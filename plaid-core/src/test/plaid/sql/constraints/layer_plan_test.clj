(ns plaid.sql.constraints.layer-plan-test
  "The chunk queries of the incremental checks look their ids up by their own
  index whatever the planner statistics say. The core's statistics refresh
  samples (`analysis_limit`), which caps every rows-per-layer estimate at
  about 401, so a layer equality next to an IN list of more ids than that
  used to walk the whole layer (H7-CORE-OPS-1). Each query is planned here
  under such capped statistics, in a transaction that is rolled back."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [next.jdbc :as jdbc]
            [plaid.sql.common :as psc]
            [plaid.sql.constraints.layer :as lc]
            [plaid.fixtures :refer [db with-db]]))

(use-fixtures :once with-db)

(def ^:private capped-stats
  "Statistics as `analysis_limit=400` leaves them on a big project."
  [["spans" "idx_spans_layer_value" "651086 401 4"]
   ["spans" "idx_spans_layer_doc" "651086 401 401"]
   ["spans" "idx_spans_document" "651086 401"]
   ["span_tokens" "idx_span_tokens_token" "700000 1"]
   ["span_tokens" "sqlite_autoindex_span_tokens_1" "700000 1 1"]
   ["relations" "idx_relations_layer_doc" "500000 401 401"]
   ["relations" "idx_relations_document" "500000 401"]
   ["relations" "idx_relations_source" "500000 2"]
   ["relations" "idx_relations_target" "500000 2"]
   ["tokens" "idx_tokens_layer_doc_begin" "700000 401 401 1"]
   ["tokens" "idx_tokens_layer_doc_end" "700000 401 37 1"]
   ["tokens" "idx_tokens_document" "700000 401"]
   ["tokens" "idx_tokens_text_begin_end" "700000 401 1 1"]
   ["vocab_link_tokens" "idx_vocab_link_tokens_token" "500000 1"]
   ["vocab_link_tokens" "sqlite_autoindex_vocab_link_tokens_1" "500000 1 1"]])

(defn- plan [tx query]
  (let [[sql & params] (psc/format-sql query)]
    (str/join " | " (map :detail (psc/q tx (into [(str "EXPLAIN QUERY PLAN " sql)] params))))))

(defn- with-capped-stats [f]
  (jdbc/with-transaction [tx db {:rollback-only true}]
    (psc/execute! tx ["ANALYZE spans"])
    (psc/execute! tx ["DELETE FROM sqlite_stat1"])
    (doseq [[tbl idx stat] capped-stats]
      (psc/execute! tx ["INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)" tbl idx stat]))
    ;; Reload the statistics on this connection.
    (psc/execute! tx ["ANALYZE sqlite_schema"])
    (f tx)))

(def ^:private ids (mapv #(str "00000000-0000-7000-8000-" (format "%012d" %)) (range 500)))
(def ^:private lid "00000000-0000-7000-8000-999999999999")

(deftest chunk-queries-search-by-their-ids
  (with-capped-stats
    (fn [tx]
      (testing "the statistics reproduce the layer walk for the shape as it was"
        (is (re-find #"SEARCH s USING (COVERING )?INDEX idx_spans_layer"
                     (plan tx {:select [:st.token_id :st.span_id :s.document_id]
                               :from [[:span_tokens :st]]
                               :join [[:spans :s] [:= :s.id :st.span_id]]
                               :where [:and [:= :s.span_layer_id lid] [:in :st.token_id ids]]}))))
      (testing "single-span looks the tokens up"
        (let [p (plan tx (#'lc/single-span-chunk lid ids))]
          (is (re-find #"SEARCH st USING INDEX idx_span_tokens_token" p) p)
          (is (not (re-find #"idx_spans_layer" p)) p)))
      (testing "single-link looks the tokens up"
        (let [p (plan tx (#'lc/single-link-chunk lid ids))]
          (is (re-find #"SEARCH vlt USING INDEX idx_vocab_link_tokens_token" p) p)
          (is (not (re-find #"idx_tokens_layer|idx_tokens_document" p)) p)))
      (testing "max-in-degree looks the targets up"
        (let [p (plan tx (#'lc/in-degree-chunk lid ids))]
          (is (re-find #"idx_relations_target" p) p)
          (is (not (re-find #"idx_relations_layer" p)) p)))
      (testing "same-ancestor looks the moved spans' relations up"
        (let [p (plan tx (#'lc/span-relations-chunk lid ids))]
          (is (re-find #"idx_relations_source" p) p)
          (is (re-find #"idx_relations_target" p) p)
          (is (not (re-find #"idx_relations_layer" p)) p))))))
