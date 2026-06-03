(ns plaid.olap.document
  "Time-travel read API over the XTDB v2 OLAP replica.

  The OLAP store mirrors OLTP document state at every committed
  operation's wall-clock time. Each read here queries XTDB with
  `:snapshot-time = ts`, so the entire deep-read assembled by
  `get-with-layer-data-at` is coherent at a single logical point in
  time — XTDB's coherence guarantee is per-query, so every sub-query
  must pass the same `ts`.

  Read shape is the contract of `plaid.sql.document/get` /
  `get-with-layer-data` — REST consumers depend on the exact key set.
  When the replayer doc shape doesn't match the SQL read shape (e.g.
  OLAP stores `:document/created-at`, SQL returns `:document/time-created`),
  reshaping happens HERE so the replayer can stay close to the audit
  post-image and the caller stays oblivious to the storage layout.

  Anti-features (DO NOT add): no arbitrary search, no analytics, no
  writes, no historical-ACL — see `plaid.olap.core` docstring."
  (:require [clojure.data.json :as json]
            [clojure.string :as str]
            [plaid.media.storage :as media]
            [plaid.olap.core :as olap]
            [plaid.sql.common :as psc]
            [plaid.sql.token-layer :as token-layer]
            [taoensso.timbre :as log]
            [xtdb.api :as xt])
  (:refer-clojure :exclude [get]))

;; OLTP stores `spans.value` / `relations.value` as JSON-encoded scalars
;; (so the column can hold string | number | bool | null with a single
;; type). The OLTP read path decodes via `psc/read-json` before returning
;; — so the OLAP read path must too, or `:span/value` / `:relation/value`
;; diverge between live and historical reads ("\"GREETING\"" vs "GREETING").
;;
;; Defensive on input shape: `read-json` throws on non-strings (the audit
;; pipeline normally serializes to a JSON string before storage, but a
;; replayer change or a hand-crafted audit row could deliver a pre-decoded
;; scalar). Pass non-strings through unchanged rather than 500ing the
;; whole deep-read with a stack-leaking ClassCastException.
;;
;; Empty / whitespace-only string is its own branch: `(string? "  ")` is
;; true, but `psc/read-json "  "` ultimately invokes
;; `clojure.data.json/read-str` on a stream of only whitespace, which
;; throws EOFException. Production should never emit a blank value, but a
;; pre-trim replayer bug or hand-crafted row could; treat any blank
;; string ("", " ", "\t", "\n") as nil to match the `psc/parse-config`
;; `(= s "") {}` short-circuit spirit (generalized to `str/blank?` so
;; whitespace-only never reaches `read-json`).
(defn- decode-value [v]
  (cond
    (nil? v) nil
    (and (string? v) (str/blank? v)) nil
    (string? v) (psc/read-json v)
    :else v))

;; ============================================================
;; Staleness guard
;; ============================================================
;;
;; Every public read flows through `check-staleness!` before touching
;; XTDB. We refuse to serve when (a) the tailer has stalled — its
;; cursor is frozen behind `last-op-ts`, so anything we'd return at a
;; ts past that cursor would silently drift from OLTP, and (b) the
;; caller asked for a ts past the cursor — we don't have that state
;; yet. Either case throws ex-info with a typed `:type` so the REST
;; middleware can map to 503 / 425.

(defn- ->instant
  "Coerce caller-supplied `ts` (Instant, ISO-8601 string, or Date) to
  java.time.Instant. Delegated to the core helper."
  ^java.time.Instant [ts]
  (olap/->instant ts))

(defn- cursor-instant
  "Pull the cursor's `:last-op-ts` as an Instant, or nil if no cursor
  has been written yet (cold-start)."
  ^java.time.Instant [cursor]
  (some-> cursor :last-op-ts ->instant))

(defn- check-staleness!
  "Throws if the tailer is stalled or the requested `ts` is past the
  cursor. The thrown ex-info's `:type` is `:olap/stalled` or
  `:olap/not-caught-up` for REST mapping (503 / 425).

  Cold-start (no cursor doc) is treated as not-caught-up — there is
  literally no state to serve."
  [node ts-inst]
  (let [cursor (olap/cursor-read node)]
    (when (= :stalled (:tailer-status cursor))
      (throw (ex-info "olap tailer stalled"
                      {:type :olap/stalled
                       :stall-reason (:stall-reason cursor)})))
    (let [last (cursor-instant cursor)]
      (when (or (nil? last) (.isAfter ts-inst last))
        (throw (ex-info "olap not caught up"
                        {:type :olap/not-caught-up
                         :olap-cursor cursor
                         :requested-ts (str ts-inst)}))))))

;; ============================================================
;; Junction-key parsing
;; ============================================================
;;
;; Per the design (xtdb-nil-stripping + nested-key-lowercasing memos),
;; `:metadata` is stored as a JSON string on every entity that carries
;; metadata. Token-id arrays (`:tokens` on spans / vocab-links) are
;; stored as vectors of UUIDs — XTDB v2 round-trips top-level vectors
;; without key mangling.

(defn- decode-metadata
  "Parse the JSON-string `:metadata` value into a Clojure map. Keys
  stay as STRINGS to match the SQL read path (see
  `plaid.sql.metadata/decode-value`). Returns nil for nil/empty."
  [v]
  (cond
    (nil? v) nil
    (map? v) v
    (string? v)
    (try
      (let [parsed (json/read-str v)]
        (when (and (map? parsed) (seq parsed))
          parsed))
      ;; Graceful degradation: a single corrupt metadata blob must NOT
      ;; 500 the whole deep read. But make it observable — a silent nil
      ;; would let a bad blob vanish without any signal. Log at :warn
      ;; naming the offending value, then return nil.
      (catch Exception e
        (log/warn e "OLAP decode-metadata: failed to parse metadata JSON, dropping it"
                  {:value v})
        nil))
    :else nil))

(defn- attach-meta
  "Patch `:metadata` into the assembled entity map iff the OLAP doc
  carried one. Mirrors `plaid.sql.document/attach-meta` — `:metadata`
  is absent on the result map when there is no metadata for this
  entity (NOT present as nil), matching what the SQL deep-read does."
  [m raw-metadata]
  (let [decoded (decode-metadata raw-metadata)]
    (if (seq decoded)
      (assoc m :metadata decoded)
      m)))

(defn- decode-config
  "Layer `:config` blob storage. Replayer stores it as a JSON string
  for the same reason as `:metadata` — nested keys would otherwise be
  lowercased by XTDB v2."
  [v]
  (cond
    (nil? v) {}
    (map? v) v
    (string? v)
    (try (or (json/read-str v) {})
         ;; Same graceful-but-observable degradation as decode-metadata:
         ;; a corrupt config blob falls back to {} rather than 500ing the
         ;; read, but we log :warn so the corruption isn't silent.
         (catch Exception e
           (log/warn e "OLAP decode-config: failed to parse config JSON, defaulting to {}"
                     {:value v})
           {}))
    :else {}))

;; ============================================================
;; XTDB query helpers
;; ============================================================
;;
;; SQL is the chosen surface for the read path here. XTDB v2.2.0-beta1's
;; XTQL parameter story is shaky — `:args {:k v}` with `$k` / `?k`
;; references errors with "not all variables in expression are in
;; scope"; the only working path is `xt/template` with `~unquote`,
;; which embeds the param into the query AST every call (defeats
;; cacheability and is awkward for IN-list pagination). SQL with `?`
;; positional params just works, supports IN-lists natively, and round-
;; trips column kebab-casing the same way next.jdbc does on the OLTP
;; side (see `q` in plaid.sql.common). Also `SELECT *` works in SQL
;; whereas XTQL's `*` returns empty maps (a v2 oddity).
;;
;; SCHEMA NAMING: a stored table `:olap/documents` is exposed in SQL
;; as `olap.documents` (XTDB v2 maps the keyword namespace to a SQL
;; schema). The `_id` column is the entity id; we alias to `id` for
;; consistency with the SQL-port row shape.
;;
;; STORAGE COLUMN NAMES — non-obvious XTDB v2 convention. A
;; `put-docs` of `{:document/time-created "..."}` is exposed in SQL as
;; column `document$time_created`: namespace + `$` + local-name, with
;; the local-name kebab→snake-cased (PostgreSQL identifier rules) but
;; the namespace and `$` separator preserved verbatim. Bare local
;; names like `name` or `time_created` DO NOT resolve — selecting
;; them returns a column populated with NULLs (no error, just silent
;; data loss). This was the root cause of the 2026-05-28 bug where
;; `?as-of=` returned 200 with mostly-nil document fields.
;;
;; Unqualified (junction) keys like `:tokens` / `:metadata` stay bare
;; (no `$`) because they have no namespace to splice in.
;;
;; `attr->col` is the SINGLE place this convention is captured — every
;; SELECT goes through `col-as` so renaming an attr is a one-line
;; change to the replayer's per-table spec, not a scavenger hunt
;; through SQL string literals here.

(defn- attr->col
  "Translate a namespaced attr keyword (`:document/time-created`) to the
  XTDB v2 SQL storage column name (`\"document$time_created\"`).
  Unqualified keywords (junction folds like `:metadata`, `:tokens`)
  stay as their lowercased local name.

  Namespace is lowercased; dashes in the namespace become underscores
  (matching how XTDB lowercases nested column names — see the
  per-table specs in `plaid.olap.replayer/table->spec`)."
  [k]
  (let [local (-> (name k) (str/replace \- \_) str/lower-case)]
    (if-let [ns* (namespace k)]
      (str (-> ns* (str/replace \- \_) str/lower-case) "$" local)
      local)))

(defn- col-as
  "Build a `\"<storage-col> AS <alias>\"` SELECT-list fragment. Aliases
  are short kebab-cased identifiers (e.g. `:created-at`, `:layer`) so
  the result-row keys stay stable regardless of how XTDB happens to
  spell the storage column."
  [attr alias-kw]
  (str (attr->col attr) " AS " (name alias-kw)))

;; ============================================================
;; Single-entity reads — the `get` shape
;; ============================================================

(defn- q
  "Pin `:snapshot-time ts` on every SQL query — XTDB's coherence is
  per-query, so the entire deep read uses the same `ts` for the same
  bitemporal slice. Retries XTDB's stale-cached-plan conflict (the olap.*
  result types evolve as annotations land — see `olap/plan-retrying`)."
  [node ts sql-vec]
  (olap/plan-retrying 3 (fn [] (xt/q node sql-vec {:snapshot-time ts}))))

(defn- attach-media-url
  "Mirror of `plaid.sql.document/get`'s media-url attach. Media files
  are NOT bitemporal (single file on disk per doc-id), so this is a
  current-filesystem probe at read time — same as v2's behavior in
  `plaid.xtdb2.document/get`, which also probed the filesystem
  irrespective of `:snapshot-time`. Shape conformance with the OLTP
  read is what makes the REST 200 body interchangeable between live
  and at-time GETs.

  Option B choice (task #138): when an `:oltp-db` is supplied AND the
  doc is currently absent from OLTP (deleted), we omit
  `:document/media-url`. The URL goes through media routes whose auth
  uses OLTP-only project lookup, so for a deleted doc it would return
  403/404 — handing the caller a clickable-but-broken URL is worse than
  a missing key. Live (non-deleted) at-time reads keep the URL: those
  routes resolve fine. When no `:oltp-db` is provided (older callers,
  tests), behavior is unchanged."
  [m doc-id oltp-db]
  (let [doc-deleted? (and (some? oltp-db)
                          (nil? (psc/fetch-by-id oltp-db :documents doc-id)))]
    (cond-> m
      (and (not doc-deleted?) (media/media-exists? doc-id))
      (assoc :document/media-url (str "/api/v1/documents/" doc-id "/media")))))

(defn- fetch-document-row
  "Pull the bare `:olap/documents` row for `doc-id` at `ts`, or nil if
  the document didn't exist at that snapshot. The storage-shape
  attributes are reshaped to the SQL read shape (`:document/time-created`
  / `:document/time-modified`) here so callers always see the SQL
  contract.

  `oltp-db` (nilable) is forwarded to `attach-media-url` so it can omit
  `:document/media-url` for docs deleted from OLTP — see that fn's
  docstring."
  [node doc-id ts oltp-db]
  (let [row (first
             (q node ts
                [(str "SELECT _id AS id, "
                      (col-as :document/name :name) ", "
                      (col-as :document/project :project) ", "
                      (col-as :document/version :version) ", "
                      (col-as :document/time-created :time_created) ", "
                      (col-as :document/time-modified :time_modified) ", "
                      "metadata "
                      "FROM olap.documents WHERE _id = ?") doc-id]))]
    (when row
      (-> {:document/id (:id row)
           :document/name (:name row)
           :document/project (:project row)
           :document/version (:version row)
           :document/time-created (:time-created row)
           :document/time-modified (:time-modified row)}
          (attach-meta (:metadata row))
          (attach-media-url (:id row) oltp-db)))))

(defn get-at
  "Shape of `plaid.sql.document/get` at time `ts`. Returns nil if the
  document didn't exist at `ts`.

  `:document/media-url` matches OLTP shape: present iff a media file
  exists on disk RIGHT NOW for this doc-id (media isn't versioned in
  either OLTP or OLAP, so neither side probes bitemporally). When
  `:oltp-db` is supplied and the doc is currently absent from OLTP
  (deleted), the URL is omitted because the media route would 403/404
  on it — see `attach-media-url`."
  ([node doc-id ts] (get-at node doc-id ts {}))
  ([node doc-id ts {:keys [oltp-db]}]
   (let [ts (->instant ts)]
     (check-staleness! node ts)
     (fetch-document-row node doc-id ts oltp-db))))

(defn exists-at?
  "Cheap presence probe. Returns true/false. Like `get-at`, throws on
  stale / stalled — a caller asking 'did this doc exist at T' needs the
  same caught-up guarantee as a read."
  [node doc-id ts]
  (let [ts (->instant ts)]
    (check-staleness! node ts)
    (boolean
     (first
      (q node ts
         ["SELECT _id FROM olap.documents WHERE _id = ? LIMIT 1" doc-id])))))

;; ============================================================
;; Deep read — the `get-with-layer-data` shape
;; ============================================================
;;
;; The shape is intentionally identical to plaid.sql.document/
;; get-with-layer-data — REST tests pass against either backend. The
;; assembler walks layers top-down (text → token → span → relation)
;; and attaches the document-scoped rows (texts / tokens / spans /
;; relations / vocab-links) under their owning layer.
;;
;; All XTDB queries pin `:snapshot-time ts`; that's the entire
;; coherence story — XTDB's bitemporal index returns each entity's
;; state at `ts` regardless of how we order the queries.

(defn- in-placeholders
  "Render `(?, ?, ?)` for an IN-list of count N. Caller is responsible
  for splicing the actual values into the parameter vector. Splits the
  ID list into per-call SQL fragment + flat params — keeps the call
  site readable for the common case where IN is the only parameterized
  filter."
  [n]
  (str "(" (str/join "," (repeat n "?")) ")"))

(defn- q-text-layers
  "Project's text layers at `ts`, ordered by `:order-idx`. Project is
  denormalized onto the layer doc (same as in the OLTP schema), so
  this is a single-id filter."
  [node prj-id ts]
  (let [order-col (attr->col :text-layer/order-idx)]
    (->> (q node ts
            [(str "SELECT _id AS id, "
                  (col-as :text-layer/name :name) ", "
                  (col-as :text-layer/project :project) ", "
                  (col-as :text-layer/order-idx :order_idx) ", "
                  "config "
                  "FROM olap.text_layers "
                  "WHERE " (attr->col :text-layer/project) " = ? "
                  "ORDER BY " order-col) prj-id])
         vec)))

(defn- q-token-layers
  [node tl-ids ts]
  (if (empty? tl-ids)
    []
    (let [order-col (attr->col :token-layer/order-idx)
          fk-col (attr->col :token-layer/text-layer)]
      (->> (q node ts
              (into [(str "SELECT _id AS id, "
                          (col-as :token-layer/name :name) ", "
                          (col-as :token-layer/text-layer :text_layer) ", "
                          (col-as :token-layer/project :project) ", "
                          (col-as :token-layer/overlap-mode :overlap_mode) ", "
                          (col-as :token-layer/parent-token-layer :parent_token_layer) ", "
                          (col-as :token-layer/order-idx :order_idx) ", "
                          "config "
                          "FROM olap.token_layers "
                          "WHERE " fk-col " IN "
                          (in-placeholders (count tl-ids))
                          " ORDER BY " order-col)]
                    tl-ids))
           vec))))

(defn- q-span-layers
  [node tokl-ids ts]
  (if (empty? tokl-ids)
    []
    (let [order-col (attr->col :span-layer/order-idx)
          fk-col (attr->col :span-layer/token-layer)]
      (->> (q node ts
              (into [(str "SELECT _id AS id, "
                          (col-as :span-layer/name :name) ", "
                          (col-as :span-layer/token-layer :token_layer) ", "
                          (col-as :span-layer/project :project) ", "
                          (col-as :span-layer/order-idx :order_idx) ", "
                          "config "
                          "FROM olap.span_layers "
                          "WHERE " fk-col " IN "
                          (in-placeholders (count tokl-ids))
                          " ORDER BY " order-col)]
                    tokl-ids))
           vec))))

(defn- q-relation-layers
  [node sl-ids ts]
  (if (empty? sl-ids)
    []
    (let [order-col (attr->col :relation-layer/order-idx)
          fk-col (attr->col :relation-layer/span-layer)]
      (->> (q node ts
              (into [(str "SELECT _id AS id, "
                          (col-as :relation-layer/name :name) ", "
                          (col-as :relation-layer/span-layer :span_layer) ", "
                          (col-as :relation-layer/project :project) ", "
                          (col-as :relation-layer/order-idx :order_idx) ", "
                          "config "
                          "FROM olap.relation_layers "
                          "WHERE " fk-col " IN "
                          (in-placeholders (count sl-ids))
                          " ORDER BY " order-col)]
                    sl-ids))
           vec))))

(defn- q-texts
  [node doc-id ts]
  (q node ts
     [(str "SELECT _id AS id, "
           (col-as :text/document :document) ", "
           (col-as :text/layer :text_layer) ", "
           (col-as :text/body :body) ", "
           "metadata "
           "FROM olap.texts "
           "WHERE " (attr->col :text/document) " = ?") doc-id]))

(defn- q-tokens
  [node doc-id ts]
  (q node ts
     [(str "SELECT _id AS id, "
           (col-as :token/document :document) ", "
           (col-as :token/text :text_id) ", "
           (col-as :token/layer :token_layer) ", "
           (col-as :token/begin :tok_begin) ", "
           (col-as :token/end :end_) ", "
           (col-as :token/precedence :precedence) ", "
           "metadata "
           "FROM olap.tokens "
           "WHERE " (attr->col :token/document) " = ?") doc-id]))

(defn- q-spans
  [node doc-id ts]
  ;; ORDER BY _id: deterministic ordering so the OLTP↔OLAP parity test
  ;; doesn't rely on coincidental row order matching across backends.
  ;; SQLite has no inherent row order without an ORDER BY, and XTDB v2
  ;; gives no guarantee either — pinning both sides to id keeps the
  ;; comparison cheap and stable.
  (q node ts
     [(str "SELECT _id AS id, "
           (col-as :span/document :document) ", "
           (col-as :span/layer :layer) ", "
           (col-as :span/value :value) ", "
           "tokens, metadata "
           "FROM olap.spans "
           "WHERE " (attr->col :span/document) " = ? "
           "ORDER BY _id") doc-id]))

(defn- q-relations
  [node doc-id ts]
  (q node ts
     [(str "SELECT _id AS id, "
           (col-as :relation/document :document) ", "
           (col-as :relation/layer :layer) ", "
           (col-as :relation/source :source) ", "
           (col-as :relation/target :target) ", "
           (col-as :relation/value :value) ", "
           "metadata "
           "FROM olap.relations "
           "WHERE " (attr->col :relation/document) " = ? "
           "ORDER BY _id") doc-id]))

(defn- q-vocab-links
  [node doc-id ts]
  (q node ts
     [(str "SELECT _id AS id, "
           (col-as :vocab-link/document :document) ", "
           (col-as :vocab-link/vocab-item :vocab_item) ", "
           "tokens, metadata "
           "FROM olap.vocab_links "
           "WHERE " (attr->col :vocab-link/document) " = ?") doc-id]))

(defn- q-vocab-items
  [node vi-ids ts]
  (if (empty? vi-ids)
    []
    (q node ts
       (into [(str "SELECT _id AS id, "
                   (col-as :vocab-item/layer :layer) ", "
                   (col-as :vocab-item/form :form) ", "
                   "metadata "
                   "FROM olap.vocab_items WHERE _id IN "
                   (in-placeholders (count vi-ids)))]
             vi-ids))))

(defn- q-vocab-layers
  [node vl-ids ts]
  (if (empty? vl-ids)
    []
    (q node ts
       (into [(str "SELECT _id AS id, "
                   (col-as :vocab/name :name) ", "
                   "config, maintainers "
                   "FROM olap.vocab_layers WHERE _id IN "
                   (in-placeholders (count vl-ids)))]
             vl-ids))))

(defn get-with-layer-data-at
  "Deep document read at time `ts`. Result shape mirrors
  `plaid.sql.document/get-with-layer-data` — same top-level keys, same
  nested layer-tree, same junction folding.

  Returns nil if the document didn't exist at `ts`. Throws on stale or
  stalled OLAP — REST middleware converts these to 425 / 503.

  Coherence: every sub-query pins `:snapshot-time ts`, so the entire
  reassembled tree reflects state at the same logical moment — even if
  a write happened mid-read, both halves of any FK pair (e.g. token
  and its referencing span) see the same snapshot.

  Optional `:oltp-db` — when supplied and the doc is currently absent
  from OLTP (deleted), `:document/media-url` is omitted. See
  `attach-media-url`."
  ([node doc-id ts] (get-with-layer-data-at node doc-id ts {}))
  ([node doc-id ts {:keys [oltp-db]}]
   (let [ts (->instant ts)]
     (check-staleness! node ts)
     (when-let [doc (fetch-document-row node doc-id ts oltp-db)]
       (let [prj-id (:document/project doc)
             text-layers (q-text-layers node prj-id ts)
             tl-ids (mapv :id text-layers)
             token-layers (q-token-layers node tl-ids ts)
             tokl-ids (mapv :id token-layers)
             span-layers (q-span-layers node tokl-ids ts)
             sl-ids (mapv :id span-layers)
             relation-layers (q-relation-layers node sl-ids ts)
             texts (q-texts node doc-id ts)
             tokens (q-tokens node doc-id ts)
             spans (q-spans node doc-id ts)
             relations (q-relations node doc-id ts)
             vocab-links (q-vocab-links node doc-id ts)
             vi-ids (->> vocab-links (map :vocab-item) distinct (remove nil?) vec)
             vocab-items (q-vocab-items node vi-ids ts)
             vlayer-ids (->> vocab-items (map :layer) distinct (remove nil?) vec)
             vocab-layers (q-vocab-layers node vlayer-ids ts)
            ;; --- grouping (SELECT aliases are snake-cased; XTDB returns
            ;; them as kebab-cased keys: `text_layer` → `:text-layer`,
            ;; `order_idx` → `:order-idx`). ---
             text-by-layer (into {} (map (juxt :text-layer identity)) texts)
             tokens-by-layer (group-by :token-layer tokens)
             spans-by-layer (group-by :layer spans)
             relations-by-layer (group-by :layer relations)
             relation-layers-by-sl (group-by :span-layer relation-layers)
             span-layers-by-tl (group-by :token-layer span-layers)
             token-layers-by-tl (group-by :text-layer token-layers)
             token-id->layer (into {} (map (juxt :id :token-layer)) tokens)
             vi-by-id (into {} (map (juxt :id identity)) vocab-items)
             vlayer-by-id (into {} (map (juxt :id identity)) vocab-layers)
            ;; A vocab-link attaches under every token-layer it touches
            ;; (the v2 contract — a cross-layer link appears under each).
             vl->token-layers
             (reduce (fn [acc vl]
                       (let [tlids (->> (or (:tokens vl) [])
                                        (map token-id->layer)
                                        (remove nil?)
                                        distinct vec)]
                         (assoc acc (:id vl) tlids)))
                     {} vocab-links)
             vl-by-id (into {} (map (juxt :id identity)) vocab-links)
             links-by-token-layer
             (reduce (fn [acc [vl-id tlids]]
                       (reduce (fn [a tlid]
                                 (update a tlid (fnil conj []) vl-id))
                               acc tlids))
                     {} vl->token-layers)
            ;; --- builders ---
             build-token
            ;; SELECT aliases (see q-tokens): :text-id → :token/text,
            ;; :tok-begin → :token/begin, :end- → :token/end. The `text`
            ;; / `begin` aliases dodge SQL reserved words; `end_`
            ;; mirrors the OLTP column name.
             (fn [t]
               (-> {:token/id (:id t)
                    :token/document (:document t)
                    :token/text (:text-id t)
                    :token/begin (:tok-begin t)
                    :token/end (or (:end- t) (:end t))
                    :token/precedence (:precedence t)}
                   (attach-meta (:metadata t))))
             build-span
             (fn [s]
               (-> {:span/id (:id s)
                    :span/document (:document s)
                    :span/value (decode-value (:value s))
                    :span/tokens (or (:tokens s) [])}
                   (attach-meta (:metadata s))))
             build-relation
             (fn [r]
               (-> {:relation/id (:id r)
                    :relation/document (:document r)
                    :relation/source (:source r)
                    :relation/target (:target r)
                    :relation/value (decode-value (:value r))}
                   (attach-meta (:metadata r))))
             build-vocab-item
             (fn [vi-id]
               (when-let [vi (vi-by-id vi-id)]
                 (-> {:vocab-item/id vi-id
                      :vocab-item/layer (:layer vi)
                      :vocab-item/form (:form vi)}
                     (attach-meta (:metadata vi)))))
             build-link
             (fn [vl-id]
               (let [vl (vl-by-id vl-id)
                     base {:vocab-link/id vl-id
                           :vocab-link/vocab-item (build-vocab-item (:vocab-item vl))
                           :vocab-link/tokens (or (:tokens vl) [])}]
                 (attach-meta base (:metadata vl))))
             build-vocabs-for-token-layer
             (fn [tl-id]
               (let [vl-ids (clojure.core/get links-by-token-layer tl-id [])
                     links (mapv build-link vl-ids)
                     by-vlayer (group-by (fn [l]
                                           (:vocab-item/layer
                                            (:vocab-link/vocab-item l)))
                                         links)]
                 (->> by-vlayer
                      (keep (fn [[vlayer-id ls]]
                              (when-let [vl (vlayer-by-id vlayer-id)]
                                {:vocab/id vlayer-id
                                 :vocab/name (:name vl)
                                 ;; Sort maintainers by id so OLAP matches
                                 ;; the OLTP read (which ORDER BYs the
                                 ;; vocab_maintainers join on user_id).
                                 ;; Without this the folded list could come
                                 ;; back in XTDB's storage order and diverge
                                 ;; from OLTP, breaking the parity test.
                                 :vocab/maintainers (vec (sort (or (:maintainers vl) [])))
                                 :config (decode-config (:config vl))
                                 :vocab-layer/vocab-links ls})))
                      vec)))
             build-relation-layer
             (fn [rl]
               {:relation-layer/id (:id rl)
                :relation-layer/name (:name rl)
                :config (decode-config (:config rl))
                :relation-layer/relations
                (->> (clojure.core/get relations-by-layer (:id rl) [])
                     (mapv build-relation))})
             build-span-layer
             (fn [sl]
               (let [spans-here (->> (clojure.core/get spans-by-layer (:id sl) [])
                                     (mapv build-span))
                     rls (->> (clojure.core/get relation-layers-by-sl (:id sl) [])
                              (sort-by :order-idx)
                              (mapv build-relation-layer))]
                 {:span-layer/id (:id sl)
                  :span-layer/name (:name sl)
                  :config (decode-config (:config sl))
                  :span-layer/spans spans-here
                  :span-layer/relation-layers rls}))
             build-token-layer
             (fn [tl]
               (let [raw-toks (->> (clojure.core/get tokens-by-layer (:id tl) [])
                                   (mapv build-token))
                     toks (vec (token-layer/sort-token-records raw-toks))
                     sls (->> (clojure.core/get span-layers-by-tl (:id tl) [])
                              (sort-by :order-idx)
                              (mapv build-span-layer))
                     vocabs (build-vocabs-for-token-layer (:id tl))]
                 {:token-layer/id (:id tl)
                  :token-layer/name (:name tl)
                  :config (decode-config (:config tl))
                  :token-layer/overlap-mode (some-> (:overlap-mode tl) keyword)
                  :token-layer/parent-token-layer (:parent-token-layer tl)
                  :token-layer/tokens toks
                  :token-layer/span-layers sls
                  :token-layer/vocabs vocabs}))
             build-text-layer
             (fn [txtl]
               (let [text (text-by-layer (:id txtl))
                     text-map (when text
                                (-> {:text/id (:id text)
                                     :text/document (:document text)
                                     :text/body (:body text)}
                                    (attach-meta (:metadata text))))
                     tls (->> (clojure.core/get token-layers-by-tl (:id txtl) [])
                              (sort-by :order-idx)
                              (mapv build-token-layer))]
                 {:text-layer/id (:id txtl)
                  :text-layer/name (:name txtl)
                  :config (decode-config (:config txtl))
                  :text-layer/text text-map
                  :text-layer/token-layers tls}))]
         (assoc doc :document/text-layers (mapv build-text-layer text-layers)))))))

;; ============================================================
;; Version history
;; ============================================================
;;
;; Each `:put-docs :olap/documents` at a new system-time produces a
;; new version row in XTDB's `_system_from` history axis. Driving
;; `list-versions` off the document's own history (rather than the
;; full ops touching its sub-entities) is a deliberate simplification
;; — the document's `:document/version` is bumped on every op that
;; touches anything in the doc (see plaid.sql.operation/
;; bump-document-version!), so the document history IS the per-op
;; touch list.

(def ^:private default-limit 50)
(def ^:private max-limit 500)

(defn- clamp-limit [n]
  (let [n (cond
            (nil? n) default-limit
            (integer? n) n
            :else (try (Long/parseLong (str n))
                       (catch Exception _ default-limit)))]
    (max 1 (min n max-limit))))

(defn- ->instant-maybe
  "Nilable variant of `olap/->instant`. Delegated so the two coercion
  helpers cannot drift — see the docstring of `olap/->instant` for the
  accepted input types."
  [v]
  (when (some? v)
    (olap/->instant v)))

(defn list-versions
  "Return a vector of `{:ts :version}` maps — one entry per operation
  that touched `doc-id`. Driven off XTDB's bitemporal history on
  `:olap/documents` (every op bumps the document's `:document/version`,
  so the doc's system-time axis IS the per-op touch list).

  `:op-id` is intentionally omitted: an op that touches only a sub-
  entity (e.g. a single span edit) doesn't re-put-docs the document
  beyond the version bump, so the op-id isn't on the doc row. The REST
  layer can resolve op-ids by joining against the `operations` table
  on the document_id and the `:ts` returned here.

  Options:
    :from   — only versions with `ts >= from` (inclusive)
    :to     — only versions with `ts < to` (exclusive)
    :limit  — default 50, max 500
    :cursor — opaque pagination cursor (pass back the previous page's
              last `:ts` to fetch the next page; newest-first ordering)"
  [node doc-id {:keys [from to limit cursor]}]
  ;; Stall guard mirrors the other public reads but only on tailer
  ;; status — version history is meaningful at any cursor position
  ;; ("what versions do you know about?"), so we deliberately skip the
  ;; "ts past cursor" branch of `check-staleness!`. A stalled tailer
  ;; still throws :olap/stalled because the history would silently
  ;; drift from OLTP otherwise.
  (let [cur (olap/cursor-read node)]
    (when (= :stalled (:tailer-status cur))
      (throw (ex-info "olap tailer stalled"
                      {:type :olap/stalled
                       :stall-reason (:stall-reason cur)}))))
  (let [lim (clamp-limit limit)
        to-cursor (some-> cursor ->instant)
        to-explicit (some-> to ->instant)
        ;; Pagination is newest-first: cursor (previous page's oldest
        ;; ts) becomes the next page's exclusive upper bound.
        upper (cond
                (and to-cursor to-explicit)
                (if (.isBefore to-cursor to-explicit) to-cursor to-explicit)
                :else (or to-cursor to-explicit))
        lower (some-> from ->instant)
        ;; Walk the bitemporal history of the document row via SQL's
        ;; FOR ALL SYSTEM_TIME — every put-docs at a new system-time
        ;; emits a row here.
        rows (olap/plan-retrying
              3
              (fn []
                (xt/q node
                      [(str "SELECT "
                            (col-as :document/version :version) ", "
                            "_system_from "
                            "FROM olap.documents FOR ALL SYSTEM_TIME "
                            "WHERE _id = ?") doc-id])))
        prepped (->> rows
                     (keep (fn [r]
                             (when-let [sf (:xt/system-from r)]
                               {:ts (->instant-maybe sf)
                                :version (:version r)})))
                     (filter (fn [{:keys [ts]}]
                               (and (or (nil? lower) (not (.isBefore ts lower)))
                                    (or (nil? upper) (.isBefore ts upper)))))
                     (sort-by :ts #(compare %2 %1)))]
    (->> prepped
         (take lim)
         (mapv (fn [{:keys [ts version]}]
                 {:ts (.toString ts)
                  :version version})))))

;; ============================================================
;; Cursor accessor (public passthrough)
;; ============================================================

(defn olap-cursor
  "Return the OLAP tailer's cursor as a plain map for /health and
  staleness diagnostics. Returns `nil` if no cursor exists yet (the
  pre-cold-replay state)."
  [node]
  (when-let [cur (olap/cursor-read node)]
    {:ts (:last-op-ts cur)
     :op-id (:last-op-id cur)
     :seq (:last-seq cur)
     :status (or (:tailer-status cur) :running)}))
