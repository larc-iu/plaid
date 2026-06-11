(ns plaid.sql.vocab-layer
  "SQL port of plaid.xtdb2.vocab-layer. Vocab layers live in
  `vocab_layers`; their maintainers in `vocab_maintainers`; their
  project grants in `project_vocabs`.

  Items live in `vocab_items` (see plaid.sql.vocab-item) and are
  cascade-deleted by the FK when a vocab layer is dropped."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.pagination :as pagination]
            [plaid.sql.user :as user])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab/id
                :vocab/name
                :vocab/maintainers
                :config])

;; ============================================================
;; Row mapper + enrichment
;; ============================================================

(defn- row->vocab-bare
  "Translate a `vocab_layers` row to the namespaced shape. Does NOT
  populate :vocab/maintainers; callers stitch those in."
  [row]
  (when row
    {:vocab/id   (:id row)
     :vocab/name (:name row)
     :config     (psc/parse-config (:config row))}))

(defn- attach-maintainers
  "Add :vocab/maintainers (vector of user-ids) to a bare vocab record."
  [db vocab-id record]
  (let [maintainers (->> (psc/q db {:select [:user_id]
                                    :from [:vocab_maintainers]
                                    :where [:= :vocab_layer_id vocab-id]})
                         (mapv :user_id))]
    (assoc record :vocab/maintainers maintainers)))

(declare get-items-fn)

(defn get
  "Get a vocab layer by ID, fully enriched.

  When `include-items?` is true, also assoc :vocab/items via
  plaid.sql.vocab-item/get-all-in-layer (resolved at call time to dodge
  the require cycle)."
  ([db id]
   (get db id false))
  ([db id include-items?]
   (when-let [bare (row->vocab-bare (psc/fetch-by-id db :vocab_layers id))]
     (cond-> (attach-maintainers db id bare)
       include-items?
       (assoc :vocab/items (get-items-fn db id))))))

;; Lazily resolved to avoid the require cycle between
;; vocab-layer ↔ vocab-item.
(defn- get-items-fn [db id]
  (let [v (requiring-resolve 'plaid.sql.vocab-item/get-all-in-layer)]
    (v db id)))

;; ============================================================
;; Accessibility queries
;; ============================================================

(defn- get-all-ids [db]
  (->> (psc/q db {:select [:id] :from [:vocab_layers]})
       (mapv :id)))

(defn maintainer-ids
  "Vector of user IDs that maintain `vocab-id`."
  [db vocab-id]
  (->> (psc/q db {:select [:user_id]
                  :from [:vocab_maintainers]
                  :where [:= :vocab_layer_id vocab-id]})
       (mapv :user_id)))

(defn maintainer?
  "True iff `user-id` is a maintainer of `vocab-id`."
  [db vocab-id user-id]
  (some? (psc/q1 db {:select [:user_id]
                     :from [:vocab_maintainers]
                     :where [:and
                             [:= :vocab_layer_id vocab-id]
                             [:= :user_id user-id]]})))

(defn accessible-through-project?
  "True iff `user-id` has any role on any project whose project_vocabs
  grants include `vocab-id`. (Read access via project grant.)"
  [db vocab-id user-id]
  (some? (psc/q1 db {:select [[:pv.project_id :pid]]
                     :from [[:project_vocabs :pv]]
                     :join [[:project_users :pu]
                            [:= :pu.project_id :pv.project_id]]
                     :where [:and
                             [:= :pv.vocab_layer_id vocab-id]
                             [:= :pu.user_id user-id]]
                     :limit 1})))

(defn write-accessible-through-project?
  "True iff `user-id` has writer or maintainer role on any project whose
  project_vocabs grants include `vocab-id`. (Write access for items.)"
  [db vocab-id user-id]
  (some? (psc/q1 db {:select [[:pv.project_id :pid]]
                     :from [[:project_vocabs :pv]]
                     :join [[:project_users :pu]
                            [:= :pu.project_id :pv.project_id]]
                     :where [:and
                             [:= :pv.vocab_layer_id vocab-id]
                             [:= :pu.user_id user-id]
                             [:in :pu.role ["writer" "maintainer"]]]
                     :limit 1})))

(defn get-accessible-ids
  "Vocab IDs the user can see: union of vocabs they directly maintain
  and vocabs granted to projects they have any role on. Admins see all."
  [db user-id]
  (let [user-rec (user/get db user-id)]
    (if (user/admin? user-rec)
      (get-all-ids db)
      (let [maintainer-ids (->> (psc/q db {:select [:vocab_layer_id]
                                           :from [:vocab_maintainers]
                                           :where [:= :user_id user-id]})
                                (mapv :vocab_layer_id))
            project-vocab-ids (->> (psc/q db {:select-distinct [:pv.vocab_layer_id]
                                              :from [[:project_vocabs :pv]]
                                              :join [[:project_users :pu]
                                                     [:= :pu.project_id :pv.project_id]]
                                              :where [:= :pu.user_id user-id]})
                                   (mapv :vocab_layer_id))]
        (vec (distinct (concat maintainer-ids project-vocab-ids)))))))

(defn batch-hydrate-vocab-layers
  "Hydrate `vocab-ids` into the same per-vocab shape as `(get db id)` —
  :vocab/id, :vocab/name, :config (parsed), :vocab/maintainers.
  Preserves the order of `vocab-ids` and drops ids that have no
  matching row.

  Round-trip count is O(1) regardless of `(count vocab-ids)`: one
  SELECT for vocab_layers rows, one for vocab_maintainers joined to
  user_ids. (Note: `get`'s 2-arg form can also include :vocab/items, but
  the per-id `get` shape exposed by `get-accessible` did NOT include
  items, so neither does this helper.)

  Mirrors `plaid.sql.project/batch-hydrate-projects` (#67)."
  [db vocab-ids]
  (if (empty? vocab-ids)
    []
    (let [;; 1) vocab_layers themselves
          vl-rows (psc/q db {:select [:*]
                             :from [:vocab_layers]
                             :where [:in :id vocab-ids]})
          vl-by-id (into {} (map (juxt :id row->vocab-bare) vl-rows))
          ;; 2) vocab_maintainers — grouped per vocab-layer
          vm-rows (psc/q db {:select [:vocab_layer_id :user_id]
                             :from [:vocab_maintainers]
                             :where [:in :vocab_layer_id vocab-ids]})
          maintainers-by-vocab (reduce (fn [acc {:keys [vocab_layer_id user_id]}]
                                         (update acc vocab_layer_id (fnil conj []) user_id))
                                       {} vm-rows)
          hydrate-one (fn [vid]
                        (when-let [bare (clojure.core/get vl-by-id vid)]
                          (assoc bare :vocab/maintainers
                                 (vec (clojure.core/get maintainers-by-vocab vid [])))))]
      (->> vocab-ids
           (mapv hydrate-one)
           (filterv some?)))))

(defn get-accessible
  "Hydrated vocab records accessible to `user-id`."
  ([db user-id]
   (let [ids (get-accessible-ids db user-id)]
     ;; Was `(mapv #(get db %) ids)` — N+1 over `ids` with each `get`
     ;; firing fetch-by-id + attach-maintainers (~2 queries per vocab).
     ;; Now a constant number of bulk SELECTs regardless of vocab count
     ;; (#67, mirrors project/batch-hydrate-projects).
     (batch-hydrate-vocab-layers db ids)))
  ([db user-id {:keys [limit cursor-vals]}]
   ;; Paginated arity: shape the (bounded, per-user) accessible set into the
   ;; uniform {:entries :next-cursor} envelope. Sorted by (name, id) —
   ;; :vocab/id is the unique tiebreaker.
   (pagination/paginate-coll (get-accessible db user-id)
                             [:vocab/name :vocab/id]
                             limit cursor-vals)))

;; ============================================================
;; Writes: create / merge / delete
;; ============================================================

(defn create
  "Create a new vocab layer. Returns {:success true :extra <new-id>}."
  [db attrs user-id]
  (let [{:vocab/keys [name]} attrs
        new-id (psc/new-uuid)
        config (clojure.core/get attrs :config {})]
    (submit-operation! [tx db {:type :vocab/create
                               :project nil
                               :document nil
                               :description (str "Create vocab '" name "'")
                               :user user-id}]
                       (psc/valid-name? name)
                       (psc/insert! tx :vocab_layers
                                    {:id new-id
                                     :name name
                                     :config (psc/serialize-config config)})
                       new-id)))

(defn merge
  "Update mutable vocab fields. Currently supports :vocab/name."
  [db eid m user-id]
  (submit-operation! [tx db {:type :vocab/update
                             :project nil
                             :document nil
                             :description (str "Update vocab " eid
                                               (when (:vocab/name m)
                                                 (str " name to \"" (:vocab/name m) "\"")))
                             :user user-id}]
                     (when (contains? m :vocab/name)
                       (psc/valid-name? (:vocab/name m)))
                     (let [existing (psc/fetch-by-id tx :vocab_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Vocab" eid) {:code 404 :id eid})))
                       (let [attrs (cond-> {}
                                     (some? (:vocab/name m))
                                     (assoc :name (:vocab/name m)))]
                         (when (seq attrs)
                           (psc/update-by-id! tx :vocab_layers eid attrs))
                         eid))))

(defn fetch-vocab-maintainer-ids
  "Vector of user-ids that maintain `vocab-id` (snapshot helper used by
  synthetic audit rows on `:vocab_layers`).

  Public so cross-namespace callers (notably `plaid.sql.user/delete`,
  which audits user → vocab_maintainers FK cascade losses) can reuse it."
  [tx vocab-id]
  ;; ORDER BY user_id so the folded :maintainers audit image is
  ;; deterministically ordered (task #13).
  (->> (psc/q tx {:select [:user_id]
                  :from [:vocab_maintainers]
                  :where [:= :vocab_layer_id vocab-id]
                  :order-by [:user_id]})
       (mapv :user_id)))

(defn- fetch-vocab-project-grants
  "Vector of project-ids that have `vocab-id` granted via project_vocabs.
  Used in `delete` to emit per-project audit rows showing the grant
  going away."
  [tx vocab-id]
  ;; ORDER BY project_id so the per-project audit rows in `delete` are
  ;; emitted in a deterministic order — (op_id, seq) assignment depends
  ;; on it (task #13).
  (->> (psc/q tx {:select [:project_id]
                  :from [:project_vocabs]
                  :where [:= :vocab_layer_id vocab-id]
                  :order-by [:project_id]})
       (mapv :project_id)))

(defn audit-vocab-maintainers-change!
  "Emit a synthetic :vocab_layers audit row for a vocab_maintainers
  mutation. Pre/post images = the vocab_layer row + the maintainer-id
  vector under :maintainers (UNNAMESPACED — matches the project-side
  fix in #65; the audit-row \"extras\" shape is intentionally distinct
  from the REST-API shape that uses `:vocab/maintainers`). Skips audit
  when pre == post (no-op add/remove, mirroring update-by-id!'s noise
  rule).

  Public so cross-namespace callers (e.g. `plaid.sql.user/delete`)
  can emit the same synthetic audit shape on FK cascade losses."
  [tx vocab-id pre-maintainers]
  (let [post-maintainers (fetch-vocab-maintainer-ids tx vocab-id)]
    (when (not= pre-maintainers post-maintainers)
      (let [vl-row (psc/fetch-by-id tx :vocab_layers vocab-id)
            pre-image (assoc vl-row :maintainers pre-maintainers)
            post-image (assoc vl-row :maintainers post-maintainers)]
        (psc/record-audit-write! tx :vocab_layers vocab-id :update pre-image post-image)))))

(defn delete
  "Delete a vocab layer. Walks the descendant subtree (vocab_items
  and the vocab_links each item is referenced by) and audits each row
  deletion through the audited helpers so audit_writes captures every
  change — FK ON DELETE CASCADE would otherwise silently sweep them.

  Junction-table cascades (Task #34): `vocab_maintainers` and
  `project_vocabs` would also FK-CASCADE silently. Two synthetic
  audits address that:
    - The vocab_layer's own :delete audit carries `:maintainers`
      (unnamespaced; see #65) in the pre-image (post = nil); the
      maintainer list going from [...] to nil is implicit in the layer
      disappearing.
    - For each project that loses a vocab grant via project_vocabs FK
      cascade, we emit a :projects :update audit (pre = grants before
      the cascade, post = grants after the cascade — i.e. with `eid`
      removed) under the unnamespaced `:vocabs` key so ETL replay sees
      the grant transition."
  [db eid user-id]
  (submit-operation! [tx db {:type :vocab/delete
                             :project nil
                             :document nil
                             :description (str "Delete vocab " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :vocab_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Vocab" eid) {:code 404 :id eid})))
                       (let [vi-ids (->> (psc/q tx {:select [:id]
                                                    :from :vocab_items
                                                    :where [:= :vocab_layer_id eid]})
                                         (mapv :id))
                             ;; Track which documents lose vocab_links so we
                             ;; can bump their versions for OCC clients
                             ;; (task #72). The op-attrs carry :document nil,
                             ;; so the post-body bump-document-version! hook
                             ;; doesn't fire — we have to walk the affected
                             ;; docs explicitly.
                             affected-doc-ids (volatile! [])]
                         (when (seq vi-ids)
                           ;; Vocab_links pointing at any of these items —
                           ;; one bulk DELETE ... RETURNING * collapses the
                           ;; per-row loop into a single round-trip.
                           (let [vl-rows (psc/q tx {:select [:id :document_id]
                                                    :from :vocab_links
                                                    :where [:in :vocab_item_id vi-ids]})
                                 vl-ids (mapv :id vl-rows)]
                             (when (seq vl-ids)
                               ;; Capture the per-link document_ids (may
                               ;; contain duplicates if multiple items
                               ;; share a doc) — bump-document-versions!
                               ;; dedups internally.
                               (vswap! affected-doc-ids into (mapv :document_id vl-rows))
                               (psc/delete-where! tx :vocab_links [:in :id vl-ids])
                               (psc/execute! tx
                                             {:delete-from :entity_metadata
                                              :where [:and
                                                      [:= :entity_type "vocab-link"]
                                                      [:in :entity_id vl-ids]]})))
                           ;; Vocab_items themselves + their metadata.
                           (psc/delete-where! tx :vocab_items [:in :id vi-ids])
                           (psc/execute! tx
                                         {:delete-from :entity_metadata
                                          :where [:and
                                                  [:= :entity_type "vocab-item"]
                                                  [:in :entity_id vi-ids]]}))
                         ;; Bump versions on every document that lost a
                         ;; vocab_link — emits :doc-version-bump audit
                         ;; rows so OCC clients are told their view is
                         ;; stale.
                         (op/bump-document-versions! tx @affected-doc-ids))
                       ;; Snapshot junction-table state BEFORE the row
                       ;; goes away (FK CASCADE would erase
                       ;; vocab_maintainers + project_vocabs rows
                       ;; silently otherwise).
                       (let [pre-maintainers (fetch-vocab-maintainer-ids tx eid)
                             grant-project-ids (fetch-vocab-project-grants tx eid)
                             ;; Per-project pre-image of vocab grants (one snapshot per
                             ;; project) so the synthetic :projects audits show the right
                             ;; "before" state.
                             ;; ORDER BY vocab_layer_id: the folded :vocabs
                             ;; vectors must be deterministically ordered —
                             ;; and ordered the SAME way as project.clj's
                             ;; fetch-project-vocab-grants — or scan-order
                             ;; variance registers as spurious history
                             ;; "changes" (task #13).
                             pre-grants-by-proj
                             (into {}
                                   (map (fn [pid] [pid (->> (psc/q tx {:select [:vocab_layer_id]
                                                                       :from [:project_vocabs]
                                                                       :where [:= :project_id pid]
                                                                       :order-by [:vocab_layer_id]})
                                                            (mapv :vocab_layer_id))]))
                                   grant-project-ids)
                             ;; Emit the vocab_layer's :delete audit with
                             ;; maintainers folded into the pre-image —
                             ;; matches the parent-row-carries-junction
                             ;; pattern that ETL relies on. We do this
                             ;; manually (vs. psc/delete-by-id!) so the
                             ;; pre-image carries :maintainers
                             ;; (unnamespaced; see #65) rather than just
                             ;; the raw row.
                             vl-row (psc/fetch-by-id tx :vocab_layers eid)
                             vl-pre-image (assoc vl-row :maintainers pre-maintainers)]
                         (psc/execute! tx {:delete-from :vocab_layers
                                           :where [:= :id eid]})
                         (psc/record-audit-write! tx :vocab_layers eid :delete vl-pre-image nil)
                         ;; Per-project audits for the project_vocabs
                         ;; FK-cascade losses. Each project sees one
                         ;; :update row showing its vocab-grant list
                         ;; shrink by `eid` under the unnamespaced
                         ;; `:vocabs` key (see #65).
                         (doseq [pid grant-project-ids]
                           (let [proj-row (psc/fetch-by-id tx :projects pid)
                                 pre-grants (clojure.core/get pre-grants-by-proj pid [])
                                 post-grants (vec (remove #(= % eid) pre-grants))
                                 pre-image (assoc proj-row :vocabs pre-grants)
                                 post-image (assoc proj-row :vocabs post-grants)]
                             (psc/record-audit-write! tx :projects pid :update pre-image post-image))))
                       eid)))

;; ============================================================
;; Maintainer management (vocab_maintainers join table)
;; ============================================================

(defn- assert-user-and-vocab!
  [tx vocab-id user-id]
  (when (nil? (psc/fetch-by-id tx :users user-id))
    (throw (ex-info (str "Not a valid user ID: " user-id) {:id user-id :code 400})))
  (when (nil? (psc/fetch-by-id tx :vocab_layers vocab-id))
    (throw (ex-info (psc/err-msg-not-found "Vocab" vocab-id) {:id vocab-id :code 400}))))

(defn add-maintainer
  [db vocab-id user-id actor-user-id]
  (submit-operation! [tx db {:type :vocab/add-maintainer
                             :project nil
                             :document nil
                             :description (str "Add maintainer " user-id " to vocab " vocab-id)
                             :user actor-user-id}]
                     (assert-user-and-vocab! tx vocab-id user-id)
                     ;; Snapshot the maintainer-set BEFORE the mutation so
                     ;; the synthetic :vocab_layers audit row's pre-image
                     ;; is accurate. Audit emission is skipped when the
                     ;; write is a no-op (user is already a maintainer).
                     (let [pre-maintainers (fetch-vocab-maintainer-ids tx vocab-id)]
                       (psc/add-join-if-absent! tx :vocab_maintainers
                                                {:vocab_layer_id vocab-id
                                                 :user_id user-id})
                       (audit-vocab-maintainers-change! tx vocab-id pre-maintainers))))

(defn remove-maintainer
  [db vocab-id user-id actor-user-id]
  (submit-operation! [tx db {:type :vocab/remove-maintainer
                             :project nil
                             :document nil
                             :description (str "Remove maintainer " user-id " from vocab " vocab-id)
                             :user actor-user-id}]
                     (assert-user-and-vocab! tx vocab-id user-id)
                     (let [pre-maintainers (fetch-vocab-maintainer-ids tx vocab-id)]
                       (psc/remove-join! tx :vocab_maintainers
                                         {:vocab_layer_id vocab-id
                                          :user_id user-id})
                       (audit-vocab-maintainers-change! tx vocab-id pre-maintainers))))
