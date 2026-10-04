(ns plaid.sql.project
  "Projects: the `projects` table, the ACL in `project_users` keyed by
  role, vocab grants in `project_vocabs`, and the editor `:config` as a
  JSON blob on the project row. The first argument is `db`, a HikariCP
  DataSource (reads) or a JDBC Connection in a tx (writes). Write fns open
  their own tx via `submit-operation!`."
  (:require [clojure.data.json :as json]
            [taoensso.timbre :as log]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.datasource :as psd]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.pagination :as pagination]
            [plaid.sql.user :as user])
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
   :config           (psc/parse-config (:config row))
   :constraints      (psc/parse-config (:constraints row))})

(defn- row->span-layer [row]
  {:span-layer/id   (:id row)
   :span-layer/name (:name row)
   :config          (psc/parse-config (:config row))
   :constraints     (psc/parse-config (:constraints row))})

(defn- row->relation-layer [row]
  {:relation-layer/id   (:id row)
   :relation-layer/name (:name row)
   :config              (psc/parse-config (:config row))
   :constraints         (psc/parse-config (:constraints row))})

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

(defn hidden?
  "Is `id` a project being deleted: marked by `delete`, not yet removed by
  `plaid.server.project-removal`? Such a project is gone to every reader and
  writer, admins included. False for an id no project has."
  [db id]
  (boolean (and id
                (psc/q1 db {:select [:id]
                            :from [:projects]
                            :where [:and [:= :id id] [:<> :deleted_at nil]]}))))

(defn hidden-ids
  "The ids of every project being deleted, oldest mark first."
  [db]
  (->> (psc/q db {:select [:id]
                  :from [:projects]
                  :where [:<> :deleted_at nil]
                  :order-by [:deleted_at]})
       (mapv :id)))

(defn get
  ([db id]
   (when-let [bare (row->project-bare (psc/q1 db {:select [:*]
                                                  :from [:projects]
                                                  :where [:and [:= :id id] [:= :deleted_at nil]]}))]
     (-> bare
         (->> (attach-acl db id))
         (->> (enrich-layers db))))))

(defn maintainer-ids [db id]
  (user-ids-for-role db id "maintainer"))

(defn get-all-ids
  "Every project's id, less the ones being deleted."
  [db]
  (->> (psc/q db {:select [:id] :from [:projects] :where [:= :deleted_at nil]})
       (mapv :id)))

(defn get-accessible-ids
  "The ids of the projects `user-id` holds a role on, less the ones being
  deleted (whose roles `delete` already removed)."
  [db user-id]
  (->> (psc/q db {:select-distinct [:pu.project_id]
                  :from [[:project_users :pu]]
                  :join [[:projects :p] [:= :p.id :pu.project_id]]
                  :where [:and [:= :pu.user_id user-id] [:= :p.deleted_at nil]]})
       (mapv :project_id)))

(defn maintainer-of-any?
  "True iff `user-id` maintains at least one project. Gates access to the
  user directory (list/search): maintainers need it to grant project roles."
  [db user-id]
  (boolean (psc/q1 db {:select [[1 :one]]
                       :from [:project_users]
                       :where [:and [:= :user_id user-id] [:= :role "maintainer"]]
                       :limit 1})))

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
  maintainer role — the REST handler passes the creating user), and
  optional :project/id (a client's UUIDv7, else the server mints one).
  Returns {:success true :extra <new-id>}.

  Audit shape: ONE audit_writes row against `:projects` with change_type
  :insert, whose post-image is the projects row augmented with the
  :readers/:writers/:maintainers role vectors (unnamespaced — the audit
  \"extras\" shape; see `fetch-project-acl-snapshot`). Manual insert + folded
  audit (vs. `crud/insert!`) so the maintainer grant rides the SAME audit row —
  otherwise the project_users grant would be invisible to history replay and the
  creator wouldn't be reconstructed as a maintainer."
  [db attrs user-id]
  (let [{:project/keys [name maintainers]} attrs
        new-id (or (:project/id attrs) (psc/new-uuid))
        config (clojure.core/get attrs :config {})]
    (submit-operation! [tx db {:type :project/create
                               :project new-id
                               :document nil
                               :description (str "Create project \"" name "\"")
                               :user user-id}]
                       ;; Validation inside the body so submit-operation*'s
                       ;; outer catch surfaces a structured 4xx (task #47).
                       (psc/assert-valid-name! name)
                       (psc/claim-ids! tx :projects "project" [(:project/id attrs)])
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
                         (crud/add-join! tx :project_users
                                         {:project_id new-id :user_id uid :role "maintainer"}))
                       (let [proj-row (psc/fetch-by-id tx :projects new-id)
                             post-image (clojure.core/merge proj-row (fetch-project-acl-snapshot tx new-id))]
                         (psaw/record-audit-write! tx :projects new-id :insert nil post-image))
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
                       (psc/assert-valid-name! n))
                     (let [existing (psc/fetch-by-id tx :projects eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Project" eid) {:code 404 :id eid})))
                       (let [attrs (cond-> {}
                                     (some? (:project/name m))
                                     (assoc :name (:project/name m)))]
                         (when (seq attrs)
                           (crud/update-by-id! tx :projects eid attrs))
                         eid))))

(defn delete
  "Delete a project, and truly delete it: not recoverable, not
  time-travelable. In ONE SHORT STEP, so saves elsewhere on the server are
  never held up behind it:

  - `projects.deleted_at` is stamped. From that moment the project is gone to
    everyone, admins included: `get`, `get-all-ids` and
    `get-accessible-ids` leave it out (the project list, the query
    language's scope) and the route gate refuses it
    (`plaid.rest-api.v1.auth/wrap-project-privileges-required`, via `hidden?`).
  - Its roles (`project_users`), vocabulary grants (`project_vocabs`) and
    pending invites are removed, so nothing reached through membership
    or a grant still leads into it. These are unaudited, as the cascade that
    used to remove them was.
  - Exactly ONE audit row is emitted: `:projects` `:delete` with the project
    row as its pre-image, as before.

  Everything under it is removed afterwards by
  `plaid.server.project-removal`, one document per transaction
  (`remove-hidden-document!`, then `remove-hidden-project!`). Removing a
  400-document project in one transaction held the write lock for 18 s,
  and every save on the server waited for it.

  A project already being deleted answers 404, as a removed one does."
  [db eid user-id]
  ;; The row names the project by its name too: once the removal has run it is
  ;; all that is left of the project, and an id names nothing a reader knows.
  ;; A missing project fails inside the operation, before anything is written
  ;; under this description.
  (submit-operation! [tx db {:type :project/delete
                             :project eid
                             :document nil
                             :description (let [pname (:name (psc/fetch-by-id db :projects eid))]
                                            (if pname
                                              (str "Delete project \"" pname "\" (" eid ")")
                                              (str "Delete project " eid)))
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :projects eid)]
                       (when (or (nil? existing) (some? (:deleted_at existing)))
                         (throw (ex-info (psc/err-msg-not-found "Project" eid) {:code 404 :id eid})))
                       (psc/execute! tx {:update :projects
                                         :set {:deleted_at (psc/now-iso)}
                                         :where [:= :id eid]})
                       (doseq [table [:project_users :project_vocabs :invites]]
                         (psc/execute! tx {:delete-from table :where [:= :project_id eid]}))
                       (psaw/record-audit-write! tx :projects eid :delete existing nil)
                       eid)))

(defn- sweep-metadata!
  "Delete the `entity_metadata` rows of the `etype` entities `table` holds
  under `where`. The one table no FK cascade reaches (it is polymorphic), so
  each removal step clears it BEFORE dropping the rows that own it, while
  the subquery still finds them. Unaudited, per the parent-owned-metadata
  contract."
  [tx etype table where]
  (psc/execute! tx {:delete-from :entity_metadata
                    :where [:and
                            [:= :entity_type etype]
                            [:in :entity_id {:select [:id] :from [table] :where where}]]}))

(defn remove-hidden-document!
  "Remove ONE document of project `pid`, which must be being deleted, and
  everything under it, in one transaction: its metadata, then the document
  row, whose FK cascade takes its texts, tokens, spans, relations and vocab
  links. Returns the removed document's id, or nil when the project has no
  documents left (or is not being deleted, so nothing is touched). Raw and
  unaudited: the project's one `:delete` audit row already recorded it."
  [datasource pid]
  (psd/with-tx [tx datasource]
    (when-let [doc-id (:id (psc/q1 tx {:select [:d.id]
                                       :from [[:documents :d]]
                                       :join [[:projects :p] [:= :p.id :d.project_id]]
                                       :where [:and [:= :d.project_id pid] [:<> :p.deleted_at nil]]
                                       :limit 1}))]
      (let [in-doc [:= :document_id doc-id]]
        (sweep-metadata! tx "text" :texts in-doc)
        (sweep-metadata! tx "token" :tokens in-doc)
        (sweep-metadata! tx "span" :spans in-doc)
        (sweep-metadata! tx "relation" :relations in-doc)
        (sweep-metadata! tx "vocab-link" :vocab_links in-doc)
        (psc/execute! tx {:delete-from :entity_metadata
                          :where [:and [:= :entity_type "document"] [:= :entity_id doc-id]]})
        (psc/execute! tx {:delete-from :documents :where [:= :id doc-id]}))
      doc-id)))

(defn remove-hidden-project!
  "The last step of removing project `pid`, once `remove-hidden-document!`
  has taken every document: the layers' and the project's own metadata, then
  the project row, whose FK cascade takes its layers, comments, guidelines
  and whatever else still names it. One transaction, and a short one with the
  documents gone. Returns true when it removed the row. Does nothing to a
  project that is not being deleted or still has documents."
  [datasource pid]
  (psd/with-tx [tx datasource]
    (when (and (psc/q1 tx {:select [:id] :from [:projects]
                           :where [:and [:= :id pid] [:<> :deleted_at nil]]})
               (nil? (psc/q1 tx {:select [:id] :from [:documents]
                                 :where [:= :project_id pid] :limit 1})))
      (let [in-project [:= :project_id pid]]
        (sweep-metadata! tx "text-layer" :text_layers in-project)
        (sweep-metadata! tx "token-layer" :token_layers in-project)
        (sweep-metadata! tx "span-layer" :span_layers in-project)
        (sweep-metadata! tx "relation-layer" :relation_layers in-project))
      (psc/execute! tx {:delete-from :entity_metadata
                        :where [:and [:= :entity_type "project"] [:= :entity_id pid]]})
      (psc/execute! tx {:delete-from :projects :where [:= :id pid]})
      true)))

(def purge-chunking
  "How `purge-deleted-project-history!` sizes its DELETEs. Each is one
  autocommit statement, so each holds the write lock for as long as it runs,
  and the number that matters is that time, not the row count: a 5000-row
  DELETE on `operations` took 0.1 s on fresh planner statistics and 34 to
  138 s on stale ones (a table analysed while nearly empty plans the FK
  cascade into `audit_writes` as a scan per deleted row), and every save
  answered 503 meanwhile. So a chunk starts small, and the next one is sized
  from how long the last took, to stay near `:budget-ms`, growing at most
  twofold, never past `:max-rows` and never below one row."
  {:initial-rows 50 :max-rows 5000 :budget-ms 100})

(defn next-purge-chunk
  "The row count of the chunk after one of `rows` rows that took `ms`."
  [rows ms]
  (let [{:keys [max-rows budget-ms]} purge-chunking
        fit (long (* rows (/ (double budget-ms) (max (double ms) 1.0))))]
    (-> fit (min (* 2 rows)) (min max-rows) (max 1))))

(def ^:private purge-attempts
  "How many times one chunk is tried when it cannot get the write lock (a
  long write elsewhere, SQLITE_BUSY past busy_timeout) before the purge
  gives up."
  10)

(defn- purge-chunk!
  "Run one chunk's DELETE, trying again a second later while it is busy."
  [datasource sql]
  (psd/retry-busy datasource "A history purge chunk" purge-attempts
                  #(psc/execute! datasource sql)))

(def ^:private delete-op-type
  "The `op_type` of the operation `delete` writes, the one a purge keeps."
  "project/delete")

(defn- history-to-purge
  "The operations of project `project-id` a purge removes: all but the
  delete's own."
  [project-id]
  [:and [:= :project_id project-id] [:<> :op_type delete-op-type]])

(defn purge-deleted-project-history!
  "Reclaim the `operations` + `audit_writes` a project accumulated over its
  lifetime, all but the record of its deletion. Project delete is
  intentionally cheap: it does NOT audit its descendants and leaves the
  project's whole op/audit history in place. A deleted project is not
  time-travelable (`plaid.history.read/project-live?`), so that history is
  unreadable dead weight, and this purges it. The `project/delete` operation,
  its one `:projects` `:delete` audit row and its operation group stay: the
  ruling is a true delete with exactly one audit row.

  Meant to run in the BACKGROUND, from `plaid.server.project-removal`, once
  the project's documents are gone and before its row is: a purge cut short
  leaves the project marked deleted, and startup takes it up again. History
  stranded some other way (a project removed with the purge off) is found by
  `stranded-history-project-ids`. Deletes in chunks, each its own autocommit
  statement on `datasource`, so the single SQLite writer lock is released
  between them. A chunk is sized by how long the last one held the lock
  (`purge-chunking`), and with `:pause-ms` the purge stands off the database
  after each chunk for that long or for as long as the chunk took, whichever
  is more, so a writer parked in its busy_timeout retry loop (which polls at
  most 100 ms apart) is certain to find the lock free. Phase 1 clears the
  project's audit_writes (the bulk), phase 2 the now-childless operations
  rows, phase 3 the operation_groups no operation names.

  Raw + unaudited: operations/audit_writes ARE the audit infrastructure, not
  audited entities, so this does not go through `submit-operation!`.

  Only for a project that is being deleted or gone: nothing here checks.
  Returns `{:audit-rows n :operations n :operation-groups n :longest-ms n}`,
  the last the longest one chunk held the lock."
  ([datasource project-id]
   (purge-deleted-project-history! datasource project-id nil))
  ([datasource project-id {:keys [pause-ms] :or {pause-ms 0}}]
   (let [longest (atom 0)
         drain! (fn [query-fn]
                  (loop [total 0
                         rows (:initial-rows purge-chunking)]
                    (let [t0 (System/nanoTime)
                          n (purge-chunk! datasource (query-fn rows))
                          ms (quot (- (System/nanoTime) t0) 1000000)]
                      (swap! longest max ms)
                      (if (pos? n)
                        (do (when (pos? pause-ms)
                              (Thread/sleep (long (max pause-ms ms))))
                            (recur (+ total n) (next-purge-chunk rows ms)))
                        total))))
         audit-rows (drain!
                     (fn [limit]
                       {:delete-from :audit_writes
                        :where [:in :id
                                {:select [:id] :from [:audit_writes]
                                 :where [:in :op_id
                                         {:select [:id] :from [:operations]
                                          :where (history-to-purge project-id)}]
                                 :limit limit}]}))
         operations (drain!
                     (fn [limit]
                       {:delete-from :operations
                        :where [:in :id
                                {:select [:id] :from [:operations]
                                 :where (history-to-purge project-id)
                                 :limit limit}]}))
         ;; Phase 3: operation_groups rows that no surviving op references
         ;; any more. The grouped audit read folds FROM operations, so an
         ;; orphan would never surface anyway; this just keeps the table tidy.
         groups (drain!
                 (fn [limit]
                   {:delete-from :operation_groups
                    :where [:in :id
                            {:select [:id] :from [:operation_groups]
                             :where [:not [:exists {:select [1] :from [:operations]
                                                    :where [:= :operations.group_id :operation_groups.id]}]]
                             :limit limit}]}))]
     {:audit-rows audit-rows :operations operations :operation-groups groups
      :longest-ms @longest})))

(defn stranded-history-project-ids
  "The ids of projects that are gone (no row in `projects`) but still have
  history a purge removes: a purge cut short before the purge resumed from
  the project row, or a project removed with the purge off. Walks the
  distinct `operations.project_id` values one index seek at a time, so it
  costs a seek per project ever made, not a scan of the operations."
  [db]
  (loop [after "", out []]
    (if-let [pid (:project_id (psc/q1 db [(str "SELECT project_id FROM operations "
                                               "INDEXED BY idx_operations_project_ts "
                                               "WHERE project_id > ? ORDER BY project_id LIMIT 1")
                                          after]))]
      (recur (str pid)
             (if (and (nil? (psc/q1 db {:select [:id] :from [:projects] :where [:= :id pid]}))
                      (psc/q1 db {:select [1] :from [:operations]
                                  :where (history-to-purge pid) :limit 1}))
               (conj out pid)
               out))
      out)))

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
        (psaw/record-audit-write! tx :projects project-id :update pre-image post-image)))))

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
        (psaw/record-audit-write! tx :projects project-id :update pre-image post-image)))))

(defn sole-maintainer-project-ids
  "Project ids on which `user-id` is the ONLY user holding the maintainer
  role, narrowed to `project-id` when one is given (nil = every project they
  maintain).

  The single place that question is answered. `assert-maintainer-remains!`
  asks it about the one project a role write touches; `plaid.sql.user`'s
  deactivation asks it about all of them at once, because deactivation strips
  every membership in one go and the operator should see the whole list."
  [tx user-id project-id]
  (->> (psc/q tx (cond-> {:select [:project_id]
                          :from [:project_users]
                          :where [:= :role "maintainer"]
                          :group-by [:project_id]
                          :having [:and
                                   [:= [:count :*] 1]
                                   [:= [:max :user_id] user-id]]}
                   project-id (assoc :where [:and
                                             [:= :role "maintainer"]
                                             [:= :project_id project-id]])))
       (mapv :project_id)))

(defn- role-held
  "The role `user-id` holds in the `acl` snapshot, nil for none. Roles are
  mutually exclusive, so there is at most one."
  [acl user-id]
  (some (fn [[role ids]]
          (when (some #{user-id} ids) role))
        [["maintainer" (:maintainers acl)]
         ["writer" (:writers acl)]
         ["reader" (:readers acl)]]))

(defn- assert-maintainer-remains!
  "Refuse a project_users write that would leave `project-id` with no
  maintainer. `next-role` is the role `user-id` holds once the write lands,
  nil when they hold none.

  A project with zero maintainers is unrecoverable through the REST API,
  since only a maintainer can grant roles, so this is a data-loss guard
  rather than a courtesy. Both writers of project_users call it, which is
  the point: `POST /projects/:id/readers/<only maintainer>` demotes exactly
  as `DELETE /projects/:id/maintainers/<them>` does, and only the second one
  used to be refused."
  [tx project-id user-id next-role]
  (when (and (not= next-role "maintainer")
             (seq (sole-maintainer-project-ids tx user-id project-id)))
    (throw (ex-info "A project needs at least one maintainer."
                    {:code 400 :project-id project-id :user-id user-id}))))

(defn add-role!
  "Grant `role` on `project-id` to `user-id`, clearing any role they already
  hold there (roles are mutually exclusive). Emits the synthetic project ACL
  audit row. Must run inside `submit-operation!`.

  PUBLIC because invite redemption (plaid.sql.invite/redeem!) applies the
  invite's project grant in the same tx that creates the account — going
  through `add-writer` and friends would open a second operation, which could
  leave the account existing without its grant if that second op failed."
  [tx project-id user-id role]
  (assert-user-and-project! tx project-id user-id)
  (assert-maintainer-remains! tx project-id user-id role)
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
    (crud/remove-join! tx :project_users
                       {:project_id project-id :user_id user-id})
    (crud/add-join! tx :project_users
                    {:project_id project-id
                     :user_id user-id
                     :role role})
    (audit-project-acl-change! tx project-id pre-acl)))

(defn- remove-role!
  [tx project-id user-id role]
  (assert-user-and-project! tx project-id user-id)
  (let [pre-acl (fetch-project-acl-snapshot tx project-id)
        held (role-held pre-acl user-id)]
    ;; The DELETE names the role, so removing a role the user does not hold
    ;; leaves the one they do hold alone: that is the role to check against.
    (assert-maintainer-remains! tx project-id user-id (when (not= held role) held))
    (crud/remove-join! tx :project_users
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

(def config-tables
  "The tables whose rows carry an editor `:config` column. The route that
  reaches one of these names its own table, so a config write never has to
  search for the row's kind.

  Both ends check against this set: `plaid.rest-api.v1.layer` when the route
  is built, so a bad table fails at boot, and `config-row!` on the write."
  #{:projects :text_layers :token_layers :span_layers :relation_layers :vocab_layers})

(defn- editor-config-project-id
  "Project id to attribute an editor-config op to: the layer's
  denormalized project_id, the project itself when `layer-id` IS a
  project, nil for vocab layers (global — linked to projects only via
  project_vocabs) and for an id that is not in `table` (the op body then 400s)."
  [db table layer-id]
  (when-let [row (psc/fetch-by-id db table layer-id)]
    (case table
      :projects (:id row)
      :vocab_layers nil
      (:project_id row))))

(defn- config-update-attrs
  "Column attrs for a config write on `table`. Vocab layers additionally
  carry a `modified_at` (their \"Updated\" column has no other source, and
  config is part of the vocabulary), folded in here so the change rides the
  one audit row rather than a second synthetic touch. Other layer tables
  have no such column."
  [table new-config]
  (cond-> {:config (psc/serialize-config new-config)}
    (= table :vocab_layers) (assoc :modified_at (op/op-ts))))

(defn- config-row!
  "The row a config write is about to edit, read inside the tx from the one
  table the route named. An id absent from that table is a 400: the route
  said which kind it is."
  [tx table layer-id]
  (when-not (config-tables table)
    (throw (ex-info (str "Not a table that carries editor config: " table) {:table table :code 500})))
  (or (psc/fetch-by-id tx table layer-id)
      (throw (ex-info (str "Not a valid layer ID: " layer-id) {:id layer-id :code 400}))))

(defn- config-cell-keys
  "The two string keys of one config cell. Config keys must round-trip as
  strings so user-supplied casing (PascalCase, camelCase) survives JSON
  storage."
  [editor-name config-key]
  [(if (keyword? editor-name) (name editor-name) (str editor-name))
   (if (keyword? config-key) (name config-key) (str config-key))])

(defn- same-json?
  "Whether two decoded JSON values are the same JSON. JSON has one kind of
  number, so 1 and 1.0 are the same: a Python writer stores `1.0`, and a
  JavaScript page reads it back as 1 and sends `1`."
  [a b]
  (cond
    (and (number? a) (number? b)) (== a b)
    (and (map? a) (map? b)) (and (= (count a) (count b))
                                 (every? (fn [[k v]] (and (contains? b k) (same-json? v (clojure.core/get b k)))) a))
    (and (sequential? a) (sequential? b)) (and (= (count a) (count b))
                                               (every? true? (map same-json? a b)))
    :else (= a b)))

(defn- assert-config-unchanged!
  "Compare-and-set for a config write. `check` is nil (no check) or
  `{:expected v :value w}`: `v` the value the writer read for this one cell
  (nil when the cell was absent, which is the same as a stored null), `w`
  the value it writes (nil for a delete). Both arrive decoded from a
  request body, with keyword keys, so they are put through JSON once to
  compare in the stored shape (string keys). A 409 when the cell holds
  anything else, so a page that read the settings before another
  maintainer saved them cannot write over that save. A cell that already
  holds `w` passes: that is this very save sent again after its answer
  was lost, and writing it again changes nothing."
  [current cell check]
  (when check
    (let [as-stored #(json/read-str (json/write-str %))
          stored (get-in current cell)]
      (when-not (or (same-json? (as-stored (:expected check)) stored)
                    (same-json? (as-stored (:value check)) stored))
        (throw (ex-info "This setting was changed by someone else since it was read"
                        {:code 409 :cell cell}))))))

(defn assoc-editor-config-pair
  "Set <editor-name>/<config-key> = <config-value> in the layer's :config
  JSON. `table` is the row's own table, which the caller's route already
  determined (:projects / :text_layers / :token_layers / :span_layers /
  :relation_layers / :vocab_layers). `acting-user-id` attributes the op
  (a maintainer-level action). `check`, when given, is `{:expected v}`:
  the write happens only while the cell still holds `v` (see
  `assert-config-unchanged!`)."
  ([db table layer-id editor-name config-key config-value acting-user-id]
   (assoc-editor-config-pair db table layer-id editor-name config-key config-value acting-user-id nil))
  ([db table layer-id editor-name config-key config-value acting-user-id check]
   (submit-operation! [tx db {:type :layer/assoc-editor-config-pair
                              :project (editor-config-project-id db table layer-id)
                              :document nil
                              :description (str "Set editor config " editor-name "/" config-key
                                                " on layer " layer-id)
                              :user acting-user-id}]
                      (let [row (config-row! tx table layer-id)
                            current (psc/parse-config (:config row))
                            cell (config-cell-keys editor-name config-key)
                            _ (assert-config-unchanged! current cell (some-> check (assoc :value config-value)))
                            new-config (assoc-in current cell config-value)]
                        (crud/update-by-id! tx table layer-id
                                            (config-update-attrs table new-config))))))

(defn dissoc-editor-config-pair
  "Remove <editor-name>/<config-key> from the layer's :config JSON. `table`
  is the row's own table, as in `assoc-editor-config-pair`.
  `acting-user-id` attributes the op (a maintainer-level action). `check`
  is the same compare-and-set as on `assoc-editor-config-pair`."
  ([db table layer-id editor-name config-key acting-user-id]
   (dissoc-editor-config-pair db table layer-id editor-name config-key acting-user-id nil))
  ([db table layer-id editor-name config-key acting-user-id check]
   (submit-operation! [tx db {:type :layer/dissoc-editor-config-pair
                              :project (editor-config-project-id db table layer-id)
                              :document nil
                              :description (str "Unset editor config " editor-name "/" config-key
                                                " on layer " layer-id)
                              :user acting-user-id}]
                      (let [row (config-row! tx table layer-id)
                            current (psc/parse-config (:config row))
                            [ed-key cfg-key :as cell] (config-cell-keys editor-name config-key)
                            _ (assert-config-unchanged! current cell (some-> check (assoc :value nil)))
                            new-config (update current ed-key dissoc cfg-key)]
                        (crud/update-by-id! tx table layer-id
                                            (config-update-attrs table new-config))))))

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
                       (crud/add-join-if-absent! tx :project_vocabs
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
                         (crud/delete-where! tx :vocab_links [:in :id vl-ids])
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
                       (crud/remove-join! tx :project_vocabs
                                          {:project_id project-id
                                           :vocab_layer_id vocab-id})
                       (audit-project-vocabs-change! tx project-id pre-vocabs))))
