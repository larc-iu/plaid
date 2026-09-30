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

  The one exception is a body save's diff, which `update-body` works out
  before the transaction and writes only when no write that could change
  what it read has committed in between (see `update-body`).

  Cross-namespace dependencies: this file calls into
  `plaid.sql.token/multi-delete!` and `plaid.sql.token/compensate-partition-layers!`
  for cascade-deletion and partition gap-fill. plaid.sql.token doesn't
  require this namespace, but to avoid a load-time cycle if/when token
  ever needs to reach back, we resolve those two fns at call-site via
  `requiring-resolve`."
  (:require [clojure.set :as set]
            [plaid.algos.text :as ta]
            [plaid.sql.audit-write :as psaw]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.metadata :as metadata]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.util.codepoint :as cp]
            [plaid.util.digest :as digest]
            [plaid.util.storable-text :as storable])
  (:refer-clojure :exclude [get]))

(def attr-keys [:text/id
                :text/document
                :text/layer
                :text/body])

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

  `:text/id` names the new text's id (a client's UUIDv7), else the server
  mints one.

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
      ;; Body-shape validation inside the body (task #47) so a non-string
      ;; body surfaces as {:success false :code 400}. `body` is the raw
      ;; caller input; `body-str` is the validated string used for INSERT.
      (when-not (or (nil? body) (string? body))
        (throw (ex-info "Text body must be a string." {:body body :code 400})))
      (storable/assert-storable! "Text body" body-str)
      (psc/claim-ids! tx :texts "text" [(:text/id attrs)])
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
          (crud/insert! tx :texts
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
  `{:edits ops}`, ops from the caret (see `edit-body`)."
  [db eid change base]
  (when-let [text-row (psc/fetch-by-id db :texts eid)]
    (when (and base (not= base (digest/text-digest (:body text-row))))
      (throw (ex-info text-changed {:code 409 :id eid :text-changed true})))
    (let [old-body (:body text-row)
          edits (when (map? change) (vec (:edits change)))
          new-body-or-ops (if (map? change) edits change)
          text-map (row->text text-row)
          token-rows (psc/q db {:select [:*]
                                :from [:tokens]
                                :where [:= :text_id eid]})
          tokens (mapv row->token token-rows)            ; code-point offsets
          ;; A diffed body gets each edit moved to where it cuts the
          ;; fewest tokens when it could stand in several places for the
          ;; same result (see ta/slide-to-tokens), its deletes snapped to
          ;; token boundaries where the edit script left an equivalent
          ;; choice open (see ta/normalize-deletes), each changed stretch
          ;; aligned word by word where the diff kept a letter of a
          ;; deleted word in place of the respelled word's own (see
          ;; ta/align-to-words), and then each delete with an insert
          ;; beside it becomes one replace op, so a token covering the
          ;; changed letters keeps the new ones (see ta/pair-replacements), and the
          ;; pieces of a word replaced outright become one replace of it, so its
          ;; tokens move onto the new word (see ta/fold-whole-words).
          ;; The pairing comes second because normalize-deletes reads only
          ;; deletes and inserts, and it must see where the deletes end up.
          ;; Explicit client ops are applied as sent. The slide is told
          ;; which layers are partitions, where an insert at a boundary
          ;; goes into the token that ends there, and the fold which
          ;; layers hold words: those that forbid overlap, are no
          ;; partition and nest under another layer. In a script without
          ;; spaces a sentence, a UMR node or a time-alignment segment (no
          ;; parent) over several words looks like a word.
          layer-rows (when (and (or (string? new-body-or-ops) edits) (seq tokens))
                       (psc/q db {:select [:id :overlap_mode :parent_token_layer_id :config]
                                  :from [:token_layers]
                                  :where [:= :text_layer_id (:text_layer_id text-row)]}))
          partitioning (into #{} (comp (filter #(= "partitioning" (:overlap_mode %))) (map :id)) layer-rows)
          word-layers (into #{}
                            (comp (filter #(and (= "non-overlapping" (:overlap_mode %))
                                                (some? (:parent_token_layer_id %))))
                                  (map :id))
                            layer-rows)
          ;; A layer whose config sets `plainEdits` (igt's) takes the edit
          ;; the plain way (see ta/apply-plain-gaps), and so do the layers
          ;; nested under it at any depth (another app's syntactic words or
          ;; nodes on the same words), which then keep to its tokens, and the
          ;; partitions, which stay on its tokens' edges. Its own word layers
          ;; decide where typed text goes. The other layers take the edit by
          ;; the rules above and below, worked out over every token, and keep
          ;; only their own tokens' outcome.
          declared (into #{}
                         (comp (filter #(true? (some-> (:config %) psc/parse-config (get-in ["plaid" "plainEdits"]))))
                               (map :id))
                         layer-rows)
          parent-of (into {} (map (juxt :id :parent_token_layer_id)) layer-rows)
          plain (into #{}
                      (filter (fn [id] (loop [id id seen #{}]
                                         (cond (nil? id) false
                                               (declared id) true
                                               (seen id) false
                                               :else (recur (parent-of id) (conj seen id))))))
                      (keys parent-of))
          ;; With no plain word layer (a node layer beside words on the other
          ;; rules) the words and the partitions over them take the other
          ;; rules, and the plain tokens follow the words at their edges
          ;; (see ta/follow-word-edges), so a node never differs from its word.
          plain-words (set/intersection word-layers plain)
          deciders (let [ws (set/intersection word-layers declared)] (if (seq ws) ws word-layers))
          plain? (fn [{:token/keys [layer]}] (or (contains? plain layer)
                                                 (and (seq plain-words) (contains? partitioning layer))))
          ;; A layer that also sets `splitOnSpace` (ud's words) has a space
          ;; typed inside a word split it. Declared on a layer the text's
          ;; words share with another app, it holds for the whole text.
          split-on-space (some #(true? (some-> (:config %) psc/parse-config (get-in ["plaid" "splitOnSpace"])))
                               layer-rows)
          plain-opts {:split-on-space (boolean split-on-space)}
          plain-tokens (when (seq plain) (filterv plain? tokens))
          plain-result (when (seq plain)
                         (cond
                           edits (ta/plain-edits old-body plain-tokens edits partitioning deciders plain-opts)
                           (string? new-body-or-ops) (ta/plain-body old-body new-body-or-ops plain-tokens partitioning deciders plain-opts)
                           :else nil))
          tokens-rest (if plain-result (filterv (complement plain?) tokens) tokens)
          ops (cond
                (and plain-result (empty? tokens-rest)) nil
                edits nil
                (string? new-body-or-ops)
                (-> (ta/diff old-body new-body-or-ops)
                    (ta/slide-to-tokens old-body tokens partitioning)
                    (ta/normalize-deletes old-body tokens)
                    (ta/align-to-words old-body tokens word-layers)
                    (ta/pair-replacements old-body tokens)
                    (ta/fold-whole-words old-body tokens word-layers))
                :else (vec new-body-or-ops))
          indexed-old (reduce (fn [m t] (assoc m (:token/id t) t)) {} tokens)
          ;; A diffed body's tokens are then moved off a space a delete
          ;; left them on (see ta/keep-edges-off-spaces): no place for
          ;; one delete keeps two UMR nodes pulling opposite ways off it.
          ;; Edits from the caret go through the same steps after their
          ;; own placement (see ta/apply-edits).
          rest-result
          (cond
            (and plain-result (empty? tokens-rest)) nil
            edits (ta/apply-edits old-body tokens edits {:partitioning partitioning
                                                         :word-layers word-layers})
            (string? new-body-or-ops) (as-> (ta/apply-text-edits ops text-map tokens) r
                                        (ta/keep-edges-off-spaces old-body tokens r partitioning))
            :else (ta/apply-text-edits ops text-map tokens))
          {new-text :text new-tokens :tokens deleted-ids :deleted}
          (if plain-result
            (let [rest-ids (into #{} (map :token/id) tokens-rest)]
              (when (and rest-result (not= (:text/body (:text rest-result)) (:text/body (:text plain-result))))
                (throw (ex-info "The new body could not be applied." {:code 500 :id eid})))
              {:text (:text plain-result)
               :tokens (into (:tokens (if (and (empty? plain-words) rest-result)
                                        (ta/follow-word-edges tokens plain-result rest-result
                                                              #(contains? word-layers (:token/layer %))
                                                              (into #{} (map :token/id) plain-tokens))
                                        plain-result))
                             (filter #(rest-ids (:token/id %))) (:tokens rest-result))
               :deleted (into (vec (:deleted plain-result)) (filter rest-ids) (:deleted rest-result))})
            rest-result)
          new-body (:text/body new-text)
          ;; The steps above only move edits between equivalent places, so
          ;; a diffed body comes out as sent, and edits as they make the body
          ;; applied in turn. Should one of them ever get that wrong, the
          ;; save fails rather than store a body nobody typed.
          _ (when (or (and (string? new-body-or-ops) (not= new-body new-body-or-ops))
                      (and edits (not= new-body (ta/edit-ops-body edits old-body))))
              (throw (ex-info "The new body could not be applied." {:code 500 :id eid})))
          ;; Checked on the result, so explicit ops' inserted text is
          ;; covered as well as a whole new body.
          _ (storable/assert-storable! "Text body" new-body)
          deleted-set (set deleted-ids)]
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
       :survivors (into [] (remove #(contains? deleted-set (:token/id %))) new-tokens)})))

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

(defn- save!
  "The write of `update-body` and `edit-body`: `change` as `save-plan` takes
  it, worked out ahead of the write lock and again under it when a write
  that could change what it read has committed meanwhile (see
  `update-body`). The answer carries the operation's id and ts as `:op`, so
  the route can read what it wrote (see `reshape`)."
  [db eid change base user-id description]
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
                  (when-let [plan (try (save-plan db eid change base)
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
         ;; Validation inside the body (task #47).
         (when-not valid?
           (throw (ex-info (if (map? change)
                             "Text edits must be a list of edit operations."
                             "Text body must be a string.")
                           {:body change :code 400})))
         (when (nil? pre)
           (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
         (vreset! op (assoc (select-keys psaw/*op* [:id :ts]) :document (:document_id pre)))
         (let [{:keys [new-body new-text-length deleted-ids survivor-updates survivors]}
               (or (when (and ahead (not (written-since? tx project (:document_id pre) (:ts ahead) (:id psaw/*op*))))
                     (:plan ahead))
                   (save-plan tx eid change base)
                   (throw (ex-info (psc/err-msg-not-found "Text" eid) {:code 404 :id eid})))
               ;; Use requiring-resolve to keep this file decoupled from
               ;; plaid.sql.token at load time. (token.clj does not require
               ;; text.clj today, but if it ever did, deferring resolution
               ;; here keeps the cycle from biting.)
               multi-delete! (requiring-resolve 'plaid.sql.token/multi-delete!)
               compensate-partition-layers!
               (requiring-resolve 'plaid.sql.token/compensate-partition-layers!)]
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
           ;; 4. Partitioning-mode gap-fill on the surviving tokens.
           (compensate-partition-layers! tx survivors new-text-length)
           eid))]
    (cond-> result
      (and (:success result) @op) (assoc :op @op)
      (and (= 409 (:code result)) (= text-changed (:error result))) (assoc :text-changed true))))

(defn update-body
  "Change the textual content of `eid`, reindexing tokens to match.

  `new-body-or-ops` is either a string (the full new body — diffed
  against the current body) or a vector of edit-ops in the shape that
  `plaid.algos.text/apply-text-edits` accepts, applied as sent. With
  `base`, the save applies only when it is the digest of the stored body
  (see `plaid.util.digest`), and answers 409 with `:text-changed` otherwise.

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
    4. Partitioning-mode token layers get gap-filled by
       plaid.sql.token/compensate-partition-layers! — the LAST step so
       it sees the final post-edit token positions.
  The audit rows and the document version bump come with them.

  Returns {:success true :extra <text-id> :op {:id :ts :document}}."
  ([db eid new-body-or-ops user-id] (update-body db eid new-body-or-ops user-id nil))
  ([db eid new-body-or-ops user-id base]
   (save! db eid new-body-or-ops base user-id "Update body of text ")))

(defn edit-body
  "Change the textual content of `eid` by `edits`, ops made at the caret
  (running code-point coordinates, each op's index in the body the ops
  before it left, in the shapes `update-body` takes). The ops are composed
  into their net change, and each pure insert or delete stands where it was
  made, while a stretch both taken and typed over is read as a whole-body
  save reads that change (see `plaid.algos.text/apply-edits`). The tokens
  then follow the rules a whole-body save follows.

  With `base`, the edit applies only when it is the digest of the stored
  body, and answers 409 with `:text-changed` otherwise: the edit's places
  are places in that body. The core never moves them onto another. Without
  it the edit applies to whatever is stored, for a caller that holds the
  document's lock. Same operation type as `update-body`, so History and
  restore read it as a body save. Returns what `update-body` returns."
  [db eid {:keys [edits base]} user-id]
  (save! db eid {:edits edits} base user-id "Edit body of text "))

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
                                  :post (some-> post_image psc/read-json)}))
                        {}
                        rows)
        ordered (distinct (map (juxt :target_table :target_id) rows))
        of (fn [table] (filter #(= table (first %)) ordered))
        gone (fn [table] (vec (keep (fn [k] (when (:deleted? (last-of k)) (second k))) (of table))))
        live (fn [table f] (vec (keep (fn [k] (let [{:keys [deleted? post]} (last-of k)]
                                                (when (and (not deleted?) post) (f (second k) post))))
                                      (of table))))
        get* (fn [m k] (if (contains? m k) (clojure.core/get m k) (clojure.core/get m (keyword k))))
        contains-key? (fn [m k] (or (contains? m k) (contains? m (keyword k))))]
    {:tokens (live "tokens" (fn [id p] {:id id :begin (get* p "begin") :end (get* p "end_")}))
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
     (let [token-ids (get-token-ids tx eid)
           multi-delete! (requiring-resolve 'plaid.sql.token/multi-delete!)]
       (when (seq token-ids)
         (multi-delete! tx token-ids))
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
