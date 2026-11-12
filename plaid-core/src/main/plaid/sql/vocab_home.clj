(ns plaid.sql.vocab-home
  "The migration that gives every vocabulary a home project
  (20261112120000-vocab-home-project.edn, 2026-11-12).

  Before it, a vocabulary stood alone, with its own maintainers in
  `vocab_maintainers`, and any number of projects linked it through
  `project_vocabs`. After it, `vocab_layers.project_id` names the one project
  the vocabulary belongs to (NOT NULL, ON DELETE CASCADE), its rights are that
  project's roles, and `vocab_maintainers` is gone. `project_vocabs` keeps
  every row, the home's included.

  `up` runs in steps, each safe to run again after a crash:

  0. Refuse while a vocabulary no project links exists, naming each and the
     script that gives it a project (`vocab_home_orphans.py`, run against the
     server before upgrading). Nothing is written.
  1. Add the column if it is missing, then, in one transaction, set the home
     of every vocabulary that has none by `home-rule`, from the data as it is.
     Unaudited: step 2 audits it. The plan is fixed here, so a restart cannot
     choose differently once step 2 has promoted people.
  2. One audited operation per vocabulary, under its home, by nobody: each of
     its maintainers who does not maintain the home is made a maintainer there
     (from reader, writer or no role), and the vocabulary row is recorded with
     its `project_id`. A marker `vocab-home:<id>` in `data_migrations`, written
     in the same transaction, makes a restart skip it.
  3. Rebuild `vocab_layers` with the column NOT NULL and the foreign key, and
     drop `vocab_maintainers`, on one connection with foreign keys off (with
     them on, dropping `vocab_layers` would cascade away every entry, link,
     project link and comment). Refused, and rolled back, when any row count
     moves or `PRAGMA foreign_key_check` finds a row. The connection is then
     discarded so no pooled connection keeps foreign keys off.

  A database already migrated (no `vocab_maintainers`, the column NOT NULL)
  is left as it is."
  (:require [clojure.string :as str]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.datasource :as psd]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.sql.project :as prj]
            [taoensso.timbre :as log]))

(def ^:dynamic *after-vocabulary*
  "For tests: called with the number of vocabularies step 2 has done, after
  each one, to cut a run short."
  nil)

(def ^:dynamic *before-rebuild-commit*
  "For tests: called inside step 3's transaction before its COMMIT, to cut
  the rebuild short."
  nil)

(def ^:private as-maps {:builder-fn rs/as-unqualified-maps})

(defn- q [con sql & args]
  (jdbc/execute! con (into [sql] args) as-maps))

(defn- exec! [^java.sql.Connection con ^String sql]
  (with-open [stmt (.createStatement con)]
    (.execute stmt sql)))

(defn- column [con table col]
  (first (filter #(= col (:name %)) (q con (str "PRAGMA table_info(" table ")")))))

(defn- table? [con table]
  (seq (q con "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?" table)))

(defn- migrated?
  "Has step 3 already run: no `vocab_maintainers`, and `project_id` NOT NULL?"
  [ds]
  (and (not (table? ds "vocab_maintainers"))
       (= 1 (:notnull (column ds "vocab_layers" "project_id")))))

;; ============================================================
;; Step 0: vocabularies no project links
;; ============================================================

(def orphan-script "vocab_home_orphans.py")

(defn- orphans
  "Every vocabulary no project links and with no home yet, as maps of `:id`,
  `:name` and `:entries`."
  [ds]
  (q ds (str "SELECT v.id, v.name, (SELECT count(*) FROM vocab_items i WHERE i.vocab_layer_id = v.id) AS entries "
             "FROM vocab_layers v "
             "WHERE NOT EXISTS (SELECT 1 FROM project_vocabs pv WHERE pv.vocab_layer_id = v.id)"
             (when (column ds "vocab_layers" "project_id") " AND v.project_id IS NULL")
             " ORDER BY v.name, v.id")))

(defn orphans-refusal
  "The message the migration refuses with while `found` (from `orphans`)
  exist."
  [found]
  (str (count found) (if (= 1 (count found)) " vocabulary is" " vocabularies are")
       " linked by no project: "
       (str/join ", " (map (fn [{:keys [id name entries]}]
                             (str "\"" name "\" (" id ", " entries (if (= 1 entries) " entry" " entries") ")"))
                           found))
       ". Run " orphan-script " against the server before upgrading (see the manual's Upgrading section)."))

;; ============================================================
;; Step 1: the plan
;; ============================================================

(defn home-rule
  "The home of a vocabulary among `candidates`, maps of `:project_id`,
  `:maintainers` (how many of the vocabulary's maintainers maintain that
  project) and `:links` (links into the vocabulary in that project's
  documents): the first by most maintainers, then most links, then the
  smallest project id as a string. Returns `[project-id step]`, `step` being
  0 when one project links it, else the rule's step that decided."
  [candidates]
  (let [ranked (sort-by (juxt (comp - :maintainers) (comp - :links) (comp str :project_id)) candidates)
        [a b] ranked]
    [(:project_id a)
     (cond
       (nil? b) 0
       (not= (:maintainers a) (:maintainers b)) 1
       (not= (:links a) (:links b)) 2
       :else 3)]))

(defn- candidates [con vocab-id]
  (q con (str "SELECT pv.project_id, "
              "(SELECT count(*) FROM vocab_maintainers vm JOIN project_users pu "
              "   ON pu.user_id = vm.user_id AND pu.project_id = pv.project_id AND pu.role = 'maintainer' "
              " WHERE vm.vocab_layer_id = pv.vocab_layer_id) AS maintainers, "
              "(SELECT count(*) FROM vocab_links l JOIN vocab_items i ON i.id = l.vocab_item_id "
              "   JOIN documents d ON d.id = l.document_id "
              " WHERE i.vocab_layer_id = pv.vocab_layer_id AND d.project_id = pv.project_id) AS links "
              "FROM project_vocabs pv WHERE pv.vocab_layer_id = ?")
     vocab-id))

(defn- names-of [con table ids]
  (into {} (for [id ids] [id (:name (first (q con (str "SELECT name FROM " table " WHERE id = ?") id)))])))

(defn- plan!
  "Step 1. Returns how many vocabularies each rule step decided."
  [ds]
  (when-not (column ds "vocab_layers" "project_id")
    (jdbc/execute! ds ["ALTER TABLE vocab_layers ADD COLUMN project_id TEXT"]))
  (psd/with-tx [tx ds]
    (reduce (fn [steps {:keys [id name]}]
              (let [cands (candidates tx id)
                    [home step] (home-rule cands)]
                (q tx "UPDATE vocab_layers SET project_id = ? WHERE id = ?" home id)
                (log/info (format "Vocabulary \"%s\" (%s): home \"%s\" (%s), linked by %d %s, %s"
                                  name id ((names-of tx "projects" [home]) home) home (count cands)
                                  (if (= 1 (count cands)) "project" "projects")
                                  (if (zero? step) "the only project linking it" (str "rule step " step " decided"))))
                (update steps step (fnil inc 0))))
            {}
            (q tx "SELECT id, name FROM vocab_layers WHERE project_id IS NULL ORDER BY id"))))

;; ============================================================
;; Step 2: audit and promote
;; ============================================================

(def ^:private role-word
  {:project/readers "reader" :project/writers "writer" nil "none"})

(defn- home-one!
  "Step 2 for vocabulary `v` (a row of `vocab_layers`). Returns the people
  made maintainer."
  [ds {:keys [id name project_id] :as v}]
  (let [pname (:name (first (q ds "SELECT name FROM projects WHERE id = ?" project_id)))
        promoted (atom [])
        r (submit-operation! [tx ds {:type :vocab/home
                                     :project project_id
                                     :document nil
                                     :description (str "Vocabulary “" name "” belongs to project “" pname "”")
                                     :user nil
                                     :skip-lock-check? true
                                     :skip-doc-version-bump? true}]
                             (doseq [{:keys [user_id]} (q tx "SELECT user_id FROM vocab_maintainers WHERE vocab_layer_id = ? ORDER BY user_id" id)
                                     :let [role (prj/role-of tx project_id user_id)]
                                     :when (not= :project/maintainers role)]
                               (prj/add-role! tx project_id user_id "maintainer")
                               (swap! promoted conj [user_id (role-word role)]))
                             (let [row (first (q tx "SELECT * FROM vocab_layers WHERE id = ?" id))]
                               (psaw/record-audit-write! tx :vocab_layers id :update
                                                         (assoc row :project_id nil) row))
                             (q tx "INSERT INTO data_migrations (id) VALUES (?)" (str "vocab-home:" id)))]
    (when-not (:success r)
      (throw (ex-info (str "Giving vocabulary " id " its project failed: " (:error r)) {:result r})))
    (let [writers (:n (first (q ds (str "SELECT count(DISTINCT pu.user_id) AS n FROM project_vocabs pv "
                                        "JOIN project_users pu ON pu.project_id = pv.project_id "
                                        "WHERE pv.vocab_layer_id = ? AND pv.project_id <> ? "
                                        "AND pu.role IN ('writer', 'maintainer') "
                                        "AND NOT EXISTS (SELECT 1 FROM project_users h WHERE h.project_id = ? "
                                        "  AND h.user_id = pu.user_id AND h.role IN ('writer', 'maintainer'))")
                                id project_id project_id)))]
      (when (seq @promoted)
        (log/info (format "Vocabulary \"%s\" (%s): made maintainer of \"%s\": %s (were %s)"
                          name id pname (str/join ", " (map first @promoted))
                          (str/join ", " (map second @promoted)))))
      (when (pos? writers)
        (log/info (format "Vocabulary \"%s\" (%s): borrowers' writers losing entry writes: %d" name id writers))))
    (assoc v :promoted @promoted)))

(defn- home-all!
  "Step 2 for every vocabulary without its marker. Returns
  `{:vocabularies n :promoted n}`."
  [ds]
  (let [todo (q ds (str "SELECT v.* FROM vocab_layers v WHERE NOT EXISTS "
                        "(SELECT 1 FROM data_migrations m WHERE m.id = 'vocab-home:' || v.id) ORDER BY v.id"))]
    (loop [[v & more] todo, n 0, promoted 0]
      (if v
        (let [done (home-one! ds v)]
          (when *after-vocabulary* (*after-vocabulary* (inc n)))
          (recur more (inc n) (+ promoted (count (:promoted done)))))
        {:vocabularies n :promoted promoted}))))

;; ============================================================
;; Step 3: the rebuild
;; ============================================================

(def ^:private counted-tables
  "The tables whose rows the rebuild must leave as they are."
  ["vocab_layers" "vocab_items" "vocab_links" "vocab_link_tokens" "entity_metadata" "comments"
   "project_vocabs" "operations" "audit_writes"])

(defn- counts [con]
  (into {} (for [t counted-tables] [t (:n (first (q con (str "SELECT count(*) AS n FROM " t))))])))

(defn- rebuild!
  "Step 3."
  [ds]
  (let [^java.sql.Connection con (.getConnection ^javax.sql.DataSource ds)]
    (try
      ;; No effect inside a transaction, so before BEGIN.
      (exec! con "PRAGMA foreign_keys = OFF")
      (exec! con "BEGIN IMMEDIATE")
      (try
        (let [before (counts con)]
          (when-let [bad (seq (q con (str "SELECT v.id FROM vocab_layers v WHERE v.project_id IS NULL "
                                          "OR NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = v.project_id)")))]
            (throw (ex-info (str "Vocabularies without a project: " (str/join ", " (map :id bad))) {})))
          (exec! con "DROP TABLE IF EXISTS vocab_layers_new")
          (exec! con (str "CREATE TABLE vocab_layers_new ("
                          "id TEXT PRIMARY KEY, "
                          "name TEXT NOT NULL, "
                          "config TEXT NOT NULL DEFAULT '{}', "
                          "created_at TEXT NULL, "
                          "modified_at TEXT NULL, "
                          "project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE)"))
          (exec! con (str "INSERT INTO vocab_layers_new (id, name, config, created_at, modified_at, project_id) "
                          "SELECT id, name, config, created_at, modified_at, project_id FROM vocab_layers"))
          (exec! con "DROP TABLE vocab_layers")
          (exec! con "ALTER TABLE vocab_layers_new RENAME TO vocab_layers")
          (exec! con "CREATE INDEX idx_vocab_layers_project ON vocab_layers(project_id)")
          (exec! con "DROP TABLE vocab_maintainers")
          (when-let [rows (seq (mapcat #(q con (str "PRAGMA foreign_key_check(" % ")"))
                                       ["vocab_layers" "vocab_items" "project_vocabs" "comments"]))]
            (throw (ex-info (str "The rebuilt tables break " (count rows) " foreign keys, first " (pr-str (first rows))) {})))
          (let [after (counts con)]
            (when (not= before after)
              (throw (ex-info (str "The rebuild changed row counts: " (pr-str before) " to " (pr-str after)) {}))))
          (when *before-rebuild-commit* (*before-rebuild-commit*))
          (exec! con "COMMIT"))
        (catch Throwable t
          (try (exec! con "ROLLBACK") (catch Throwable _))
          (throw t)))
      (finally
        (try (exec! con "PRAGMA foreign_keys = ON") (catch Throwable _))
        (psd/discard-connection! ds con)
        (try (.close con) (catch Throwable _))))))

;; ============================================================
;; The migration
;; ============================================================

(defn up [config]
  (let [ds (get-in config [:db :datasource])]
    (when-not (migrated? ds)
      (when-let [found (seq (orphans ds))]
        (throw (ex-info (orphans-refusal found) {:orphans (mapv :id found)})))
      (let [steps (plan! ds)
            {:keys [vocabularies promoted]} (home-all! ds)]
        (rebuild! ds)
        (log/info (format (str "Vocabulary homes: %d vocabularies audited (%d the only project linking them, "
                               "%d by maintainers, %d by links, %d by id), %d people made maintainer")
                          vocabularies (get steps 0 0) (get steps 1 0) (get steps 2 0) (get steps 3 0)
                          promoted))))))

(defn down [_config]
  (throw (ex-info "This migration cannot be undone: restore the copy taken before upgrading." {})))
