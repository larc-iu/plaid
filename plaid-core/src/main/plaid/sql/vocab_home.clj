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

  0. Check every plan an earlier, stopped run made (`replan-broken!`): a
     planned home that is no longer a live project linking the vocabulary
     (the old version ran in between and unlinked or deleted it) is cleared,
     with its marker, so the rule plans that vocabulary again. Then refuse
     while a vocabulary no live project links exists, naming each and the
     script that gives it a project (`vocab_home_orphans.py`, run against the
     server before upgrading). Nothing else is written.
  1. Add the column if it is missing, then, in one transaction, set the home
     of every vocabulary that has none by `home-rule`, from the data as it is.
     Unaudited: step 2 audits it. The plan is fixed here, so a restart cannot
     choose differently once step 2 has promoted people, unless step 0 finds
     it broken.
  2. One audited operation per vocabulary, under its home, by nobody: each of
     its maintainers who does not maintain the home is made a maintainer there
     (from reader, writer or no role). A deactivated account is not made one,
     and is named in the log. The vocabulary row is recorded with its
     `project_id`. A marker `vocab-home:<id>` in `data_migrations`, written in
     the same transaction, makes a restart skip it.
  3. Refuse unless every vocabulary's home is a live project holding its
     `project_vocabs` row. Make maintainer of its home every vocabulary
     maintainer still not one, as step 2 does (the old version may have added
     one after step 2 audited the vocabulary), each in an audited operation
     by nobody. Rebuild `vocab_layers` with the column NOT NULL and
     the foreign key, and drop `vocab_maintainers`, on one connection with foreign keys off (with
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
            [plaid.sql.operation :as op :refer [submit-operation!]]
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

(def orphan-script
  "Where an operator finds the script that gives an unlinked vocabulary a
  project, and how it runs."
  (str "plaid-core/scripts/vocab_home_orphans.py, in the Plaid repository, against the server on the version "
       "before this one: python vocab_home_orphans.py BASE_URL TOKEN_FILE, with an admin's API token in the file"))

(defn- orphans
  "Every vocabulary no live project links and with no home yet, as maps of `:id`,
  `:name` and `:entries`."
  [ds]
  (q ds (str "SELECT v.id, v.name, (SELECT count(*) FROM vocab_items i WHERE i.vocab_layer_id = v.id) AS entries "
             "FROM vocab_layers v "
             "WHERE NOT EXISTS (SELECT 1 FROM project_vocabs pv JOIN projects p ON p.id = pv.project_id "
             "                  WHERE pv.vocab_layer_id = v.id AND p.deleted_at IS NULL)"
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
       ". Run " orphan-script " (see the manual's Upgrading section)."))

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

(defn- candidates
  "The live projects that link `vocab-id`, as `home-rule` takes them."
  [con vocab-id]
  (q con (str "SELECT pv.project_id, "
              "(SELECT count(*) FROM vocab_maintainers vm JOIN project_users pu "
              "   ON pu.user_id = vm.user_id AND pu.project_id = pv.project_id AND pu.role = 'maintainer' "
              "   JOIN users u ON u.id = vm.user_id AND u.deactivated_at IS NULL "
              " WHERE vm.vocab_layer_id = pv.vocab_layer_id) AS maintainers, "
              "(SELECT count(*) FROM vocab_links l JOIN vocab_items i ON i.id = l.vocab_item_id "
              "   JOIN documents d ON d.id = l.document_id "
              " WHERE i.vocab_layer_id = pv.vocab_layer_id AND d.project_id = pv.project_id) AS links "
              "FROM project_vocabs pv JOIN projects p ON p.id = pv.project_id "
              "WHERE pv.vocab_layer_id = ? AND p.deleted_at IS NULL")
     vocab-id))

(def ^:private broken-plans-sql
  "The vocabularies whose planned home is not a live project holding their
  `project_vocabs` row, with why."
  (str "SELECT v.id, v.name, v.project_id, p.name AS project_name, "
       "CASE WHEN p.id IS NULL THEN 'no longer exists' "
       "     WHEN p.deleted_at IS NOT NULL THEN 'is being deleted' "
       "     ELSE 'no longer links it' END AS why "
       "FROM vocab_layers v LEFT JOIN projects p ON p.id = v.project_id "
       "WHERE v.project_id IS NOT NULL AND (p.id IS NULL OR p.deleted_at IS NOT NULL OR NOT EXISTS "
       "  (SELECT 1 FROM project_vocabs pv WHERE pv.project_id = v.project_id AND pv.vocab_layer_id = v.id)) "
       "ORDER BY v.id"))

(defn- replan-broken!
  "Step 0. Clear the plan of every vocabulary whose planned home no longer
  holds (`broken-plans-sql`): the old version ran on the database after a
  stopped run of this migration and unlinked the vocabulary from that
  project, or deleted the project. Its home and its marker go, so steps 1
  and 2 plan and audit it again by the rule, from the data as it is now:
  never a home that does not link it, nor one whose removal would take the
  vocabulary with it. People promoted by the old plan stay maintainers
  (nothing is taken away), and the warning names the vocabulary's
  maintainers who maintain the dropped home. The vocabulary's History keeps
  the dropped plan's `vocab/home` entry, and step 2's new one follows it.
  Returns how many plans were cleared."
  [ds]
  (if-not (column ds "vocab_layers" "project_id")
    0
    (psd/with-tx [tx ds]
      (let [broken (q tx broken-plans-sql)]
        (doseq [{:keys [id name project_id project_name why]} broken
                :let [stay (q tx (str "SELECT vm.user_id FROM vocab_maintainers vm "
                                      "JOIN users u ON u.id = vm.user_id AND u.deactivated_at IS NULL "
                                      "JOIN project_users pu ON pu.user_id = vm.user_id AND pu.project_id = ? "
                                      "  AND pu.role = 'maintainer' "
                                      "WHERE vm.vocab_layer_id = ? ORDER BY vm.user_id")
                              project_id id)]]
          (log/warn (str (format "Vocabulary \"%s\" (%s): its planned home %s(%s) %s since the plan was made. Planning it again"
                                 name id (if project_name (str "\"" project_name "\" ") "") project_id why)
                         (when (seq stay)
                           (format ". Its maintainers stay maintainers of \"%s\": %s"
                                   project_name (str/join ", " (map :user_id stay))))))
          (q tx "UPDATE vocab_layers SET project_id = NULL WHERE id = ?" id)
          (q tx "DELETE FROM data_migrations WHERE id = ?" (str "vocab-home:" id)))
        (count broken)))))

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

(defn- log-promoted!
  "The line step 2 and step 3 log for the people `promoted`, pairs of user
  id and the role they had."
  [name id pname promoted]
  (when (seq promoted)
    (log/info (format "Vocabulary \"%s\" (%s): made maintainer of \"%s\": %s (were %s)"
                      name id pname (str/join ", " (map first promoted))
                      (str/join ", " (map second promoted))))))

(defn- home-one!
  "Step 2 for vocabulary `v` (a row of `vocab_layers`). Returns the people
  made maintainer."
  [ds {:keys [id name project_id] :as v}]
  (let [pname (:name (first (q ds "SELECT name FROM projects WHERE id = ?" project_id)))
        promoted (atom [])
        r (submit-operation! [tx ds (merge {:type :vocab/home
                                            :project project_id
                                            :document nil
                                            :user nil
                                            :skip-lock-check? true
                                            :skip-doc-version-bump? true}
                                           ;; Its History is read by borrowers too.
                                           (op/named-description project_id pname
                                                                 #(str "Vocabulary “" name "” belongs to " %)))]
                             (doseq [{:keys [user_id]} (q tx (str "SELECT vm.user_id FROM vocab_maintainers vm "
                                                                  "JOIN users u ON u.id = vm.user_id "
                                                                  "WHERE vm.vocab_layer_id = ? AND u.deactivated_at IS NULL "
                                                                  "ORDER BY vm.user_id")
                                                          id)
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
      (log-promoted! name id pname @promoted)
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

(defn- promote-left!
  "Step 3, inside its transaction on `con`, before `vocab_maintainers` is
  dropped. Step 2 skips a vocabulary it has audited, so a maintainer the old
  version added to one after that (it was run on the database between a
  stopped start and this one) would otherwise lose every right over it. Each
  such active account who does not maintain the vocabulary's home is made
  its maintainer, as step 2 does, in one audited operation by nobody. Then
  every vocabulary maintainer left out for a deactivated account is named,
  once for the whole run. Returns how many people were made maintainer."
  [con]
  (let [rows (q con (str "SELECT v.id, v.name, v.project_id, p.name AS project_name, vm.user_id, "
                         "u.deactivated_at IS NOT NULL AS deactivated "
                         "FROM vocab_maintainers vm JOIN vocab_layers v ON v.id = vm.vocab_layer_id "
                         "JOIN projects p ON p.id = v.project_id JOIN users u ON u.id = vm.user_id "
                         "WHERE NOT EXISTS (SELECT 1 FROM project_users pu WHERE pu.project_id = v.project_id "
                         "  AND pu.user_id = vm.user_id AND pu.role = 'maintainer') "
                         "ORDER BY v.id, vm.user_id"))]
    (reduce + 0
            (for [[[id name pid pname] rows] (group-by (juxt :id :name :project_id :project_name) rows)
                  :let [{active false deactivated true} (group-by #(= 1 (:deactivated %)) rows)]]
              (do
                (when (seq deactivated)
                  (log/info (format "Vocabulary \"%s\" (%s): not made maintainer of \"%s\", deactivated: %s"
                                    name id pname (str/join ", " (map :user_id deactivated)))))
                (let [promoted (doall
                                (for [{:keys [user_id]} active
                                      :let [was (role-word (prj/role-of con pid user_id))
                                            r (prj/grant-role con pid user_id "maintainer" nil)]]
                                  (if (:success r)
                                    [user_id was]
                                    (throw (ex-info (str "Making " user_id " maintainer of " pid " failed: " (:error r))
                                                    {:result r})))))]
                  (log-promoted! name id pname promoted)
                  (count promoted)))))))

(defn- rebuild!
  "Step 3. Returns how many people it made maintainer."
  [ds]
  (let [^java.sql.Connection con (.getConnection ^javax.sql.DataSource ds)]
    (try
      ;; No effect inside a transaction, so before BEGIN.
      (exec! con "PRAGMA foreign_keys = OFF")
      (exec! con "BEGIN IMMEDIATE")
      (try
        (do
          (when-let [bad (seq (q con (str "SELECT v.id, v.name FROM vocab_layers v WHERE v.project_id IS NULL OR "
                                          "NOT EXISTS (SELECT 1 FROM projects p JOIN project_vocabs pv ON pv.project_id = p.id "
                                          "  WHERE p.id = v.project_id AND p.deleted_at IS NULL AND pv.vocab_layer_id = v.id)")))]
            (throw (ex-info (str "The database was not migrated: " (count bad)
                                 (if (= 1 (count bad)) " vocabulary has" " vocabularies have")
                                 " no live project linking it as its home: "
                                 (str/join ", " (map (fn [{:keys [id name]}] (str "\"" name "\" (" id ")")) bad))
                                 ". Start the server again: the migration plans them again.")
                            {})))
          (let [late (promote-left! con)
                before (counts con)]
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
            (exec! con "COMMIT")
            late))
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
      (replan-broken! ds)
      (when-let [found (seq (orphans ds))]
        (throw (ex-info (orphans-refusal found) {:orphans (mapv :id found)})))
      (let [steps (plan! ds)
            {:keys [vocabularies promoted]} (home-all! ds)]
        ;; A resumed run plans and audits only what the stopped one had not,
        ;; so each count is this run's.
        (let [late (rebuild! ds)]
          (log/info (format (str "Vocabulary homes: planned %d (%d the only project linking them, %d by maintainers, "
                                 "%d by links, %d by id), audited %d, people made maintainer %d")
                            (reduce + 0 (vals steps)) (get steps 0 0) (get steps 1 0) (get steps 2 0) (get steps 3 0)
                            vocabularies (+ promoted late))))))))

(defn down [_config]
  (throw (ex-info "This migration cannot be undone: restore the copy taken before upgrading." {})))
