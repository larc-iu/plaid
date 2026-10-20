(ns plaid.sql.text
  "Texts: one per (document, text layer) pair, a UNIQUE constraint in the
  `texts` table.

  The interesting function here is `update-body`, which saves a new body
  and moves, shrinks or deletes the tokens over it (see `plaid.algos.text`)
  in one write transaction. Its plan is worked out before the transaction
  and written only when no write that could change what it read has
  committed in between. Deleting the tokens a save leaves with no letter
  and refilling the partitions are `plaid.sql.token`'s
  `multi-delete!` and `compensate-partition-layers!`."
  (:require [plaid.algos.text :as ta]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.token :as token]
            [plaid.util.canonical :as canonical]
            [plaid.util.codepoint :as cp]
            [plaid.util.digest :as digest]
            [plaid.util.storable-text :as storable])
  (:refer-clojure :exclude [get]))

;; ============================================================
;; Row mapper
;; ============================================================

(defn- row->text
  "Translate a `texts` row to the namespaced shape, with the body's digest
  (see `plaid.util.digest`). Returns nil on nil input."
  [row]
  (when row
    {:text/id       (:id row)
     :text/body     (:body row)
     :text/document (:document_id row)
     :text/layer    (:text_layer_id row)
     :text/digest   (digest/text-digest (:body row))}))

;; ============================================================
;; Reads
;; ============================================================

(defn get
  "Look up a text by ID, with metadata attached."
  [db id]
  (when-let [raw (row->text (psc/fetch-by-id db :texts id))]
    (metadata/add-metadata-to-response db raw "text" id)))

(defn get-many
  "`{id text}` for the texts `ids` that exist, each as `get` gives it, read
  together."
  [db ids]
  (metadata/with-metadata-of db "text"
    (update-vals (crud/rows-by-id db :texts ids) row->text)))

(defn project-id
  "Find the project id for a text. Goes through its text-layer."
  [db id]
  (when-let [txtl-id (:text_layer_id (psc/fetch-by-id db :texts id))]
    (:project_id (psc/fetch-by-id db :text_layers txtl-id))))

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

(defn- tokenize-spec
  "What \"Tokenize new text\" on token layer `layer-id` reads, for a text of
  text layer `text-layer-id`: the layer, its ignored-tokens rule
  (`config.igt.ignoredTokens`) and the text layer's partition layers (the
  sentences), which no new word crosses. Throws a 400 when `layer-id` is not
  a token layer of that text layer."
  [db text-layer-id layer-id]
  (let [rows (psc/q db {:select [:id :overlap_mode :config]
                        :from [:token_layers]
                        :where [:= :text_layer_id text-layer-id]})
        row (some #(when (= (str layer-id) (str (:id %))) %) rows)]
    (when-not row
      (throw (ex-info (str "Token layer " layer-id " is not a token layer of this text's layer.")
                      {:code 400 :id layer-id})))
    {:layer (:id row)
     :rule (get-in (some-> (:config row) psc/parse-config) ["igt" "ignoredTokens"])
     :partitions (into #{} (comp (filter #(= "partitioning" (:overlap_mode %))) (map :id)) rows)}))

(defn- tokenize-words
  "The words `spec` (see `tokenize-spec`) makes on `body`, for a save that
  typed `typed` and left `tokens` on it (see `ta/new-words`)."
  [{:keys [layer rule partitions]} body typed tokens]
  (ta/new-words body typed tokens layer partitions rule))

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

  `:text/id` names the new text's id (a client's UUIDv7), else the server
  mints one. `:text/tokenize-layer`, optional, a token layer of the text's
  layer, gets the words of \"Tokenize new text\" over the whole body (see
  `plaid.algos.text/new-words`). `:text/edges`, optional, are the code-point offsets where the
  tokens the caller makes next begin and end: a character one of them falls
  inside stays decomposed (see `canonical/compose`), so a body written with
  a mark of its own token (an archive of such a text) keeps its offsets.

  Returns {:success true :extra <new-id>} on success."
  ([db attrs user-id] (create db attrs user-id nil))
  ([db attrs user-id metadata-map]
   (let [{:text/keys [body document layer]} attrs
         body-str (if (string? body) body "")
         new-id (or (:text/id attrs) (psc/new-uuid))
         prj-id (project-id-from-text-layer db layer)]
     (submit-operation!
      [tx db {:type :text/create
              :project prj-id
              :document document
              :description (str "Create text in layer " layer " for document " document
                                (when (seq metadata-map) (str " with " (count metadata-map) " metadata keys")))
              :user user-id}]
      ;; Body-shape validation inside the body so a non-string
      ;; body surfaces as {:success false :code 400}. `body` is the raw
      ;; caller input; `body-str` is the validated string used for INSERT.
      (when-not (or (nil? body) (string? body))
        (throw (ex-info "Text body must be a string." {:body body :code 400})))
      (storable/assert-storable! "Text body" body-str)
      (psc/claim-ids! tx :texts "text" [(:text/id attrs)])
      (let [doc-row (psc/fetch-by-id tx :documents document)
            txtl-row (psc/fetch-by-id tx :text_layers layer)
            stored (:text (canonical/compose body-str (:text/edges attrs)))]
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
          (crud/insert! tx :texts
                        {:id new-id
                         ;; stored composed, as all text is, except a
                         ;; character the tokens to come will cut (`:text/edges`)
                         :body stored
                         :document_id document
                         :text_layer_id layer})
          (catch Exception e
            ;; Belt-and-suspenders: if a concurrent writer slipped in,
            ;; the UNIQUE constraint will trip here. Re-throw with 409.
            (if (re-find #"(?i)unique" (or (ex-message e) ""))
              (throw (ex-info (str "Text already exists for document " document)
                              {:document document :code 409}))
              (throw e))))
        (when-let [spec (some->> (:text/tokenize-layer attrs) (tokenize-spec tx layer))]
          (doseq [{:token/keys [begin end]} (tokenize-words spec stored [[0 (cp/cp-count stored)]] [])]
            (crud/insert! tx :tokens {:id (psc/new-uuid) :text_id new-id :token_layer_id (:layer spec)
                                      :document_id document :begin begin :end_ end})))
        (when (seq metadata-map)
          (metadata/insert-metadata! tx "text" new-id metadata-map))
        new-id)))))

;; ============================================================
;; Update body
;; ============================================================

;; Offsets are Unicode code points throughout: the edits, the diff of a body
;; and the token offsets `plaid.algos.text` moves, so no unit conversion is
;; needed here.
(def ^:private text-changed
  "The error of an edit whose `base` is not the stored body's digest."
  "The text was changed since it was read.")

(defn- save-plan
  "Work out what a body save writes, from what `db` holds now: the new body,
  the tokens to delete, the new extents of the others, and the tokens that
  survive. Reads only the text row, its tokens and their layers' rows, and
  writes nothing, so `update-body` can run it before it takes the write lock.
  Nil when the text does not exist. Throws what the save should answer when
  the ops or the new body are refused, and a 409 when `base` is given and
  is not the stored body's digest.

  `change` is a new body (a string), ops applied as sent (a vector), or
  `{:edits ops}`, ops from the caret (see `edit-body`). With
  `tokenize-layer`, a token layer of the text, the text the save types gets
  the words of \"Tokenize new text\" on it (see `ta/new-words`)."
  [db eid change base tokenize-layer]
  (when-let [text-row (psc/fetch-by-id db :texts eid)]
    (when (and base (not= base (digest/text-digest (:body text-row))))
      (throw (ex-info text-changed {:code 409 :id eid :text-changed true})))
    (let [old-body (:body text-row)
          tokenize (when tokenize-layer (tokenize-spec db (:text_layer_id text-row) tokenize-layer))
          edits (when (map? change) (vec (:edits change)))
          ;; A whole new body is composed before it is diffed, so a body sent
          ;; decomposed differs from the stored one only where it was changed.
          ;; A character the stored body keeps decomposed (a token edge
          ;; between its letter and its mark) is left as sent, so it is no
          ;; change either.
          new-body-or-ops (cond (map? change) edits
                                (string? change) (canonical/nfc-but change (:body text-row))
                                :else change)
          text-map (row->text text-row)
          token-rows (psc/q db {:select [:*]
                                :from [:tokens]
                                :where [:= :text_id eid]})
          tokens (mapv token/row->token token-rows)            ; code-point offsets
          ;; A new body or edits from the caret take the plain rule (see
          ;; ta/apply-plain-gaps), on every token layer alike: what the layers
          ;; are to it is read from their shape (see ta/layer-roles), and a
          ;; layer setting `splitOnSpace` (ud's words) has a space typed inside
          ;; a word split it, for every word of the text, the tokens under
          ;; the word placed by where they stand, or dealt one to each part
          ;; on a layer of role `syntactic-word`. A character a layer's
          ;; ignored-tokens rule calls letter-like is a letter to the
          ;; punctuation rule (see ta/ignored-letter-like). A diffed body's
          ;; edits are first moved to where they disturb the fewest tokens
          ;; when they could stand in several places for the same result (see
          ;; ta/plain-body-gaps). Ops sent as the body are applied as sent.
          layer-rows (when (and (or (string? new-body-or-ops) edits) (seq tokens))
                       (psc/q db {:select [:id :name :overlap_mode :parent_token_layer_id :config]
                                  :from [:token_layers]
                                  :where [:= :text_layer_id (:text_layer_id text-row)]}))
          {:keys [partitioning deciders exclusive] :as roles}
          (ta/layer-roles (map (fn [r] (let [config (some-> (:config r) psc/parse-config)
                                             plaid (clojure.core/get config "plaid")]
                                         {:id (:id r)
                                          :overlap-mode (:overlap_mode r)
                                          :parent (:parent_token_layer_id r)
                                          :split-on-space (true? (clojure.core/get plaid "splitOnSpace"))
                                          :role (clojure.core/get plaid "role")
                                          :letter-like (ta/ignored-letter-like config)}))
                               layer-rows))
          opts (select-keys roles [:split-on-space :children :dealt :exclusive :head-layers :letter-like])
          indexed-old (reduce (fn [m t] (assoc m (:token/id t) t)) {} tokens)
          [gaps {new-text :text sent-tokens :tokens deleted-ids :deleted sent-heads :heads sent-made :made}]
          (cond
            edits (let [gaps (ta/plain-edit-gaps old-body edits tokens partitioning deciders opts)]
                    [gaps (ta/apply-plain-gaps old-body tokens gaps partitioning deciders opts)])
            (string? new-body-or-ops) (ta/plain-body-read old-body new-body-or-ops tokens partitioning deciders opts)
            :else [(when tokenize (ta/compose-edits (vec new-body-or-ops) old-body))
                   (ta/apply-text-edits (vec new-body-or-ops) text-map tokens)])
          sent-body (:text/body new-text)
          ;; The steps above only move edits between equivalent places, so
          ;; a diffed body comes out as sent, and edits as they make the body
          ;; applied in turn. Should one of them ever get that wrong, the
          ;; save fails rather than store a body nobody typed.
          _ (when (or (and (string? new-body-or-ops) (not= sent-body new-body-or-ops))
                      (and edits (not= sent-body (ta/edit-ops-body edits old-body))))
              (throw (ex-info "The new body could not be applied." {:code 500 :id eid})))
          ;; Checked on the result, so explicit ops' inserted text is
          ;; covered as well as a whole new body.
          _ (storable/assert-storable! "Text body" sent-body)
          deleted-set (set deleted-ids)
          ;; "Tokenize new text": the words of the text the save typed, made
          ;; on the tokens as the save leaves them (see `ta/new-words`).
          sent-made (cond-> (vec sent-made)
                      tokenize (into (tokenize-words tokenize sent-body (ta/typed-ranges gaps)
                                                     (concat (remove #(deleted-set (:token/id %)) sent-tokens)
                                                             sent-heads sent-made))))
          ;; The body is stored composed. Text an edit inserted that composes
          ;; with a letter beside it becomes one character with it, except
          ;; where a token edge falls between them: there the character stays
          ;; decomposed, so each token keeps its own characters and none is
          ;; left with no text (see `canonical/compose`). Every token's
          ;; offsets go through the same map, which keeps their order, so
          ;; nothing is refused for it.
          {new-body :text at :at} (canonical/compose
                                   sent-body
                                   (into #{} (comp (remove #(deleted-set (:token/id %)))
                                                   (mapcat (juxt :token/begin :token/end)))
                                         (concat sent-tokens sent-heads sent-made)))
          move (fn [t] (-> t (update :token/begin at) (update :token/end at)))
          new-tokens (mapv move sent-tokens)
          heads (mapv move sent-heads)
          made (mapv move sent-made)]
      {:new-body new-body
       ;; Code-point length: feeds compensate-partition-layers! /
       ;; validate-partition!, which compare it against (code-point)
       ;; token offsets, so the unit must match.
       :new-text-length (cp/cp-count new-body)
       :deleted-ids deleted-ids
       ;; Surviving tokens whose extent changed, as [id attrs] in source
       ;; order, so the audit_writes rows follow the document.
       :survivor-updates (->> new-tokens
                              (keep (fn [{:token/keys [id begin end]}]
                                      (when-not (deleted-set id)
                                        (let [orig (clojure.core/get indexed-old id)]
                                          (when (or (not= begin (:token/begin orig))
                                                    (not= end (:token/end orig)))
                                            [id {:begin begin :end_ end}])))))
                              (sort-by (fn [[_ {:keys [begin]}]] begin))
                              vec)
       ;; the tokens the save makes, written in this order: the sentences
       ;; made over a line typed before the first one, and the parts of a
       ;; word a typed space split, each before the tokens under it
       :heads (mapv #(assoc % :token/id (psc/new-uuid)) (concat heads made))
       :survivors (let [survivors (into [] (remove #(contains? deleted-set (:token/id %))) new-tokens)]
                    ;; never two tokens of a layer that forbids overlap on one
                    ;; stretch: should a rule above ever leave them, the save
                    ;; is refused rather than stored
                    (doseq [[layer ts] (group-by :token/layer (filter #(exclusive (:token/layer %))
                                                                      (into survivors made)))
                            [x y] (partition 2 1 (sort-by (juxt :token/begin :token/end) ts))]
                      (when (> (:token/end x) (:token/begin y))
                        (throw (ex-info (str "The change would leave two tokens of layer \""
                                             (or (some #(when (= layer (:id %)) (:name %)) layer-rows) layer)
                                             "\" over the same text, which the layer does not allow.")
                                        {:code 409 :id eid :layer layer}))))
                    survivors)})))

(defn- last-op-ts
  "The time of the newest operation on the server, or \"\" when there is none.
  Every operation's `ts` is stamped under the write lock and is strictly
  greater than every earlier one, so an operation that commits after this
  read has a greater `ts`."
  [db]
  (or (:ts (psc/q1 db {:select [[[:max :ts] :ts]] :from [:operations]})) ""))

(defn- written-since?
  "True when an operation other than `op-id` that could have changed what a
  save of document `doc-id` in project `project-id` read has committed since
  `ts`: one naming the document, one naming the project and no document (a
  layer write), or one naming neither. Every write to a text or a token
  records an operation naming its document, and every write to a token layer
  one naming its project and no document (the writers are listed in the
  V-LOCK report of the 2026-09-28 UMR round, and
  `text-save-outside-lock-test` pins it), so false means the save's inputs
  are as they were at `ts`. A write to another document of the project
  changes nothing the save read. The operations naming no project are
  vocabulary, user and API token writes, which reach no text or token today.
  They are counted anyway, so a writer that one day leaves its project out
  makes a save work itself out again rather than write stale rows. Three
  seeks, on `idx_operations_document_ts` and `idx_operations_project_ts`."
  [tx project-id doc-id ts op-id]
  (let [newer? (fn [scope]
                 (some? (psc/q1 tx {:select [:id]
                                    :from [:operations]
                                    :where [:and scope [:> :ts ts] [:<> :id op-id]]
                                    :limit 1})))]
    (or (newer? [:= :document_id doc-id])
        (newer? [:and [:= :project_id project-id] [:= :document_id nil]])
        (newer? [:= :project_id nil]))))

(declare ^:private save!*)

(defn- save!
  "The write of `update-body` and `edit-body`: `change` as `save-plan` takes
  it, worked out ahead of the write lock and again under it when a write
  that could change what it read has committed meanwhile (see
  `update-body`). The answer carries the operation's id and ts as `:op`, so
  the route can read what it wrote (see `reshape`)."
  [db eid change base tokenize-layer user-id description]
  (if (and (map? change) (sequential? (:edits change)) (empty? (:edits change)))
    ;; An empty edits list changes nothing, so it writes nothing: no
    ;; operation, no audit row and no version bump (REV8-CORE-8). It is
    ;; still answered as the save would be: 404 for no text, 409 for a
    ;; stale `base`.
    (let [pre (psc/fetch-by-id db :texts eid)]
      (cond
        (nil? pre) {:success false :code 404 :error (psc/err-msg-not-found "Text" eid)}
        (and base (not= base (digest/text-digest (:body pre))))
        {:success false :code 409 :error text-changed :text-changed true}
        :else {:success true :extra eid :op {:id nil :ts nil :document nil :body (:body pre)}}))
    (save!* db eid change base tokenize-layer user-id description)))

(defn- save!*
  [db eid change base tokenize-layer user-id description]
  (let [pre (psc/fetch-by-id db :texts eid)
        project (when pre (project-id db eid))
        valid? (or (string? change)
                   (sequential? change)
                   (and (map? change) (sequential? (:edits change))))
        ;; Read the newest operation first: whatever commits after it, while
        ;; the plan below reads, has a later ts and makes the save recompute.
        ahead (when (and pre project valid? (not (instance? java.sql.Connection db)))
                (let [ts (last-op-ts db)]
                  ;; A save the plan refuses is refused again under the lock,
                  ;; where the error becomes the answer.
                  (when-let [plan (try (save-plan db eid change base tokenize-layer)
                                       (catch Exception _ nil))]
                    {:ts ts :plan plan})))
        op (volatile! nil)
        result
        (submit-operation!
         [tx db {:type :text/update-body
                 :project project
                 :document (:document_id pre)
                 :description (str description eid)
                 :user user-id}]
         ;; Validation inside the body.
         (when-not valid?
           (throw (ex-info (if (map? change)
                             "Text edits must be a list of edit operations."
                             "Text body must be a string.")
                           {:body change :code 400})))
         (when (nil? pre)
           (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
         (vreset! op (assoc (select-keys psaw/*op* [:id :ts]) :document (:document_id pre)))
         (let [{:keys [new-body new-text-length deleted-ids survivor-updates survivors heads]}
               (or (when (and ahead (not (written-since? tx project (:document_id pre) (:ts ahead) (:id psaw/*op*))))
                     (:plan ahead))
                   (save-plan tx eid change base tokenize-layer)
                   (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
               multi-delete! token/multi-delete!
               compensate-partition-layers! token/compensate-partition-layers!]
           ;; 1. Cascade-delete tokens that collapsed into a deletion range.
           (when (seq deleted-ids)
             (multi-delete! tx deleted-ids))
           ;; 2. One bulk UPDATE for the surviving tokens whose extent changed.
           ;;    The audit-skip semantics inside bulk-update-by-id! (pre ==
           ;;    post) match the per-row helper's behavior.
           (when (seq survivor-updates)
             (crud/bulk-update-by-id! tx :tokens survivor-updates))
           ;; 3. Update the text body. The answer carries the body this
           ;; transaction wrote, not one read after it.
           (crud/update-by-id! tx :texts eid {:body new-body})
           (vswap! op assoc :body new-body)
           ;; 4. The tokens the save makes (a sentence over a line typed before
           ;; the first one, the parts of a split word, the new words of
           ;; \"Tokenize new text\"), then the
           ;; partitioning-mode gap-fill on the surviving tokens.
           (doseq [{:token/keys [id layer begin end]} heads]
             (crud/insert! tx :tokens {:id id :text_id eid :token_layer_id layer
                                       :document_id (:document_id pre) :begin begin :end_ end}))
           (compensate-partition-layers! tx (into survivors heads) new-text-length)
           eid))]
    (cond-> result
      (and (:success result) @op) (assoc :op @op)
      (and (= 409 (:code result)) (= text-changed (:error result))) (assoc :text-changed true))))

(defn update-body
  "Change the textual content of `eid`, reindexing tokens to match.

  `new-body-or-ops` is either a string (the full new body, diffed
  against the current body and taken by the plain rule, see
  `plaid.algos.text/apply-plain-gaps`) or a vector of edit-ops in the shape
  that `plaid.algos.text/apply-text-edits` accepts, applied as sent. With
  `base`, the save applies only when it is the digest of the stored body
  (see `plaid.util.digest`), and answers 409 with `:text-changed` otherwise.
  With `tokenize-layer`, a token layer of the text, the text the save types
  gets the words of \"Tokenize new text\" on that layer, made after the old
  tokens are placed (see `plaid.algos.text/new-words`).

  The diff and the token arithmetic (`save-plan`) run BEFORE the write lock,
  on what the database holds then, which at 50,000 words takes seconds.
  Inside `BEGIN IMMEDIATE` the save checks that no operation has committed
  since that could change what it read (`written-since?`): one on its
  document, on its project's layers, or naming no project. If none has, it writes what it
  worked out. If one has, it works the save out again under the lock, as
  every save did before. Inside an atomic batch the lock is already held,
  so the save works it out there once.

  Writes, all inside the transaction:
    1. Tokens whose extent falls entirely inside a deletion range are
       deleted via plaid.sql.token/multi-delete! (audited cascade
       through spans/relations/vocab_links).
    2. Tokens whose extent shifts get their new extent.
    3. The texts row's body is updated.
    4. The tokens the save makes are inserted, and partitioning-mode
       token layers get gap-filled by
       plaid.sql.token/compensate-partition-layers! — the LAST step so
       it sees the final post-edit token positions.
  The audit rows and the document version bump come with them.

  Returns {:success true :extra <text-id> :op {:id :ts :document}}."
  ([db eid new-body-or-ops user-id] (update-body db eid new-body-or-ops user-id nil))
  ([db eid new-body-or-ops user-id base] (update-body db eid new-body-or-ops user-id base nil))
  ([db eid new-body-or-ops user-id base tokenize-layer]
   (save! db eid new-body-or-ops base tokenize-layer user-id "Update body of text ")))

(defn edit-body
  "Change the textual content of `eid` by `edits`, ops made at the caret
  (running code-point coordinates, each op's index in the body the ops
  before it left, in the shapes `update-body` takes). The ops are composed
  into their net change, each gap of it standing where it was made, and the
  tokens take it by the plain rule a whole-body save takes (see
  `plaid.algos.text/plain-edit-gaps` and `apply-plain-gaps`).

  With `base`, the edit applies only when it is the digest of the stored
  body, and answers 409 with `:text-changed` otherwise: the edit's places
  are places in that body. The core never moves them onto another. Without
  it the edit applies to whatever is stored, for a caller that holds the
  document's lock. Same operation type as `update-body`, so History and
  restore read it as a body save. Returns what `update-body` returns."
  [db eid {:keys [edits base tokenize-layer]} user-id]
  (save! db eid {:edits edits} base tokenize-layer user-id "Edit body of text "))

(defn reshape
  "What a body save wrote besides the body, for the apps to patch a read
  from: the extents of the tokens it moved, the token lists of the spans
  and vocabulary links it trimmed, and every row the cascade deleted, read
  from the audit rows of operation `op` (`{:id :ts :document}` as
  `update-body` answers it) and of the layer rules applied right after it in its
  transaction (see `plaid.sql.constraints.layer/finish!`). Ids are plain;
  extents are code points."
  [db op]
  (let [;; the operations right after it that apply layer rules: those
        ;; run in its transaction, before any other writer's
        after (when (:document op)
                (->> (psc/q db {:select [:id :op_type]
                                :from [:operations]
                                :where [:and [:= :document_id (:document op)] [:> :ts (:ts op)]]
                                :order-by [[:ts :asc]]
                                :limit 50})
                     (take-while #(= "layer/apply-constraints" (str (:op_type %))))
                     (map :id)))
        rows (psc/q db {:select [:target_table :target_id :change_type :post_image]
                        :from [:audit_writes]
                        :where [:in :op_id (into [(:id op)] after)]
                        :order-by [[:ts :asc] [:seq :asc]]})
        ;; the last image of each row, and whether it went
        last-of (reduce (fn [m {:keys [target_table target_id change_type post_image]}]
                          (assoc m [target_table target_id]
                                 {:deleted? (= "delete" change_type)
                                  :inserted? (or (= "insert" change_type)
                                                 (:inserted? (clojure.core/get m [target_table target_id])))
                                  :post (some-> post_image psc/read-json)}))
                        {}
                        rows)
        ordered (distinct (map (juxt :target_table :target_id) rows))
        of (fn [table] (filter #(= table (first %)) ordered))
        gone (fn [table] (vec (keep (fn [k] (when (:deleted? (last-of k)) (second k))) (of table))))
        live (fn [table f] (vec (keep (fn [k] (let [{:keys [deleted? inserted? post]} (last-of k)]
                                                (when (and (not deleted?) post)
                                                  (f (second k) (cond-> post inserted? (assoc ::inserted true))))))
                                      (of table))))
        get* (fn [m k] (if (contains? m k) (clojure.core/get m k) (clojure.core/get m (keyword k))))
        contains-key? (fn [m k] (or (contains? m k) (contains? m (keyword k))))]
    ;; a token the save made (a sentence over a line typed before the first
    ;; one) comes with its layer and text, for a read to take it in
    {:tokens (live "tokens" (fn [id p] (cond-> {:id id :begin (get* p "begin") :end (get* p "end_")}
                                         (::inserted p)
                                         (assoc :layer (get* p "token_layer_id") :text (get* p "text_id")))))
     ;; with the value, which a layer rule's remedy may have rewritten
     :spans (live "spans" (fn [id p] (when (or (some? (get* p "tokens")) (contains-key? p "value"))
                                       (cond-> {:id id}
                                         (some? (get* p "tokens")) (assoc :tokens (vec (get* p "tokens")))
                                         (contains-key? p "value") (assoc :value (some-> (get* p "value") psc/read-json))))))
     :vocab-links (live "vocab_links" (fn [id p] (when (some? (get* p "tokens")) {:id id :tokens (vec (get* p "tokens"))})))
     :deleted {:tokens (gone "tokens")
               :spans (gone "spans")
               :relations (gone "relations")
               :vocab-links (gone "vocab_links")}}))

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
     (let [token-ids (get-token-ids tx eid)]
       (when (seq token-ids)
         (token/multi-delete! tx token-ids))
       (metadata/delete-metadata! tx "text" eid)
       (crud/delete-by-id! tx :texts eid)
       eid))))

;; ============================================================
;; Metadata
;; ============================================================

(def ^:private metadata-fns
  (metadata/metadata-fns {:table :texts
                          :entity-type "text"
                          :noun "text"
                          :project-fn project-id
                          :doc-id-fn (fn [db eid] (:document_id (psc/fetch-by-id db :texts eid)))}))

(def ^{:doc "Replace all metadata for the text."
       :arglists '([db eid metadata-map user-id])}
  set-metadata (:set-metadata metadata-fns))

(def ^{:doc "Shallow-merge a metadata patch on the text: keys present set/overwrite,
  a null value deletes that key, omitted keys are untouched. See
  `plaid.sql.metadata/patch-metadata!`."
       :arglists '([db eid patch user-id])}
  patch-metadata (:patch-metadata metadata-fns))

(def ^{:doc "Remove all metadata from the text."
       :arglists '([db eid user-id])}
  delete-metadata (:delete-metadata metadata-fns))
