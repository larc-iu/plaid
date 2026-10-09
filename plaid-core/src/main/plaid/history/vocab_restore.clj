(ns plaid.history.vocab-restore
  "Put one vocabulary entry back as it was at an earlier time, on the
  server, as one operation (audit-vocab-history, ruled 2026-09-27).

  The entry at T is what the audit log folds for it
  (`plaid.history.read/vocab-item-row-at`): its form and its fields. If
  the entry has been deleted since, it is inserted again UNDER ITS OLD ID,
  so its comments and every reference to it (another entry's sense tree, a
  document's history) find it again. If it still exists, its form and
  fields are set back where they differ.

  Links are not part of an entry. A link is annotation on a document, and
  a deleted entry's links come back through each document's own restore
  (`plaid.history.restore`), which skips a link only while its entry is
  gone.

  A form set back restates every document linking the entry, so those
  documents' versions are bumped, as for any rename. Every change also
  stamps the vocabulary's `modified_at`, which is what a client checks
  before reusing its copy of the entries."
  (:require [plaid.history.read :as hread]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.util.canonical :as canonical]
            [plaid.util.storable-text :as storable]))

(defn- meta-of [row] (or (:metadata row) {}))

(defn- target-row!
  "The entry at `ts`, or a structured throw the REST layer maps."
  [db vocab-id item-id ts]
  (when (nil? (psc/fetch-by-id db :vocab_layers vocab-id))
    (throw (ex-info (psc/err-msg-not-found "Vocab layer" vocab-id) {:code 404 :id vocab-id})))
  (or (some-> (hread/vocab-item-row-at db vocab-id item-id ts)
              ;; composed, as every write stores text
              (canonical/compose-data (constantly false)))
      (throw (ex-info "The entry did not exist at that time." {:code 400 :id item-id}))))

(defn- plan
  "What putting the entry back would change, from the entry at T and the
  live row (nil when the entry is gone)."
  [db tgt item-id]
  (let [cur (psc/fetch-by-id db :vocab_items item-id)
        cur-meta (when cur (metadata/get-metadata db "vocab-item" item-id))]
    {:insert? (nil? cur)
     :form? (and (some? cur) (not= (:form tgt) (:form cur)))
     :metadata? (and (some? cur) (not= (meta-of tgt) cur-meta))}))

(defn- summarize
  "The summary a person confirms. `:inserted` when the entry was gone and
  comes back, `:form` and `:metadata` when a living entry's form or fields
  are set back. `:total` is zero only when nothing would change."
  [{:keys [insert? form? metadata?]}]
  {:inserted (boolean insert?)
   :form (boolean form?)
   :metadata (boolean metadata?)
   :total (if insert? 1 (+ (if form? 1 0) (if metadata? 1 0)))})

(defn- linked-document-ids
  "Documents holding a link to `item-id`, read before its form changes."
  [tx item-id]
  (mapv :document_id (psc/q tx {:select [:document_id]
                                :from :vocab_links
                                :where [:= :vocab_item_id item-id]})))

(defn- apply-plan! [tx vocab-id item-id tgt {:keys [insert? form? metadata?]}]
  (cond
    insert?
    ;; One insert row whose image carries the fields, as a create does, so
    ;; the history fold rebuilds the entry from it alone.
    (let [m (meta-of tgt)]
      (psc/execute! tx {:insert-into :vocab_items
                        :values [{:id item-id :form (:form tgt) :vocab_layer_id vocab-id}]})
      (metadata/insert-metadata! tx "vocab-item" item-id m {:skip-parent-audit? true})
      (let [row (psc/fetch-by-id tx :vocab_items item-id)]
        (psaw/record-audit-write! tx :vocab_items item-id :insert nil
                                  (cond-> row (seq m) (assoc :metadata m)))))

    :else
    (do
      (when form?
        (let [doc-ids (linked-document-ids tx item-id)]
          (crud/update-by-id! tx :vocab_items item-id {:form (:form tgt)})
          (op/bump-document-versions! tx doc-ids)))
      (when metadata?
        (metadata/replace-metadata! tx "vocab-item" item-id (meta-of tgt)))))
  (when (or insert? form? metadata?)
    (op/touch-vocab-layer! tx vocab-id)))

(defn preview
  "What putting entry `item-id` of vocabulary `vocab-id` back as it was at
  `ts` would change, without writing. Throws ex-info with `:code` 404 (no
  such vocabulary now) or 400 (no such entry in it at `ts`)."
  [db vocab-id item-id ts]
  (let [tgt (target-row! db vocab-id item-id ts)]
    (summarize (plan db tgt item-id))))

(defn restore
  "Put entry `item-id` of vocabulary `vocab-id` back as it was at `ts`, as
  one audited operation. Returns `{:success true :extra summary :documents
  [...]}` or `{:success false :code :error}` like every other operation."
  [db vocab-id item-id ts user-id]
  (submit-operation!
   [tx db {:type :vocab-item/restore
           :project nil
           :document nil
           :description (str "Restore vocab item " item-id " to " (hread/->ts-iso ts))
           :user user-id}]
   (let [tgt (target-row! tx vocab-id item-id ts)
         p (plan tx tgt item-id)]
     (storable/assert-storable! "Form" (:form tgt))
     (apply-plan! tx vocab-id item-id tgt p)
     (summarize p))))
