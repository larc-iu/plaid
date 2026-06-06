(ns plaid.sql.text
  "SQL port of plaid.xtdb2.text. Texts live in the `texts` table with
  the (document_id, text_layer_id) pair under a UNIQUE constraint.

  The interesting function here is `update-body`. In v2 it had to thread
  the text body change, token reindexing, deleted-token cascade, and
  partitioning gap-fill through a single XTDB transaction laden with
  match*/ASSERT TOCTOU guards (`oob-assert`, `text-edit-partition-asserts`,
  the `compensated-ids` filter). All of that machinery exists in v2 because
  the XTDB writer does not serialize on the read snapshot.

  The SQL port runs inside a single JDBC transaction, which under SQLite's
  single-writer model gives us serializable isolation for free. The reads
  inside the tx see a consistent snapshot and no other writer can interleave,
  so the v2 guards are redundant and are not ported:

    * `match*` calls for texts/tokens → gone (tx isolation)
    * `:sql \"ASSERT NOT EXISTS ... text$end > ?\"` → gone
    * `text-edit-partition-asserts` → gone
    * `compensated-ids` filtering of update-tx → gone (we just don't
       schedule duplicate updates; the compensator runs LAST and writes
       what it needs)

  Cross-namespace dependencies: this file calls into
  `plaid.sql.token/multi-delete!` and `plaid.sql.token/compensate-partition-layers!`
  for cascade-deletion and partition gap-fill. plaid.sql.token doesn't
  require this namespace, but to avoid a load-time cycle if/when token
  ever needs to reach back, we resolve those two fns at call-site via
  `requiring-resolve`."
  (:require [plaid.algos.text :as ta]
            [plaid.sql.common :as psc]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.util.codepoint :as cp])
  (:refer-clojure :exclude [get]))

(def attr-keys [:text/id
                :text/document
                :text/layer
                :text/body])

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->text
  "Translate a `texts` row to the namespaced shape. Returns nil on nil input."
  [row]
  (when row
    {:text/id       (:id row)
     :text/body     (:body row)
     :text/document (:document_id row)
     :text/layer    (:text_layer_id row)}))

(defn- row->token
  "Local row->token, kept independent of plaid.sql.token to avoid a
  load-time require cycle (text -> token would close the loop, since
  token already calls into text for partition gap-fill, etc.).

  DRIFT RISK: this body is intentionally a copy of
  `plaid.sql.token/row->token` — that is the canonical version. If you
  add/rename a token attr, update BOTH places (token.clj first, then
  mirror the change here). Tests on either side should fail loudly if
  they drift, but the duplication is not enforced by code."
  [row]
  (when row
    {:token/id       (:id row)
     :token/text     (:text_id row)
     :token/layer    (:token_layer_id row)
     :token/document (:document_id row)
     :token/begin    (:begin row)
     :token/end      (:end_ row)
     :token/precedence (:precedence row)}))

;; ============================================================
;; Reads
;; ============================================================

(defn get
  "Look up a text by ID, with metadata attached."
  [db id]
  (when-let [raw (row->text (psc/fetch-by-id db :texts id))]
    (metadata/add-metadata-to-response db raw "text" id)))

(defn project-id
  "Find the project id for a text. Goes through its text-layer."
  [db id]
  (when-let [txtl-id (:text_layer_id (psc/fetch-by-id db :texts id))]
    (:project_id (psc/fetch-by-id db :text_layers txtl-id))))

(defn get-text-for-doc
  "Find the (unique) text for a (text-layer, document) pair. Returns the
  formatted text or nil."
  [db text-layer-id document-id]
  (when-let [row (psc/q1 db {:select [:*]
                             :from [:texts]
                             :where [:and
                                     [:= :text_layer_id text-layer-id]
                                     [:= :document_id document-id]]})]
    (let [t (row->text row)]
      (metadata/add-metadata-to-response db t "text" (:text/id t)))))

(defn get-token-ids
  "Return the IDs of all tokens for this text."
  [db text-id]
  (->> (psc/q db {:select [:id]
                  :from [:tokens]
                  :where [:= :text_id text-id]})
       (mapv :id)))

(defn- project-id-from-text-layer
  [db text-layer-id]
  (:project_id (psc/fetch-by-id db :text_layers text-layer-id)))

;; ============================================================
;; Create
;; ============================================================

(defn create
  "Create a new text. `attrs` requires :text/body, :text/document, and
  :text/layer. `metadata-map` (optional) populates entity_metadata.

  Validates that the document and text-layer exist, that the text-layer
  belongs to the same project as the document, and that no text already
  exists for the (document, text-layer) pair (the UNIQUE constraint
  enforces this; we pre-check for a clean 409).

  Returns {:success true :extra <new-id>} on success."
  ([db attrs user-id] (create db attrs user-id nil))
  ([db attrs user-id metadata-map]
   (let [{:text/keys [body document layer]} attrs
         body-str (if (string? body) body "")
         new-id (psc/new-uuid)
         prj-id (project-id-from-text-layer db layer)]
     (submit-operation!
      [tx db {:type :text/create
              :project prj-id
              :document document
              :description (str "Create text in layer " layer " for document " document
                                (when metadata-map (str " with " (count metadata-map) " metadata keys")))
              :user user-id}]
      ;; Body-shape validation inside the body (task #47) so a non-string
      ;; body surfaces as {:success false :code 400}. `body` is the raw
      ;; caller input; `body-str` is the validated string used for INSERT.
      (when-not (or (nil? body) (string? body))
        (throw (ex-info "Text body must be a string." {:body body :code 400})))
      (let [doc-row (psc/fetch-by-id tx :documents document)
            txtl-row (psc/fetch-by-id tx :text_layers layer)]
        (when (nil? doc-row)
          (throw (ex-info (psc/err-msg-not-found "Document" document)
                          {:id document :code 400})))
        (when (nil? txtl-row)
          (throw (ex-info (psc/err-msg-not-found "Text layer" layer)
                          {:id layer :code 400})))
        (when (not= (:project_id doc-row) (:project_id txtl-row))
          (throw (ex-info (str "Text layer " layer " not linked to project "
                               (:project_id doc-row))
                          {:text-layer layer
                           :project (:project_id doc-row)
                           :document document :code 400})))
        ;; UNIQUE (document_id, text_layer_id) — pre-check for clean 409.
        (when (psc/q1 tx {:select [:id]
                          :from [:texts]
                          :where [:and
                                  [:= :text_layer_id layer]
                                  [:= :document_id document]]})
          (throw (ex-info (str "Text already exists for document " document)
                          {:document document :code 409})))
        (try
          (psc/insert! tx :texts
                       {:id new-id
                        :body body-str
                        :document_id document
                        :text_layer_id layer})
          (catch Exception e
            ;; Belt-and-suspenders: if a concurrent writer slipped in,
            ;; the UNIQUE constraint will trip here. Re-throw with 409.
            (if (re-find #"(?i)unique" (or (ex-message e) ""))
              (throw (ex-info (str "Text already exists for document " document)
                              {:document document :code 409}))
              (throw e))))
        (when (seq metadata-map)
          (metadata/insert-metadata! tx "text" new-id metadata-map))
        new-id)))))

;; ============================================================
;; Update body
;; ============================================================

;; Offsets are Unicode code points throughout: `plaid.algos.text/diff` produces
;; code-point-indexed ops (it diffs at code-point granularity) and
;; `apply-text-edits` shifts code-point token offsets, so no unit conversion is
;; needed here.
(defn update-body
  "Change the textual content of `eid`, reindexing tokens to match.

  `new-body-or-ops` is either a string (the full new body — diffed
  against the current body) or a vector of edit-ops in the shape that
  `plaid.algos.text/apply-text-edits` accepts.

  Cascades:
    1. Tokens whose extent falls entirely inside a deletion range are
       deleted via plaid.sql.token/multi-delete! (audited cascade
       through spans/relations/vocab_links).
    2. Tokens whose extent shifts get a per-row UPDATE.
    3. The texts row's body is updated.
    4. Partitioning-mode token layers get gap-filled by
       plaid.sql.token/compensate-partition-layers! — the LAST step so
       it sees the final post-edit token positions.

  v2's TOCTOU guards (match*/ASSERT, oob-assert, partition-asserts,
  compensated-ids filtering) are not ported — the SQL tx makes them
  redundant.

  Returns {:success true :extra <text-id>}."
  [db eid new-body-or-ops user-id]
  (let [pre (psc/fetch-by-id db :texts eid)]
    (submit-operation!
     [tx db {:type :text/update-body
             :project (when pre (project-id db eid))
             :document (:document_id pre)
             :description (str "Update body of text " eid)
             :user user-id}]
     ;; Validation inside the body (task #47).
     (when-not (or (string? new-body-or-ops) (sequential? new-body-or-ops))
       (throw (ex-info "Text body must be a string." {:body new-body-or-ops :code 400})))
     (when (nil? pre)
       (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
     (let [text-row (psc/fetch-by-id tx :texts eid)]
       (when (nil? text-row)
         (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
       (let [old-body (:body text-row)
             text-map (row->text text-row)
             ops (if (string? new-body-or-ops)
                   (ta/diff old-body new-body-or-ops)
                   (vec new-body-or-ops))
             token-rows (psc/q tx {:select [:*]
                                   :from [:tokens]
                                   :where [:= :text_id eid]})
             tokens (mapv row->token token-rows)            ; code-point offsets
             indexed-old (reduce (fn [m t] (assoc m (:token/id t) t)) {} tokens)
             {new-text :text new-tokens :tokens deleted-ids :deleted}
             (ta/apply-text-edits ops text-map tokens)
             new-body (:text/body new-text)
             ;; Code-point length: feeds compensate-partition-layers! /
             ;; validate-partition!, which compare it against (code-point)
             ;; token offsets, so the unit must match.
             new-text-length (cp/cp-count new-body)
             ;; Use requiring-resolve to keep this file decoupled from
             ;; plaid.sql.token at load time. (token.clj does not require
             ;; text.clj today, but if it ever did, deferring resolution
             ;; here keeps the cycle from biting.)
             multi-delete! (requiring-resolve 'plaid.sql.token/multi-delete!)
             compensate-partition-layers!
             (requiring-resolve 'plaid.sql.token/compensate-partition-layers!)]
         (let [deleted-set (set deleted-ids)]
           ;; 1. Cascade-delete tokens that collapsed into a deletion range.
           (when (seq deleted-ids)
             (multi-delete! tx deleted-ids))
           ;; 2. Bulk UPDATE via CASE for surviving tokens whose extent
           ;;    changed — collapses N UPDATEs + N SELECTs into one of
           ;;    each, regardless of survivor count. The audit-skip
           ;;    semantics inside bulk-update-by-id! (pre == post)
           ;;    match the per-row helper's behavior.
           ;; Build a [id attrs] seq sorted by source position so the
           ;; resulting audit_writes rows reflect document order — handy
           ;; for ETL consumers reconstructing the per-token timeline.
           (let [survivor-updates
                 (->> new-tokens
                      (keep (fn [{:token/keys [id begin end]}]
                              (when-not (deleted-set id)
                                (let [orig (clojure.core/get indexed-old id)]
                                  (when (or (not= begin (:token/begin orig))
                                            (not= end (:token/end orig)))
                                    [id {:begin begin :end_ end}])))))
                      (sort-by (fn [[_ {:keys [begin]}]] begin))
                      vec)]
             (when (seq survivor-updates)
               (psc/bulk-update-by-id! tx :tokens survivor-updates)))
           ;; 3. Update the text body.
           (psc/update-by-id! tx :texts eid {:body new-body})
           ;; 4. Partitioning-mode gap-fill on the surviving tokens.
           (let [survivors (->> new-tokens
                                (remove #(contains? deleted-set (:token/id %)))
                                vec)]
             (compensate-partition-layers! tx survivors new-text-length))
           eid))))))

;; ============================================================
;; Delete
;; ============================================================

(defn delete
  "Delete a text.

  The schema's FK ON DELETE CASCADE from tokens.text_id would clean up
  tokens at the DB level, but FK cascades bypass audit_writes. To
  preserve audit fidelity (and to fire the visible-entity cascade
  through spans/relations/vocab_links), we fetch the text's tokens
  first and delete them through plaid.sql.token/multi-delete!, then
  delete the text row. Entity metadata for the text itself has no FK
  and is cleaned up explicitly."
  [db eid user-id]
  (let [pre (psc/fetch-by-id db :texts eid)]
    (submit-operation!
     [tx db {:type :text/delete
             :project (project-id db eid)
             :document (:document_id pre)
             :description (str "Delete text " eid)
             :user user-id}]
     (when (nil? (psc/fetch-by-id tx :texts eid))
       (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
     (let [token-ids (get-token-ids tx eid)
           multi-delete! (requiring-resolve 'plaid.sql.token/multi-delete!)]
       (when (seq token-ids)
         (multi-delete! tx token-ids))
       (metadata/delete-metadata! tx "text" eid)
       (psc/delete-by-id! tx :texts eid)
       eid))))

;; ============================================================
;; Metadata
;; ============================================================

(defn set-metadata
  "Replace all metadata for the text."
  [db eid metadata-map user-id]
  (submit-operation!
   [tx db {:type :text/set-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :texts eid))
           :description (str "Set metadata on text " eid
                             " with " (count metadata-map) " keys")
           :user user-id}]
   (metadata/validate-entity-type! "text")
   (when (nil? (psc/fetch-by-id tx :texts eid))
     (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
   (metadata/replace-metadata! tx "text" eid metadata-map)
   eid))

(defn patch-metadata
  "Shallow-merge a metadata patch on the text: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
  [db eid patch user-id]
  (submit-operation!
   [tx db {:type :text/patch-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :texts eid))
           :description (str "Patch metadata on text " eid
                             " with " (count patch) " keys")
           :user user-id}]
   (metadata/validate-entity-type! "text")
   (when (nil? (psc/fetch-by-id tx :texts eid))
     (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
   (metadata/patch-metadata! tx "text" eid patch)
   eid))

(defn delete-metadata
  "Remove all metadata from the text."
  [db eid user-id]
  (submit-operation!
   [tx db {:type :text/delete-metadata
           :project (project-id db eid)
           :document (:document_id (psc/fetch-by-id db :texts eid))
           :description (str "Delete all metadata from text " eid)
           :user user-id}]
   (metadata/validate-entity-type! "text")
   (when (nil? (psc/fetch-by-id tx :texts eid))
     (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
   (metadata/delete-metadata! tx "text" eid)
   eid))
