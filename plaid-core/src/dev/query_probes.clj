(ns query-probes
  "Engine probes for query-language design.

  Generates synthetic linguistic data and runs three queries to characterize
  the XTDB v2 planner's behavior on the patterns Plaid will need:

    1. ACL-style project filter pushdown   (cross-project narrowing)
    2. Contiguity self-join                 (CQP-style 'NOUN followed by VERB')
    3. Multi-layer span coverage via unnest (POS=NOUN ∧ gloss=X)

  Synthetic data is laid down with raw put-docs (bypassing the operation API)
  for speed and to avoid constraint/audit overhead — we are measuring the
  planner, not the write path."
  (:require [xtdb.api :as xt]
            [plaid.server.xtdb]
            [plaid.xtdb2.common :as pxc]
            [clojure.string :as str]))

(defn node [] plaid.server.xtdb/xtdb-node)

;; ---------- id helpers ----------

(defn- uuid [] (random-uuid))

(def ^:private probe-tag "probe::")

(defn- prj-name [i] (str probe-tag "p" i))

;; ---------- data generation ----------

(def pos-values    ["NOUN" "VERB" "ADJ" "ADV" "DET" "PRON" "PART" "CCONJ"])
(def gloss-values  ["come" "go" "see" "the" "a" "of" "PPTC" "Kemal" "house" "run"])

(defn- mk-text-body [k]
  ;; "t000 t001 t002 ..." — fixed 4-char tokens + 1 space = 5 chars stride
  (str/join " " (for [i (range k)] (format "t%03d" i))))

(defn- token-extents [k]
  ;; Pairs of [begin end] for each token in the body produced above.
  (mapv (fn [i] [(* i 5) (+ (* i 5) 4)]) (range k)))

(defn- generate-project!
  "Generate one project with N docs of K tokens each. Returns ids map."
  [{:keys [project-idx docs-per-project tokens-per-doc seed]}]
  (let [rnd       (java.util.Random. (long (+ seed (* project-idx 7919))))
        prj-id    (uuid)
        txtl-id   (uuid)
        tokl-id   (uuid)
        pos-sl    (uuid)
        gloss-sl  (uuid)
        ;; layers
        layer-ops [[:put-docs :projects   {:xt/id prj-id
                                           :project/id prj-id
                                           :project/name (prj-name project-idx)
                                           :project/readers []
                                           :project/writers []
                                           :project/maintainers []
                                           :project/text-layers [txtl-id]
                                           :project/vocabs []}]
                   [:put-docs :text-layers {:xt/id txtl-id
                                            :text-layer/id txtl-id
                                            :text-layer/name "txtl"
                                            :text-layer/project prj-id
                                            :text-layer/token-layers [tokl-id]}]
                   [:put-docs :token-layers {:xt/id tokl-id
                                             :token-layer/id tokl-id
                                             :token-layer/name "tokl"
                                             :token-layer/project prj-id
                                             :token-layer/text-layer txtl-id
                                             :token-layer/overlap-mode :any
                                             :token-layer/span-layers [pos-sl gloss-sl]}]
                   [:put-docs :span-layers {:xt/id pos-sl
                                            :span-layer/id pos-sl
                                            :span-layer/name "pos"
                                            :span-layer/project prj-id
                                            :span-layer/token-layer tokl-id
                                            :span-layer/relation-layers []}]
                   [:put-docs :span-layers {:xt/id gloss-sl
                                            :span-layer/id gloss-sl
                                            :span-layer/name "gloss"
                                            :span-layer/project prj-id
                                            :span-layer/token-layer tokl-id
                                            :span-layer/relation-layers []}]]
        body      (mk-text-body tokens-per-doc)
        extents   (token-extents tokens-per-doc)
        doc-ops   (mapcat
                   (fn [doc-idx]
                     (let [doc-id (uuid)
                           text-id (uuid)
                           token-ids (vec (repeatedly tokens-per-doc uuid))
                           token-ops (mapv (fn [tid [b e]]
                                             [:put-docs :tokens
                                              {:xt/id tid :token/id tid
                                               :token/layer tokl-id
                                               :token/text text-id
                                               :token/document doc-id
                                               :token/begin b :token/end e}])
                                           token-ids extents)
                           pos-span-ops (->> token-ids
                                             (map-indexed
                                              (fn [i tid]
                                                (when (< (.nextDouble rnd) 0.8)
                                                  (let [sid (uuid)
                                                        v (nth pos-values (mod i (count pos-values)))]
                                                    [tid v [:put-docs :spans
                                                            {:xt/id sid :span/id sid
                                                             :span/layer pos-sl
                                                             :span/document doc-id
                                                             :span/tokens [tid]
                                                             :span/value v}]]))))
                                             (filter some?))
                           gloss-span-ops (->> token-ids
                                               (map-indexed
                                                (fn [i tid]
                                                  (when (< (.nextDouble rnd) 0.3)
                                                    (let [sid (uuid)
                                                          v (nth gloss-values (mod (+ i project-idx) (count gloss-values)))]
                                                      [:put-docs :spans
                                                       {:xt/id sid :span/id sid
                                                        :span/layer gloss-sl
                                                        :span/document doc-id
                                                        :span/tokens [tid]
                                                        :span/value v}]))))
                                               (filter some?))]
                       (concat
                        [[:put-docs :documents {:xt/id doc-id :document/id doc-id
                                                :document/name (str "d" doc-idx)
                                                :document/project prj-id}]
                         [:put-docs :texts {:xt/id text-id :text/id text-id
                                            :text/layer txtl-id :text/document doc-id
                                            :text/body body}]]
                        token-ops
                        (mapv #(nth % 2) pos-span-ops)
                        gloss-span-ops)))
                   (range docs-per-project))]
    (into [] (concat layer-ops doc-ops))))

(defn setup!
  "Generate synthetic data. Options:
     :projects 5  :docs-per-project 10  :tokens-per-doc 500  :seed 42
   Submits in one tx per project. Returns timing/scale info."
  [opts]
  (let [{:keys [projects docs-per-project tokens-per-doc seed]
         :or {projects 5 docs-per-project 10 tokens-per-doc 500 seed 42}} opts
        start (System/currentTimeMillis)]
    (doseq [i (range projects)]
      (let [ops (generate-project! {:project-idx i
                                    :docs-per-project docs-per-project
                                    :tokens-per-doc tokens-per-doc
                                    :seed seed})]
        (xt/execute-tx (node) ops)))
    (let [dur (- (System/currentTimeMillis) start)
          total-docs (* projects docs-per-project)
          total-tokens (* total-docs tokens-per-doc)]
      {:projects projects
       :docs total-docs
       :tokens total-tokens
       :duration-ms dur})))

(defn count-summary
  "Sanity-check counts of probe data."
  []
  {:probe-projects   (-> (xt/q (node) ["SELECT COUNT(*) c FROM projects WHERE project$name LIKE ?" (str probe-tag "%")]) first :c)
   :probe-documents  (-> (xt/q (node) ["SELECT COUNT(*) c FROM documents d JOIN projects p ON d.document$project = p._id WHERE p.project$name LIKE ?" (str probe-tag "%")]) first :c)
   :probe-tokens     (-> (xt/q (node)
                               ["SELECT COUNT(*) c FROM tokens t JOIN token_layers tl ON t.token$layer = tl._id JOIN projects p ON tl.token_layer$project = p._id WHERE p.project$name LIKE ?"
                                (str probe-tag "%")]) first :c)
   :probe-spans-pos  (-> (xt/q (node)
                               ["SELECT COUNT(*) c FROM spans s JOIN span_layers sl ON s.span$layer = sl._id JOIN projects p ON sl.span_layer$project = p._id WHERE sl.span_layer$name = 'pos' AND p.project$name LIKE ?"
                                (str probe-tag "%")]) first :c)
   :probe-spans-gl   (-> (xt/q (node)
                               ["SELECT COUNT(*) c FROM spans s JOIN span_layers sl ON s.span$layer = sl._id JOIN projects p ON sl.span_layer$project = p._id WHERE sl.span_layer$name = 'gloss' AND p.project$name LIKE ?"
                                (str probe-tag "%")]) first :c)})

(defn probe-project-ids
  "Return all probe-project ids."
  []
  (->> (xt/q (node) ["SELECT _id FROM projects WHERE project$name LIKE ?" (str probe-tag "%")])
       (mapv :xt/id)))

;; ---------- timing helper ----------

(defn- time-q [label q & [opts]]
  (let [start (System/nanoTime)
        rs (xt/q (node) q (or opts {}))
        ms (/ (- (System/nanoTime) start) 1e6)]
    (println (format "  %-30s %.2f ms  rows=%d" label ms (count rs)))
    {:label label :ms ms :rows (count rs)}))

(defn- explain-sql
  "Get a structured plan for a SQL query vector [sql & params]."
  [[sql & params]]
  (xt/q (node) (into [(str "EXPLAIN " sql)] params)))

(defn- pp-plan [plan-rows]
  ;; The plan is a vector of {:depth :op :explain} maps. Print one per line.
  (doseq [row plan-rows]
    (let [{:keys [depth op explain]} row
          indent (apply str (repeat (max 0 (count (str depth))) " "))]
      (println (format "    %s%s %s" indent (name op) (pr-str explain))))))

;; ---------- probe 1: ACL pushdown ----------

(defn- sql-acl-q [ids]
  (let [ph (str/join ", " (repeat (count ids) "?"))]
    (into [(str "SELECT s._id "
                "FROM spans s "
                "JOIN span_layers sl ON s.span$layer = sl._id "
                "WHERE sl.span_layer$project IN (" ph ") "
                "AND s.span$value = 'NOUN'")] ids)))

(defn- baseline-no-acl-q []
  ["SELECT s._id FROM spans s JOIN span_layers sl ON s.span$layer = sl._id WHERE s.span$value = 'NOUN'"])

(defn- sql-acl-only-q
  "Worst-case ACL: no value predicate, just project filter. Tests whether the
   planner has anything useful to push down when the query is 'all spans in
   project(s) X'."
  [ids]
  (let [ph (str/join ", " (repeat (count ids) "?"))]
    (into [(str "SELECT s._id "
                "FROM spans s "
                "JOIN span_layers sl ON s.span$layer = sl._id "
                "WHERE sl.span_layer$project IN (" ph ")")] ids)))

(defn probe-1-acl
  "Cross-project query that joins spans→span_layers and filters on
   span_layer$project IN (... user's readable projects ...).
   Tests SQL `IN` form (the production shape) at varying ACL sizes.
   Print plan + timings; compare to no-ACL baseline."
  []
  (let [all-ids (probe-project-ids)
        sizes   (sort (distinct [1
                                 (min 5 (count all-ids))
                                 (min 20 (count all-ids))
                                 (count all-ids)]))]
    (println "=== Probe 1: ACL pushdown ===")
    (println (format "  Total probe projects: %d" (count all-ids)))
    (time-q "no-ACL baseline" (baseline-no-acl-q))
    (doseq [n sizes]
      (let [ids (vec (take n all-ids))]
        (time-q (str "SQL acl=" n) (sql-acl-q ids))))
    (println "  --- worst case: ACL only, no value filter ---")
    (doseq [n sizes]
      (let [ids (vec (take n all-ids))]
        (time-q (str "SQL acl-only=" n) (sql-acl-only-q ids))))
    (println "  --- plan (acl=1, SQL) ---")
    (pp-plan (explain-sql (sql-acl-q (vec (take 1 all-ids)))))
    (println "  --- plan (acl-only=1, SQL) ---")
    (pp-plan (explain-sql (sql-acl-only-q (vec (take 1 all-ids)))))
    (when (>= (count all-ids) 5)
      (println "  --- plan (acl=5, SQL) ---")
      (pp-plan (explain-sql (sql-acl-q (vec (take 5 all-ids))))))))

;; ---------- probe 2: contiguity self-join ----------

(defn- sql-contiguity-q
  "Find (NOUN, VERB) span pairs where the noun's last token is immediately
   followed by the verb's first token (offset diff +1, same text and layer).
   Uses UNNEST + LATERAL on the span$tokens arrays. Filters to ids."
  [ids]
  (let [ph (str/join ", " (repeat (count ids) "?"))]
    (into [(str
            "SELECT s1._id n_id, s2._id v_id "
            "FROM spans s1, "
            "     span_layers sl1, "
            "     spans s2, "
            "     span_layers sl2, "
            "     UNNEST(s1.span$tokens) AS tn(tid1), "
            "     UNNEST(s2.span$tokens) AS tv(tid2), "
            "     tokens t1, tokens t2 "
            "WHERE s1.span$layer = sl1._id "
            "  AND s2.span$layer = sl2._id "
            "  AND t1._id = tn.tid1 "
            "  AND t2._id = tv.tid2 "
            "  AND s1.span$value = 'NOUN' AND s2.span$value = 'VERB' "
            "  AND sl1.span_layer$name = 'pos' AND sl2.span_layer$name = 'pos' "
            "  AND sl1.span_layer$project = sl2.span_layer$project "
            "  AND sl1.span_layer$project IN (" ph ") "
            "  AND t1.token$text = t2.token$text "
            "  AND t1.token$layer = t2.token$layer "
            "  AND t2.token$begin = t1.token$end + 1")] ids)))

(defn probe-2-contiguity
  "NOUN followed by VERB in the same text+layer. Measure 1-proj and all-proj scope.
   Inspect the plan to see how the planner handles the self-join + UNNEST."
  []
  (let [all-ids (probe-project-ids)
        one     (vec (take 1 all-ids))]
    (println "=== Probe 2: contiguity self-join ===")
    (time-q "SQL contiguity 1-proj"   (sql-contiguity-q one))
    (time-q "SQL contiguity all-proj" (sql-contiguity-q all-ids))
    (println "  --- plan (contiguity 1-proj, SQL) ---")
    (pp-plan (explain-sql (sql-contiguity-q one)))))

;; ---------- probe 3: multi-layer unnest coverage ----------

(defn- sql-coverage-q [ids]
  (let [ph (str/join ", " (repeat (count ids) "?"))]
    (into [(str
            "SELECT n._id n_id, g._id g_id "
            "FROM spans n, "
            "     span_layers sln, "
            "     spans g, "
            "     span_layers slg, "
            "     UNNEST(n.span$tokens) AS tn(t1), "
            "     UNNEST(g.span$tokens) AS tg(t2) "
            "WHERE n.span$layer = sln._id "
            "  AND g.span$layer = slg._id "
            "  AND n.span$value = 'NOUN' AND g.span$value = 'Kemal' "
            "  AND sln.span_layer$name = 'pos' AND slg.span_layer$name = 'gloss' "
            "  AND sln.span_layer$project = slg.span_layer$project "
            "  AND sln.span_layer$project IN (" ph ") "
            "  AND tn.t1 = tg.t2")] ids)))

(defn probe-3-coverage
  "POS=NOUN ∧ gloss=Kemal sharing >=1 token. Tests multi-layer unnest performance."
  []
  (let [all-ids (probe-project-ids)
        one     (vec (take 1 all-ids))]
    (println "=== Probe 3: multi-layer unnest coverage ===")
    (time-q "SQL coverage 1-proj"   (sql-coverage-q one))
    (time-q "SQL coverage all-proj" (sql-coverage-q all-ids))
    (println "  --- plan (coverage 1-proj, SQL) ---")
    (pp-plan (explain-sql (sql-coverage-q one)))))

(defn run-all []
  (println "------------------------------------------------------------")
  (println "Probe data summary:" (count-summary))
  (println "------------------------------------------------------------")
  (probe-1-acl)
  (probe-2-contiguity)
  (probe-3-coverage))

;; ---------- teardown ----------

(defn teardown!
  "Erase synthetic probe data. Returns counts after teardown for sanity."
  []
  (let [prj-ids (probe-project-ids)]
    (println "Tearing down" (count prj-ids) "probe projects...")
    (doseq [t [:relations :spans :tokens :texts :documents
               :span-layers :token-layers :text-layers :projects]
            :let [coln (str/replace (name t) "-" "_")
                  ph (str/join ", " (repeat (count prj-ids) "?"))
                  ;; Determine the project-ref column for each table.
                  col (case t
                        :projects       "_id"
                        :documents      "document$project"
                        :texts          "text$document"
                        :tokens         "token$document"
                        :spans          "span$document"
                        :relations      "relation$document"
                        :span-layers    "span_layer$project"
                        :token-layers   "token_layer$project"
                        :text-layers    "text_layer$project")]]
      (let [scope-ids
            (cond
              ;; doc-scoped: resolve docs first
              (#{:texts :tokens :spans :relations} t)
              (let [docs (->> (xt/q (node)
                                    (into [(str "SELECT _id FROM documents WHERE document$project IN (" ph ")")] prj-ids))
                              (mapv :xt/id))
                    dph (str/join ", " (repeat (count docs) "?"))]
                (when (seq docs)
                  (->> (xt/q (node)
                             (into [(str "SELECT _id FROM " coln " WHERE " col " IN (" dph ")")] docs))
                       (mapv :xt/id))))
              :else
              (->> (xt/q (node)
                         (into [(str "SELECT _id FROM " coln " WHERE " col " IN (" ph ")")] prj-ids))
                   (mapv :xt/id)))]
        (println "  " t "→" (count (or scope-ids [])) "rows")
        (when (seq scope-ids)
          (doseq [chunk (partition-all 500 scope-ids)]
            (xt/execute-tx (node)
                           (mapv (fn [id] [:delete-docs t id]) chunk))))))))
