(ns plaid.sql.metadata
  "SQL-side metadata helpers backed by the `entity_metadata` table.

  Where the XTDB v2 port stuffed metadata into a per-entity-type
  `<entity-type>/metadata` JSON column, the SQL port normalizes it
  into a wide-narrow table keyed on (entity_type, entity_id, key).

  ## Parent-owned :delete contract (task #58)

  Metadata is PARENT-OWNED with respect to the audit log. On
  `:insert` and `:update` of a parent entity, metadata IS folded into
  the parent row's audit image (post or pre-and-post) — see
  `emit-parent-audit!` below and the `insert`/`update` paths in
  span.clj, vocab_link.clj, relation.clj, token.clj. On `:delete`
  of a parent entity, however, the parent's `:delete` audit row
  carries ONLY the bare parent row columns; the metadata going away
  is IMPLIED by the parent's deletion and NO separate audit row is
  emitted for the metadata cleanup. The `entity_metadata` rows are
  swept by `sweep-metadata!` (unaudited) in the cascade callers.

  Consequence: the ETL replayer is responsible for maintaining a
  running junction state per entity (which it already needs for
  `:update` rows that fold metadata in) so it knows what metadata an
  entity had at the moment of its deletion. This asymmetry trades a
  bit more replayer state for cheaper `:delete` audit rows (no
  re-fetch of the metadata at delete time).

  Public API (Clojure):
    (get-metadata db entity-type entity-id)
      => {<key-string> <decoded-value> ...}

    (insert-metadata! tx entity-type entity-id m)
      INSERT one row per (k,v). Values are JSON-encoded so primitives
      and maps round-trip cleanly. No-op for nil/empty m.

    (replace-metadata! tx entity-type entity-id m)
      DELETE existing rows then INSERT the new ones.

    (delete-metadata! tx entity-type entity-id)
      DELETE all rows for (entity_type, entity_id).

    (add-metadata-to-response db core-attrs entity-type entity-id)
      Reader-side helper that mirrors the v2
      `metadata/add-metadata-to-response` contract: looks up metadata
      and, if non-empty, assoc's it under :metadata on the response map."
  (:require [clojure.string]
            [plaid.sql.common :as psc])
  (:refer-clojure :exclude [get]))

(def ^:private valid-entity-types
  "Mirrors the v2 entity-type whitelist (`plaid.xtdb2.metadata`)."
  #{"document" "text" "token" "span" "relation" "vocab-item" "vocab-link"})

(def entity-type->table
  "Maps a metadata entity-type string to the parent row's SQL table.
  Used by the metadata mutators to fold the metadata change into a
  synthetic audit_writes row on the parent entity — the `entity_metadata`
  table is wide-narrow + has no audit of its own, so an ETL replayer
  that only sees parent audit rows would otherwise reconstruct entities
  with no metadata."
  {"document"   :documents
   "text"       :texts
   "token"      :tokens
   "span"       :spans
   "relation"   :relations
   "vocab-item" :vocab_items
   "vocab-link" :vocab_links})

(defn validate-entity-type! [entity-type]
  (when-not (valid-entity-types entity-type)
    (throw (ex-info (str "Entity type '" entity-type "' does not support metadata operations.")
                    {:entity-type entity-type :code 400}))))

(def ^:const max-metadata-key-length
  "Hard ceiling on a metadata key length. Generous (no real-world key
  comes close) but bounded so a runaway client can't fill the
  entity_metadata.key column with megabyte strings."
  200)

(defn- control-char?
  "True if `c` is an ASCII control character: U+0000..U+001F or U+007F.
  These would otherwise round-trip through JSON / cli output as escape
  sequences and make log lines / debugger views misleading."
  [^Character c]
  (let [code (long (.charValue c))]
    (or (<= code 0x1F)
        (= code 0x7F))))

(defn valid-metadata-key?
  "True iff `k` is acceptable as a metadata key. Rejects empty strings,
  whitespace-only strings, strings longer than `max-metadata-key-length`,
  and any string containing an ASCII control character. Keywords are
  coerced to their name before validation so callers can pass either
  shape (matches `raw-insert-metadata!`'s tolerant input handling).
  Task #100 V5."
  [k]
  (let [s (cond
            (keyword? k) (name k)
            (string? k)  k
            :else        (str k))]
    (and (not (clojure.string/blank? s))
         (<= (count s) max-metadata-key-length)
         (not-any? control-char? s))))

(defn- validate-metadata-keys!
  "Throw 400 on the first invalid key in `m`. Called by `insert-metadata!`
  and `replace-metadata!` so all write paths share the same gate."
  [m]
  (doseq [[k _v] m]
    (when-not (valid-metadata-key? k)
      (throw (ex-info "Invalid metadata key"
                      {:code 400 :key k})))))

(defn- encode-value [v]
  (psc/write-json v))

(defn- decode-value [s]
  (when (some? s)
    (try
      ;; Keep nested map keys as STRINGS so user-supplied case round-trips.
      ;; psc/read-json keywordizes; we deliberately use raw clojure.data.json here.
      (clojure.data.json/read-str s)
      (catch Exception _
        s))))

(defn get-metadata
  "Return a `{key-string value}` map for the (entity-type, entity-id)
  pair. Empty map if no rows exist."
  [db entity-type entity-id]
  (let [rows (psc/q db {:select [:key :value]
                        :from [:entity_metadata]
                        :where [:and
                                [:= :entity_type entity-type]
                                [:= :entity_id entity-id]]})]
    (into {} (map (fn [{:keys [key value]}]
                    [key (decode-value value)]))
          rows)))

(defn- raw-insert-metadata!
  "Raw INSERT of k/v rows into entity_metadata, no audit. Internal — the
  public `insert-metadata!` wraps this with parent-row audit folding."
  [tx entity-type entity-id m]
  (when (seq m)
    (let [rows (for [[k v] m]
                 {:entity_type entity-type
                  :entity_id entity-id
                  :key (if (keyword? k) (name k) (str k))
                  :value (encode-value v)})]
      (psc/execute! tx {:insert-into :entity_metadata
                        :values (vec rows)}))))

(defn- raw-delete-metadata!
  "Raw DELETE of all metadata rows for (entity-type, entity-id). Internal —
  the public `delete-metadata!` wraps this with parent-row audit folding."
  [tx entity-type entity-id]
  (psc/execute! tx {:delete-from :entity_metadata
                    :where [:and
                            [:= :entity_type entity-type]
                            [:= :entity_id entity-id]]}))

(defn- emit-parent-audit!
  "Emit a synthetic audit_writes row on the parent entity's table that
  captures a metadata transition. The parent row contents are unchanged
  but pre-image carries `:metadata <old>` and post-image carries
  `:metadata <new>`. No-op when pre == post (e.g. replace-with-same map)
  to match the (= pre post) skip in `psc/update-by-id!`.

  Returns nil if the parent row is missing — this can happen when the
  metadata mutator is called BEFORE the parent row exists (rare; the
  current callers always create the parent first) or AFTER the parent
  row has already been audit-deleted (in which case the metadata sweep
  is purely about cleaning the wide-narrow table and the parent's own
  audit row already carries the pre-image metadata)."
  [tx entity-type entity-id pre-meta post-meta]
  (when-let [table (entity-type->table entity-type)]
    (when-let [parent-row (psc/fetch-by-id tx table entity-id)]
      (let [pre-image  (assoc parent-row :metadata (or pre-meta {}))
            post-image (assoc parent-row :metadata (or post-meta {}))]
        (when (not= pre-image post-image)
          (psc/record-audit-write! tx table entity-id :update pre-image post-image))))))

(defn insert-metadata!
  "Insert k/v pairs into entity_metadata and emit a synthetic audit row
  on the parent entity (so an ETL replayer reading only audit_writes can
  reconstruct the metadata transition). No-op for nil/empty maps.
  Values are JSON-encoded so they round-trip cleanly.

  4-arity overload: pass `:skip-parent-audit? true` to suppress the
  synthetic parent-row audit emission. Used by the entity `create`
  paths (span / vocab_link / relation / token) where the caller has
  already emitted ONE synthetic :insert audit row that folds metadata
  into the parent's post_image directly — without the skip flag those
  creates produce a noisy :insert + :update pair against the same
  parent row in the same op (task #59)."
  ([tx entity-type entity-id m]
   (insert-metadata! tx entity-type entity-id m nil))
  ([tx entity-type entity-id m {:keys [skip-parent-audit?]}]
   (when (seq m)
     (validate-metadata-keys! m)
     (let [pre (get-metadata tx entity-type entity-id)]
       (raw-insert-metadata! tx entity-type entity-id m)
       (when-not skip-parent-audit?
         (let [post (get-metadata tx entity-type entity-id)]
           (emit-parent-audit! tx entity-type entity-id pre post)))))))

(defn delete-metadata!
  "Delete every metadata row for (entity-type, entity-id) and emit a
  synthetic parent-row audit row capturing the transition. No-op (and no
  audit row) when there was no metadata to begin with."
  [tx entity-type entity-id]
  (let [pre (get-metadata tx entity-type entity-id)]
    (raw-delete-metadata! tx entity-type entity-id)
    (when (seq pre)
      (emit-parent-audit! tx entity-type entity-id pre {}))))

(defn replace-metadata!
  "Replace all metadata for the entity: DELETE then INSERT. Emits a
  single synthetic parent-row audit row capturing the transition (no-op
  when pre == post)."
  [tx entity-type entity-id m]
  (when (seq m) (validate-metadata-keys! m))
  (let [pre (get-metadata tx entity-type entity-id)]
    (raw-delete-metadata! tx entity-type entity-id)
    (raw-insert-metadata! tx entity-type entity-id m)
    (let [post (get-metadata tx entity-type entity-id)]
      (emit-parent-audit! tx entity-type entity-id pre post))))

(defn sweep-metadata!
  "Raw DELETE of all metadata rows for a list of (entity-type, entity-id).
  Does NOT emit parent-row audit rows — callers use this from cascade
  paths where the parent has already been audit-deleted (its delete row
  is the audit-of-record for the metadata going away). Internal helper
  exposed for use by cascade callers in document.clj / token.clj that
  previously inlined a raw DELETE on :entity_metadata."
  [tx entity-type entity-ids]
  (when (seq entity-ids)
    (psc/execute! tx
                  {:delete-from :entity_metadata
                   :where [:and
                           [:= :entity_type entity-type]
                           [:in :entity_id (vec entity-ids)]]})))

(defn add-metadata-to-response
  "Reader helper. If metadata exists for the entity, assoc it under
  :metadata on core-attrs. Otherwise return core-attrs unchanged."
  [db core-attrs entity-type entity-id]
  (let [m (get-metadata db entity-type entity-id)]
    (if (seq m)
      (assoc core-attrs :metadata m)
      core-attrs)))
