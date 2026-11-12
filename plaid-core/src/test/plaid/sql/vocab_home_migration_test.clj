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
            [plaid.server.sql :as server-sql]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.datasource :as psd]
            [plaid.sql.document :as doc]
            [plaid.sql.operation :refer [submit-operation!]]
            [plaid.sql.vocab-home :as vh]
            [plaid.test-helpers :refer [temp-db-path]]))

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
          (is (str/ends-with? msg (str "Run vocab_home_orphans.py against the server before upgrading "
                                       "(see the manual's Upgrading section)."))))
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
                    "remove the mark the stopped start left, with sqlite3 /srv/plaid/plaid.db \"DELETE FROM "
                    "schema_migrations WHERE id = -1\", and start again.")
               (some-> thrown ex-message)))
        (is (= before (schema ds)) "nothing was written")))))

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
