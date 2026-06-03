(ns plaid.sql.project
  "SQL port of plaid.xtdb2.project. Projects live in the `projects`
  table; ACL lives in `project_users` keyed by role; vocab grants in
  `project_vocabs`; the editor `:config` is a JSON blob on the project
  row.

  External API mirrors the xtdb2 version. The first argument is `db`,
  either a HikariCP DataSource (reads) or a JDBC Connection in a tx
  (writes). Write fns open their own tx via `submit-operation!`."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.pagination :as pagination]
            [plaid.sql.user :as user]
            [plaid.sql.document :as document]
            [plaid.sql.text-layer :as text-layer])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:project/id
                :project/name
                :project/readers
                :project/writers
                :project/maintainers
                :project/text-layers
                :project/vocabs
                :config])

;; ============================================================
;; Row mappers
;; ============================================================

(defn- row->project-bare
  "Translate a `projects` row to the namespaced shape, parsing config.
  Does NOT populate readers/writers/maintainers/text-layers/vocabs;
  callers stitch those in from their respective tables."
  [row]
  (when row
    {:project/id   (:id row)
     :project/name (:name row)
     :config       (psc/parse-config (:config row))}))

(defn- row->text-layer [row]
  {:text-layer/id   (:id row)
   :text-layer/name (:name row)
   :config          (psc/parse-config (:config row))})

(defn- row->token-layer [row]
  {:token-layer/id   (:id row)
   :token-layer/name (:name row)
   :config           (psc/parse-config (:config row))})

(defn- row->span-layer [row]
  {:span-layer/id   (:id row)
   :span-layer/name (:name row)
   :config          (psc/parse-config (:config row))})

(defn- row->relation-layer [row]
  {:relation-layer/id   (:id row)
   :relation-layer/name (:name row)
   :config              (psc/parse-config (:config row))})

(defn- row->vocab-layer [row maintainers]
  {:vocab/id           (:id row)
   :vocab/name         (:name row)
   :vocab/maintainers  (vec maintainers)
   :config             (psc/parse-config (:config row))})

;; ============================================================
;; ACL helpers (project_users join table)
;; ============================================================

(defn- user-ids-for-role
  "Vector of user IDs that have `role` on `project-id`."
  [db project-id role]
  (->> (psc/q db {:select [:user_id]
                  :from [:project_users]
                  :where [:and
                          [:= :project_id project-id]
                          [:= :role role]]})
       (mapv :user_id)))

;; ============================================================
;; Layer enrichment
;; ============================================================

(defn- enrich-layers
  "Build the nested layer hierarchy for `project-bare`. Adds
  :project/text-layers and :project/vocabs in the same shape as v2."
  [db project-bare]
  (let [project-id (:project/id project-bare)
        ;; text layers
        txtl-rows (psc/q db {:select [:*]
                             :from [:text_layers]
                             :where [:= :project_id project-id]
                             :order-by [:order_idx]})
        txtl-ids (mapv :id txtl-rows)
        ;; token layers under those text layers
        tokl-rows (if (empty? txtl-ids)
                    []
                    (psc/q db {:select [:*]
                               :from [:token_layers]
                               :where [:in :text_layer_id txtl-ids]
                               :order-by [:order_idx]}))
        tokl-by-txtl (group-by :text_layer_id tokl-rows)
        tokl-ids (mapv :id tokl-rows)
        ;; span layers under those token layers
        sl-rows (if (empty? tokl-ids)
                  []
                  (psc/q db {:select [:*]
                             :from [:span_layers]
                             :where [:in :token_layer_id tokl-ids]
                             :order-by [:order_idx]}))
        sl-by-tokl (group-by :token_layer_id sl-rows)
        sl-ids (mapv :id sl-rows)
        ;; relation layers under those span layers
        rl-rows (if (empty? sl-ids)
                  []
                  (psc/q db {:select [:*]
                             :from [:relation_layers]
                             :where [:in :span_layer_id sl-ids]
                             :order-by [:order_idx]}))
        rl-by-sl (group-by :span_layer_id rl-rows)
        ;; vocabs (and their maintainers)
        vocab-rows (psc/q db {:select [:vl.*]
                              :from [[:vocab_layers :vl]]
                              :join [[:project_vocabs :pv]
                                     [:= :pv.vocab_layer_id :vl.id]]
                              :where [:= :pv.project_id project-id]})
        vocab-ids (mapv :id vocab-rows)
        vm-rows (if (empty? vocab-ids)
                  []
                  (psc/q db {:select [:vocab_layer_id :user_id]
                             :from [:vocab_maintainers]
                             :where [:in :vocab_layer_id vocab-ids]}))
        maintainers-by-vocab (reduce (fn [acc {:keys [vocab_layer_id user_id]}]
                                       (update acc vocab_layer_id (fnil conj []) user_id))
                                     {} vm-rows)
        ;; Bottom-up assembly
        build-rl (fn [rl-row] (row->relation-layer rl-row))
        build-sl (fn [sl-row]
                   (assoc (row->span-layer sl-row)
                          :span-layer/relation-layers
                          (mapv build-rl (clojure.core/get rl-by-sl (:id sl-row) []))))
        build-tokl (fn [tokl-row]
                     (assoc (row->token-layer tokl-row)
                            :token-layer/span-layers
                            (mapv build-sl (clojure.core/get sl-by-tokl (:id tokl-row) []))))
        build-txtl (fn [txtl-row]
                     (assoc (row->text-layer txtl-row)
                            :text-layer/token-layers
                            (mapv build-tokl (clojure.core/get tokl-by-txtl (:id txtl-row) []))))
        enriched-text-layers (mapv build-txtl txtl-rows)
        enriched-vocabs (mapv #(row->vocab-layer % (clojure.core/get maintainers-by-vocab (:id %) []))
                              vocab-rows)]
    (assoc project-bare
           :project/text-layers enriched-text-layers
           :project/vocabs enriched-vocabs)))

(defn- attach-acl
  "Add :project/readers, :project/writers, :project/maintainers as
  vectors of user IDs."
  [db project-id project-map]
  (let [rows (psc/q db {:select [:user_id :role]
                        :from [:project_users]
                        :where [:= :project_id project-id]})
        by-role (reduce (fn [acc {:keys [user_id role]}]
                          (update acc role (fnil conj []) user_id))
                        {} rows)]
    (assoc project-map
           :project/readers     (vec (clojure.core/get by-role "reader" []))
           :project/writers     (vec (clojure.core/get by-role "writer" []))
           :project/maintainers (vec (clojure.core/get by-role "maintainer" [])))))

;; ============================================================
;; Reads
;; ============================================================

(defn get-document-ids [db id]
  (->> (psc/q db {:select [:id]
                  :from [:documents]
                  :where [:= :project_id id]})
       (mapv :id)))

(defn get-documents-page
  "Keyset-paginated documents for a project, ordered by (name, id). The stub
  carries the same scalar fields as `document/get` (sans nested layers/media) so
  list views can show version + last-modified without a follow-up fetch."
  [db project-id {:keys [limit cursor-vals]}]
  (pagination/paginate db {:select [:id :name :version :created_at :modified_at]
                           :from :documents
                           :base-where [:= :project_id project-id]
                           :order-by [:name :id]
                           :limit limit
                           :cursor-vals cursor-vals
                           :row->entity (fn [r] {:document/id            (:id r)
                                                 :document/name          (:name r)
                                                 :document/version       (:version r)
                                                 :document/time-created  (:created_at r)
                                                 :document/time-modified (:modified_at r)})}))

(defn get
  ([db id]
   (when-let [bare (row->project-bare (psc/fetch-by-id db :projects id))]
     (-> bare
         (->> (attach-acl db id))
         (->> (enrich-layers db))))))

(defn reader-ids [db id]
  (user-ids-for-role db id "reader"))

(defn writer-ids [db id]
  (user-ids-for-role db id "writer"))

(defn maintainer-ids [db id]
  (user-ids-for-role db id "maintainer"))

(defn get-all-ids [db]
  (->> (psc/q db {:select [:id] :from [:projects]})
       (mapv :id)))

(defn get-accessible-ids [db user-id]
  (->> (psc/q db {:select-distinct [:project_id]
                  :from [:project_users]
                  :where [:= :user_id user-id]})
       (mapv :project_id)))

(defn- batch-hydrate-projects
  "Hydrate `project-ids` into the same per-project shape as `(get db id)`
  — :project/readers/writers/maintainers, :project/text-layers (with
  nested token/span/relation layers), and :project/vocabs (with
  maintainers). Preserves the order of `project-ids`.

  Round-trip count is O(layer-kinds) instead of O(projects × layer-kinds):
  one SELECT for projects, one per layer-kind (text/token/span/relation,
  filtered by denormalized project_id), one for vocab_layers joined to
  project_vocabs, one for vocab_maintainers, one for project_users (ACL).

  SQLite/Postgres dialect note: grouping is done Clojure-side rather than
  with `json_group_array` (SQLite) / `json_agg` (Postgres). The existing
  `get` shape exposes parsed-config maps and namespaced keys; folding
  those into a server-side JSON array would force a second parse pass
  and we'd lose nothing by grouping in-process — the row counts are
  modest and the per-query overhead is dominated by round-trip latency."
  [db project-ids]
  (if (empty? project-ids)
    []
    (let [;; 1) projects themselves
          project-rows (psc/q db {:select [:*]
                                  :from [:projects]
                                  :where [:in :id project-ids]})
          project-by-id (into {} (map (juxt :id row->project-bare) project-rows))
          ;; 2) project_users — ACL grouped per project / role
          acl-rows (psc/q db {:select [:project_id :user_id :role]
                              :from [:project_users]
                              :where [:in :project_id project-ids]})
          acl-by-project (reduce (fn [acc {:keys [project_id user_id role]}]
                                   (update-in acc [project_id role] (fnil conj []) user_id))
                                 {} acl-rows)
          ;; 3) text layers (denormalized project_id, ordered by order_idx)
          txtl-rows (psc/q db {:select [:*]
                               :from [:text_layers]
                               :where [:in :project_id project-ids]
                               :order-by [:order_idx]})
          txtl-by-project (group-by :project_id txtl-rows)
          ;; 4) token layers — flattened under text_layer_id (mirrors
          ;; `enrich-layers`; token-layer hierarchy via
          ;; parent_token_layer_id is NOT nested in this response shape)
          tokl-rows (psc/q db {:select [:*]
                               :from [:token_layers]
                               :where [:in :project_id project-ids]
                               :order-by [:order_idx]})
          tokl-by-txtl (group-by :text_layer_id tokl-rows)
          ;; 5) span layers
          sl-rows (psc/q db {:select [:*]
                             :from [:span_layers]
                             :where [:in :project_id project-ids]
                             :order-by [:order_idx]})
          sl-by-tokl (group-by :token_layer_id sl-rows)
          ;; 6) relation layers
          rl-rows (psc/q db {:select [:*]
                             :from [:relation_layers]
                             :where [:in :project_id project-ids]
                             :order-by [:order_idx]})
          rl-by-sl (group-by :span_layer_id rl-rows)
          ;; 7) vocab layers granted to these projects (one join query
          ;; carrying the project_id back so we can re-bucket Clojure-side)
          vocab-rows (psc/q db {:select [:vl.* [:pv.project_id :project_id]]
                                :from [[:vocab_layers :vl]]
                                :join [[:project_vocabs :pv]
                                       [:= :pv.vocab_layer_id :vl.id]]
                                :where [:in :pv.project_id project-ids]})
          vocab-by-project (group-by :project_id vocab-rows)
          vocab-ids (into #{} (map :id) vocab-rows)
          ;; 8) vocab maintainers — fetched once across every vocab in
          ;; play; a vocab may be granted to several projects but its
          ;; maintainer set is shared.
          vm-rows (if (empty? vocab-ids)
                    []
                    (psc/q db {:select [:vocab_layer_id :user_id]
                               :from [:vocab_maintainers]
                               :where [:in :vocab_layer_id (vec vocab-ids)]}))
          maintainers-by-vocab (reduce (fn [acc {:keys [vocab_layer_id user_id]}]
                                         (update acc vocab_layer_id (fnil conj []) user_id))
                                       {} vm-rows)
          ;; 9) per-project document count + last-modified (one grouped query).
          ;; modified_at is ISO-8601 text, so MAX is chronological. Powers
          ;; last-updated + doc-count on list views without N count queries.
          doc-stat-rows (psc/q db {:select [:project_id
                                            [[:count :*] :doc_count]
                                            [[:max :modified_at] :last_modified]]
                                   :from [:documents]
                                   :where [:in :project_id project-ids]
                                   :group-by [:project_id]})
          doc-stats-by-project (into {} (map (juxt :project_id identity)) doc-stat-rows)
          ;; Bottom-up layer builders — identical shape to `enrich-layers`.
          build-rl (fn [rl-row] (row->relation-layer rl-row))
          build-sl (fn [sl-row]
                     (assoc (row->span-layer sl-row)
                            :span-layer/relation-layers
                            (mapv build-rl (clojure.core/get rl-by-sl (:id sl-row) []))))
          build-tokl (fn [tokl-row]
                       (assoc (row->token-layer tokl-row)
                              :token-layer/span-layers
                              (mapv build-sl (clojure.core/get sl-by-tokl (:id tokl-row) []))))
          build-txtl (fn [txtl-row]
                       (assoc (row->text-layer txtl-row)
                              :text-layer/token-layers
                              (mapv build-tokl (clojure.core/get tokl-by-txtl (:id txtl-row) []))))
          hydrate-one (fn [pid]
                        (when-let [bare (clojure.core/get project-by-id pid)]
                          (let [role-map (clojure.core/get acl-by-project pid {})
                                txt-layers (mapv build-txtl
                                                 (clojure.core/get txtl-by-project pid []))
                                vocabs (mapv (fn [vrow]
                                               (row->vocab-layer
                                                vrow
                                                (clojure.core/get maintainers-by-vocab
                                                                  (:id vrow) [])))
                                             (clojure.core/get vocab-by-project pid []))]
                            (assoc bare
                                   :project/readers     (vec (clojure.core/get role-map "reader" []))
                                   :project/writers     (vec (clojure.core/get role-map "writer" []))
                                   :project/maintainers (vec (clojure.core/get role-map "maintainer" []))
                                   :project/text-layers txt-layers
                                   :project/vocabs      vocabs
                                   :project/document-count (or (:doc_count (clojure.core/get doc-stats-by-project pid)) 0)
                                   :project/last-modified  (:last_modified (clojure.core/get doc-stats-by-project pid))))))]
      (->> project-ids
           (mapv hydrate-one)
           (filterv some?)))))

(defn get-accessible
  ([db user-id]
   (let [admin? (user/admin? (user/get db user-id))
         ids (if admin?
               (get-all-ids db)
               (get-accessible-ids db user-id))]
     ;; Was `(mapv #(get db %) ids)` — N+1 over `ids` with each `get`
     ;; firing attach-acl + enrich-layers (~6 queries per project). Now a
     ;; constant number of bulk SELECTs regardless of project count.
     (batch-hydrate-projects db ids)))
  ([db user-id {:keys [limit cursor-vals]}]
   ;; Paginated arity: hydrate the (bounded, per-user) accessible set then
   ;; shape it into the uniform {:entries :next-cursor} envelope. Sorted by
   ;; (name, id) — :project/id is the unique tiebreaker.
   (pagination/paginate-coll (get-accessible db user-id)
                             [:project/name :project/id]
                             limit cursor-vals)))

(defn get-by-name [db name]
  (when-let [row (psc/q1 db {:select [:*]
                             :from [:projects]
                             :where [:= :name name]})]
    (-> (row->project-bare row)
        (->> (attach-acl db (:id row))))))

(defn project-id
  "For projects, the project-id is the entity's own ID."
  [_db id]
  id)

;; ============================================================
;; Mutations: create / merge / delete
;; ============================================================

;; `create` folds the creator's maintainer grant into the project's :insert
;; audit image; the ACL snapshot helper is defined further down this file.
(declare fetch-project-acl-snapshot)

(defn create
  "Create a new project. `attrs` includes :project/name (required), optional
  :config, and optional :project/maintainers (a vector of user-ids to grant the
  maintainer role — the REST handler passes the creating user). Returns
  {:success true :extra <new-id>}.

  Audit shape: ONE audit_writes row against `:projects` with change_type
  :insert, whose post-image is the projects row augmented with the
  :readers/:writers/:maintainers role vectors (unnamespaced — the audit
  \"extras\" shape; see `fetch-project-acl-snapshot`). Manual insert + folded
  audit (vs. `psc/insert!`) so the maintainer grant rides the SAME audit row —
  otherwise the project_users grant would be invisible to history replay and the
  creator wouldn't be reconstructed as a maintainer."
  [db attrs user-id]
  (let [{:project/keys [name maintainers]} attrs
        new-id (psc/new-uuid)
        config (clojure.core/get attrs :config {})]
    (submit-operation! [tx db {:type :project/create
                               :project new-id
                               :document nil
                               :description (str "Create project \"" name "\"")
                               :user user-id}]
                       ;; Validation inside the body so submit-operation*'s
                       ;; outer catch surfaces a structured 4xx (task #47).
                       (psc/valid-name? name)
                       (psc/execute! tx {:insert-into :projects
                                         :values [{:id new-id
                                                   :name name
                                                   :config (psc/serialize-config config)}]})
                       ;; Grant the maintainer role to the creator (and any
                       ;; other requested maintainers). Without this, a
                       ;; non-admin creator can't add layers to their own
                       ;; project (403). project_users rows are unaudited;
                       ;; their state is folded into the :insert image below.
                       (doseq [uid (distinct maintainers)]
                         (when (nil? (psc/fetch-by-id tx :users uid))
                           (throw (ex-info (str "Not a valid user ID: " uid) {:id uid :code 400})))
                         (psc/add-join! tx :project_users
                                        {:project_id new-id :user_id uid :role "maintainer"}))
                       (let [proj-row (psc/fetch-by-id tx :projects new-id)
                             post-image (clojure.core/merge proj-row (fetch-project-acl-snapshot tx new-id))]
                         (psc/record-audit-write! tx :projects new-id :insert nil post-image))
                       new-id)))

(defn merge
  "Update mutable project fields. Currently supports :project/name."
  [db eid m user-id]
  (submit-operation! [tx db {:type :project/update
                             :project eid
                             :document nil
                             :description (str "Update project " eid
                                               (when (:project/name m)
                                                 (str " to name \"" (:project/name m) "\"")))
                             :user user-id}]
                     (when-let [n (:project/name m)]
                       (psc/valid-name? n))
                     (let [existing (psc/fetch-by-id tx :projects eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Project" eid) {:code 404 :id eid})))
                       (let [attrs (cond-> {}
                                     (some? (:project/name m))
                                     (assoc :name (:project/name m)))]
                         (when (seq attrs)
                           (psc/update-by-id! tx :projects eid attrs))
                         eid))))

(defn delete
  "Delete a project. Walks the descendant subtree (documents via
  document/cascade-delete!, then text_layers via text-layer/
  cascade-delete!) and audits each row deletion through the audited
  helpers so audit_writes captures every change — FK ON DELETE CASCADE
  would otherwise silently sweep them. Project_users / project_vocabs
  are junction tables and are left to FK CASCADE (per audit policy)."
  [db eid user-id]
  (submit-operation! [tx db {:type :project/delete
                             :project eid
                             :document nil
                             :description (str "Delete project " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :projects eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Project" eid) {:code 404 :id eid})))
                       ;; Documents first (their text_layer is the
                       ;; same project's, but document cascade sweeps
                       ;; document-scoped tokens/spans/relations/
                       ;; vocab_links so the text_layer cascade has
                       ;; less to do).
                       (let [doc-ids (->> (psc/q tx {:select [:id]
                                                     :from :documents
                                                     :where [:= :project_id eid]})
                                          (mapv :id))]
                         (doseq [did doc-ids]
                           (document/cascade-delete! tx did)))
                       ;; Text layers (cascade walks token_layers →
                       ;; span_layers → relation_layers).
                       (let [tl-ids (->> (psc/q tx {:select [:id]
                                                    :from :text_layers
                                                    :where [:= :project_id eid]})
                                         (mapv :id))]
                         (doseq [tl-id tl-ids]
                           (text-layer/cascade-delete! tx tl-id)))
                       ;; Defensive: sweep entity_metadata rows whose
                       ;; entity_type is "project" (rare but no FK).
                       (psc/execute! tx
                                     {:delete-from :entity_metadata
                                      :where [:and
                                              [:= :entity_type "project"]
                                              [:= :entity_id eid]]})
                       (psc/delete-by-id! tx :projects eid)
                       eid)))

;; ============================================================
;; Access privileges (project_users join table)
;; ============================================================

(defn- assert-user-and-project!
  [tx project-id user-id]
  (when (nil? (psc/fetch-by-id tx :users user-id))
    (throw (ex-info (str "Not a valid user ID: " user-id) {:id user-id :code 400})))
  (when (nil? (psc/fetch-by-id tx :projects project-id))
    (throw (ex-info (str "Not a valid project ID: " project-id) {:id project-id :code 400}))))

(defn fetch-project-acl-snapshot
  "Return `{:readers [...] :writers [...] :maintainers [...]}` for
  `project-id` — the role-id vectors that get folded into synthetic
  audit images on project_users mutations.

  Keys are UNNAMESPACED on purpose: this is the audit-row \"extras\"
  shape, not the REST-API shape. Folding namespaced keys (:project/...)
  into the `projects` row pre/post image produced mixed-shape audit
  records (see #65). Precedent: `span.clj/set-tokens` uses `:tokens`
  unnamespaced for the same reason. The namespaced REST shape lives in
  `attach-acl` / `batch-hydrate-projects` and is unaffected.

  Public so cross-namespace callers (notably `plaid.sql.user/delete`,
  which audits user → project_users FK cascade losses) can reuse it
  without inlining the SELECT or paying for `requiring-resolve` on the
  hot path."
  [tx project-id]
  (let [;; ORDER BY user_id so each role list is deterministically ordered
        ;; (the `by-role` reduce appends in row order). Without it, the
        ;; folded audit image order can vary run-to-run after DELETE+INSERT
        ;; churn, producing spurious history "changes" / OLTP↔history divergence
        ;; (task #13).
        rows (psc/q tx {:select [:user_id :role]
                        :from [:project_users]
                        :where [:= :project_id project-id]
                        :order-by [:user_id]})
        by-role (reduce (fn [acc {:keys [user_id role]}]
                          (update acc role (fnil conj []) user_id))
                        {} rows)]
    {:readers     (vec (clojure.core/get by-role "reader" []))
     :writers     (vec (clojure.core/get by-role "writer" []))
     :maintainers (vec (clojure.core/get by-role "maintainer" []))}))

(defn- fetch-project-vocab-grants
  "Return `[vocab-layer-id ...]` granted to `project-id` via project_vocabs."
  [tx project-id]
  ;; ORDER BY vocab_layer_id so the folded :vocabs audit image is
  ;; deterministically ordered (task #13).
  (->> (psc/q tx {:select [:vocab_layer_id]
                  :from [:project_vocabs]
                  :where [:= :project_id project-id]
                  :order-by [:vocab_layer_id]})
       (mapv :vocab_layer_id)))

(defn audit-project-acl-change!
  "Emit a synthetic :projects audit row for a project_users mutation.
  Pre/post images = the projects row + the three role-id vectors. Skips
  the audit when pre == post (no-op write, e.g. add-role for a role the
  user already had — see #28 docs / common.clj/update-by-id! noise rule).

  Public so cross-namespace callers (e.g. `plaid.sql.user/delete`)
  can emit the same synthetic audit shape on FK cascade losses."
  [tx project-id pre-acl]
  (let [post-acl (fetch-project-acl-snapshot tx project-id)]
    (when (not= pre-acl post-acl)
      (let [proj-row (psc/fetch-by-id tx :projects project-id)
            pre-image (clojure.core/merge proj-row pre-acl)
            post-image (clojure.core/merge proj-row post-acl)]
        (psc/record-audit-write! tx :projects project-id :update pre-image post-image)))))

(defn- audit-project-vocabs-change!
  "Emit a synthetic :projects audit row for a project_vocabs mutation.
  Pre/post images = the projects row + the vocab-grant id vector under
  :vocabs (UNNAMESPACED — see `fetch-project-acl-snapshot` docstring for
  the rationale). Skips audit when pre == post."
  [tx project-id pre-vocabs]
  (let [post-vocabs (fetch-project-vocab-grants tx project-id)]
    (when (not= pre-vocabs post-vocabs)
      (let [proj-row (psc/fetch-by-id tx :projects project-id)
            pre-image (assoc proj-row :vocabs pre-vocabs)
            post-image (assoc proj-row :vocabs post-vocabs)]
        (psc/record-audit-write! tx :projects project-id :update pre-image post-image)))))

(defn- add-role!
  [tx project-id user-id role]
  (assert-user-and-project! tx project-id user-id)
  ;; Snapshot the role-set BEFORE we mutate so the synthetic audit row
  ;; carries an accurate pre-image (e.g. user was a reader, now they're
  ;; a writer — both states are visible).
  (let [pre-acl (fetch-project-acl-snapshot tx project-id)]
    ;; Roles are mutually exclusive: clear any existing role this user holds
    ;; on this project, then grant the new one. Matches v2 semantics.
    ;; NOTE (#70): DELETE-then-INSERT exposes a momentary empty-role state
    ;; on the same Connection. This is fine under our BEGIN IMMEDIATE
    ;; writer-serialization model (no concurrent reader on the same tx
    ;; can observe the gap), but it would become fragile if a future
    ;; refactor reuses `tx` across nested `with-tx*` calls or otherwise
    ;; multiplexes read/write traffic on the same Connection mid-tx.
    (psc/remove-join! tx :project_users
                      {:project_id project-id :user_id user-id})
    (psc/add-join! tx :project_users
                   {:project_id project-id
                    :user_id user-id
                    :role role})
    (audit-project-acl-change! tx project-id pre-acl)))

(defn- remove-role!
  [tx project-id user-id role]
  (assert-user-and-project! tx project-id user-id)
  (let [pre-acl (fetch-project-acl-snapshot tx project-id)]
    ;; Task #100 V4: refuse to strip the last maintainer. A project with
    ;; zero maintainers is unrecoverable through the REST API (only
    ;; maintainers can add roles), so this is a real data-loss guard, not
    ;; cosmetic. Only checked on the "maintainer" role — readers/writers
    ;; can hit zero freely. The check sits here (vs. at the REST layer)
    ;; so it applies uniformly to every code path that reaches
    ;; remove-role!.
    (when (and (= role "maintainer")
               (some #{user-id} (:maintainers pre-acl))
               (= 1 (count (:maintainers pre-acl))))
      (throw (ex-info (str "Cannot remove the last maintainer of project " project-id)
                      {:code 400 :project-id project-id :user-id user-id})))
    (psc/remove-join! tx :project_users
                      {:project_id project-id
                       :user_id user-id
                       :role role})
    (audit-project-acl-change! tx project-id pre-acl)))

(defn add-reader [db project-id user-id actor-user-id]
  (submit-operation! [tx db {:type :project/add-reader
                             :project project-id
                             :document nil
                             :description (str "Add reader " user-id " to project " project-id)
                             :user actor-user-id}]
                     (add-role! tx project-id user-id "reader")))

(defn remove-reader [db project-id user-id actor-user-id]
  (submit-operation! [tx db {:type :project/remove-reader
                             :project project-id
                             :document nil
                             :description (str "Remove reader " user-id " from project " project-id)
                             :user actor-user-id}]
                     (remove-role! tx project-id user-id "reader")))

(defn add-writer [db project-id user-id actor-user-id]
  (submit-operation! [tx db {:type :project/add-writer
                             :project project-id
                             :document nil
                             :description (str "Add writer " user-id " to project " project-id)
                             :user actor-user-id}]
                     (add-role! tx project-id user-id "writer")))

(defn remove-writer [db project-id user-id actor-user-id]
  (submit-operation! [tx db {:type :project/remove-writer
                             :project project-id
                             :document nil
                             :description (str "Remove writer " user-id " from project " project-id)
                             :user actor-user-id}]
                     (remove-role! tx project-id user-id "writer")))

(defn add-maintainer [db project-id user-id actor-user-id]
  (submit-operation! [tx db {:type :project/add-maintainer
                             :project project-id
                             :document nil
                             :description (str "Add maintainer " user-id " to project " project-id)
                             :user actor-user-id}]
                     (add-role! tx project-id user-id "maintainer")))

(defn remove-maintainer [db project-id user-id actor-user-id]
  (submit-operation! [tx db {:type :project/remove-maintainer
                             :project project-id
                             :document nil
                             :description (str "Remove maintainer " user-id " from project " project-id)
                             :user actor-user-id}]
                     (remove-role! tx project-id user-id "maintainer")))

;; ============================================================
;; Editor config
;; The :config JSON column holds an editor-keyed map of maps:
;; {<editor-name> {<config-key> <config-value> ...} ...}
;; assoc/dissoc mutates one inner cell at a time.
;; ============================================================

(def ^:private layer-tables
  "Order matters only for first-match; each id is unique across tables so
  no real ambiguity in practice."
  [:projects :text_layers :token_layers :span_layers :relation_layers :vocab_layers])

(defn- find-layer-table
  "Find the table that contains a row with id=`layer-id`. Returns nil
  if no table has it."
  [db layer-id]
  (some (fn [table]
          (when (psc/fetch-by-id db table layer-id)
            table))
        layer-tables))

(defn assoc-editor-config-pair
  "Set <editor-name>/<config-key> = <config-value> in the layer's :config
  JSON. `layer-id` may be any kind of layer (project / text / token /
  span / relation / vocab) — we look it up across all layer tables."
  [db layer-id editor-name config-key config-value]
  (submit-operation! [tx db {:type :layer/assoc-editor-config-pair
                             :project nil
                             :document nil
                             :description (str "Set editor config " editor-name "/" config-key
                                               " on layer " layer-id)
                             :user nil}]
                     (let [table (find-layer-table tx layer-id)]
                       (when-not table
                         (throw (ex-info (str "Not a valid layer ID: " layer-id) {:id layer-id :code 400})))
                       (let [row (psc/fetch-by-id tx table layer-id)
                             current (psc/parse-config (:config row))
                             ;; Config keys must round-trip as strings so user-supplied
                             ;; casing (PascalCase, camelCase) survives JSON storage.
                             new-config (assoc-in current
                                                  [(if (keyword? editor-name) (name editor-name) (str editor-name))
                                                   (if (keyword? config-key) (name config-key) (str config-key))]
                                                  config-value)]
                         (psc/update-by-id! tx table layer-id
                                            {:config (psc/serialize-config new-config)})))))

(defn dissoc-editor-config-pair
  "Remove <editor-name>/<config-key> from the layer's :config JSON."
  [db layer-id editor-name config-key]
  (submit-operation! [tx db {:type :layer/dissoc-editor-config-pair
                             :project nil
                             :document nil
                             :description (str "Unset editor config " editor-name "/" config-key
                                               " on layer " layer-id)
                             :user nil}]
                     (let [table (find-layer-table tx layer-id)]
                       (when-not table
                         (throw (ex-info (str "Not a valid layer ID: " layer-id) {:id layer-id :code 400})))
                       (let [row (psc/fetch-by-id tx table layer-id)
                             current (psc/parse-config (:config row))
                             ed-key (if (keyword? editor-name) (name editor-name) (str editor-name))
                             cfg-key (if (keyword? config-key) (name config-key) (str config-key))
                             new-config (update current ed-key dissoc cfg-key)]
                         (psc/update-by-id! tx table layer-id
                                            {:config (psc/serialize-config new-config)})))))

;; ============================================================
;; Vocab management (project_vocabs join + cascade vocab_links)
;; ============================================================

(defn add-vocab [db project-id vocab-id actor-user-id]
  (submit-operation! [tx db {:type :project/add-vocab
                             :project project-id
                             :document nil
                             :description (str "Add vocab " vocab-id " to project " project-id)
                             :user actor-user-id}]
                     (when (nil? (psc/fetch-by-id tx :projects project-id))
                       (throw (ex-info (psc/err-msg-not-found "Project" project-id)
                                       {:code 404 :id project-id})))
                     (when (nil? (psc/fetch-by-id tx :vocab_layers vocab-id))
                       (throw (ex-info (psc/err-msg-not-found "Vocab" vocab-id)
                                       {:code 400 :id vocab-id})))
                     ;; Snapshot the pre-state vocab grant list so the
                     ;; synthetic audit row (emitted after the write)
                     ;; carries an accurate pre-image.
                     (let [pre-vocabs (fetch-project-vocab-grants tx project-id)]
                       (psc/add-join-if-absent! tx :project_vocabs
                                                {:project_id project-id
                                                 :vocab_layer_id vocab-id})
                       (audit-project-vocabs-change! tx project-id pre-vocabs))))

(defn remove-vocab
  "Remove a vocab from a project. Also deletes vocab_links for that
  vocab's items that belong to documents in this project."
  [db project-id vocab-id actor-user-id]
  (submit-operation! [tx db {:type :project/remove-vocab
                             :project project-id
                             :document nil
                             :description (str "Remove vocab " vocab-id " from project " project-id)
                             :user actor-user-id}]
                     (when (nil? (psc/fetch-by-id tx :projects project-id))
                       (throw (ex-info (psc/err-msg-not-found "Project" project-id)
                                       {:code 404 :id project-id})))
                     (when (nil? (psc/fetch-by-id tx :vocab_layers vocab-id))
                       (throw (ex-info (psc/err-msg-not-found "Vocab" vocab-id)
                                       {:code 400 :id vocab-id})))
                     ;; Delete project-scoped vocab_links: any vocab_link
                     ;; whose vocab_item belongs to this vocab AND whose
                     ;; document belongs to this project. Capture the
                     ;; affected document_ids so we can bump their
                     ;; versions for OCC clients (task #72) — op-attrs
                     ;; carry :document nil, so the post-body
                     ;; bump-document-version! hook doesn't fire on
                     ;; those docs.
                     (let [vl-rows (psc/q tx
                                          {:select [:vl.id :vl.document_id]
                                           :from [[:vocab_links :vl]]
                                           :join [[:vocab_items :vi]
                                                  [:= :vi.id :vl.vocab_item_id]
                                                  [:documents :d]
                                                  [:= :d.id :vl.document_id]]
                                           :where [:and
                                                   [:= :vi.vocab_layer_id vocab-id]
                                                   [:= :d.project_id project-id]]})
                           vl-ids (mapv :id vl-rows)
                           affected-doc-ids (mapv :document_id vl-rows)]
                       (when (seq vl-ids)
                         (psc/delete-where! tx :vocab_links [:in :id vl-ids])
                         ;; Sweep orphan entity_metadata rows for those
                         ;; vocab_links — matches `vocab_layer.clj/delete`
                         ;; (#66). Intentionally NOT audited:
                         ;; parent-owned metadata is part of the parent's
                         ;; audit row.
                         (psc/execute! tx
                                       {:delete-from :entity_metadata
                                        :where [:and
                                                [:= :entity_type "vocab-link"]
                                                [:in :entity_id vl-ids]]}))
                       ;; Bump per-doc versions for OCC parity (task #72).
                       (op/bump-document-versions! tx affected-doc-ids))
                     ;; Snapshot AFTER vocab_links cleanup but BEFORE the
                     ;; junction-row removal so the synthetic audit
                     ;; captures only the grant transition itself.
                     (let [pre-vocabs (fetch-project-vocab-grants tx project-id)]
                       (psc/remove-join! tx :project_vocabs
                                         {:project_id project-id
                                          :vocab_layer_id vocab-id})
                       (audit-project-vocabs-change! tx project-id pre-vocabs))))
