(ns plaid.olap.replayer-test
  "Unit tests for plaid.olap.replayer.

  Hand-rolled audit-row sequences are fed into `audit-row->tx-op` and
  `apply-op!` to verify:
    - each `change_type` (`insert`, `update`, `delete`, `doc-version-bump`)
      is translated to the right XTDB tx-op shape,
    - every OLTP entity table has a corresponding replayer spec (column
      renames + namespace) that round-trips an audit post-image into a
      well-shaped OLAP doc,
    - junction-fold keys (`:tokens`, `:metadata`, `:readers`, etc.) are
      preserved through the round-trip — these are the unqualified-key
      contract the OLAP read API depends on,
    - malformed input throws `ex-info` with the right `:type` for the
      tailer's stall logic, and
    - `apply-op!` writes the cursor doc atomically with the op's
      tx-ops (one xt/submit-tx)."
  (:require [clojure.data.json :as json]
            [clojure.test :refer :all]
            [plaid.olap.core :as olap-core]
            [plaid.olap.replayer :as replayer]
            [xtdb.api :as xt]
            [xtdb.node :as xtn])
  (:import (java.time Instant)
           (java.util Date UUID)))

;; ============================================================
;; In-memory node fixture (no defstate, no disk)
;; ============================================================

(def ^:dynamic ^:private *node* nil)

(defn- with-fresh-node
  "Spin up a fresh in-memory XTDB node for every deftest. No persistent
   storage — the replayer doesn't need it; cursor + entity docs live in
   the same in-memory node and we throw the whole thing away after."
  [f]
  (with-open [node (xtn/start-node {})]
    (binding [*node* node]
      (f))))

(use-fixtures :each with-fresh-node)

;; ============================================================
;; Test data helpers
;; ============================================================

(defn- uuid [] (UUID/randomUUID))

(defn- iso [^Instant inst] (.toString inst))

(defn- audit-row
  "Build an audit-row map in the shape the tailer hands to the replayer
   — i.e. column-keyed (snake_case), with `post_image` as a JSON string.
   Defaults `:change_type` to `:insert` and `:seq` to 0."
  [target-table target-id post & {:keys [change-type pre seq]
                                  :or {change-type :insert seq 0}}]
  {:target_table target-table
   :target_id (str target-id)
   :change_type (name change-type)
   :pre_image (some-> pre json/write-str)
   :post_image (some-> post json/write-str)
   :seq seq})

(defn- op-record
  ([] (op-record (Instant/now)))
  ([^Instant ts]
   {:op/id (uuid)
    :op/ts (Date/from ts)
    :op/op-type :test/op}))

;; ============================================================
;; audit-row->tx-op — table specs + change_type matrix
;; ============================================================

(deftest insert-row->put-docs-for-documents
  (let [doc-id (uuid)
        post {:id (str doc-id)
              :name "Doc 1"
              :project_id (str (uuid))
              :version 1
              :created_at "2026-05-28T09:00:00Z"
              :modified_at "2026-05-28T09:00:00Z"}
        [op-kw tbl-kw doc] (replayer/audit-row->tx-op (audit-row "documents" doc-id post))]
    (is (= :put-docs op-kw))
    (is (= :olap/documents tbl-kw))
    (is (= doc-id (:xt/id doc)))
    (is (= "Doc 1" (:document/name doc)))
    (is (= "2026-05-28T09:00:00Z" (:document/time-created doc)))
    (is (= "2026-05-28T09:00:00Z" (:document/time-modified doc)))
    (is (= 1 (:document/version doc)))
    (is (uuid? (:document/project doc))
        "FK *_id columns coerce back to UUID after JSON round-trip")))

(deftest update-row->patch-docs-for-spans
  ;; :update replays as :patch-docs (key-merge) — NOT :put-docs — so an
  ;; update carrying only the spans-table columns (e.g. a value change)
  ;; can't strip the :tokens / :metadata junction state folded by an
  ;; earlier op. See `audit-row->tx-op`'s docstring.
  (let [span-id (uuid)
        layer-id (uuid)
        doc-id (uuid)
        post {:id (str span-id)
              :span_layer_id (str layer-id)
              :document_id (str doc-id)
              :value "GREETING"}
        [op-kw tbl-kw doc] (replayer/audit-row->tx-op
                            (audit-row "spans" span-id post :change-type :update))]
    (is (= :patch-docs op-kw))
    (is (= :olap/spans tbl-kw))
    (is (= span-id (:xt/id doc)))
    (is (= "GREETING" (:span/value doc)))
    (is (= layer-id (:span/layer doc)))
    (is (= doc-id (:span/document doc)))))

(deftest delete-row->delete-docs
  (let [span-id (uuid)
        ;; A delete row carries no post-image (pre-image is optional and
        ;; ignored by the replayer — XTDB v2's :delete-docs closes out
        ;; the entity's validity at the tx system-time).
        row (audit-row "spans" span-id nil :change-type :delete)
        [op-kw tbl-kw id] (replayer/audit-row->tx-op row)]
    (is (= :delete-docs op-kw))
    (is (= :olap/spans tbl-kw))
    (is (= span-id id))))

(deftest doc-version-bump-row->patch-docs
  (let [doc-id (uuid)
        post {:id (str doc-id)
              :name "Doc 1"
              :project_id (str (uuid))
              :version 2
              :created_at "2026-05-28T09:00:00Z"
              :modified_at "2026-05-28T09:01:00Z"}
        [op-kw tbl-kw doc] (replayer/audit-row->tx-op
                            (audit-row "documents" doc-id post
                                       :change-type :doc-version-bump))]
    (is (= :patch-docs op-kw)
        "Version bump replays as a patch-docs (key-merge) so it can't strip
         :metadata folded by an earlier op carrying the doc")
    (is (= :olap/documents tbl-kw))
    (is (= 2 (:document/version doc)))))

(deftest each-entity-table-has-a-spec
  ;; One smoke row per known target_table — exercises the table->spec
  ;; map. Schema-drift canary: when migrations add a new table, this
  ;; test stays green until you forget to register it in the replayer.
  (let [tables ["users" "projects" "documents" "text_layers" "token_layers"
                "span_layers" "relation_layers" "texts" "tokens" "spans"
                "relations" "vocab_layers" "vocab_items" "vocab_links"]]
    (doseq [t tables]
      (let [tid (uuid)
            ;; Minimum-viable post-image — every table has at least an `id`.
            row (audit-row t tid {:id (str tid)})
            [op tbl doc] (replayer/audit-row->tx-op row)]
        (is (= :put-docs op) (str "table: " t))
        (is (= (keyword "olap" t) tbl))
        (is (= tid (:xt/id doc)))))))

;; ============================================================
;; Per-table rename / FK-coercion spot checks
;; ============================================================

(deftest tokens-respect-end-and-precedence-renames
  (let [tok-id (uuid)
        text-id (uuid)
        layer-id (uuid)
        doc-id (uuid)
        post {:id (str tok-id)
              :text_id (str text-id)
              :token_layer_id (str layer-id)
              :document_id (str doc-id)
              :begin 0
              :end_ 5
              :precedence 10}
        [_ _ doc] (replayer/audit-row->tx-op (audit-row "tokens" tok-id post))]
    (is (= text-id (:token/text doc)))
    (is (= layer-id (:token/layer doc)))
    (is (= doc-id (:token/document doc)))
    (is (= 0 (:token/begin doc)))
    (is (= 5 (:token/end doc)) ":end_ column → :token/end attr")
    (is (= 10 (:token/precedence doc)))))

(deftest relations-rename-source-and-target
  (let [rel-id (uuid)
        layer-id (uuid)
        doc-id (uuid)
        src (uuid)
        tgt (uuid)
        post {:id (str rel-id)
              :relation_layer_id (str layer-id)
              :document_id (str doc-id)
              :source_span_id (str src)
              :target_span_id (str tgt)
              :value "agent"}
        [_ _ doc] (replayer/audit-row->tx-op (audit-row "relations" rel-id post))]
    (is (= layer-id (:relation/layer doc)))
    (is (= src (:relation/source doc)))
    (is (= tgt (:relation/target doc)))
    (is (= "agent" (:relation/value doc)))))

;; ============================================================
;; Junction-key folding round-trip
;; ============================================================

(deftest span-tokens-junction-preserved
  ;; The span's `:tokens` list is folded into the parent's post-image
  ;; unqualified. The replayer must preserve the key as-is AND coerce
  ;; the stringified UUIDs back to UUIDs so OLAP reads filtering by
  ;; token-id work.
  (let [span-id (uuid)
        t1 (uuid) t2 (uuid)
        post {:id (str span-id)
              :span_layer_id (str (uuid))
              :document_id (str (uuid))
              :value "VERB"
              :tokens [(str t1) (str t2)]}
        [_ _ doc] (replayer/audit-row->tx-op
                   (audit-row "spans" span-id post :change-type :update))]
    (is (contains? doc :tokens) "junction key stays unqualified")
    (is (= [t1 t2] (:tokens doc)) "stringified UUIDs are coerced back to UUID")))

(deftest entity-metadata-folds-into-parent-as-json-string
  ;; entity-metadata is special: the JSON map is stored as an opaque
  ;; STRING on the OLAP doc to dodge XTDB v2's nested-key lowercasing.
  ;; (see xtdb-nil-stripping memo + decode-metadata on the read side)
  (let [tok-id (uuid)
        meta {"GlossKey" "value"}
        post {:id (str tok-id)
              :text_id (str (uuid))
              :token_layer_id (str (uuid))
              :document_id (str (uuid))
              :begin 0
              :end_ 5
              :metadata meta}
        [_ _ doc] (replayer/audit-row->tx-op
                   (audit-row "tokens" tok-id post :change-type :update))]
    (is (string? (:metadata doc))
        ":metadata is serialized to a JSON string for opaque storage")
    (is (= meta (json/read-str (:metadata doc)))
        "round-trips back to the original map")))

(deftest project-acl-junctions-preserved
  ;; project_users state is folded into the parent projects row under
  ;; unqualified :readers / :writers / :maintainers, and project_vocabs
  ;; under :vocabs. Each must round-trip with UUIDs intact.
  (let [proj-id (uuid)
        r1 (uuid) w1 (uuid) m1 (uuid) v1 (uuid)
        post {:id (str proj-id)
              :name "P1"
              :config "{}"
              :readers [(str r1)]
              :writers [(str w1)]
              :maintainers [(str m1)]
              :vocabs [(str v1)]}
        [_ _ doc] (replayer/audit-row->tx-op
                   (audit-row "projects" proj-id post :change-type :update))]
    (is (= [r1] (:readers doc)))
    (is (= [w1] (:writers doc)))
    (is (= [m1] (:maintainers doc)))
    (is (= [v1] (:vocabs doc)))
    (is (= "P1" (:project/name doc)))))

(deftest known-junction-keys-constant-preserved
  ;; If anyone adds a junction key to the synthetic-image emit sites
  ;; without updating KNOWN_JUNCTION_KEYS, the new key won't be
  ;; preserved on round-trip. This test pins the contract.
  (is (= #{:tokens :metadata :readers :writers :maintainers :vocabs}
         replayer/KNOWN_JUNCTION_KEYS))
  ;; Each must pass through audit-row->tx-op without re-namespacing.
  (doseq [k replayer/KNOWN_JUNCTION_KEYS]
    (let [tid (uuid)
          v (case k
              :metadata {"x" 1}
              [(str (uuid))])
          post {:id (str tid) k v}
          [_ _ doc] (replayer/audit-row->tx-op (audit-row "spans" tid post))]
      (is (contains? doc k) (str "junction key preserved unqualified: " k)))))

;; ============================================================
;; Malformed-row handling
;; ============================================================

(deftest unknown-table-throws-malformed
  (try
    (replayer/audit-row->tx-op (audit-row "not_a_real_table" (uuid) {:id (str (uuid))}))
    (is false "should have thrown")
    (catch clojure.lang.ExceptionInfo e
      (is (= :replayer/malformed-row (:type (ex-data e)))))))

(deftest unknown-change-type-throws-malformed
  (try
    (replayer/audit-row->tx-op
     (audit-row "spans" (uuid) {:id (str (uuid))} :change-type :bogus))
    (is false "should have thrown")
    (catch clojure.lang.ExceptionInfo e
      (is (= :replayer/malformed-row (:type (ex-data e)))))))

(deftest missing-post-image-on-insert-throws
  ;; Insert/update/version-bump rows must carry a post-image. nil/empty
  ;; would silently put-docs an id-only stub, breaking later reads.
  (try
    (replayer/audit-row->tx-op
     (-> (audit-row "spans" (uuid) nil :change-type :insert)))
    (is false "should have thrown")
    (catch clojure.lang.ExceptionInfo e
      (is (= :replayer/malformed-row (:type (ex-data e)))))))

(deftest missing-required-columns-throws
  (try
    (replayer/audit-row->tx-op {:target_table nil
                                :target_id nil
                                :change_type "insert"})
    (is false "should have thrown")
    (catch clojure.lang.ExceptionInfo e
      (is (= :replayer/malformed-row (:type (ex-data e)))))))

(deftest empty-string-change-type-rejected-as-missing-column
  ;; Pre-fix the empty string slipped past the nil? check, then through
  ;; `(keyword "")` (a degenerate but valid keyword), then to the
  ;; `:else` arm as "Unknown change_type" — technically rejected, but
  ;; the operator-facing error pointed at the wrong root cause.
  (try
    (replayer/audit-row->tx-op {:target_table "spans"
                                :target_id (str (uuid))
                                :change_type ""})
    (is false "should have thrown")
    (catch clojure.lang.ExceptionInfo e
      (is (= :replayer/malformed-row (:type (ex-data e))))
      (is (re-find #"missing required column" (ex-message e))
          "the error must surface the real cause: missing column, not unknown change_type"))))

(deftest malformed-post-image-json-throws-via-parse-image
  (try
    (replayer/parse-image "not-valid-json{{{{")
    (is false "should have thrown")
    (catch clojure.lang.ExceptionInfo e
      (is (= :replayer/malformed-row (:type (ex-data e)))))))

(deftest parse-image-handles-nil-and-empty
  (is (nil? (replayer/parse-image nil)))
  (is (nil? (replayer/parse-image ""))))

(deftest blank-target-id-is-rejected-as-malformed
  ;; A corrupt audit row with `target_id = ""` or `"   "` would otherwise
  ;; degrade to `:xt/id ""` and silently create a phantom doc no real
  ;; reader can address. Reject up-front so the tailer stalls clearly.
  (doseq [bad ["" "   " "\t\n"]]
    (try
      (replayer/audit-row->tx-op
       (assoc (audit-row "spans" (uuid) {:id (str (uuid))})
              :target_id bad))
      (is false (str "blank target_id should have thrown: " (pr-str bad)))
      (catch clojure.lang.ExceptionInfo e
        (is (= :replayer/malformed-row (:type (ex-data e)))
            (str "blank target_id type: " (pr-str bad)))
        (is (re-find #"blank" (ex-message e))
            "error message points at the blank-id root cause")))))

(deftest non-uuid-target-id-passes-through-as-string
  ;; `users.id` is a TEXT primary key (the user's username/email), so
  ;; the replayer must accept non-UUID strings without stalling the
  ;; tailer. UUID-shaped strings still coerce; arbitrary strings are
  ;; preserved as-is on `:xt/id` — XTDB v2 supports string ids natively.
  (let [[op-kw _tbl-kw doc] (replayer/audit-row->tx-op
                             (assoc (audit-row "users" "user@example.com"
                                               {:id "user@example.com"
                                                :username "user@example.com"
                                                :password_hash "x"
                                                :password_changes 0
                                                :is_admin 0})
                                    :target_id "user@example.com"))]
    (is (= :put-docs op-kw))
    (is (= "user@example.com" (:xt/id doc))
        "non-UUID string target_id is preserved as-is on :xt/id"))
  ;; Non-string / non-UUID values still surface as :replayer/malformed-row.
  (try
    (replayer/audit-row->tx-op
     (assoc (audit-row "users" "x" {:id "x"})
            :target_id 12345))
    (is false "should have thrown")
    (catch clojure.lang.ExceptionInfo e
      (is (= :replayer/malformed-row (:type (ex-data e)))))))

;; ============================================================
;; apply-op! — atomic apply + cursor advance
;; ============================================================

(deftest apply-op-writes-entity-and-cursor-atomically
  ;; Single xt/submit-tx must carry both the entity put-docs and the
  ;; cursor doc. After apply, the cursor reads the op's id/ts/seq and a
  ;; snapshot at op.ts returns the entity.
  (let [span-id (uuid)
        post {:id (str span-id)
              :span_layer_id (str (uuid))
              :document_id (str (uuid))
              :value "X"}
        ts (Instant/parse "2026-05-28T09:00:00Z")
        op (op-record ts)
        rows [(audit-row "spans" span-id post)]]
    (replayer/apply-op! *node* op rows)
    (let [cursor (olap-core/cursor-read *node*)]
      (is (some? cursor))
      (is (= (:op/id op) (:last-op-id cursor)))
      (is (= 0 (:last-seq cursor)))
      (is (= :running (:tailer-status cursor))))
    ;; The cursor is :olap/meta — and the entity is in :olap/spans.
    ;; Both were written in the same submit-tx, so a snapshot at op.ts
    ;; sees them together. We use XTQL with xt/template here so the
    ;; namespaced `:span/value` attr is addressed directly (storage
    ;; columns lowercase-and-prefix as `span$value`; a bare SQL
    ;; `SELECT value` doesn't pick it up).
    (let [rows (xt/q *node*
                     (xt/template
                      (-> (from :olap/spans [{:xt/id id} span/value])
                          (where (= id ~span-id))))
                     {:snapshot-time ts})]
      (is (= 1 (count rows)))
      (is (= "X" (:span/value (first rows)))))))

(deftest apply-op-with-multiple-rows-advances-cursor-to-last-seq
  ;; Two audit rows in one op — the cursor must land on the highest
  ;; :seq among them.
  (let [s1 (uuid) s2 (uuid)
        ts (Instant/parse "2026-05-28T09:00:01Z")
        op (op-record ts)
        rows [(audit-row "spans" s1 {:id (str s1)
                                     :span_layer_id (str (uuid))
                                     :document_id (str (uuid))
                                     :value "A"} :seq 0)
              (audit-row "spans" s2 {:id (str s2)
                                     :span_layer_id (str (uuid))
                                     :document_id (str (uuid))
                                     :value "B"} :seq 1)]]
    (replayer/apply-op! *node* op rows)
    (is (= 1 (:last-seq (olap-core/cursor-read *node*))))
    (is (= 2 (count (xt/q *node*
                          '(from :olap/spans [{:xt/id id}])
                          {:snapshot-time ts}))))))

(deftest apply-op-merges-metadata-fold-with-doc-version-bump
  ;; An OLTP metadata PUT on a document emits TWO audit rows in one op:
  ;;   seq 0: emit-parent-audit! :update on documents, post-image
  ;;          carries :metadata (folded into the parent's row)
  ;;   seq 1: bump-document-version! :doc-version-bump on documents,
  ;;          post-image is the bare doc row (NO :metadata key)
  ;; Applied as two separate put-docs at the same :system-time, XTDB v2's
  ;; put-docs (a REPLACEMENT, not a merge) lets seq 1 strip :metadata
  ;; folded by seq 0 — the OLAP doc would have NO :metadata. The replayer
  ;; merges same-id rows within one op so :metadata survives.
  (let [doc-id (uuid)
        prj-id (uuid)
        meta {"GlossKey" "value"}
        ts (Instant/parse "2026-05-28T09:30:00Z")
        op (op-record ts)
        rows [(audit-row "documents" doc-id
                         {:id (str doc-id)
                          :name "Doc 1"
                          :project_id (str prj-id)
                          :version 1
                          :created_at "2026-05-28T09:00:00Z"
                          :modified_at "2026-05-28T09:00:00Z"
                          :metadata meta}
                         :change-type :update
                         :seq 0)
              ;; Doc-version-bump row carries the bare doc — no :metadata.
              (audit-row "documents" doc-id
                         {:id (str doc-id)
                          :name "Doc 1"
                          :project_id (str prj-id)
                          :version 2
                          :created_at "2026-05-28T09:00:00Z"
                          :modified_at "2026-05-28T09:30:00Z"}
                         :change-type :doc-version-bump
                         :seq 1)]]
    (replayer/apply-op! *node* op rows)
    (let [doc (first (xt/q *node*
                           (xt/template
                            (-> (from :olap/documents [{:xt/id id}
                                                       document/name
                                                       document/version
                                                       metadata])
                                (where (= id ~doc-id))))
                           {:snapshot-time ts}))]
      (is (some? doc))
      (is (= 2 (:document/version doc))
          "later-seq doc-version-bump wins for :document/version")
      (is (= "Doc 1" (:document/name doc)))
      (is (string? (:metadata doc))
          ":metadata folded by earlier-seq :update survives the version bump")
      (is (= meta (json/read-str (:metadata doc)))
          ":metadata payload round-trips through the merge"))))

(deftest apply-op-merge-put-after-delete-recreates-entity
  ;; Inverse of `apply-op-merge-delete-wins-over-prior-puts`: when the
  ;; last tx-op for a same-id group is a `:put-docs` AFTER a
  ;; `:delete-docs`, the recreated entity wins. This matches the OLTP
  ;; semantics of a delete-then-recreate within a single op — the user
  ;; sees the new row, not nothing. Pins the docstring's positional
  ;; (not sticky) delete behaviour.
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T09:32:00Z")
        op (op-record ts)
        rows [(audit-row "documents" doc-id nil
                         :change-type :delete
                         :seq 0)
              (audit-row "documents" doc-id
                         {:id (str doc-id)
                          :name "recreated"
                          :project_id (str prj-id)
                          :version 1
                          :created_at "2026-05-28T09:30:00Z"
                          :modified_at "2026-05-28T09:30:00Z"}
                         :change-type :update
                         :seq 1)]]
    (replayer/apply-op! *node* op rows)
    (let [doc (first (xt/q *node*
                           (xt/template
                            (-> (from :olap/documents [{:xt/id id}
                                                       document/name])
                                (where (= id ~doc-id))))
                           {:snapshot-time ts}))]
      (is (some? doc) "entity exists after delete-then-put — the later put wins")
      (is (= "recreated" (:document/name doc))
          "the post-delete put is the merged state, not the pre-delete one"))))

(deftest apply-op-merge-update-after-delete-does-not-resurrect-stale-keys
  ;; Regression: a delete-then-UPDATE (patch) of the same id WITHIN one op
  ;; must NOT key-merge the update into the PRE-delete committed version —
  ;; that would resurrect junction state the delete dropped. Earlier op
  ;; (op1) commits a span carrying :tokens; a later op (op2) deletes it
  ;; then re-updates it WITHOUT :tokens. The recreated span must have the
  ;; new value and NO leftover :tokens.
  (let [span-id (uuid)
        tok (uuid)
        slayer (str (uuid))
        doc (str (uuid))
        t1 (Instant/parse "2026-05-28T09:40:00Z")
        t2 (Instant/parse "2026-05-28T09:40:01Z")
        op1 (op-record t1)
        op2 (op-record t2)]
    ;; op1: span exists with a folded token
    (replayer/apply-op! *node* op1
                        [(audit-row "spans" span-id
                                    {:id (str span-id)
                                     :span_layer_id slayer
                                     :document_id doc
                                     :value "A"
                                     :tokens [(str tok)]}
                                    :change-type :insert
                                    :seq 0)])
    ;; op2: delete then update (no tokens in the update image)
    (replayer/apply-op! *node* op2
                        [(audit-row "spans" span-id nil
                                    :change-type :delete
                                    :seq 0)
                         (audit-row "spans" span-id
                                    {:id (str span-id)
                                     :span_layer_id slayer
                                     :document_id doc
                                     :value "B"}
                                    :change-type :update
                                    :seq 1)])
    ;; `value` is stored namespaced (`:span/value`); `:tokens` is the
    ;; unqualified junction key. XTQL returns each binding under its
    ;; logic-var name, so `v`→`:v` and `tks`→`:tks`. A map-binding of an
    ;; ABSENT attr does not filter the row — it just leaves the var nil —
    ;; so `(:tks span)` being nil is the proof that :tokens didn't leak.
    (let [span (first (xt/q *node*
                            (xt/template
                             (-> (from :olap/spans [{:xt/id id :span/value v :tokens tks}])
                                 (where (= id ~span-id))))
                            {:snapshot-time t2}))]
      (is (some? span) "recreated span exists at t2")
      (is (= "B" (:v span)) "shows the post-delete update value")
      (is (nil? (:tks span))
          "pre-delete :tokens must NOT leak through the delete-then-update"))))

(deftest apply-op-merge-delete-wins-over-prior-puts
  ;; If any row in a same-id group is a delete, the delete wins: the
  ;; merged tx-op is :delete-docs and prior puts in the same op for that
  ;; id are dropped.
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T09:31:00Z")
        op (op-record ts)
        rows [(audit-row "documents" doc-id
                         {:id (str doc-id)
                          :name "ephemeral"
                          :project_id (str prj-id)
                          :version 1
                          :created_at "2026-05-28T09:00:00Z"
                          :modified_at "2026-05-28T09:00:00Z"}
                         :change-type :update
                         :seq 0)
              (audit-row "documents" doc-id nil
                         :change-type :delete
                         :seq 1)]]
    (replayer/apply-op! *node* op rows)
    (let [hits (xt/q *node*
                     (xt/template
                      (-> (from :olap/documents [{:xt/id id}])
                          (where (= id ~doc-id))))
                     {:snapshot-time ts})]
      (is (empty? hits) "entity is gone after delete-wins merge"))))

(deftest apply-op-clearing-nullable-column-via-update-nulls-it-and-keeps-junction
  ;; Regression: clearing a nullable intrinsic column (tokens.precedence)
  ;; via an :update emits a post-image with precedence=null. `:patch-docs`
  ;; SILENTLY STRIPS nil-valued keys, so a naive patch would leave the
  ;; stale prior value (7) in the OLAP read. The replayer must rewrite
  ;; such a patch into a junction-preserving put so (a) precedence reads
  ;; back nil and (b) the token's folded :metadata is NOT wiped.
  (let [tok (uuid)
        txt (str (uuid))
        tl (str (uuid))
        doc (str (uuid))
        t1 (Instant/parse "2026-05-28T09:50:00Z")
        t2 (Instant/parse "2026-05-28T09:50:01Z")
        op1 (op-record t1)
        op2 (op-record t2)]
    ;; op1: token with precedence 7 and folded metadata
    (replayer/apply-op! *node* op1
                        [(audit-row "tokens" tok
                                    {:id (str tok)
                                     :text_id txt
                                     :token_layer_id tl
                                     :document_id doc
                                     :begin 0
                                     :end_ 5
                                     :precedence 7
                                     :metadata {"k" "v"}}
                                    :change-type :insert
                                    :seq 0)])
    ;; op2: a precedence-clearing update — full intrinsic row, precedence
    ;; null, NO :metadata key (a precedence change doesn't refold it)
    (replayer/apply-op! *node* op2
                        [(audit-row "tokens" tok
                                    {:id (str tok)
                                     :text_id txt
                                     :token_layer_id tl
                                     :document_id doc
                                     :begin 0
                                     :end_ 5
                                     :precedence nil}
                                    :change-type :update
                                    :seq 0)])
    (let [token (first (xt/q *node*
                             (xt/template
                              (-> (from :olap/tokens [{:xt/id id :token/begin b
                                                       :token/precedence p :metadata m}])
                                  (where (= id ~tok))))
                             {:snapshot-time t2}))]
      (is (some? token) "token exists at t2")
      (is (= 0 (:b token)) "intrinsic columns from the update image are present")
      (is (nil? (:p token))
          "precedence cleared to nil — NOT the stale prior value 7")
      (is (= {"k" "v"} (json/read-str (:m token)))
          "folded :metadata survives the precedence-clear (junction preserved)"))))

(deftest apply-op-handles-non-uuid-user-id
  ;; Users have TEXT (email) primary keys. Replaying a user audit row
  ;; must not stall the tailer. The doc must land at the string id.
  (let [email "user@example.com"
        ts (Instant/parse "2026-05-28T09:32:00Z")
        op (op-record ts)
        rows [(audit-row "users" email
                         {:id email
                          :username email
                          :password_hash "x"
                          :password_changes 0
                          :is_admin 0}
                         :change-type :insert
                         :seq 0)]]
    (replayer/apply-op! *node* op rows)
    (let [doc (first (xt/q *node*
                           (xt/template
                            (-> (from :olap/users [{:xt/id id}
                                                   user/username])
                                (where (= id ~email))))
                           {:snapshot-time ts}))]
      (is (some? doc) "user audit row applies without stalling")
      (is (= email (:user/username doc))))))

(deftest apply-op-delete-closes-entity-validity
  ;; Insert at t1, delete at t2. A snapshot at t1 still sees the entity;
  ;; a snapshot at t2 sees the entity gone. That's the bitemporal
  ;; contract the OLAP read API depends on.
  (let [span-id (uuid)
        post {:id (str span-id)
              :span_layer_id (str (uuid))
              :document_id (str (uuid))
              :value "first"}
        t1 (Instant/parse "2026-05-28T09:00:00Z")
        t2 (Instant/parse "2026-05-28T09:00:01Z")
        op1 (op-record t1)
        op2 (op-record t2)]
    (replayer/apply-op! *node* op1 [(audit-row "spans" span-id post)])
    (replayer/apply-op! *node* op2 [(audit-row "spans" span-id nil :change-type :delete)])
    (let [at-t1 (xt/q *node*
                      (xt/template
                       (-> (from :olap/spans [{:xt/id id} span/value])
                           (where (= id ~span-id))))
                      {:snapshot-time t1})
          at-t2 (xt/q *node*
                      (xt/template
                       (-> (from :olap/spans [{:xt/id id} span/value])
                           (where (= id ~span-id))))
                      {:snapshot-time t2})]
      (is (= 1 (count at-t1)) "entity present at t1")
      (is (= "first" (:span/value (first at-t1))))
      (is (empty? at-t2) "entity gone at t2"))))

(deftest apply-op-two-puts-same-id-one-op-last-write-wins
  ;; T2 mutation M5: `merge-same-id-tx-ops`'s put arm key-merges a later
  ;; same-id put OVER the accumulated state — `(merge (:doc prev) arg)`,
  ;; so the LATER row's values win on overlapping keys. Reversing the
  ;; merge order (first-write-wins) survived every existing test because
  ;; none emits two puts/updates to the SAME [table id] within one op.
  ;; This pins last-write-wins: two :insert rows for one span in one op,
  ;; differing on :value, must resolve to the second row's value.
  (let [span-id (uuid)
        slayer (str (uuid))
        doc (str (uuid))
        ts (Instant/parse "2026-05-28T09:45:00Z")
        op (op-record ts)
        rows [(audit-row "spans" span-id
                         {:id (str span-id)
                          :span_layer_id slayer
                          :document_id doc
                          :value "first"}
                         :change-type :insert
                         :seq 0)
              (audit-row "spans" span-id
                         {:id (str span-id)
                          :span_layer_id slayer
                          :document_id doc
                          :value "second"}
                         :change-type :insert
                         :seq 1)]]
    (replayer/apply-op! *node* op rows)
    (let [span (first (xt/q *node*
                            (xt/template
                             (-> (from :olap/spans [{:xt/id id} span/value])
                                 (where (= id ~span-id))))
                            {:snapshot-time ts}))]
      (is (some? span) "span exists after the two-put merge")
      (is (= "second" (:span/value span))
          "the LATER same-id put wins (last-write-wins), not the earlier one"))))
