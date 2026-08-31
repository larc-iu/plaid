(ns plaid.sql.comment
  "Comments: free-text discussion anchored to one annotatable entity.

  Comments are SOCIAL data, not annotation data, and the whole design falls
  out of that one distinction:

    * Writes are NOT routed through `submit-operation!`. They are unaudited
      and they do NOT bump `documents.version` — a comment must never
      invalidate an editor's optimistic-concurrency token or trigger a
      reconcile, because it changes nothing about the linguistic record.
      (Same reasoning as `plaid.sql.user-data`.)
    * They never ride the document read path. `entity_metadata` is bulk
      attached to every entity by `document/get-with-layer-data`; comments
      are fetched only when something actually wants to show them.
    * No export target carries them.

  Flat by design: no threading, no resolve state, no reactions. A comment is
  a row with an author and a body.

  ## Anchoring

  `(entity_type, entity_id)` names the commented entity. The commentable set
  is exactly the PROJECT-SCOPED entities — document, text, token, span,
  relation — because the ACL that governs a comment is the project ACL of
  the thing it hangs off. Vocab items are deliberately excluded: a vocab
  layer is shared across projects and carries its own maintainer model, so
  a comment there would have no single project to inherit permissions from.

  `project_id` and `document_id` are resolved from the anchor at insert time
  and denormalized onto the row, which buys the two hot reads (a document's
  comments, a project's comments) as single indexed scans and lets FK
  cascade reclaim rows when either ancestor is deleted. The anchor entity's
  own deletion is swept by `plaid.sql.common/sweep-comments!`.

  ## Authorship

  `author_id` is stamped from the authenticated user, never from the request
  body. Only the author may edit a comment; the REST layer enforces that,
  and it is the reason comments are a table rather than a blob under
  `entity_metadata` (where any writer could rewrite anyone's text)."
  (:require [clojure.string]
            [plaid.sql.common :as psc]
            [plaid.sql.pagination :as pg])
  (:refer-clojure :exclude [get list update]))

(def commentable-types
  "Entity types that can carry a comment. See the anchoring note above for
  why this is the project-scoped set and not `metadata`'s wider whitelist."
  #{"document" "text" "token" "span" "relation"})

(def ^:const max-body-length
  "Ceiling on one comment's body, in characters. Generous for prose a person
  actually types into a comment box, bounded so the table cannot become a
  file dump."
  10000)

(def ^:private entity-type->table
  {"document" :documents
   "text"     :texts
   "token"    :tokens
   "span"     :spans
   "relation" :relations})

(def ^:private entity-type->layer
  "The layer table (and its FK column on the entity row) that carries the
  denormalized project id. `document` is absent: a document row names its
  project directly."
  {"text"     [:text_layers :text_layer_id]
   "token"    [:token_layers :token_layer_id]
   "span"     [:span_layers :span_layer_id]
   "relation" [:relation_layers :relation_layer_id]})

;; ============================================================
;; Anchor resolution
;; ============================================================

(defn resolve-anchor
  "Resolve `(entity-type, entity-id)` to `{:project-id .. :document-id ..}`,
  or nil when the type is not commentable or the entity does not exist.

  Every commentable entity but `document` carries a denormalized
  `document_id` column already, so this is two point lookups at worst: the
  entity row, then its layer row for the project id."
  [db entity-type entity-id]
  (when-let [table (entity-type->table entity-type)]
    (when-let [row (psc/fetch-by-id db table entity-id)]
      (if (= entity-type "document")
        {:project-id (:project_id row) :document-id (:id row)}
        (let [[layer-table fk] (entity-type->layer entity-type)]
          (when-let [layer (psc/fetch-by-id db layer-table (clojure.core/get row fk))]
            {:project-id (:project_id layer) :document-id (:document_id row)}))))))

;; ============================================================
;; Reads
;; ============================================================

(defn- row->comment
  "External shape. `:comment/edited?` is derived rather than stored — a
  comment is edited iff its body has been rewritten since it was posted."
  [row]
  (when row
    {:comment/id          (:id row)
     :comment/project-id  (:project_id row)
     :comment/document-id (:document_id row)
     :comment/entity-type (:entity_type row)
     :comment/entity-id   (:entity_id row)
     :comment/author-id   (:author_id row)
     :comment/body        (:body row)
     :comment/created-at  (:created_at row)
     :comment/updated-at  (:updated_at row)
     :comment/edited?     (not= (:created_at row) (:updated_at row))}))

(defn get
  "One comment by id in external shape, or nil."
  [db id]
  (row->comment (psc/fetch-by-id db :comments id)))

(defn get-internal
  "Raw comment row by id, or nil. Used by the REST layer's authorization
  path, which needs `project_id` and `author_id` before it decides whether
  the caller may see the comment at all."
  [db id]
  (psc/fetch-by-id db :comments id))

(defn- paginate-comments
  [db base-where {:keys [limit cursor-vals]}]
  (pg/paginate db {:from        :comments
                   :base-where  base-where
                   ;; (created_at, id): both TEXT NOT NULL, and `id` is the
                   ;; unique tiebreaker `paginate` requires for a total order.
                   :order-by    [:created_at :id]
                   :limit       limit
                   :cursor-vals cursor-vals
                   :row->entity row->comment}))

(defn- project-scoped-where
  "The WHERE for a project-scoped read, narrowed by whichever optional
  filters are present. Every filter is ANDed UNDER the project scope, so a
  document or entity id belonging to another project simply matches nothing.
  There is deliberately no way to widen past the project the caller's ACL was
  checked against."
  [project-id {:keys [document-id entity-type entity-id]}]
  (cond-> [:and [:= :project_id project-id]]
    document-id (conj [:= :document_id document-id])
    entity-type (conj [:= :entity_type entity-type])
    entity-id   (conj [:= :entity_id entity-id])))

(defn list-in-project
  "Comments in `project-id`, oldest first, optionally narrowed to one
  document (`:document-id`) or one entity (`:entity-type` + `:entity-id`).

  The document-scoped form is the read an editor makes on open to paint its
  comment indicators: one indexed scan over `idx_comments_document` rather
  than a request per commented entity."
  [db project-id opts]
  (paginate-comments db (project-scoped-where project-id opts) opts))

(defn count-by-entity
  "`{entity-id -> n}` over the same scope `list-in-project` reads. Lets a
  client paint a comment indicator on every annotated item in a document
  from ONE cheap request, without paging through the bodies to do it."
  [db project-id opts]
  (into {}
        (map (juxt :entity_id :n))
        (psc/q db {:select   [:entity_id [[:count :*] :n]]
                   :from     [:comments]
                   :where    (project-scoped-where project-id opts)
                   :group-by [:entity_id]})))

;; ============================================================
;; Writes
;; ============================================================

(defn- validate-body!
  "Throw a 400 unless `body` is non-blank prose within the length ceiling.
  Blank is rejected rather than silently stored: an empty comment is a UI
  slip, and the delete endpoint is how you remove one."
  [body]
  (when-not (string? body)
    (throw (ex-info "Comment body must be a string" {:code 400})))
  (when (clojure.string/blank? body)
    (throw (ex-info "Comment body cannot be blank" {:code 400})))
  (when (> (count body) max-body-length)
    (throw (ex-info (str "Comment body exceeds " max-body-length " characters")
                    {:code 400 :length (count body)}))))

(defn create!
  "Post a comment on `(entity-type, entity-id)` as `author-id`. Returns the
  created comment in external shape.

  Throws `{:code 400}` for an uncommentable entity type or a bad body, and
  `{:code 404}` when the anchor entity does not exist. The caller is
  responsible for having checked that `author-id` may write to the resolved
  project — `resolve-anchor` is also what the REST auth middleware uses to
  find that project."
  [db {:keys [entity-type entity-id body]} author-id]
  (when-not (commentable-types entity-type)
    (throw (ex-info (str "Entity type '" entity-type "' cannot carry comments. "
                         "Commentable types: "
                         (clojure.string/join ", " (sort commentable-types)))
                    {:code 400 :entity-type entity-type})))
  (validate-body! body)
  (let [{:keys [project-id document-id]} (resolve-anchor db entity-type entity-id)]
    (when (nil? project-id)
      (throw (ex-info (psc/err-msg-not-found (clojure.string/capitalize entity-type) entity-id)
                      {:code 404 :id entity-id})))
    (let [now (psc/now-iso)
          row {:id          (psc/new-uuid)
               :project_id  project-id
               :document_id document-id
               :entity_type entity-type
               :entity_id   entity-id
               :author_id   author-id
               :body        body
               :created_at  now
               :updated_at  now}]
      ;; Raw insert, NOT `psc/insert!`: that helper requires a bound
      ;; operation and writes an audit row, and comments are neither audited
      ;; nor part of any operation. See the ns docstring.
      (psc/execute! db {:insert-into :comments :values [row]})
      (row->comment row))))

(defn update!
  "Rewrite a comment's body and stamp `updated_at`. Returns the updated
  comment, or nil if no such comment. Authorship is NOT checked here — the
  REST layer owns that rule, so a service or migration path can still
  correct a body deliberately."
  [db id body]
  (validate-body! body)
  (when (psc/fetch-by-id db :comments id)
    (psc/execute! db {:update :comments
                      :set    {:body body :updated_at (psc/now-iso)}
                      :where  [:= :id id]})
    (get db id)))

(defn delete!
  "Delete a comment. Returns true if a row went away, false if there was
  none."
  [db id]
  (pos? (psc/execute! db {:delete-from :comments :where [:= :id id]})))
