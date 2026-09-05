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
    * No INTERCHANGE format carries them: in FLEx, CLDF and ELAN the slot
      called note/comment is already bound to a user-configured annotation
      field, so writing a comment there would corrupt an annotation rather
      than transfer a comment. Only plaid-igt's native archive carries them,
      and it cannot restore `author_id` or the timestamps on the way back in
      (see below), so it prepends the original attribution to the body.

  Flat by design: no threading, no resolve state, no reactions. A comment is
  a row with an author and a body.

  ## Anchoring

  `(entity_type, entity_id)` names the commented entity: a document, text,
  token, span, or relation, or a vocab item. The OWNER of the comment is
  whatever ACL governs that entity, and it is denormalized onto the row at
  insert time so the hot reads are single indexed scans and FK cascade
  reclaims rows when the owner goes:

    * a project-scoped anchor gives `project_id` + `document_id`;
    * a vocab item gives `vocab_layer_id` alone. A vocabulary is shared
      across projects and carries its own maintainer model, so its comments
      belong to the vocab layer, not to any project that links it.

  The CHECK constraint on the table pins exactly one owner.

  ## Outliving the anchor

  Deleting the anchor entity does NOT delete its comments. A comment is a
  remark a person made; an edit that removes the word it was about (a merge,
  a re-segmentation, a typo fix that recreates the token) should not
  silently un-say it. The comment stays, now pointing at an id nothing
  resolves, and the app shows it as OUTDATED with `anchor_label`, the
  caption captured when it was posted (\"Gloss of ktab, sentence 4\"), the
  way a code review keeps a comment on a line that has since changed.
  Only the OWNER's deletion (document, project, vocab layer) takes comments
  with it, through the FK cascades. Nothing re-anchors a comment
  automatically: which successor a split or a re-analysis \"meant\" is a
  guess, and a person can re-post.

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
  "Entity types that can carry a comment: the project-scoped set, plus vocab
  items (owned by their vocab layer). See the anchoring note above."
  #{"document" "text" "token" "span" "relation" "vocab-item"})

(def ^:const max-anchor-label-length
  "Ceiling on `anchor_label`, the caption a client supplies when it posts."
  200)

(def ^:const max-body-length
  "Ceiling on one comment's body, in characters. Generous for prose a person
  actually types into a comment box, bounded so the table cannot become a
  file dump."
  10000)

(def ^:private entity-type->table
  {"document"   :documents
   "text"       :texts
   "token"      :tokens
   "span"       :spans
   "relation"   :relations
   "vocab-item" :vocab_items})

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
  "Resolve `(entity-type, entity-id)` to the comment's OWNER: `{:project-id
  .. :document-id ..}` for a project-scoped entity, `{:vocab-layer-id ..}`
  for a vocab item, or nil when the type is not commentable or the entity
  does not exist.

  Every project-scoped entity but `document` carries a denormalized
  `document_id` column already, so this is two point lookups at worst: the
  entity row, then its layer row for the project id."
  [db entity-type entity-id]
  (when-let [table (entity-type->table entity-type)]
    (when-let [row (psc/fetch-by-id db table entity-id)]
      (case entity-type
        "document"   {:project-id (:project_id row) :document-id (:id row)}
        "vocab-item" {:vocab-layer-id (:vocab_layer_id row)}
        (let [[layer-table fk] (entity-type->layer entity-type)]
          (when-let [layer (psc/fetch-by-id db layer-table (clojure.core/get row fk))]
            {:project-id (:project_id layer) :document-id (:document_id row)}))))))

(defn owner-of
  "A stored comment row's owner in the same shape `resolve-anchor` returns,
  read off the denormalized columns rather than the anchor (which may no
  longer exist)."
  [row]
  (when row
    (if (:vocab_layer_id row)
      {:vocab-layer-id (:vocab_layer_id row)}
      {:project-id (:project_id row) :document-id (:document_id row)})))

;; ============================================================
;; Reads
;; ============================================================

(defn- row->comment
  "External shape. `:comment/edited` is derived rather than stored — a
  comment is edited iff its body has been rewritten since it was posted."
  [row]
  (when row
    {:comment/id             (:id row)
     :comment/project-id     (:project_id row)
     :comment/document-id    (:document_id row)
     :comment/vocab-layer-id (:vocab_layer_id row)
     :comment/entity-type    (:entity_type row)
     :comment/entity-id      (:entity_id row)
     :comment/anchor-label   (:anchor_label row)
     :comment/author-id      (:author_id row)
     :comment/body           (:body row)
     :comment/created-at     (:created_at row)
     :comment/updated-at     (:updated_at row)
     :comment/edited         (not= (:created_at row) (:updated_at row))}))

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

(defn- scoped-where
  "The WHERE for an owner-scoped read, narrowed by whichever optional
  filters are present. Every filter is ANDed UNDER the owner scope, so a
  document or entity id belonging elsewhere simply matches nothing. There is
  deliberately no way to widen past the owner the caller's ACL was checked
  against."
  [owner-clause {:keys [document-id entity-type entity-id]}]
  (cond-> [:and owner-clause]
    document-id (conj [:= :document_id document-id])
    entity-type (conj [:= :entity_type entity-type])
    entity-id   (conj [:= :entity_id entity-id])))

(defn- project-scoped-where [project-id opts]
  (scoped-where [:= :project_id project-id] opts))

(defn- vocab-scoped-where [vocab-layer-id opts]
  (scoped-where [:= :vocab_layer_id vocab-layer-id] opts))

(defn list-in-project
  "Comments in `project-id`, oldest first, optionally narrowed to one
  document (`:document-id`) or one entity (`:entity-type` + `:entity-id`).

  The document-scoped form is the read an editor makes on open to paint its
  comment indicators: one indexed scan over `idx_comments_document` rather
  than a request per commented entity."
  [db project-id opts]
  (paginate-comments db (project-scoped-where project-id opts) opts))

(defn list-in-vocab
  "Comments on `vocab-layer-id`'s entries, oldest first, optionally narrowed
  to one entry (`:entity-id`)."
  [db vocab-layer-id opts]
  (paginate-comments db (vocab-scoped-where vocab-layer-id opts) opts))

(defn- count-by-entity [db where]
  (into {}
        (map (juxt :entity_id :n))
        (psc/q db {:select   [:entity_id [[:count :*] :n]]
                   :from     [:comments]
                   :where    where
                   :group-by [:entity_id]})))

(defn count-in-project
  "`{entity-id -> n}` over the same scope `list-in-project` reads. Lets a
  client paint a comment indicator on every annotated item in a document
  from ONE cheap request, without paging through the bodies to do it."
  [db project-id opts]
  (count-by-entity db (project-scoped-where project-id opts)))

(defn count-in-vocab
  "`{entity-id -> n}` over the same scope `list-in-vocab` reads: one request
  marks every commented entry in a vocabulary."
  [db vocab-layer-id opts]
  (count-by-entity db (vocab-scoped-where vocab-layer-id opts)))

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

(defn- normalize-anchor-label!
  "The caption to store: trimmed, nil when absent or blank, a 400 when it is
  not a string or runs past the ceiling."
  [label]
  (cond
    (nil? label) nil
    (not (string? label)) (throw (ex-info "Comment anchor label must be a string" {:code 400}))
    (> (count label) max-anchor-label-length)
    (throw (ex-info (str "Comment anchor label exceeds " max-anchor-label-length " characters")
                    {:code 400 :length (count label)}))
    :else (let [t (clojure.string/trim label)] (when (seq t) t))))

(defn create!
  "Post a comment on `(entity-type, entity-id)` as `author-id`, with an
  optional `anchor-label` caption. Returns the created comment in external
  shape.

  Throws `{:code 400}` for an uncommentable entity type or a bad body or
  label, and `{:code 404}` when the anchor entity does not exist. The caller
  is responsible for having checked that `author-id` may write to the
  resolved owner — `resolve-anchor` is also what the REST auth middleware
  uses to find it."
  [db {:keys [entity-type entity-id body anchor-label]} author-id]
  (when-not (commentable-types entity-type)
    (throw (ex-info (str "Entity type '" entity-type "' cannot carry comments. "
                         "Commentable types: "
                         (clojure.string/join ", " (sort commentable-types)))
                    {:code 400 :entity-type entity-type})))
  (validate-body! body)
  (let [label (normalize-anchor-label! anchor-label)
        {:keys [project-id document-id vocab-layer-id]} (resolve-anchor db entity-type entity-id)]
    (when (and (nil? project-id) (nil? vocab-layer-id))
      (throw (ex-info (psc/err-msg-not-found (clojure.string/capitalize entity-type) entity-id)
                      {:code 404 :id entity-id})))
    (let [now (psc/now-iso)
          row {:id             (psc/new-uuid)
               :project_id     project-id
               :document_id    document-id
               :vocab_layer_id vocab-layer-id
               :entity_type    entity-type
               :entity_id      entity-id
               :anchor_label   label
               :author_id      author-id
               :body           body
               :created_at     now
               :updated_at     now}]
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
