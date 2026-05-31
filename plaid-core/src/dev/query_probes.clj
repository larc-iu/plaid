(ns query-probes
  "Synthetic linguistic data generator for performance probing.

  Ported from the v2 file of the same name. We bypass `submit-operation!`
  and audit capture on purpose — the goal is to measure read-path planner
  behavior, not exercise the write pipeline.

  Workflow:
    (setup! {:projects 5 :docs-per-project 10 :tokens-per-doc 500})
    (count-summary)
    (teardown!)

  When the dev server is running on the worktree's `data/plaid.db`, just
  call these via REPL — the inserts commit through WAL so the running
  server sees them on the next query."
  (:require [plaid.sql.common :as psc]
            [plaid.server.config :as cfg]
            [clojure.string :as str]
            [next.jdbc :as jdbc])
  (:import [java.util UUID]))

(defn- db-path
  "Read the SQLite path from the dev config bundle. Loads directly so this
  works even when called from outside a started mount stack (e.g. from a
  separate process while the dev server is running)."
  []
  (or (-> (cfg/load-config! {:config-path "config/dev.edn"})
          :plaid.server.sql/config
          :main-db-path)
      "data/plaid.db"))

;; ---------- DataSource resolution ----------
;;
;; If the dev server is up its mount-state datasource is what we want.
;; Otherwise build one directly from config so this works in a bare REPL.

(defn- db
  "Resolve a DataSource for the probe writes. Prefers the running server's
  mount-managed datasource (so REPL and probe share a pool); falls back to
  opening a fresh HikariCP DataSource against the dev-config path when
  called outside a started mount stack."
  []
  (let [running (try
                  (when-let [v (resolve 'plaid.server.sql/datasource)]
                    (let [val (deref v)]
                      (when (or (instance? javax.sql.DataSource val)
                                (instance? java.sql.Connection val))
                        val)))
                  (catch Throwable _ nil))]
    (or running (psc/build-datasource (db-path)))))

;; ---------- ID helpers ----------

(defn- uuid [] (UUID/randomUUID))

(def ^:private probe-tag "probe::")

(defn- prj-name [i] (str probe-tag "p" i))

;; ---------- Data generation ----------

(def pos-values    ["NOUN" "VERB" "ADJ" "ADV" "DET" "PRON" "PART" "CCONJ"])
(def gloss-values  ["come" "go" "see" "the" "a" "of" "PPTC" "Kemal" "house" "run"])

(defn- mk-text-body [k]
  ;; "t000 t001 t002 …" — fixed 4-char tokens + 1 space = 5-char stride.
  (str/join " " (for [i (range k)] (format "t%03d" i))))

(defn- token-extents [k]
  ;; [begin end] for each token in the body produced above.
  (mapv (fn [i] [(* i 5) (+ (* i 5) 4)]) (range k)))

(defn- generate-project!
  "Insert one project's worth of data inside the given tx.

  Issues a small number of bulk INSERTs (one per table) rather than
  per-row inserts so this runs fast for large probe sizes."
  [tx {:keys [project-idx docs-per-project tokens-per-doc seed]}]
  (let [rnd       (java.util.Random. (long (+ seed (* project-idx 7919))))
        prj-id    (uuid)
        txtl-id   (uuid)
        tokl-id   (uuid)
        pos-sl    (uuid)
        gloss-sl  (uuid)
        body      (mk-text-body tokens-per-doc)
        extents   (token-extents tokens-per-doc)
        empty-cfg "{}"
        ;; ----- core layers -----
        _ (jdbc/execute! tx ["INSERT INTO projects (id, name, config) VALUES (?, ?, ?)"
                             (str prj-id) (prj-name project-idx) empty-cfg])
        _ (jdbc/execute! tx ["INSERT INTO text_layers (id, name, project_id, order_idx, config) VALUES (?, ?, ?, 0, ?)"
                             (str txtl-id) "txtl" (str prj-id) empty-cfg])
        _ (jdbc/execute! tx ["INSERT INTO token_layers (id, name, text_layer_id, project_id, overlap_mode, order_idx, config) VALUES (?, ?, ?, ?, 'any', 0, ?)"
                             (str tokl-id) "tokl" (str txtl-id) (str prj-id) empty-cfg])
        _ (jdbc/execute! tx ["INSERT INTO span_layers (id, name, token_layer_id, project_id, order_idx, config) VALUES (?, ?, ?, ?, 0, ?)"
                             (str pos-sl) "pos" (str tokl-id) (str prj-id) empty-cfg])
        _ (jdbc/execute! tx ["INSERT INTO span_layers (id, name, token_layer_id, project_id, order_idx, config) VALUES (?, ?, ?, ?, 1, ?)"
                             (str gloss-sl) "gloss" (str tokl-id) (str prj-id) empty-cfg])
        ;; ----- per-document data, collected into bulk batches -----
        ts (psc/now-iso)
        docs (atom [])
        texts (atom [])
        tokens (atom [])
        spans (atom [])
        span-tokens (atom [])]
    (doseq [doc-idx (range docs-per-project)]
      (let [doc-id (uuid)
            text-id (uuid)
            token-ids (vec (repeatedly tokens-per-doc uuid))]
        (swap! docs conj [(str doc-id) (str "d" doc-idx) (str prj-id) 1 ts ts])
        (swap! texts conj [(str text-id) body (str doc-id) (str txtl-id)])
        (dotimes [i tokens-per-doc]
          (let [[b e] (nth extents i)
                tid (nth token-ids i)]
            (swap! tokens conj [(str tid) (str text-id) (str tokl-id) (str doc-id) b e])
            (when (< (.nextDouble rnd) 0.8)
              (let [sid (uuid)
                    v (nth pos-values (mod i (count pos-values)))]
                (swap! spans conj [(str sid) (str pos-sl) (str doc-id) (psc/write-json v)])
                (swap! span-tokens conj [(str sid) (str tid) 0])))
            (when (< (.nextDouble rnd) 0.3)
              (let [sid (uuid)
                    v (nth gloss-values (mod (+ i project-idx) (count gloss-values)))]
                (swap! spans conj [(str sid) (str gloss-sl) (str doc-id) (psc/write-json v)])
                (swap! span-tokens conj [(str sid) (str tid) 0])))))))
    ;; Flush each table in one batched INSERT. next.jdbc/execute-batch! sends
    ;; a single prepared statement with N parameter sets, avoiding SQLite's
    ;; per-statement overhead.
    (when (seq @docs)
      (jdbc/execute-batch! tx
                           "INSERT INTO documents (id, name, project_id, version, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)"
                           @docs {}))
    (when (seq @texts)
      (jdbc/execute-batch! tx
                           "INSERT INTO texts (id, body, document_id, text_layer_id) VALUES (?, ?, ?, ?)"
                           @texts {}))
    (when (seq @tokens)
      (jdbc/execute-batch! tx
                           "INSERT INTO tokens (id, text_id, token_layer_id, document_id, begin, end_) VALUES (?, ?, ?, ?, ?, ?)"
                           @tokens {}))
    (when (seq @spans)
      (jdbc/execute-batch! tx
                           "INSERT INTO spans (id, span_layer_id, document_id, value) VALUES (?, ?, ?, ?)"
                           @spans {}))
    (when (seq @span-tokens)
      (jdbc/execute-batch! tx
                           "INSERT INTO span_tokens (span_id, token_id, order_idx) VALUES (?, ?, ?)"
                           @span-tokens {}))
    {:project-id prj-id
     :docs (count @docs)
     :tokens (count @tokens)
     :spans (count @spans)}))

(defn setup!
  "Generate synthetic data. Defaults: {:projects 5 :docs-per-project 10
  :tokens-per-doc 500 :seed 42}. Each project's rows go in a single tx;
  multiple projects → multiple txs (so SQLite WAL can checkpoint between)."
  [opts]
  (let [{:keys [projects docs-per-project tokens-per-doc seed]
         :or {projects 5 docs-per-project 10 tokens-per-doc 500 seed 42}} opts
        ds (db)
        start (System/currentTimeMillis)]
    (doseq [i (range projects)]
      (jdbc/with-transaction [tx ds]
        (generate-project! tx {:project-idx i
                               :docs-per-project docs-per-project
                               :tokens-per-doc tokens-per-doc
                               :seed seed})))
    (let [dur (- (System/currentTimeMillis) start)
          total-docs (* projects docs-per-project)
          total-tokens (* total-docs tokens-per-doc)]
      {:projects projects
       :docs total-docs
       :tokens total-tokens
       :duration-ms dur})))

(defn count-summary
  "Quick sanity counts of probe data."
  []
  (let [ds (db)
        like (str probe-tag "%")
        cnt #(-> (psc/q ds %) first :c)]
    {:probe-projects   (cnt ["SELECT COUNT(*) c FROM projects WHERE name LIKE ?" like])
     :probe-documents  (cnt ["SELECT COUNT(*) c FROM documents d JOIN projects p ON d.project_id = p.id WHERE p.name LIKE ?" like])
     :probe-tokens     (cnt ["SELECT COUNT(*) c FROM tokens t JOIN token_layers tl ON t.token_layer_id = tl.id JOIN projects p ON tl.project_id = p.id WHERE p.name LIKE ?" like])
     :probe-spans-pos  (cnt ["SELECT COUNT(*) c FROM spans s JOIN span_layers sl ON s.span_layer_id = sl.id JOIN projects p ON sl.project_id = p.id WHERE sl.name = 'pos' AND p.name LIKE ?" like])
     :probe-spans-gl   (cnt ["SELECT COUNT(*) c FROM spans s JOIN span_layers sl ON s.span_layer_id = sl.id JOIN projects p ON sl.project_id = p.id WHERE sl.name = 'gloss' AND p.name LIKE ?" like])}))

(defn probe-project-ids
  []
  (->> (psc/q (db) ["SELECT id FROM projects WHERE name LIKE ?" (str probe-tag "%")])
       (mapv :id)))

(defn teardown!
  "Erase synthetic probe data. ON DELETE CASCADE on the project FK
  sweeps everything else (text_layers → tokens → spans → span_tokens,
  documents → ...). Returns the post-teardown count summary."
  []
  (let [ds (db)
        prj-ids (probe-project-ids)]
    (when (seq prj-ids)
      (let [ph (str/join ", " (repeat (count prj-ids) "?"))]
        (jdbc/execute! ds (into [(str "DELETE FROM projects WHERE id IN (" ph ")")]
                                (mapv str prj-ids)))))
    {:deleted (count prj-ids)
     :remaining (count-summary)}))
