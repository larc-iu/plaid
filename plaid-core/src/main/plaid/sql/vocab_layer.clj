(ns plaid.sql.vocab-layer
  "Vocab layers: the `vocab_layers` table and their project links in
  `project_vocabs`.

  A vocabulary belongs to one project, its home (`project_id`, 2026-11-12):
  its rights are that project's roles, and its operations are audited under
  that project. Other projects may link it as borrowers, read only. The home's
  own row is in `project_vocabs` too, so every reader of \"the vocabularies of
  a project\" sees it: for every vocabulary of a live project, the row
  `(project_id, id)` exists there (written by `create` and `move`, never
  removed while the home lives).

  Items live in `vocab_items` (see plaid.sql.vocab-item) and are
  cascade-deleted by the FK when a vocab layer is dropped."
  (:require [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.pagination :as pagination]
            [plaid.sql.user :as user]
            [plaid.sql.vocab-item :as vocab-item])
  (:refer-clojure :exclude [get merge]))

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->vocab-bare
  "Translate a `vocab_layers` row to the namespaced shape.

  :vocab/time-created and :vocab/time-modified mirror the document shape
  (`created_at` / `modified_at` columns). Both are nil for vocabularies
  created before those columns existed, so readers must tolerate absence.
  :vocab/project is the home project's id."
  [row]
  (when row
    {:vocab/id            (:id row)
     :vocab/name          (:name row)
     :vocab/project       (:project_id row)
     :vocab/time-created  (:created_at row)
     :vocab/time-modified (:modified_at row)
     :config              (psc/parse-config (:config row))}))

(declare get-items-fn)

(defn get
  "Get a vocab layer by ID.

  When `include-items?` is true, also assoc :vocab/items via
  plaid.sql.vocab-item/get-all-in-layer (resolved at call time to dodge
  the require cycle)."
  ([db id]
   (get db id false))
  ([db id include-items?]
   (when-let [bare (row->vocab-bare (psc/fetch-by-id db :vocab_layers id))]
     (cond-> bare
       include-items?
       (assoc :vocab/items (get-items-fn db id))))))

;; Lazily resolved to avoid the require cycle between
;; vocab-layer ↔ vocab-item.
(defn- get-items-fn [db id]
  (let [v (requiring-resolve 'plaid.sql.vocab-item/get-all-in-layer)]
    (v db id)))

;; ============================================================
;; Homes and accessibility
;; ============================================================

(defn home-of
  "The id of the project vocab layer `vocab-id` belongs to, nil when there is
  no such vocabulary."
  [db vocab-id]
  (when vocab-id
    (:project_id (psc/q1 db {:select [:project_id] :from [:vocab_layers] :where [:= :id vocab-id]}))))

(defn homes-of
  "The distinct home project ids of the vocab layers `vocab-ids` that exist."
  [db vocab-ids]
  (if-let [ids (seq (distinct (remove nil? vocab-ids)))]
    (->> (psc/q db {:select-distinct [:project_id] :from [:vocab_layers] :where [:in :id (vec ids)]})
         (mapv :project_id))
    []))

(defn hidden-home?
  "Is the home of `vocab-id` a project being deleted?"
  [db vocab-id]
  (boolean (and vocab-id
                (psc/q1 db {:select [1]
                            :from [[:vocab_layers :v]]
                            :join [[:projects :p] [:= :p.id :v.project_id]]
                            :where [:and [:= :v.id vocab-id] [:<> :p.deleted_at nil]]}))))

(defn borrower-ids
  "The live projects that link `vocab-id` and are not its home, ordered by id."
  [db vocab-id]
  (->> (psc/q db {:select [:pv.project_id]
                  :from [[:project_vocabs :pv]]
                  :join [[:vocab_layers :v] [:= :v.id :pv.vocab_layer_id]
                         [:projects :p] [:= :p.id :pv.project_id]]
                  :where [:and
                          [:= :pv.vocab_layer_id vocab-id]
                          [:<> :pv.project_id :v.project_id]
                          [:= :p.deleted_at nil]]
                  :order-by [:pv.project_id]})
       (mapv :project_id)))

(defn links?
  "Does project `project-id` link vocab layer `vocab-id` (as its home or a
  borrower)?"
  [db project-id vocab-id]
  (some? (psc/q1 db {:select [1]
                     :from [:project_vocabs]
                     :where [:and [:= :project_id project-id] [:= :vocab_layer_id vocab-id]]})))

(defn accessible-through-project?
  "True iff `user-id` has any role on any project that links `vocab-id`
  (its home or a borrower): read access."
  [db vocab-id user-id]
  (some? (psc/q1 db {:select [[:pv.project_id :pid]]
                     :from [[:project_vocabs :pv]]
                     :join [[:project_users :pu]
                            [:= :pu.project_id :pv.project_id]]
                     :where [:and
                             [:= :pv.vocab_layer_id vocab-id]
                             [:= :pu.user_id user-id]]
                     :limit 1}
                 {:uuid-cols #{:pid}})))

(defn linking-writer?
  "True iff `user-id` has writer or maintainer role on any project that links
  `vocab-id`. Not a right over entries (those follow the home's roles): the
  gate for commenting on an entry."
  [db vocab-id user-id]
  (some? (psc/q1 db {:select [[:pv.project_id :pid]]
                     :from [[:project_vocabs :pv]]
                     :join [[:project_users :pu]
                            [:= :pu.project_id :pv.project_id]]
                     :where [:and
                             [:= :pv.vocab_layer_id vocab-id]
                             [:= :pu.user_id user-id]
                             [:in :pu.role ["writer" "maintainer"]]]
                     :limit 1}
                 {:uuid-cols #{:pid}})))

(defn get-accessible-ids
  "Vocab IDs the user can see: those linked by a project they have any role
  on. An admin sees every vocabulary whose home is not being deleted."
  [db user-id]
  (let [user-rec (user/get db user-id)]
    (if (user/admin? user-rec)
      (->> (psc/q db {:select [:v.id]
                      :from [[:vocab_layers :v]]
                      :join [[:projects :p] [:= :p.id :v.project_id]]
                      :where [:= :p.deleted_at nil]})
           (mapv :id))
      (->> (psc/q db {:select-distinct [:pv.vocab_layer_id]
                      :from [[:project_vocabs :pv]]
                      :join [[:project_users :pu]
                             [:= :pu.project_id :pv.project_id]]
                      :where [:= :pu.user_id user-id]})
           (mapv :vocab_layer_id)))))

(defn batch-hydrate-vocab-layers
  "Hydrate `vocab-ids` into the same per-vocab shape as `(get db id)`.
  Preserves the order of `vocab-ids` and drops ids that have no matching
  row. One SELECT whatever the number of ids."
  [db vocab-ids]
  (if (empty? vocab-ids)
    []
    (let [vl-rows (psc/q db {:select [:*]
                             :from [:vocab_layers]
                             :where [:in :id vocab-ids]})
          vl-by-id (into {} (map (juxt :id row->vocab-bare) vl-rows))]
      (->> vocab-ids
           (keep #(clojure.core/get vl-by-id %))
           vec))))

(defn get-accessible
  "Hydrated vocab records accessible to `user-id`."
  ([db user-id]
   (batch-hydrate-vocab-layers db (get-accessible-ids db user-id)))
  ([db user-id {:keys [limit cursor-vals]}]
   ;; Paginated arity: shape the (bounded, per-user) accessible set into the
   ;; uniform {:entries :next-cursor} envelope. Sorted by (name, id) —
   ;; :vocab/id is the unique tiebreaker.
   (pagination/paginate-coll (get-accessible db user-id)
                             [:vocab/name :vocab/id]
                             limit cursor-vals)))

;; ============================================================
;; Writes: create / merge / move / delete
;; ============================================================

(defn- vocab-name [db id]
  (:name (psc/q1 db {:select [:name] :from [:vocab_layers] :where [:= :id id]})))

(defn- project-name [db id]
  (:name (psc/q1 db {:select [:name] :from [:projects] :where [:= :id id]})))

(defn- fetch-project-vocab-ids
  "The vocab layer ids `project-id` links, ordered by id: the `:vocabs` fold
  of a synthetic `:projects` audit row, ordered as `plaid.sql.project` orders
  it."
  [tx project-id]
  (->> (psc/q tx {:select [:vocab_layer_id]
                  :from [:project_vocabs]
                  :where [:= :project_id project-id]
                  :order-by [:vocab_layer_id]})
       (mapv :vocab_layer_id)))

(defn- link-project!
  "Give `project-id` its `project_vocabs` row for `vocab-id` when it has none,
  with the synthetic `:projects` audit row whose `:vocabs` gains the id."
  [tx project-id vocab-id]
  (let [pre (fetch-project-vocab-ids tx project-id)]
    (crud/add-join-if-absent! tx :project_vocabs {:project_id project-id :vocab_layer_id vocab-id})
    (let [post (fetch-project-vocab-ids tx project-id)]
      (when (not= pre post)
        (let [row (psc/fetch-by-id tx :projects project-id)]
          (psaw/record-audit-write! tx :projects project-id :update
                                    (assoc row :vocabs pre) (assoc row :vocabs post)))))))

(defn- assert-live-project!
  [tx project-id]
  (let [row (psc/fetch-by-id tx :projects project-id)]
    (when (or (nil? row) (some? (:deleted_at row)))
      (throw (ex-info (str "Not a valid project ID: " project-id) {:code 400 :id project-id})))))

(defn create
  "Create a new vocab layer in project `:vocab/project`, its home.
  `:vocab/id` names its id (a client's UUIDv7), else the server mints one.
  Returns {:success true :extra <new-id>}.

  Audited under the home: one `:vocab_layers` insert (its image carries
  `project_id`), and one synthetic `:projects` update whose `:vocabs` gains
  the id (the home's row in `project_vocabs`)."
  [db attrs user-id]
  (let [{:vocab/keys [name project]} attrs
        new-id (or (:vocab/id attrs) (psc/new-uuid))
        config (clojure.core/get attrs :config {})]
    (submit-operation! [tx db {:type :vocab/create
                               :project project
                               :document nil
                               :description (str "Create vocabulary “" name "”")
                               :user user-id}]
                       (psc/assert-valid-name! name)
                       (assert-live-project! tx project)
                       (psc/claim-ids! tx :vocab_layers "vocabulary" [(:vocab/id attrs)])
                       ;; Stamped from the op's ts (not a fresh now-iso) so the
                       ;; timestamps agree with the operations row, as documents do.
                       (let [ts (op/op-ts)]
                         (crud/insert! tx :vocab_layers {:id new-id
                                                         :name name
                                                         :config (psc/serialize-config config)
                                                         :created_at ts
                                                         :modified_at ts
                                                         :project_id project}))
                       (link-project! tx project new-id)
                       new-id)))

(defn linked-document-ids
  "Ids of every document holding a link to an entry of `vocab-id`. A deep
  document read names each linked vocabulary's name and config, so a write
  to either restates exactly these documents and bumps them (R14). A move
  bumps none of them (the home is not restated content, as R22 ruled for
  maintainers). A document of a project being deleted is left out, as
  `vocab-item/linked-document-ids` leaves it out (R39)."
  [tx vocab-id]
  (->> (psc/q tx {:select-distinct [:vl.document_id]
                  :from [[:vocab_links :vl]]
                  :join [[:vocab_items :vi] [:= :vi.id :vl.vocab_item_id]
                         [:documents :d] [:= :d.id :vl.document_id]
                         [:projects :p] [:= :p.id :d.project_id]]
                  :where [:and [:= :vi.vocab_layer_id vocab-id] [:= :p.deleted_at nil]]})
       (mapv :document_id)))

(defn merge
  "Update mutable vocab fields. Currently supports :vocab/name. A new name
  bumps every document linking the vocabulary (`linked-document-ids`)."
  [db eid m user-id]
  (let [old-name (vocab-name db eid)]
    (submit-operation! [tx db {:type :vocab/update
                               :project (home-of db eid)
                               :document nil
                               :description (if (:vocab/name m)
                                              (str "Rename vocabulary “" old-name "” to “" (:vocab/name m) "”")
                                              (str "Update vocabulary “" old-name "”"))
                               :user user-id}]
                       (when (contains? m :vocab/name)
                         (psc/assert-valid-name! (:vocab/name m)))
                       (let [existing (psc/fetch-by-id tx :vocab_layers eid)]
                         (when (nil? existing)
                           (throw (ex-info (psc/err-msg-not-found "Vocab" eid) {:code 404 :id eid})))
                         (let [attrs (cond-> {}
                                       (some? (:vocab/name m))
                                       (assoc :name (:vocab/name m)))]
                           (when (seq attrs)
                             ;; Folded rather than a separate touch-vocab-layer! call:
                             ;; this op already writes the row, so one audit row carries
                             ;; both the new name and the new modified_at.
                             (crud/update-by-id! tx :vocab_layers eid
                                                 (assoc attrs :modified_at (op/op-ts))))
                           (when (and (contains? attrs :name) (not= (:name attrs) (:name existing)))
                             (op/bump-document-versions! tx (linked-document-ids tx eid)))
                           eid)))))

(defn move
  "Make project `target` the home of vocab layer `eid`. The old home keeps its
  `project_vocabs` row and so becomes a borrower, the target gains its row
  when it had none. Audited under the OLD home, the project losing the
  rights, so its Activity says so, and heard by the new home's listeners
  too. Bumps no document: no deep read changes but each vocabulary's
  `project`, which is not restated content. A move to the current home
  writes nothing (`{:success true :extra eid}` without an operation)."
  [db eid target user-id]
  (let [home (home-of db eid)]
    (if (and home (= (str home) (str target)))
      {:success true :extra eid}
      (submit-operation! [tx db {:type :vocab/move
                                 :project home
                                 :document nil
                                 :description (str "Move vocabulary “" (vocab-name db eid) "” to project “"
                                                   (project-name db target) "”")
                                 :user user-id}]
                         (when (nil? (psc/fetch-by-id tx :vocab_layers eid))
                           (throw (ex-info (psc/err-msg-not-found "Vocab" eid) {:code 404 :id eid})))
                         (assert-live-project! tx target)
                         (crud/update-by-id! tx :vocab_layers eid {:project_id target :modified_at (op/op-ts)})
                         (link-project! tx target eid)
                         (when-let [a (:affected-projects psaw/*op*)]
                           (swap! a update target (fnil identity #{})))
                         eid))))

(defn- refuse-borrowers!
  "Throw the 409 a delete of `eid` is refused with while any live project
  other than its home links it (`borrower-ids`), whoever asks, admins
  included (Luke 2026-11-12). The body counts them as `other-projects` and
  names none, since the caller may not be able to read them."
  [tx eid]
  (let [n (count (borrower-ids tx eid))]
    (when (pos? n)
      (throw (ex-info (str n (if (= 1 n) " other project uses" " other projects use") " this vocabulary.")
                      {:code 409 :id eid :plaid/body {:other-projects n}})))))

(defn delete-preview
  "What deleting vocab layer `eid` would remove, without writing:
  `{:links n}`, the links in its home's documents. Throws the delete's own
  refusals (404, and the 409 while a borrower links it)."
  [db eid]
  (when (nil? (psc/fetch-by-id db :vocab_layers eid))
    (throw (ex-info (psc/err-msg-not-found "Vocab" eid) {:code 404 :id eid})))
  (refuse-borrowers! db eid)
  {:links (:n (psc/q1 db {:select [[[:count :*] :n]]
                          :from [[:vocab_links :l]]
                          :join [[:vocab_items :i] [:= :i.id :l.vocab_item_id]
                                 [:documents :d] [:= :d.id :l.document_id]
                                 [:projects :p] [:= :p.id :d.project_id]]
                          :where [:and [:= :i.vocab_layer_id eid] [:= :p.deleted_at nil]]}))})

(defn delete
  "Delete a vocab layer. Walks the descendant subtree (vocab_items
  and the vocab_links each item is referenced by) and audits each row
  deletion through the audited helpers so audit_writes captures every
  change — FK ON DELETE CASCADE would otherwise silently sweep them.
  The exception is a link in a project being deleted (R39): it is removed
  unaudited, with no version bump, since nothing travels back to it.

  The `project_vocabs` rows (the home's) would also FK-CASCADE silently,
  so each project that loses one gets a synthetic `:projects` update under
  the unnamespaced `:vocabs` key.

  Refused (409, nothing written) while a borrower links it
  (`refuse-borrowers!`). Audited under the home."
  [db eid user-id]
  (submit-operation! [tx db {:type :vocab/delete
                             :project (home-of db eid)
                             :document nil
                             :description (if-let [n (vocab-name db eid)]
                                            (str "Delete vocabulary “" n "”")
                                            (str "Delete vocabulary " eid))
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :vocab_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Vocab" eid) {:code 404 :id eid})))
                       (refuse-borrowers! tx eid)
                       (let [vi-ids (->> (psc/q tx {:select [:id]
                                                    :from :vocab_items
                                                    :where [:= :vocab_layer_id eid]})
                                         (mapv :id))]
                         (when (seq vi-ids)
                           ;; The items by the one item delete path: the
                           ;; links audited, a version bump on every
                           ;; document that lost one (the op-attrs carry
                           ;; :document nil, so the post-body bump does not
                           ;; fire), a link in a project being deleted
                           ;; removed unaudited (R39), then the items with
                           ;; their metadata.
                           (vocab-item/delete-items! tx vi-ids)))
                       (let [grants (->> (psc/q tx {:select [:project_id]
                                                    :from [:project_vocabs]
                                                    :where [:= :vocab_layer_id eid]
                                                    :order-by [:project_id]})
                                         (mapv :project_id))
                             pre-by-project (into {} (map (fn [pid] [pid (fetch-project-vocab-ids tx pid)])) grants)]
                         (crud/delete-by-id! tx :vocab_layers eid)
                         (doseq [pid grants]
                           (let [row (psc/fetch-by-id tx :projects pid)
                                 pre (clojure.core/get pre-by-project pid [])]
                             (psaw/record-audit-write! tx :projects pid :update
                                                       (assoc row :vocabs pre)
                                                       (assoc row :vocabs (vec (remove #(= % eid) pre)))))))
                       eid)))
