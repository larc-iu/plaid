(ns plaid.sql.text-layer
  "SQL port of plaid.xtdb2.text-layer. Text layers live in the
  `text_layers` table; ordering within a project is by `order_idx`.

  External API mirrors the xtdb2 version: same fn names + arglists,
  `db` replaces `node-or-map`/`xt-map`. Writes open their own tx via
  `submit-operation!`. Child rows (token_layers and below) are
  cleaned up by FK ON DELETE CASCADE — we do not manually delete
  them here."
  (:require [taoensso.timbre :as log]
            [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.token-layer :as token-layer])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text-layer/id
                :text-layer/name
                :text-layer/project
                :config])

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->text-layer
  "Translate a `text_layers` row to the namespaced shape. The nested
  :text-layer/token-layers structure is built by plaid.sql.project/get,
  not here — `get` on the bare layer returns the flat record."
  [row]
  (when row
    {:text-layer/id      (:id row)
     :text-layer/name    (:name row)
     :text-layer/project (:project_id row)
     :config             (psc/parse-config (:config row))}))

;; ============================================================
;; Reads
;; ============================================================

(defn get [db id]
  (row->text-layer (psc/fetch-by-id db :text_layers id)))

(defn project-id [db id]
  (:project_id (psc/fetch-by-id db :text_layers id)))

;; ============================================================
;; Mutations
;; ============================================================

(defn create
  "Create a new text layer in `project-id`. `attrs` includes
  :text-layer/name (required) and optionally :config. Returns
  {:success true :extra <new-id>}.

  `order_idx` is resolved by a scalar-subquery inside the INSERT
  itself (see `psc/next-order-idx-expr`) — atomic against concurrent
  creates against the same project, and guarded by the
  `UNIQUE (project_id, order_idx)` constraint on text_layers."
  [db attrs project-id user-id]
  (let [{:text-layer/keys [name]} attrs
        new-id (psc/new-uuid)
        config (clojure.core/get attrs :config {})]
    (submit-operation! [tx db {:type :text-layer/create
                               :project project-id
                               :document nil
                               :description (str "Create text layer \"" name "\" in project " project-id)
                               :user user-id}]
                       ;; Validation inside the body (task #47).
                       (psc/valid-name? name)
                       (when (nil? (psc/fetch-by-id tx :projects project-id))
                         (throw (ex-info (psc/err-msg-not-found "Project" project-id)
                                         {:id project-id :code 400})))
                       (psc/insert! tx :text_layers
                                    {:id new-id
                                     :name name
                                     :project_id project-id
                                     :order_idx (psc/next-order-idx-expr
                                                 :text_layers
                                                 [:= :project_id project-id])
                                     :config (psc/serialize-config config)})
                       new-id)))

(defn merge
  "Update mutable fields. Currently supports :text-layer/name."
  [db eid m user-id]
  (submit-operation! [tx db {:type :text-layer/update
                             :project (project-id db eid)
                             :document nil
                             :description (str "Update text layer " eid)
                             :user user-id}]
                     (when-let [n (:text-layer/name m)]
                       (psc/valid-name? n))
                     (let [existing (psc/fetch-by-id tx :text_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Text layer" eid) {:code 404 :id eid})))
                       (let [attrs (cond-> {}
                                     (some? (:text-layer/name m))
                                     (assoc :name (:text-layer/name m)))]
                         (when (seq attrs)
                           (psc/update-by-id! tx :text_layers eid attrs))
                         eid))))

(defn- shift-layer!
  "Swap order_idx between `eid` and its adjacent sibling (up? → previous,
  else next) inside `table`, where siblings share `parent-col` = parent."
  [tx table eid parent-col up?]
  (let [row (psc/fetch-by-id tx table eid)]
    (when (nil? row)
      (throw (ex-info (psc/err-msg-not-found (clojure.core/name table) eid)
                      {:code 404 :id eid})))
    (let [parent (clojure.core/get row parent-col)
          my-idx (:order_idx row)
          neighbor (psc/q1 tx {:select [:*]
                               :from [table]
                               :where [:and
                                       [:= parent-col parent]
                                       (if up?
                                         [:< :order_idx my-idx]
                                         [:> :order_idx my-idx])]
                               :order-by [[:order_idx (if up? :desc :asc)]]
                               :limit 1})]
      (when neighbor
        ;; Two-step swap via a temporary sentinel idx to avoid colliding on
        ;; the (parent, order_idx) shape if any unique constraint were added.
        (let [tmp -1
              their-idx (:order_idx neighbor)
              their-id (:id neighbor)]
          (psc/update-by-id! tx table eid {:order_idx tmp})
          (psc/update-by-id! tx table their-id {:order_idx my-idx})
          (psc/update-by-id! tx table eid {:order_idx their-idx})))
      eid)))

(defn shift-text-layer [db txtl-id up? user-id]
  (submit-operation! [tx db {:type :text-layer/shift
                             :project (project-id db txtl-id)
                             :document nil
                             :description (str "Shift text layer " txtl-id " " (if up? "up" "down"))
                             :user user-id}]
                     (shift-layer! tx :text_layers txtl-id :project_id up?)))

(defn cascade-delete!
  "Tx-level cascade for a text_layer. Audits every descendant entity
  (token_layers and their full subtree of spans/relations/tokens/
  vocab_links, plus texts and their entity_metadata) before the FK
  CASCADE fires. Reused by project's cascade walker."
  [tx eid]
  ;; 1. Token_layers under this text_layer (root layers only — each
  ;; cascade-delete! walks the parent_token_layer_id subtree itself).
  (let [tl-ids (->> (psc/q tx {:select [:id]
                               :from :token_layers
                               :where [:and
                                       [:= :text_layer_id eid]
                                       [:= :parent_token_layer_id nil]]})
                    (mapv :id))]
    (doseq [tl-id tl-ids]
      (token-layer/cascade-delete! tx tl-id)))
  ;; 2. Any remaining token_layers in this text_layer (defensive: if a
  ;; child layer outlived its parent somehow, sweep it too).
  (let [leftover-ids (->> (psc/q tx {:select [:id]
                                     :from :token_layers
                                     :where [:= :text_layer_id eid]})
                          (mapv :id))]
    (doseq [tl-id leftover-ids]
      (token-layer/cascade-delete! tx tl-id)))
  ;; 3. Texts in this text_layer (across all documents in the project).
  ;; Tokens are already gone via the token-layer cascade; here we just
  ;; need to audit the text rows + their entity_metadata.
  (let [text-ids (->> (psc/q tx {:select [:id]
                                 :from :texts
                                 :where [:= :text_layer_id eid]})
                      (mapv :id))]
    (doseq [tid text-ids]
      (psc/delete-by-id! tx :texts tid))
    (when (seq text-ids)
      (psc/execute! tx
                    {:delete-from :entity_metadata
                     :where [:and
                             [:= :entity_type "text"]
                             [:in :entity_id text-ids]]})))
  ;; 4. The text_layer's own entity_metadata + row.
  (psc/execute! tx
                {:delete-from :entity_metadata
                 :where [:and
                         [:= :entity_type "text-layer"]
                         [:= :entity_id eid]]})
  (psc/delete-by-id! tx :text_layers eid))

(defn delete
  "Delete a text layer. Walks the descendant subtree (token_layers →
  span_layers → relation_layers, plus tokens/spans/relations/
  vocab_links/texts that point at them) and audits each row deletion
  through the audited helpers so audit_writes captures every change —
  FK ON DELETE CASCADE would otherwise silently sweep them."
  [db eid user-id]
  (submit-operation! [tx db {:type :text-layer/delete
                             :project (project-id db eid)
                             :document nil
                             :description (str "Delete text layer " eid)
                             :user user-id}]
                     (let [existing (psc/fetch-by-id tx :text_layers eid)]
                       (when (nil? existing)
                         (throw (ex-info (psc/err-msg-not-found "Text layer" eid) {:code 404 :id eid})))
                       (cascade-delete! tx eid)
                       eid)))
