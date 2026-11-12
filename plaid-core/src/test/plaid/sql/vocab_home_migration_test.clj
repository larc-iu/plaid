(ns plaid.sql.vocab-home-migration-test
  "The migration that gives every vocabulary a home project
  (20261112120000-vocab-home-project.edn, plaid.sql.vocab-home), on a
  database built by hand just before it, shaped like production's census of
  2026-11-11 and never from its data: 42 projects, 36 vocabularies, 31 of
  them linked by one project each with every vocabulary maintainer a
  maintainer of it, 6 of those with a project maintainer who is not one of
  the vocabulary's, 29 projects linking one, 1 linking two, 12 linking none,
  and 5 vocabularies no project links. Then the shapes production lacks: a
  vocabulary linked by two projects decided by maintainers, one by links, one
  by id, one linked by three, and vocabulary maintainers who are a reader, a
  writer and no member of the home. Entries with metadata, links in
  documents, a comment on an entry, and history before the migration."
  (:require [clojure.string :as str]
            [clojure.test :refer [deftest is testing use-fixtures]]
            [migratus.core :as migratus]
            [next.jdbc :as jdbc]
            [next.jdbc.result-set :as rs]
            [plaid.fixtures :refer [with-db with-mount-states]]
            [plaid.history.read :as hread]
            [plaid.server.project-removal :as removal]
            [plaid.server.sql :as server-sql]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [plaid.sql.document :as doc]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.sql.vocab-home :as vh]
            [plaid.test-helpers :refer [temp-db-path]]
            [taoensso.timbre :as log]))

(use-fixtures :once with-db with-mount-states)

(def ^:private migration 20261112120000)

(defn- cfg [ds] {:store :database :migration-dir "migrations" :db {:datasource ds}})

(defn- q [ds sql & args]
  (jdbc/execute! ds (into [sql] args) {:builder-fn rs/as-unqualified-maps}))

(defn- u
  "A fixed UUID for `s`, so two databases built alike have the same ids."
  [s]
  (str (java.util.UUID/nameUUIDFromBytes (.getBytes (str s) "UTF-8"))))

(defn- email [s] (str s "@census.example"))

;; ============================================================
;; Building the database as the old code left it
;; ============================================================

(defn- op!
  "Run `f` with a transaction inside one audited operation by nobody, as the
  old code's writes were."
  [ds type project f]
  (let [r (submit-operation! [tx ds {:type type :project project :document nil
                                     :description (name type) :user nil
                                     :skip-lock-check? true :skip-doc-version-bump? true}]
                             (f tx)
                             nil)]
    (when-not (:success r) (throw (ex-info "A fixture operation failed" {:result r})))))

(defn- ins! [tx table row]
  (psc/execute! tx {:insert-into table :values [row]}))

(defn- audited-ins!
  "Insert `row` and record it as the old code did, with `extras` folded into
  the image."
  [tx table row & [extras]]
  (ins! tx table row)
  (psaw/record-audit-write! tx table (:id row) :insert nil (merge row extras)))

(defn- user! [ds id]
  (when (empty? (q ds "SELECT 1 FROM users WHERE id = ?" id))
    (q ds "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, 'x', 0)" id id)))

(defn- project! [ds pid pname roles]
  (doseq [[uid _] roles] (user! ds uid))
  (op! ds :project/create pid
       (fn [tx]
         (audited-ins! tx :projects {:id pid :name pname :config "{}"})
         (doseq [[uid role] roles]
           (ins! tx :project_users {:project_id pid :user_id uid :role role})))))

(defn- vocab! [ds vid vname maintainers forms]
  (doseq [m maintainers] (user! ds m))
  (op! ds :vocab/create nil
       (fn [tx]
         (audited-ins! tx :vocab_layers {:id vid :name vname :config "{}"
                                         :created_at "2026-10-01T00:00:00.000000000Z"
                                         :modified_at "2026-10-01T00:00:00.000000000Z"}
                       {:maintainers (vec (sort maintainers))})
         (doseq [m maintainers] (ins! tx :vocab_maintainers {:vocab_layer_id vid :user_id m}))))
  (op! ds :vocab-item/create nil
       (fn [tx]
         (doseq [f forms
                 :let [iid (u (str vid ":" f))]]
           (audited-ins! tx :vocab_items {:id iid :form f :vocab_layer_id vid} {:metadata {"gloss" (str f "-gloss")}})
           (ins! tx :entity_metadata {:entity_type "vocab-item" :entity_id iid :key "gloss"
                                      :value (psc/write-json (str f "-gloss"))})))))

(defn- link-project! [ds pid vid]
  (op! ds :project/add-vocab pid (fn [tx] (ins! tx :project_vocabs {:project_id pid :vocab_layer_id vid}))))

(defn- document!
  "A document of `pid` whose tokens link to `items`, one token each, made by
  one operation as an import makes one."
  [ds pid items]
  (let [d (u (str "doc:" pid)) tl (u (str "tl:" pid)) tkl (u (str "tkl:" pid)) t (u (str "text:" pid))
        ts "2026-10-02T00:00:00.000000000Z"]
    (op! ds :text-layer/create pid
         (fn [tx]
           (audited-ins! tx :text_layers {:id tl :name "Text" :project_id pid :order_idx 0 :config "{}"})
           (audited-ins! tx :token_layers {:id tkl :name "Words" :text_layer_id tl :project_id pid
                                           :overlap_mode "any" :order_idx 0 :config "{}"})))
    (op! ds :document/create pid
         (fn [tx]
           (audited-ins! tx :documents {:id d :name "Doc" :name_key "doc" :project_id pid :version 1
                                        :created_at ts :modified_at ts})
           (ins! tx :texts {:id t :body (str/join " " (repeat (count items) "word")) :document_id d :text_layer_id tl})
           (doseq [[i item] (map-indexed vector items)
                   :let [tok (u (str "tok:" pid ":" i)) link (u (str "link:" pid ":" i))]]
             (ins! tx :tokens {:id tok :text_id t :token_layer_id tkl :document_id d :begin (* 5 i) :end_ (+ 4 (* 5 i))})
             (ins! tx :vocab_links {:id link :vocab_item_id item :document_id d})
             (ins! tx :vocab_link_tokens {:vocab_link_id link :token_id tok :order_idx 0}))))
    d))

(defn- item [vid form] (u (str vid ":" form)))

(defn- build!
  "The database just before the migration. Returns what the assertions need."
  [ds]
  (let [pids (mapv #(u (str "p" %)) (range 42))
        p (fn [i] (pids i))
        m (fn [i] (email (str "m" i)))
        extra #{0 1 2 3 4 5}]
    ;; 42 projects, each with its maintainer, 6 with a second one.
    (doseq [i (range 42)]
      (project! ds (p i) (str "P" i)
                (cond-> [[(m i) "maintainer"]]
                  (extra i) (conj [(email (str "e" i)) "maintainer"])
                  (= i 0) (conj [(email "reader") "reader"])
                  (= i 1) (conj [(email "writer") "writer"])
                  (= i 40) (conj [(email "borrower-writer") "writer"]))))
    ;; 31 vocabularies linked by one project each: p0..p28 one each, p29 two.
    (doseq [i (range 31)
            :let [home (min i 29)
                  vid (u (str "v" i))]]
      (vocab! ds vid (str "V" i)
              (cond-> [(m home)]
                (= i 0) (conj (email "reader"))
                (= i 1) (conj (email "writer"))
                (= i 2) (conj (email "stranger")))
              ["a" "b"])
      (link-project! ds (p home) vid))
    ;; 5 that no project links.
    (doseq [k (range 5)]
      (vocab! ds (u (str "o" k)) (str "Orphan " k) [(email (str "om" k))] ["a"]))
    ;; Shapes production lacks.
    (user! ds (email "xa")) (user! ds (email "xb")) (user! ds (email "xc")) (user! ds (email "xd")) (user! ds (email "xe"))
    (q ds "INSERT INTO project_users (project_id, user_id, role) VALUES (?, ?, 'maintainer'), (?, ?, 'maintainer'), (?, ?, 'maintainer')"
       (p 30) (email "xa") (p 30) (email "xb") (p 31) (email "xa"))
    (q ds "INSERT INTO project_users (project_id, user_id, role) VALUES (?, ?, 'maintainer'), (?, ?, 'maintainer')"
       (p 32) (email "xc") (p 33) (email "xc"))
    (q ds "INSERT INTO project_users (project_id, user_id, role) VALUES (?, ?, 'maintainer')" (p 37) (email "xe"))
    (vocab! ds (u "x1") "X1 by maintainers" [(email "xa") (email "xb")] ["a" "b"])
    (link-project! ds (p 30) (u "x1")) (link-project! ds (p 31) (u "x1"))
    (vocab! ds (u "x2") "X2 by links" [(email "xc")] ["a" "b"])
    (link-project! ds (p 32) (u "x2")) (link-project! ds (p 33) (u "x2"))
    (vocab! ds (u "x3") "X3 by id" [(email "xd")] ["a"])
    (link-project! ds (p 34) (u "x3")) (link-project! ds (p 35) (u "x3"))
    (vocab! ds (u "x4") "X4 linked by three" [(email "xe")] ["a"])
    (doseq [i [36 37 38]] (link-project! ds (p i) (u "x4")))
    ;; p40 borrows v0, so its writer loses entry writes.
    (link-project! ds (p 40) (u "v0"))
    ;; Documents with links, a comment on an entry, a rename before the migration.
    (let [d0 (document! ds (p 0) [(item (u "v0") "a") (item (u "v0") "b")])]
      (document! ds (p 29) [(item (u "v29") "a") (item (u "v30") "a")])
      (document! ds (p 32) [(item (u "x2") "a")])
      (document! ds (p 33) [(item (u "x2") "a") (item (u "x2") "b")])
      (q ds (str "INSERT INTO comments (id, vocab_layer_id, entity_type, entity_id, author_id, body, created_at, updated_at) "
                 "VALUES (?, ?, 'vocab-item', ?, ?, 'a note', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z')")
         (u "comment") (u "v0") (item (u "v0") "a") (m 0))
      (op! ds :vocab/update nil
           (fn [tx]
             (q tx "UPDATE vocab_layers SET name = 'V0 renamed' WHERE id = ?" (u "v0"))
             (psaw/record-audit-write! tx :vocab_layers (u "v0") :update nil
                                       (assoc (first (q tx "SELECT * FROM vocab_layers WHERE id = ?" (u "v0")))
                                              :maintainers (vec (sort [(m 0) (email "reader")]))))))
      {:p p :m m :d0 d0})))

(defn- give-orphans-projects!
  "What `vocab_home_orphans.py` does on the old server: a project per
  vocabulary no project links, named after it, its maintainers maintaining
  it, linking it."
  [ds]
  (doseq [k (range 5)]
    (let [pid (u (str "orphan-project" k))]
      (project! ds pid (str "Orphan " k) [[(email (str "om" k)) "maintainer"]])
      (link-project! ds pid (u (str "o" k))))))

;; ============================================================
;; Reading the database
;; ============================================================

(def ^:private kept-tables
  ["vocab_items" "vocab_links" "vocab_link_tokens" "entity_metadata" "comments" "project_vocabs"
   "documents" "tokens" "texts"])

(defn- counts [ds]
  (into {} (for [t (concat ["vocab_layers" "operations" "audit_writes" "project_users" "users" "projects"] kept-tables)]
             [t (:n (first (q ds (str "SELECT count(*) AS n FROM " t))))])))

(defn- schema [ds]
  {:migrations (q ds "SELECT id FROM schema_migrations ORDER BY id")
   :sql (q ds "SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
   :counts (counts ds)})

(defn- homes [ds] (into {} (map (juxt :id :project_id)) (q ds "SELECT id, project_id FROM vocab_layers")))

(defn- roles [ds] (set (map (juxt :project_id :user_id :role) (q ds "SELECT * FROM project_users"))))

(defn- with-temp-db [f]
  (let [path (temp-db-path)
        ds (psd/build-datasource path)]
    (try
      (migratus/migrate-until-just-before (cfg ds) migration)
      (f ds)
      (finally
        (.close ds)
        (doseq [suffix ["" "-wal" "-shm"]]
          (.delete (java.io.File. (str path suffix))))))))

(defn- latest-ts [ds] (:ts (first (q ds "SELECT max(ts) AS ts FROM operations"))))

;; ============================================================
;; The tests
;; ============================================================

(deftest the-migration-refuses-while-a-vocabulary-no-project-links-exists
  (with-temp-db
    (fn [ds]
      (build! ds)
      (let [before (schema ds)
            thrown (try (migratus/migrate (cfg ds)) nil (catch Exception e e))]
        (is (some? thrown) "the migration refuses")
        (let [msg (ex-message thrown)]
          (doseq [k (range 5)]
            (is (str/includes? msg (str "\"Orphan " k "\" (" (u (str "o" k)) ", 1 entry)")) msg))
          (is (str/starts-with? msg "5 vocabularies are linked by no project: "))
          (is (str/ends-with? msg (str "Run PYTHONPATH=plaid-client-py/src python3 "
                                       "plaid-core/scripts/vocab_home_orphans.py BASE_URL TOKEN_FILE from the top of a "
                                       "checkout of the Plaid repository, against the server on the version before "
                                       "this one, with an admin's named API token in the file (see the manual's "
                                       "Upgrading section)."))
              msg))
        (is (= before (schema ds)) "nothing was written, the migration is not recorded")))))

(deftest the-migration-gives-every-vocabulary-its-home-and-loses-nothing
  (with-temp-db
    (fn [ds]
      (let [{:keys [p m d0]} (build! ds)
            _ (give-orphans-projects! ds)
            before (counts ds)
            roles-before (roles ds)
            ts-before (latest-ts ds)
            v0-before (hread/get-vocab-at ds (u "v0") ts-before true)]
        (migratus/migrate (cfg ds))
        (testing "no row of any kept table is lost"
          (let [after (counts ds)]
            (is (= (select-keys before (concat ["vocab_layers" "users" "projects"] kept-tables))
                   (select-keys after (concat ["vocab_layers" "users" "projects"] kept-tables))))
            (is (= (+ (before "operations") 40) (after "operations")) "one operation per vocabulary")))
        (testing "the schema is the new one"
          (is (empty? (q ds "SELECT 1 FROM sqlite_master WHERE name = 'vocab_maintainers'")))
          (is (= 1 (:notnull (first (filter #(= "project_id" (:name %)) (q ds "PRAGMA table_info(vocab_layers)"))))))
          (is (= [{:table "projects" :from "project_id" :to "id" :on_delete "CASCADE"}]
                 (map #(select-keys % [:table :from :to :on_delete]) (q ds "PRAGMA foreign_key_list(vocab_layers)"))))
          (is (seq (q ds "SELECT 1 FROM sqlite_master WHERE name = 'idx_vocab_layers_project'")))
          (is (empty? (q ds "PRAGMA foreign_key_check")))
          (with-open [c (jdbc/get-connection ds)]
            (is (= 1 (:foreign_keys (jdbc/execute-one! c ["PRAGMA foreign_keys"] {:builder-fn rs/as-unqualified-maps})))
                "a pooled connection has foreign keys on")))
        (testing "each home is the rule's"
          (let [h (homes ds)]
            (doseq [i (range 31)] (is (= (p (min i 29)) (h (u (str "v" i)))) (str "v" i)))
            (is (= (p 30) (h (u "x1"))) "step 1: more of its maintainers maintain p30")
            (is (= (p 33) (h (u "x2"))) "step 2: a tie on maintainers, p33 has more links")
            (is (= (first (sort [(p 34) (p 35)])) (h (u "x3"))) "step 3: the smaller id")
            (is (= (p 37) (h (u "x4"))) "linked by three, step 1")
            (doseq [k (range 5)] (is (= (u (str "orphan-project" k)) (h (u (str "o" k))))))))
        (testing "the home row of every vocabulary is in project_vocabs"
          (is (empty? (q ds (str "SELECT v.id FROM vocab_layers v WHERE NOT EXISTS (SELECT 1 FROM project_vocabs pv "
                                 "WHERE pv.project_id = v.project_id AND pv.vocab_layer_id = v.id)")))))
        (testing "the vocabulary maintainers who did not maintain the home do now, and nobody else changed"
          (let [promoted #{[(p 0) (email "reader") "maintainer"] [(p 1) (email "writer") "maintainer"]
                           [(p 2) (email "stranger") "maintainer"]
                           [(first (sort [(p 34) (p 35)])) (email "xd") "maintainer"]}
                demoted #{[(p 0) (email "reader") "reader"] [(p 1) (email "writer") "writer"]}]
            (is (= (into (apply disj roles-before demoted) promoted) (roles ds)))))
        (testing "one vocab/home operation per vocabulary, under its home, by nobody"
          (let [ops (q ds "SELECT * FROM operations WHERE op_type = 'vocab/home'")
                h (homes ds)]
            (is (= 40 (count ops)))
            (is (every? #(nil? (:user_id %)) ops))
            (is (= (set (map (fn [[v pid]] [pid (count (filter #(= (:project_id %) pid) ops))]) h))
                   (set (map (fn [[pid os]] [pid (count os)]) (group-by :project_id ops))))))
          (is (= 40 (count (q ds "SELECT id FROM data_migrations WHERE id LIKE 'vocab-home:%'")))))
        (testing "the vocabulary's History lists its operations before and the migration's"
          (let [types (set (map :op_type (q ds (str "SELECT DISTINCT o.op_type FROM audit_writes aw JOIN operations o "
                                                    "ON o.id = aw.op_id WHERE aw.vocab_layer_id = ?")
                                            (u "v0"))))]
            (is (= #{"vocab/create" "vocab-item/create" "vocab/update" "vocab/home"} types))))
        (testing "the home's Activity lists the migration's operation and none from before"
          (is (= #{"vocab/home" "project/create" "project/add-vocab" "text-layer/create" "document/create"}
                 (set (map :op_type (q ds "SELECT op_type FROM operations WHERE project_id = ?" (p 0)))))))
        (testing "a vocabulary read before the migration has no project, after it has its home"
          (let [at-before (hread/get-vocab-at ds (u "v0") ts-before true)
                now (hread/get-vocab-at ds (u "v0") (latest-ts ds) true)]
            (is (= v0-before at-before))
            (is (nil? (:vocab/project at-before)))
            (is (= ["a" "b"] (map :vocab-item/form (:vocab/items at-before))))
            (is (= (str (p 0)) (str (:vocab/project now))))
            (is (not (contains? now :vocab/maintainers)))))
        (testing "a deep read now equals the deep read as of now"
          (let [live (doc/get-with-layer-data ds d0)]
            (is (= live (hread/get-with-layer-data-at ds d0 (latest-ts ds))))
            (is (= #{(str (p 0))}
                   (set (for [tl (:document/text-layers live) tkl (:text-layer/token-layers tl) v (:token-layer/vocabs tkl)]
                          (str (:vocab/project v))))))))
        (testing "the comment on an entry is still there"
          (is (= 1 (count (q ds "SELECT 1 FROM comments WHERE vocab_layer_id = ?" (u "v0"))))))
        (testing "run again on a migrated database, up writes nothing"
          (let [s (schema ds)]
            (vh/up (cfg ds))
            (is (= s (schema ds)))))
        (is (some? m))))))

(defn- outcome
  "What two runs of the migration must agree on."
  [ds]
  {:homes (homes ds)
   :roles (roles ds)
   :ops (frequencies (map :op_type (q ds "SELECT op_type FROM operations")))
   :markers (set (map :id (q ds "SELECT id FROM data_migrations WHERE id LIKE 'vocab-home:%'")))
   :counts (counts ds)
   :schema (q ds "SELECT type, name, sql FROM sqlite_master ORDER BY type, name")})

(deftest a-run-cut-short-ends-where-one-run-ends
  (let [single (atom nil)]
    (with-temp-db
      (fn [ds]
        (build! ds) (give-orphans-projects! ds)
        (migratus/migrate (cfg ds))
        (reset! single (outcome ds))))
    (testing "cut after 7 vocabularies of step 2, then run again"
      (with-temp-db
        (fn [ds]
          (build! ds) (give-orphans-projects! ds)
          (is (thrown? Exception
                       (binding [vh/*after-vocabulary* (fn [n] (when (= n 7) (throw (ex-info "cut" {}))))]
                         (migratus/migrate (cfg ds)))))
          (is (= 7 (count (q ds "SELECT id FROM data_migrations WHERE id LIKE 'vocab-home:%'"))))
          (is (seq (q ds "SELECT 1 FROM sqlite_master WHERE name = 'vocab_maintainers'")) "the rebuild has not run")
          (migratus/migrate (cfg ds))
          (is (= @single (outcome ds))))))
    (testing "cut inside step 3, before its COMMIT, then run again"
      (with-temp-db
        (fn [ds]
          (build! ds) (give-orphans-projects! ds)
          (let [counts-before (counts ds)]
            (is (thrown? Exception
                         (binding [vh/*before-rebuild-commit* (fn [] (throw (ex-info "cut" {})))]
                           (migratus/migrate (cfg ds)))))
            (testing "the table is as step 2 left it"
              (is (seq (q ds "SELECT 1 FROM sqlite_master WHERE name = 'vocab_maintainers'")))
              (is (= 0 (:notnull (first (filter #(= "project_id" (:name %)) (q ds "PRAGMA table_info(vocab_layers)"))))))
              (is (= (select-keys counts-before kept-tables) (select-keys (counts ds) kept-tables)))
              (with-open [c (jdbc/get-connection ds)]
                (is (= 1 (:foreign_keys (jdbc/execute-one! c ["PRAGMA foreign_keys"] {:builder-fn rs/as-unqualified-maps}))))))
            (migratus/migrate (cfg ds))
            (is (= @single (outcome ds)))))))))

(defn- stopped-start!
  "Leave the database as a start killed at that point leaves it: whatever
  `cut!` committed, and migratus' reservation row, which its `finally` would
  have removed."
  [ds cut!]
  (cut! ds)
  (q ds "INSERT INTO schema_migrations (id) VALUES (-1)"))

(def ^:private stop-points
  {"after step 1" (fn [ds]
                    (jdbc/execute! ds ["ALTER TABLE vocab_layers ADD COLUMN project_id TEXT"])
                    (#'vh/plan! ds))
   "after 7 vocabularies of step 2" (fn [ds]
                                      (try
                                        (binding [vh/*after-vocabulary* (fn [n] (when (= n 7) (throw (ex-info "cut" {}))))]
                                          (migratus/migrate (cfg ds)))
                                        (catch Exception _)))
   "inside step 3, before its COMMIT" (fn [ds]
                                        (try
                                          (binding [vh/*before-rebuild-commit* (fn [] (throw (ex-info "cut" {})))]
                                            (migratus/migrate (cfg ds)))
                                          (catch Exception _)))
   "after step 3's COMMIT, before migratus recorded the migration" (fn [ds] (vh/up (cfg ds)))})

(deftest a-start-stopped-during-the-migration-is-resumed-by-the-next
  (let [single (atom nil)]
    (with-temp-db
      (fn [ds]
        (build! ds) (give-orphans-projects! ds)
        (migratus/migrate (cfg ds))
        (reset! single (outcome ds))))
    (doseq [[point cut!] stop-points]
      (testing (str "stopped " point ", then started again holding the instance lock")
        (with-temp-db
          (fn [ds]
            (build! ds) (give-orphans-projects! ds)
            (stopped-start! ds cut!)
            (server-sql/run-migrations! ds {:db-path "plaid.db" :lock-held? true})
            (is (= @single (outcome ds)) "the outcome of one uninterrupted run")
            (is (empty? (q ds "SELECT id FROM schema_migrations WHERE id = -1")) "the mark is gone")
            (is (seq (q ds "SELECT id FROM schema_migrations WHERE id = ?" migration)) "the migration is recorded")))))))

(deftest a-stopped-migration-is-refused-without-the-instance-lock
  (with-temp-db
    (fn [ds]
      (build! ds) (give-orphans-projects! ds)
      (stopped-start! ds (stop-points "after 7 vocabularies of step 2"))
      (let [before (schema ds)
            thrown (try (server-sql/run-migrations! ds {:db-path "/srv/plaid/plaid.db" :lock-held? false})
                        nil
                        (catch Exception e e))]
        (is (= (str "The database was not migrated: the last start was stopped during migration "
                    "20261112120000-vocab-home-project, which cannot be resumed by the server. Restore the backup "
                    "taken before upgrading and start again. To run the migration again on this database instead, "
                    "remove the mark the stopped start left, with python3 -c \"import sqlite3; c = "
                    "sqlite3.connect('/srv/plaid/plaid.db'); c.execute('DELETE FROM schema_migrations WHERE id = -1'); "
                    "c.commit()\", and start again.")
               (some-> thrown ex-message)))
        (is (= before (schema ds)) "nothing was written")))))

;; ============================================================
;; The old version run between a stopped run and the next
;; ============================================================

(defn- old-unlink!
  "What the old version's unlink of `vid` from `pid` leaves: no
  `project_vocabs` row (its links in `pid`'s documents go too, and these
  fixtures have none there)."
  [ds pid vid]
  (q ds "DELETE FROM project_vocabs WHERE project_id = ? AND vocab_layer_id = ?" pid vid))

(defn- old-hide!
  "What the old version's project delete leaves before its removal runs: the
  project stamped deleted, its roles, vocabulary links and invites gone."
  [ds pid]
  (q ds "UPDATE projects SET deleted_at = '2026-11-12T00:00:00Z' WHERE id = ?" pid)
  (doseq [t ["project_users" "project_vocabs" "invites"]]
    (q ds (str "DELETE FROM " t " WHERE project_id = ?") pid)))

(defn- give-project!
  "What `vocab_home_orphans.py` does for one vocabulary: a project of its own,
  linking it."
  [ds vid pname]
  (let [pid (u (str "own:" vid))]
    (project! ds pid pname [[(email "admin") "maintainer"]])
    (link-project! ds pid vid)
    pid))

(defn- after-a-stopped-run
  "A database whose migration was stopped inside step 3, so every vocabulary
  has its planned home and its marker, on which the old version then ran
  `old!`."
  [old!]
  (fn [ds]
    (build! ds) (give-orphans-projects! ds)
    (try
      (binding [vh/*before-rebuild-commit* (fn [] (throw (ex-info "cut" {})))]
        (migratus/migrate (cfg ds)))
      (catch Exception _))
    (old! ds)))

(defn- refusal-of [ds]
  (try (migratus/migrate (cfg ds)) nil (catch Exception e (ex-message e))))

(deftest a-plan-the-old-version-broke-is-made-again
  (testing "the planned home unlinked it, another project still links it"
    (with-temp-db
      (fn [ds]
        ((after-a-stopped-run #(old-unlink! % (u "p30") (u "x1"))) ds)
        (is (= (u "p30") (get (homes ds) (u "x1"))) "the stopped run planned p30")
        (migratus/migrate (cfg ds))
        (is (= (u "p31") (get (homes ds) (u "x1"))) "planned again among the projects that link it")
        (is (seq (q ds "SELECT 1 FROM project_vocabs WHERE project_id = ? AND vocab_layer_id = ?" (u "p31") (u "x1"))))
        (is (contains? (roles ds) [(u "p31") (email "xb") "maintainer"]) "its maintainers maintain the new home")
        (is (= 1 (count (q ds "SELECT 1 FROM operations WHERE op_type = 'vocab/home' AND project_id = ?" (u "p31"))))
            "audited under the new home"))))
  (testing "its only linking project unlinked it: refused as unlinked, until it is given a project"
    (with-temp-db
      (fn [ds]
        ((after-a-stopped-run #(old-unlink! % (u "p5") (u "v5"))) ds)
        (let [msg (refusal-of ds)]
          (is (str/starts-with? (str msg) (str "1 vocabulary is linked by no project: \"V5\" (" (u "v5") ", 2 entries)"))
              msg))
        (let [own (give-project! ds (u "v5") "V5")]
          (migratus/migrate (cfg ds))
          (is (= own (get (homes ds) (u "v5"))))
          (is (empty? (q ds "SELECT 1 FROM sqlite_master WHERE name = 'vocab_maintainers'")))))))
  (testing "its only linking project was deleted and removed: refused as unlinked, until it is given a project"
    (with-temp-db
      (fn [ds]
        ((after-a-stopped-run (fn [ds] (old-hide! ds (u "p6")) (q ds "DELETE FROM projects WHERE id = ?" (u "p6")))) ds)
        (is (str/starts-with? (str (refusal-of ds)) "1 vocabulary is linked by no project: \"V6\""))
        (let [own (give-project! ds (u "v6") "V6")]
          (migratus/migrate (cfg ds))
          (is (= own (get (homes ds) (u "v6")))))))))

(defn- logged
  "Run `f` and return what it logged at INFO and above, one string per line."
  [f]
  (let [lines (atom [])]
    (log/with-merged-config
      {:appenders {:capture {:enabled? true
                             :min-level :info
                             :fn (fn [{:keys [vargs]}] (swap! lines conj (str/join " " vargs)))}}}
      (f))
    @lines))

(deftest a-maintainer-the-old-version-added-after-the-plan-is-made-maintainer-of-the-home
  ;; The stopped run audited every vocabulary, then the old version made
  ;; `late` a maintainer of V3 (a reader of P3) and `gone` one of V4 (a
  ;; deactivated account). Step 2 skips a vocabulary it has done, so the
  ;; rebuild, which drops `vocab_maintainers`, is the last place to see them.
  (with-temp-db
    (fn [ds]
      ((after-a-stopped-run
        (fn [ds]
          (user! ds (email "late")) (user! ds (email "gone"))
          (q ds "UPDATE users SET deactivated_at = '2026-11-01T00:00:00Z' WHERE id = ?" (email "gone"))
          (q ds "INSERT INTO project_users (project_id, user_id, role) VALUES (?, ?, 'reader')" (u "p3") (email "late"))
          (q ds "INSERT INTO vocab_maintainers (vocab_layer_id, user_id) VALUES (?, ?), (?, ?)"
             (u "v3") (email "late") (u "v4") (email "gone"))))
       ds)
      (let [ops-before (count (q ds "SELECT 1 FROM operations"))
            lines (logged #(migratus/migrate (cfg ds)))]
        (is (contains? (roles ds) [(u "p3") (email "late") "maintainer"]) "made maintainer of the home")
        (is (not (contains? (roles ds) [(u "p3") (email "late") "reader"])))
        (is (not (some (fn [[_ uid]] (= uid (email "gone"))) (roles ds))) "a deactivated account is not")
        (is (= [[(u "p3") nil]]
               (map (juxt :project_id :user_id)
                    (q ds "SELECT project_id, user_id FROM operations WHERE op_type = 'project/add-maintainer'")))
            "one audited operation, under the home, by nobody")
        (is (= (inc ops-before) (count (q ds "SELECT 1 FROM operations"))) "nothing else is written")
        (is (some #(= % (str "Vocabulary \"V3\" (" (u "v3") "): made maintainer of \"P3\": " (email "late")
                             " (were reader)"))
                  lines)
            (pr-str lines))
        (is (some #(= % (str "Vocabulary \"V4\" (" (u "v4") "): not made maintainer of \"P4\", deactivated: "
                             (email "gone")))
                  lines)
            (pr-str lines))
        (is (empty? (q ds "SELECT 1 FROM sqlite_master WHERE name = 'vocab_maintainers'")))))))

(deftest a-replanned-vocabulary-names-who-stays-maintainer-of-the-old-plan
  ;; X1 was planned for P30 and the stopped run audited it there, then the old
  ;; version unlinked it from P30. The re-plan gives it P31 and keeps every
  ;; role (nothing is taken away), so the log names the vocabulary's
  ;; maintainers who stay maintainers of P30, and X1's History lists the
  ;; stale home, then the home it got.
  (with-temp-db
    (fn [ds]
      ((after-a-stopped-run #(old-unlink! % (u "p30") (u "x1"))) ds)
      (let [lines (logged #(migratus/migrate (cfg ds)))]
        (is (some #(= % (str "Vocabulary \"X1 by maintainers\" (" (u "x1") "): its planned home \"P30\" ("
                             (u "p30") ") no longer links it since the plan was made. Planning it again. "
                             "Its maintainers stay maintainers of \"P30\": " (email "xa") ", " (email "xb")))
                  lines)
            (pr-str (filter #(str/includes? % "Planning it again") lines)))
        (is (contains? (roles ds) [(u "p30") (email "xb") "maintainer"]) "the promotion under the old plan stays")
        (is (= [(u "p30") (u "p31")]
               (map :project_id (q ds (str "SELECT o.project_id FROM operations o WHERE o.op_type = 'vocab/home' "
                                           "AND EXISTS (SELECT 1 FROM audit_writes aw WHERE aw.op_id = o.id "
                                           "AND aw.vocab_layer_id = ?) ORDER BY o.ts")
                                   (u "x1"))))
            "its History: the stale home, then the one it got")))))

(deftest the-summary-line-adds-up-on-a-resumed-run
  (let [summary (fn [lines] (first (filter #(str/starts-with? % "Vocabulary homes:") lines)))]
    (with-temp-db
      (fn [ds]
        (build! ds) (give-orphans-projects! ds)
        (is (= (str "Vocabulary homes: planned 40 (35 the only project linking them, 3 by maintainers, 1 by links, "
                    "1 by id), audited 40, people made maintainer 4")
               (summary (logged #(migratus/migrate (cfg ds))))))))
    (with-temp-db
      (fn [ds]
        (build! ds) (give-orphans-projects! ds)
        (try
          (binding [vh/*after-vocabulary* (fn [n] (when (= n 7) (throw (ex-info "cut" {}))))]
            (migratus/migrate (cfg ds)))
          (catch Exception _))
        (is (= (str "Vocabulary homes: planned 0 (0 the only project linking them, 0 by maintainers, 0 by links, "
                    "0 by id), audited 33, people made maintainer 2")
               (summary (logged #(migratus/migrate (cfg ds))))))))))

(deftest a-vocabulary-is-not-removed-with-a-home-the-old-version-deleted-after-the-plan
  (testing "the planned home is being deleted, its removal still to run"
    (with-temp-db
      (fn [ds]
        ((after-a-stopped-run #(old-hide! % (u "p0"))) ds)
        (migratus/migrate (cfg ds))
        (is (= (u "p40") (get (homes ds) (u "v0"))) "p40, which borrowed it, is its home")
        (removal/remove-project! ds (u "p0"))
        (is (empty? (q ds "SELECT 1 FROM projects WHERE id = ?" (u "p0"))) "the deleted project is removed")
        (is (= 2 (count (q ds "SELECT 1 FROM vocab_items WHERE vocab_layer_id = ?" (u "v0"))))
            "the vocabulary and its entries are still there")
        (is (= 1 (count (q ds "SELECT 1 FROM comments WHERE vocab_layer_id = ?" (u "v0")))))))))

(deftest a-deactivated-maintainer-is-not-made-maintainer-of-the-home
  (with-temp-db
    (fn [ds]
      (build! ds) (give-orphans-projects! ds)
      (q ds "UPDATE users SET deactivated_at = '2026-11-01T00:00:00Z' WHERE id = ?" (email "stranger"))
      (migratus/migrate (cfg ds))
      (is (not (contains? (roles ds) [(u "p2") (email "stranger") "maintainer"])))
      (is (contains? (roles ds) [(u "p0") (email "reader") "maintainer"]) "an active one is"))))

(deftest a-fresh-install-migrates
  (with-temp-db
    (fn [ds]
      (migratus/migrate (cfg ds))
      (is (empty? (q ds "SELECT 1 FROM sqlite_master WHERE name = 'vocab_maintainers'")))
      (is (= 1 (:notnull (first (filter #(= "project_id" (:name %)) (q ds "PRAGMA table_info(vocab_layers)"))))))
      (is (empty? (q ds "SELECT * FROM operations"))))))

(deftest the-rule-decides-in-order
  (is (= [(u "a") 0] (vh/home-rule [{:project_id (u "a") :maintainers 0 :links 0}])))
  (is (= ["b" 1] (vh/home-rule [{:project_id "a" :maintainers 1 :links 9} {:project_id "b" :maintainers 2 :links 0}])))
  (is (= ["a" 2] (vh/home-rule [{:project_id "a" :maintainers 1 :links 9} {:project_id "b" :maintainers 1 :links 0}])))
  (is (= ["a" 3] (vh/home-rule [{:project_id "b" :maintainers 1 :links 1} {:project_id "a" :maintainers 1 :links 1}]))))
