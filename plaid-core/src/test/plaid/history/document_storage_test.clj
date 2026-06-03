(ns plaid.history.document-storage-test
  "Round-trip smoke test for plaid.history.document's SQL queries against
  XTDB v2's actual storage column naming.

  Why this exists: XTDB v2 stores `:document/name` under SQL column
  `document$name`, not `name`. A `SELECT name FROM history.documents` is
  syntactically valid but the column doesn't exist — XTDB returns a
  row with every selected attribute NULL. The replayer-test suite
  uses XTQL with `xt/template` (which addresses the namespaced attr
  directly) so it never noticed; the REST `?as-of=` route did. This
  test writes a fully-populated doc via the replayer, then calls
  `document/get-at` / `get-with-layer-data-at` and asserts every
  intrinsic field round-trips — i.e. the SQL queries actually hit the
  storage columns.

  Future task replaces this with REST-driven integration coverage;
  until then this is the regression guard."
  (:require [clojure.data.json :as json]
            [clojure.test :refer :all]
            [plaid.media.storage :as media]
            [plaid.history.core :as history-core]
            [plaid.history.document :as history-doc]
            [plaid.history.replayer :as replayer]
            [plaid.sql.common]
            [xtdb.api :as xt]
            [xtdb.node :as xtn])
  (:import (java.time Instant)
           (java.util Date UUID)))

(def ^:dynamic ^:private *node* nil)

(defn- with-fresh-node [f]
  (with-open [node (xtn/start-node {})]
    (binding [*node* node]
      (f))))

(use-fixtures :each with-fresh-node)

(defn- uuid [] (UUID/randomUUID))

(defn- audit-row
  [target-table target-id post & {:keys [change-type seq]
                                  :or {change-type :insert seq 0}}]
  {:target_table target-table
   :target_id (str target-id)
   :change_type (name change-type)
   :pre_image nil
   :post_image (some-> post json/write-str)
   :seq seq})

(defn- op-record [^Instant ts]
  {:op/id (uuid)
   :op/ts (Date/from ts)
   :op/op-type :test/op})

;; ============================================================
;; The bug guard: every intrinsic doc field must round-trip
;; ============================================================

(deftest document-get-at-returns-all-fields-populated
  ;; Replayer writes a single document via the audit-row path the
  ;; tailer would use in production. `document/get-at` must then
  ;; return EVERY intrinsic field non-nil — pre-fix every field but
  ;; `:document/id` came back nil because the SELECT list referenced
  ;; columns (`name`, `project`, `version`, ...) that XTDB v2 doesn't
  ;; expose by those bare names (they're stored under `document$name`,
  ;; `document$project`, etc.).
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T09:00:00Z")
        ;; Cursor `:last-op-ts` is written as an ISO string in production
        ;; (the tailer reads `operations.ts` straight from SQLite, which
        ;; comes back as a TEXT). `check-staleness!` parses it via
        ;; `history-core/->instant`. The helper now also handles
        ;; ZonedDateTime (extended in Group C of the round-3 fixes), so a
        ;; future tailer change that wrote `:last-op-ts` as a Date would
        ;; round-trip correctly — but the production tailer continues to
        ;; store strings for consistency with the OLTP `operations.ts`
        ;; column shape.
        cursor-ts-iso "2026-05-28T09:01:00Z"
        post {:id (str doc-id)
              :name "Hello Doc"
              :project_id (str prj-id)
              :version 7
              :created_at "2026-05-28T08:00:00Z"
              :modified_at "2026-05-28T08:30:00Z"}
        op (op-record ts)]
    (replayer/apply-op! *node* op [(audit-row "documents" doc-id post)])
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (let [got (history-doc/get-at *node* doc-id ts)]
      (is (some? got) "doc found")
      (is (= doc-id (:document/id got))                    ":document/id")
      (is (= "Hello Doc" (:document/name got))             ":document/name (was nil pre-fix)")
      (is (= prj-id (:document/project got))               ":document/project (was nil pre-fix)")
      (is (= 7 (:document/version got))                    ":document/version (was nil pre-fix)")
      (is (= "2026-05-28T08:00:00Z" (:document/time-created got))
          ":document/time-created (was nil pre-fix)")
      (is (= "2026-05-28T08:30:00Z" (:document/time-modified got))
          ":document/time-modified (was nil pre-fix)"))))

(deftest exists-at?-finds-the-doc
  ;; `exists-at?` only SELECTs `_id` so it was the one fn that
  ;; happened to work pre-fix — pin it down anyway.
  (let [doc-id (uuid)
        ts (Instant/parse "2026-05-28T09:00:00Z")
        cursor-ts-iso "2026-05-28T09:01:00Z"
        post {:id (str doc-id)
              :name "Doc"
              :project_id (str (uuid))
              :version 1
              :created_at "2026-05-28T08:00:00Z"
              :modified_at "2026-05-28T08:00:00Z"}]
    (replayer/apply-op! *node*
                        (op-record ts)
                        [(audit-row "documents" doc-id post)])
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (is (true? (history-doc/exists-at? *node* doc-id ts)))
    (is (false? (history-doc/exists-at? *node* (uuid) ts))
        "absent id reads as false, not nil")))

;; ============================================================
;; Deep read: layers + tokens + spans + relations must all populate
;; ============================================================

(deftest get-with-layer-data-at-populates-every-layer-shape
  ;; Apply a small but representative tree:
  ;;   project -> text-layer -> token-layer -> span-layer -> relation-layer
  ;;                                                       \-> text
  ;;                                                       \-> tokens
  ;;                                                       \-> spans (one)
  ;;                                                       \-> relations (none)
  ;; After replay, `get-with-layer-data-at` must reproduce the tree
  ;; with no nil intrinsic fields on any layer/text/token/span. Pre-
  ;; fix the layer SELECTs returned mostly-nil rows so the assembler
  ;; built a doc with `:text-layer/name nil`, `:token-layer/name nil`,
  ;; tokens with `:token/begin nil`, etc.
  (let [doc-id (uuid)
        prj-id (uuid)
        tl-id (uuid)
        tkl-id (uuid)
        sl-id (uuid)
        rl-id (uuid)
        text-id (uuid)
        tok-id-a (uuid)
        tok-id-b (uuid)
        span-id (uuid)
        ts (Instant/parse "2026-05-28T09:00:00Z")
        cursor-ts-iso "2026-05-28T09:01:00Z"
        op (op-record ts)
        rows [(audit-row "documents" doc-id
                         {:id (str doc-id)
                          :name "Doc"
                          :project_id (str prj-id)
                          :version 1
                          :created_at "2026-05-28T08:00:00Z"
                          :modified_at "2026-05-28T08:00:00Z"}
                         :seq 0)
              (audit-row "text_layers" tl-id
                         {:id (str tl-id)
                          :name "TL"
                          :project_id (str prj-id)
                          :order_idx 0
                          :config nil}
                         :seq 1)
              (audit-row "token_layers" tkl-id
                         {:id (str tkl-id)
                          :name "TKL"
                          :text_layer_id (str tl-id)
                          :project_id (str prj-id)
                          :order_idx 0
                          :overlap_mode "strict"
                          :parent_token_layer_id nil
                          :config nil}
                         :seq 2)
              (audit-row "span_layers" sl-id
                         {:id (str sl-id)
                          :name "SL"
                          :token_layer_id (str tkl-id)
                          :project_id (str prj-id)
                          :order_idx 0
                          :config nil}
                         :seq 3)
              (audit-row "relation_layers" rl-id
                         {:id (str rl-id)
                          :name "RL"
                          :span_layer_id (str sl-id)
                          :project_id (str prj-id)
                          :order_idx 0
                          :config nil}
                         :seq 4)
              (audit-row "texts" text-id
                         {:id (str text-id)
                          :document_id (str doc-id)
                          :text_layer_id (str tl-id)
                          :body "Hello world"}
                         :seq 5)
              (audit-row "tokens" tok-id-a
                         {:id (str tok-id-a)
                          :document_id (str doc-id)
                          :text_id (str text-id)
                          :token_layer_id (str tkl-id)
                          :begin 0
                          :end_ 5
                          :precedence 0}
                         :seq 6)
              (audit-row "tokens" tok-id-b
                         {:id (str tok-id-b)
                          :document_id (str doc-id)
                          :text_id (str text-id)
                          :token_layer_id (str tkl-id)
                          :begin 6
                          :end_ 11
                          :precedence 0}
                         :seq 7)
              (audit-row "spans" span-id
                         {:id (str span-id)
                          :document_id (str doc-id)
                          :span_layer_id (str sl-id)
                          ;; OLTP stores `spans.value` as a JSON-encoded scalar
                          ;; (so the column can hold string|number|bool|null
                          ;; uniformly). The history read path decodes via
                          ;; `psc/read-json`, so this test post-image must
                          ;; carry the JSON-encoded form.
                          :value "\"GREETING\""
                          :tokens [(str tok-id-a)]}
                         :seq 8)]]
    (replayer/apply-op! *node* op rows)
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 8
                     :tailer-status :running})])
    (let [doc (history-doc/get-with-layer-data-at *node* doc-id ts)]
      ;; --- Top-level doc ---
      (is (some? doc))
      (is (= "Doc" (:document/name doc)))
      (is (= prj-id (:document/project doc)))
      ;; --- Text layers ---
      (let [tls (:document/text-layers doc)]
        (is (= 1 (count tls)))
        (let [txtl (first tls)]
          (is (= tl-id (:text-layer/id txtl)))
          (is (= "TL" (:text-layer/name txtl)))
          ;; --- Text ---
          (let [text (:text-layer/text txtl)]
            (is (= text-id (:text/id text)))
            (is (= doc-id (:text/document text)))
            (is (= "Hello world" (:text/body text))))
          ;; --- Token layer ---
          (let [tkls (:text-layer/token-layers txtl)]
            (is (= 1 (count tkls)))
            (let [tkl (first tkls)]
              (is (= tkl-id (:token-layer/id tkl)))
              (is (= "TKL" (:token-layer/name tkl)))
              (is (= :strict (:token-layer/overlap-mode tkl)))
              ;; --- Tokens ---
              (let [tokens (:token-layer/tokens tkl)]
                (is (= 2 (count tokens)))
                (let [t1 (first tokens)]
                  (is (= tok-id-a (:token/id t1)))
                  (is (= doc-id (:token/document t1)))
                  (is (= text-id (:token/text t1)))
                  (is (= 0 (:token/begin t1)))
                  (is (= 5 (:token/end t1)))
                  (is (= 0 (:token/precedence t1)))))
              ;; --- Span layer + spans ---
              (let [sls (:token-layer/span-layers tkl)]
                (is (= 1 (count sls)))
                (let [spl (first sls)]
                  (is (= sl-id (:span-layer/id spl)))
                  (is (= "SL" (:span-layer/name spl)))
                  (let [spans (:span-layer/spans spl)]
                    (is (= 1 (count spans)))
                    (let [s (first spans)]
                      (is (= span-id (:span/id s)))
                      (is (= doc-id (:span/document s)))
                      (is (= "GREETING" (:span/value s)))
                      (is (= [tok-id-a] (:span/tokens s)))))
                  ;; --- Relation layer (empty) ---
                  (let [rls (:span-layer/relation-layers spl)]
                    (is (= 1 (count rls)))
                    (let [rl (first rls)]
                      (is (= rl-id (:relation-layer/id rl)))
                      (is (= "RL" (:relation-layer/name rl)))
                      (is (= [] (:relation-layer/relations rl))))))))))))))

;; ============================================================
;; BUG-6 guard: decode-value must not throw on non-string :value
;; ============================================================
;;
;; The OLTP write path JSON-encodes scalars before storing, so a
;; well-formed replayed row will always carry a string. But the history
;; SQL read path used to call `(psc/read-json v)` unconditionally,
;; which throws ClassCastException on a non-string value — a single
;; replayer change that pre-decoded values would have 500'd the entire
;; deep read with a stack-leaking unhandled exception. The fixed
;; `decode-value` should pass non-strings through unchanged.
;;
;; We test all the scalar shapes a replayer might plausibly hand us:
;; long, double, true, false, nil. Strings are exercised by the
;; existing deep-read test above.

(defn- replay-span-with-value
  "Helper: write a doc + minimal layer chain + one span with the given
  raw `:value` payload (as it would land in the history after replay).
  Returns the assembled `(get-with-layer-data-at ...)` doc."
  [v]
  (let [doc-id (uuid)
        prj-id (uuid)
        tl-id (uuid)
        tkl-id (uuid)
        sl-id (uuid)
        text-id (uuid)
        tok-id (uuid)
        span-id (uuid)
        ts (Instant/parse "2026-05-28T09:00:00Z")
        cursor-ts-iso "2026-05-28T09:01:00Z"
        op (op-record ts)
        rows [(audit-row "documents" doc-id
                         {:id (str doc-id) :name "D" :project_id (str prj-id)
                          :version 1
                          :created_at "2026-05-28T08:00:00Z"
                          :modified_at "2026-05-28T08:00:00Z"}
                         :seq 0)
              (audit-row "text_layers" tl-id
                         {:id (str tl-id) :name "TL" :project_id (str prj-id)
                          :order_idx 0 :config nil} :seq 1)
              (audit-row "token_layers" tkl-id
                         {:id (str tkl-id) :name "TKL" :text_layer_id (str tl-id)
                          :project_id (str prj-id) :order_idx 0
                          :overlap_mode "any" :parent_token_layer_id nil
                          :config nil} :seq 2)
              (audit-row "span_layers" sl-id
                         {:id (str sl-id) :name "SL" :token_layer_id (str tkl-id)
                          :project_id (str prj-id) :order_idx 0 :config nil}
                         :seq 3)
              (audit-row "texts" text-id
                         {:id (str text-id) :document_id (str doc-id)
                          :text_layer_id (str tl-id) :body "X"} :seq 4)
              (audit-row "tokens" tok-id
                         {:id (str tok-id) :document_id (str doc-id)
                          :text_id (str text-id) :token_layer_id (str tkl-id)
                          :begin 0 :end_ 1 :precedence 0} :seq 5)
              (audit-row "spans" span-id
                         {:id (str span-id) :document_id (str doc-id)
                          :span_layer_id (str sl-id)
                          :value v
                          :tokens [(str tok-id)]} :seq 6)]]
    (replayer/apply-op! *node* op rows)
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 6
                     :tailer-status :running})])
    {:doc (history-doc/get-with-layer-data-at *node* doc-id ts)
     :sl-id sl-id
     :tkl-id tkl-id
     :tl-id tl-id}))

(defn- first-span [{:keys [doc tkl-id sl-id tl-id]}]
  (->> doc :document/text-layers
       (filter #(= tl-id (:text-layer/id %))) first
       :text-layer/token-layers
       (filter #(= tkl-id (:token-layer/id %))) first
       :token-layer/span-layers
       (filter #(= sl-id (:span-layer/id %))) first
       :span-layer/spans first))

;; XTDB v2 stores the `:span/value` column with a type inferred from
;; the first put-docs to land in it; mixing types across put-docs into
;; the same node makes later SELECTs return nil for the mismatched
;; rows (we observed long+double+bool collision dropping double/bool
;; to nil even though each value round-trips fine in isolation). Each
;; non-string scalar below therefore runs against its OWN fresh node so
;; the column type is pinned to a single scalar shape — what we
;; actually care about is whether `decode-value` swallows the read
;; without 500ing, not XTDB's union-typing behavior.

(defmacro ^:private with-isolated-node
  "Run `body` against a fresh in-memory XTDB node bound to `*node*`,
  closing it after."
  [& body]
  `(with-open [node# (xtn/start-node {})]
     (binding [*node* node#]
       ~@body)))

(deftest decode-value-passes-through-non-string-scalars
  ;; Numbers, booleans, and pre-decoded nil must not throw. The history
  ;; read path used to die with ClassCastException on these.
  (testing "long passes through unchanged"
    (with-isolated-node
      (let [s (first-span (replay-span-with-value 42))]
        (is (= 42 (:span/value s))))))
  (testing "double passes through unchanged"
    (with-isolated-node
      (let [s (first-span (replay-span-with-value 1.5))]
        (is (= 1.5 (:span/value s))))))
  (testing "true passes through unchanged"
    (with-isolated-node
      (let [s (first-span (replay-span-with-value true))]
        (is (= true (:span/value s))))))
  (testing "false passes through unchanged"
    (with-isolated-node
      (let [s (first-span (replay-span-with-value false))]
        (is (= false (:span/value s))))))
  (testing "nil decodes to nil (already supported pre-fix, kept for regression)"
    (with-isolated-node
      (let [s (first-span (replay-span-with-value nil))]
        (is (nil? (:span/value s))))))
  ;; Empty string is its own branch — `read-json` throws EOFException
  ;; on "", same failure mode BUG-6 was supposed to close. Production
  ;; never emits "" but a pre-trim replayer bug could; the fix
  ;; short-circuits to nil to match `psc/parse-config`'s `(= s "") {}`
  ;; convention.
  (testing "empty string decodes to nil (BUG-6 follow-up)"
    (with-isolated-node
      (let [s (first-span (replay-span-with-value ""))]
        (is (nil? (:span/value s))
            "empty string is treated as nil rather than throwing EOFException"))))
  ;; Whitespace-only string (Fix #12): `(= v "")` missed " " / "\t" /
  ;; "\n", so `read-json` still threw EOFException on a blank-but-
  ;; nonempty value and 500'd the entire deep read. The fix generalizes
  ;; the guard to `str/blank?`. A space and a tab+newline both must
  ;; decode to nil rather than throwing.
  (testing "whitespace-only string decodes to nil (Fix #12)"
    (with-isolated-node
      (let [s (first-span (replay-span-with-value "   "))]
        (is (nil? (:span/value s))
            "single-space value is treated as nil, not an EOFException")))
    (with-isolated-node
      (let [s (first-span (replay-span-with-value "\t\n "))]
        (is (nil? (:span/value s))
            "tab/newline-only value is treated as nil, not an EOFException")))))

;; ============================================================
;; BUG-5 guard: media-url shape matches the OLTP read
;; ============================================================
;;
;; OLTP `plaid.sql.document/get` attaches `:document/media-url` iff
;; `media/media-exists?` is true. The history at-time read must match —
;; media isn't versioned in either backend, so we probe the live
;; filesystem (same as v2 did pre-port). Without this, an `?as-of=`
;; read of a doc with media silently drops the URL and a client
;; comparing the live + historical responses sees a shape diff.

(deftest get-at-attaches-media-url-when-file-present
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T09:00:00Z")
        cursor-ts-iso "2026-05-28T09:01:00Z"
        post {:id (str doc-id)
              :name "WithMedia"
              :project_id (str prj-id)
              :version 1
              :created_at "2026-05-28T08:00:00Z"
              :modified_at "2026-05-28T08:00:00Z"}]
    (replayer/apply-op! *node* (op-record ts)
                        [(audit-row "documents" doc-id post)])
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    ;; Redef rather than touching the real media dir — keeps the test
    ;; hermetic and matches how the rest of the history tests dodge filesystem
    ;; assumptions.
    (with-redefs [media/media-exists? (constantly true)]
      (let [got (history-doc/get-at *node* doc-id ts)]
        (is (= (str "/api/v1/documents/" doc-id "/media")
               (:document/media-url got))
            "media-url attached when media-exists? is true")))
    (with-redefs [media/media-exists? (constantly false)]
      (let [got (history-doc/get-at *node* doc-id ts)]
        (is (not (contains? got :document/media-url))
            "media-url omitted when media-exists? is false (key absent, not nil)")))))

(deftest get-with-layer-data-at-attaches-media-url-when-file-present
  ;; Deep read goes through `fetch-document-row` for the doc-level
  ;; shape, so the same media-url attach applies. Confirm the
  ;; include-body path doesn't regress past the get-at fix.
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T09:00:00Z")
        cursor-ts-iso "2026-05-28T09:01:00Z"
        post {:id (str doc-id)
              :name "WithMedia"
              :project_id (str prj-id)
              :version 1
              :created_at "2026-05-28T08:00:00Z"
              :modified_at "2026-05-28T08:00:00Z"}]
    (replayer/apply-op! *node* (op-record ts)
                        [(audit-row "documents" doc-id post)])
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (with-redefs [media/media-exists? (constantly true)]
      (let [got (history-doc/get-with-layer-data-at *node* doc-id ts)]
        (is (= (str "/api/v1/documents/" doc-id "/media")
               (:document/media-url got)))))))

(deftest decode-value-still-decodes-json-strings
  ;; Defensive — make sure the new cond didn't accidentally pass strings
  ;; through unparsed. The deep-read test up top covers the happy path
  ;; for a string; this is a tighter assertion on the (string? v) branch.
  (with-isolated-node
    (let [s (first-span (replay-span-with-value "\"hello\""))]
      (is (= "hello" (:span/value s)))
      (is (string? (:span/value s))))))

;; ============================================================
;; list-versions — pagination + filtering
;; ============================================================
;;
;; `plaid.history.document/list-versions` drives off XTDB's bitemporal
;; history on the document row — every doc-version-bump emits a new
;; system_from row, and a `FOR ALL SYSTEM_TIME` query returns the full
;; history newest-first. The :from / :to / :limit / :cursor knobs let
;; the REST consumer page through a long history. None of those knobs
;; had direct test coverage before — this section pins them.

(defn- replay-doc-at-version
  "Replay one doc-version-bump audit row at `ts` with the given `version`.
  All other doc columns stay constant so we're only varying the
  bitemporal history. Returns the post-image as written."
  [doc-id prj-id ts version]
  (let [op (op-record ts)
        post {:id (str doc-id)
              :name "Versioned"
              :project_id (str prj-id)
              :version version
              :created_at "2026-05-28T08:00:00Z"
              :modified_at (.toString ts)}]
    (replayer/apply-op! *node* op
                        [(audit-row "documents" doc-id post
                                    :change-type :doc-version-bump
                                    :seq 0)])
    post))

(deftest list-versions-returns-all-versions-newest-first-by-default
  ;; Build a 5-version history at distinct ts values. `list-versions`
  ;; with no opts should return all five, newest-first.
  (let [doc-id (uuid)
        prj-id (uuid)
        instants [(Instant/parse "2026-05-28T10:00:00Z")
                  (Instant/parse "2026-05-28T10:01:00Z")
                  (Instant/parse "2026-05-28T10:02:00Z")
                  (Instant/parse "2026-05-28T10:03:00Z")
                  (Instant/parse "2026-05-28T10:04:00Z")]]
    (doseq [[v t] (map vector (range 1 6) instants)]
      (replay-doc-at-version doc-id prj-id t v))
    ;; Cursor needed so `check-staleness!` would pass (not actually
    ;; called by list-versions today, but we set it anyway so a future
    ;; staleness guard wouldn't trip on this test).
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts "2026-05-28T10:05:00Z"
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (let [versions (history-doc/list-versions *node* doc-id {})]
      (is (= 5 (count versions)) "all 5 versions returned by default")
      (is (apply > (map :version versions))
          "newest-first: version numbers strictly decreasing")
      (is (= 5 (:version (first versions))) "newest is version 5")
      (is (= 1 (:version (last versions))) "oldest is version 1"))))

(deftest list-versions-respects-limit
  (let [doc-id (uuid)
        prj-id (uuid)
        instants [(Instant/parse "2026-05-28T11:00:00Z")
                  (Instant/parse "2026-05-28T11:01:00Z")
                  (Instant/parse "2026-05-28T11:02:00Z")
                  (Instant/parse "2026-05-28T11:03:00Z")
                  (Instant/parse "2026-05-28T11:04:00Z")]]
    (doseq [[v t] (map vector (range 1 6) instants)]
      (replay-doc-at-version doc-id prj-id t v))
    (let [versions (history-doc/list-versions *node* doc-id {:limit 2})]
      (is (= 2 (count versions)) ":limit 2 caps the page")
      (is (= [5 4] (mapv :version versions))
          "the newest two come back when limited"))))

(deftest list-versions-respects-from-filter
  ;; :from is INCLUSIVE — versions with ts >= from are returned.
  (let [doc-id (uuid)
        prj-id (uuid)
        instants [(Instant/parse "2026-05-28T12:00:00Z")
                  (Instant/parse "2026-05-28T12:01:00Z")
                  (Instant/parse "2026-05-28T12:02:00Z")
                  (Instant/parse "2026-05-28T12:03:00Z")
                  (Instant/parse "2026-05-28T12:04:00Z")]
        ts3 (nth instants 2)]
    (doseq [[v t] (map vector (range 1 6) instants)]
      (replay-doc-at-version doc-id prj-id t v))
    (let [versions (history-doc/list-versions *node* doc-id {:from (.toString ts3)})]
      (is (= 3 (count versions))
          ":from inclusive — versions 3/4/5 (ts >= ts3) returned")
      (is (every? (fn [v] (>= (:version v) 3)) versions)
          "no version older than the :from anchor"))))

(deftest list-versions-respects-to-filter
  ;; :to is EXCLUSIVE — versions with ts < to are returned.
  (let [doc-id (uuid)
        prj-id (uuid)
        instants [(Instant/parse "2026-05-28T13:00:00Z")
                  (Instant/parse "2026-05-28T13:01:00Z")
                  (Instant/parse "2026-05-28T13:02:00Z")
                  (Instant/parse "2026-05-28T13:03:00Z")
                  (Instant/parse "2026-05-28T13:04:00Z")]
        ts3 (nth instants 2)]
    (doseq [[v t] (map vector (range 1 6) instants)]
      (replay-doc-at-version doc-id prj-id t v))
    (let [versions (history-doc/list-versions *node* doc-id {:to (.toString ts3)})]
      (is (= 2 (count versions))
          ":to exclusive — versions 1/2 (ts < ts3) returned, not version 3 at ts3 itself")
      (is (every? (fn [v] (< (:version v) 3)) versions)
          "no version at or after the :to anchor"))))

(deftest list-versions-cursor-paginates
  ;; The cursor protocol: caller passes back the previous page's oldest
  ;; ts as the next page's `:cursor`. With limit 2 across a 5-version
  ;; history, page-1 returns versions {5,4}; page-2 with cursor=ts(v4)
  ;; should pick up where we left off ({3,2}); page-3 returns {1}.
  (let [doc-id (uuid)
        prj-id (uuid)
        instants [(Instant/parse "2026-05-28T14:00:00Z")
                  (Instant/parse "2026-05-28T14:01:00Z")
                  (Instant/parse "2026-05-28T14:02:00Z")
                  (Instant/parse "2026-05-28T14:03:00Z")
                  (Instant/parse "2026-05-28T14:04:00Z")]]
    (doseq [[v t] (map vector (range 1 6) instants)]
      (replay-doc-at-version doc-id prj-id t v))
    (let [page1 (history-doc/list-versions *node* doc-id {:limit 2})
          page1-oldest-ts (:ts (last page1))
          page2 (history-doc/list-versions *node* doc-id
                                           {:limit 2 :cursor page1-oldest-ts})]
      (is (= [5 4] (mapv :version page1)))
      ;; cursor is EXCLUSIVE — page2 starts at v3, not v4 (which was at
      ;; ts equal to cursor). This matches the docstring: "cursor
      ;; (previous page's oldest ts) becomes the next page's exclusive
      ;; upper bound."
      (is (= [3 2] (mapv :version page2))
          ":cursor advances strictly past the previous page's oldest entry"))))

(deftest list-versions-empty-history-returns-empty-vec
  ;; No doc-version-bumps yet → no history → []. Defensive: many callers
  ;; will assume vector shape regardless of presence.
  (let [doc-id (uuid)
        versions (history-doc/list-versions *node* doc-id {})]
    (is (vector? versions))
    (is (empty? versions))))

;; ============================================================
;; list-versions — edge cases (Group D coverage)
;; ============================================================
;;
;; Pin behavior on the corners the happy-path tests didn't touch: same-ts
;; ops (XTDB v2 allows multiple submit-tx at the same :system-time, so a
;; pathological replayer could land two version rows at the same ts);
;; cursor pointing AT the oldest entry; out-of-range :limit values.

;; NB: timestamps below sit before today's wall clock. XTDB v2 hides rows
;; whose :system-time is in the future relative to the JVM's now() even
;; under `FOR ALL SYSTEM_TIME` — so a write stamped tomorrow returns []
;; from any query until tomorrow arrives. The existing list-versions
;; tests use morning timestamps; we use early-morning ranges here so the
;; corner tests survive a CI run regardless of which hour it lands in.

(deftest list-versions-two-rows-at-same-ts-return-deterministically
  ;; Two doc-version-bumps at the EXACT same Instant. XTDB v2 accepts
  ;; same-system-time writes — the tailer pre-fix advanced by 1ms to dodge
  ;; this, but post-fix equal-ts is left alone. We don't care which entry
  ;; sorts first as long as the order is STABLE across repeated calls — a
  ;; flaky order would make REST pagination clients diverge.
  (let [doc-id (uuid)
        prj-id (uuid)
        ;; Same instant for both writes. apply-op! is two separate
        ;; submit-tx calls — they'll land at the same :xt/system-from.
        ts (Instant/parse "2026-05-28T01:00:00Z")]
    (replay-doc-at-version doc-id prj-id ts 1)
    (replay-doc-at-version doc-id prj-id ts 2)
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts "2026-05-28T01:01:00Z"
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (let [page-a (history-doc/list-versions *node* doc-id {})
          page-b (history-doc/list-versions *node* doc-id {})]
      ;; Per the bitemporal contract, only the latest version at a given
      ;; system-time is visible — the second put-docs replaces the first
      ;; rather than appending a second history row. We don't assert a
      ;; specific count here (XTDB may surface 1 or 2 history rows
      ;; depending on whether `FOR ALL SYSTEM_TIME` exposes the replaced
      ;; row); the contract this test pins is "the answer is stable".
      (is (= page-a page-b)
          "same call returns identical results — ordering is deterministic")
      (is (>= (count page-a) 1)
          "at least one history entry survives")
      (is (every? #(#{1 2} (:version %)) page-a)
          "every visible version is one of the writes we made"))))

(deftest list-versions-cursor-at-oldest-entry-returns-empty
  ;; The pagination contract: `:cursor` is the previous page's oldest
  ;; ts and acts as an exclusive upper bound. If a caller hands in a
  ;; cursor equal to the ts of the very first (oldest) entry, the next
  ;; page should be empty — there's nothing strictly older.
  (let [doc-id (uuid)
        prj-id (uuid)
        instants [(Instant/parse "2026-05-28T02:00:00Z")
                  (Instant/parse "2026-05-28T02:01:00Z")
                  (Instant/parse "2026-05-28T02:02:00Z")]]
    (doseq [[v t] (map vector (range 1 4) instants)]
      (replay-doc-at-version doc-id prj-id t v))
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts "2026-05-28T02:03:00Z"
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (let [all (history-doc/list-versions *node* doc-id {})
          oldest-ts (:ts (last all))
          next-page (history-doc/list-versions *node* doc-id {:cursor oldest-ts})]
      (is (= 3 (count all)))
      (is (empty? next-page)
          ":cursor at the oldest entry's ts → no entries strictly older → empty page"))))

(deftest list-versions-large-limit-is-clamped-to-max
  ;; `:limit` over the implementation's `max-limit` (500) is silently
  ;; clamped — see `clamp-limit`. Caller asking for 1000 must not get a
  ;; 500 nor 1000 rows; the contract is "you get at most 500".
  (let [doc-id (uuid)
        prj-id (uuid)
        ;; Three entries is enough — we don't need to actually build 500
        ;; to verify clamping. The contract is "the returned count never
        ;; exceeds max-limit", which we verify indirectly by passing a
        ;; clearly-over-cap limit and confirming no exception is thrown.
        instants [(Instant/parse "2026-05-28T03:00:00Z")
                  (Instant/parse "2026-05-28T03:01:00Z")
                  (Instant/parse "2026-05-28T03:02:00Z")]]
    (doseq [[v t] (map vector (range 1 4) instants)]
      (replay-doc-at-version doc-id prj-id t v))
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts "2026-05-28T03:03:00Z"
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (let [versions (history-doc/list-versions *node* doc-id {:limit 1000})]
      (is (= 3 (count versions))
          "all 3 returned (clamp doesn't truncate below actual count)"))
    ;; Direct unit test of the clamp boundary — verifies 1000 clamps to 500
    ;; without needing to actually build 500 entries (impractical for an
    ;; in-memory deftest).
    (let [clamp @#'history-doc/clamp-limit]
      (is (= 500 (clamp 1000)) "1000 clamps to 500 (max-limit)")
      (is (= 500 (clamp 10000)) "any huge value clamps to 500"))))

(deftest list-versions-non-positive-limit-is-clamped-up-to-min
  ;; `clamp-limit` uses `(max 1 (min n max-limit))` so 0 and negatives
  ;; become 1 rather than throwing or returning empty. Pinning here so a
  ;; refactor that flips the clamp to `(max 0 …)` (off-by-one) would fail
  ;; loudly — empty-results-on-negative-limit is a footgun for clients
  ;; that loop "while results, fetch more".
  (let [clamp @#'history-doc/clamp-limit]
    (is (= 1 (clamp 0)) "0 clamps up to 1")
    (is (= 1 (clamp -5)) "negative clamps up to 1")
    (is (= 50 (clamp nil)) "nil falls back to default-limit (50)")
    (is (= 50 (clamp "not-a-number")) "non-parseable string falls back to default")
    (is (= 7 (clamp "7")) "numeric string parses through")))

;; ============================================================
;; history-cursor accessor — shape coverage
;; ============================================================
;;
;; The integration test surfaces this indirectly via 425 / /health.
;; Direct shape coverage catches refactors that change the exposed key
;; set without flipping a REST status — operator dashboards consume it.

(deftest history-cursor-returns-canonical-shape-after-apply
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T15:00:00Z")
        cursor-ts-iso "2026-05-28T15:01:00Z"
        post {:id (str doc-id)
              :name "D"
              :project_id (str prj-id)
              :version 1
              :created_at "2026-05-28T15:00:00Z"
              :modified_at "2026-05-28T15:00:00Z"}]
    (replayer/apply-op! *node* (op-record ts)
                        [(audit-row "documents" doc-id post)])
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 7
                     :tailer-status :running})])
    (let [c (history-doc/history-cursor *node*)]
      (is (some? c))
      (is (= cursor-ts-iso (:ts c)) ":ts maps to cursor's last-op-ts")
      (is (some? (:op-id c)) ":op-id present")
      (is (= 7 (:seq c)) ":seq maps to cursor's last-seq")
      (is (= :running (:status c)) ":status defaults to :running"))))

(deftest history-cursor-returns-nil-with-no-cursor-doc
  ;; Cold-start case: no apply has happened, no cursor written. The
  ;; accessor returns nil rather than throwing — the /health code path
  ;; treats nil as "not ready" without a 500.
  (is (nil? (history-doc/history-cursor *node*))
      "fresh node returns nil instead of throwing"))

;; ============================================================
;; history-core/->instant — unified coercion helper
;; ============================================================
;;
;; `history-core/->instant` accepts Instant / String / Date / ZDT. The
;; ZDT branch was added because `cursor-instant` (in history.document)
;; calls this on `:last-op-ts`, and a future replayer/tailer change
;; that stores `Date` there would have XTDB round-trip it as a
;; ZonedDateTime — without the ZDT branch, the staleness check would
;; throw on every read. `history.document/->instant-maybe` now delegates
;; here so the two helpers cannot drift.

(deftest ->instant-round-trips-zoned-date-time
  ;; Each input shape must produce an equivalent Instant. Use the same
  ;; reference moment across all four to make divergence obvious.
  (let [iso "2026-05-28T09:00:00Z"
        inst (Instant/parse iso)
        date (Date/from inst)
        zdt (.atZone inst (java.time.ZoneOffset/UTC))]
    (is (= inst (history-core/->instant inst)) "Instant passes through")
    (is (= inst (history-core/->instant iso)) "ISO-8601 string parses")
    (is (= inst (history-core/->instant date)) "java.util.Date converts")
    (is (= inst (history-core/->instant zdt))
        (str "ZonedDateTime converts (regression: prior fn rejected ZDT, which broke "
             "cursor reads after XTDB round-trips a stored Date as ZDT)"))))

;; ============================================================
;; list-versions — stall guard
;; ============================================================
;;
;; `list-versions` had no staleness check pre-fix; the other public
;; reads do. Stalled tailer + list-versions silently served drifting
;; history. We check only the tailer-status (the "ts past cursor"
;; branch of check-staleness! is deliberately skipped — version history
;; is meaningful at any cursor position).

(deftest list-versions-throws-history-stalled-when-tailer-stalled
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T10:00:00Z")]
    (replay-doc-at-version doc-id prj-id ts 1)
    ;; Stall the tailer by setting :tailer-status :stalled on the cursor.
    (history-core/set-stalled! *node*
                               {:op-id (uuid) :seq 0 :reason "synthetic test stall"})
    (let [thrown (try
                   (history-doc/list-versions *node* doc-id {})
                   nil
                   (catch clojure.lang.ExceptionInfo e e))]
      (is (some? thrown) "list-versions throws when tailer is stalled")
      (is (= :history/stalled (:type (ex-data thrown)))
          ":type matches the contract so wrap-route-as-of can map to 503")
      (is (re-find #"synthetic test stall" (:stall-reason (ex-data thrown)))
          ":stall-reason propagates from the cursor doc"))))

;; ============================================================
;; get-at media-url omission for deleted docs (option B, task #138 fix #7)
;; ============================================================
;;
;; The auth chain falls through to history at-time reads for docs deleted
;; from OLTP. Without this guard, `:document/media-url` would be
;; attached to the response, but the media route's auth lookup uses
;; OLTP only — clicking the URL would 403/404. Option B: omit the URL
;; for deleted docs so the caller never sees a clickable-but-broken
;; link. Live (non-deleted) at-time reads keep the URL because the
;; route works for them.
;;
;; The OLTP-existence check requires an oltp-db parameter; without it,
;; the legacy 3-arity behavior is preserved (media-url attached iff
;; the file exists on disk).

(deftest get-at-omits-media-url-for-deleted-doc-when-oltp-db-passed
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T16:00:00Z")
        cursor-ts-iso "2026-05-28T16:01:00Z"
        post {:id (str doc-id)
              :name "DeletedDoc"
              :project_id (str prj-id)
              :version 1
              :created_at "2026-05-28T16:00:00Z"
              :modified_at "2026-05-28T16:00:00Z"}
        ;; Mock OLTP that NEVER finds this doc — simulates the
        ;; deleted-doc case where the history at-time read still
        ;; surfaces the doc but OLTP no longer has the row.
        empty-oltp-db (reify java.lang.AutoCloseable (close [_]))]
    (replayer/apply-op! *node* (op-record ts)
                        [(audit-row "documents" doc-id post)])
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (with-redefs [media/media-exists? (constantly true)
                  ;; Bypass the real fetch-by-id and force "doc absent in OLTP"
                  ;; without standing up a real SQLite tx — keeps this hermetic.
                  plaid.sql.common/fetch-by-id (constantly nil)]
      (let [got (history-doc/get-at *node* doc-id ts {:oltp-db empty-oltp-db})]
        (is (some? got) "doc is still readable from history at ts")
        (is (not (contains? got :document/media-url))
            "media-url omitted for deleted-doc at-time read (option B)")))))

(deftest get-at-keeps-media-url-when-doc-present-in-oltp
  ;; Sanity: live doc (present in OLTP) still gets media-url.
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T16:00:00Z")
        cursor-ts-iso "2026-05-28T16:01:00Z"
        post {:id (str doc-id)
              :name "LiveDoc"
              :project_id (str prj-id)
              :version 1
              :created_at "2026-05-28T16:00:00Z"
              :modified_at "2026-05-28T16:00:00Z"}
        present-oltp-db (reify java.lang.AutoCloseable (close [_]))]
    (replayer/apply-op! *node* (op-record ts)
                        [(audit-row "documents" doc-id post)])
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (with-redefs [media/media-exists? (constantly true)
                  plaid.sql.common/fetch-by-id (constantly {:id doc-id})]
      (let [got (history-doc/get-at *node* doc-id ts {:oltp-db present-oltp-db})]
        (is (some? (:document/media-url got))
            "media-url present when OLTP still has the doc")))))

(deftest get-at-legacy-arity-preserves-media-url-without-oltp-check
  ;; The 3-arity (no oltp-db) preserves the old behavior — media-url
  ;; attached iff the file exists, no OLTP probe. Existing test
  ;; coverage (get-at-attaches-media-url-when-file-present) already
  ;; pins this for the on-disk happy path; we add the off-disk case
  ;; here so a refactor that flips the legacy default fails loud.
  (let [doc-id (uuid)
        prj-id (uuid)
        ts (Instant/parse "2026-05-28T16:00:00Z")
        cursor-ts-iso "2026-05-28T16:01:00Z"
        post {:id (str doc-id) :name "D" :project_id (str prj-id)
              :version 1 :created_at "2026-05-28T16:00:00Z"
              :modified_at "2026-05-28T16:00:00Z"}]
    (replayer/apply-op! *node* (op-record ts)
                        [(audit-row "documents" doc-id post)])
    (xt/submit-tx *node*
                  [(history-core/cursor->tx-op
                    {:last-op-ts cursor-ts-iso
                     :last-op-id (uuid)
                     :last-seq 0
                     :tailer-status :running})])
    (with-redefs [media/media-exists? (constantly false)]
      (is (not (contains? (history-doc/get-at *node* doc-id ts) :document/media-url))
          "3-arity drops media-url when the file isn't on disk — unchanged from before"))))
