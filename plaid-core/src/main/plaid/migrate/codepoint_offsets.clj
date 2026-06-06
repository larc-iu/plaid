(ns plaid.migrate.codepoint-offsets
  "One-time DATA migration: reinterpret token text offsets from UTF-16 code
  units to Unicode code points.

  Until this cutover, `:token/begin` / `:token/end` were stored as Java/Clojure
  UTF-16 indices (`subs`/`count`). The canonical unit is now code points (see
  `plaid.util.codepoint`). For BMP-only text the two coincide, so ONLY texts
  that contain astral characters (>= U+10000) need their tokens converted —
  everything else is already correct. In practice most deployments have zero
  astral text, so this is usually a verified no-op.

  Audited + history-consistent: each text's tokens are rewritten inside a
  `submit-operation!` (op type `:text/migrate-offsets`), so the change flows
  through `audit_writes` and the history replica like any other write.

  Idempotent + resumable: each converted text writes a marker row into
  `data_migrations` (id = \"codepoint-offsets:text:<text-id>\") INSIDE the same
  transaction as its token updates, so a re-run skips already-converted texts
  and a partial failure leaves the texts it DID finish marked.

  Run at the cutover via `(run! ds admin-user-id)`, or rely on the guarded
  startup hook `ensure-converted!` (wired in plaid.server.sql). Use `detect`
  for a read-only pre-flight."
  (:require [plaid.sql.common :as psc]
            [plaid.sql.operation :as op :refer [submit-operation!]]
            [plaid.sql.text :as text]
            [plaid.util.codepoint :as cp]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [run!]))

(defn astral?
  "True if `s` contains any code point >= U+10000 (its code-point count differs
  from its UTF-16 `.length`)."
  [s]
  (and (string? s)
       (not= (.length ^String s) (cp/cp-count s))))

;; Markers live in the `data_migrations` table. Per-text markers make the
;; transform idempotent + resumable; the global `complete` marker lets startup
;; short-circuit the corpus scan once the one-time migration is done.
(def ^:private complete-marker "codepoint-offsets:complete")
(defn- text-marker [text-id] (str "codepoint-offsets:text:" text-id))

(defn- marked? [db marker]
  (boolean (seq (psc/q db {:select [:id]
                           :from :data_migrations
                           :where [:= :id marker]}))))

(defn- mark! [db marker]
  (psc/execute! db {:insert-into :data_migrations :values [{:id marker}]}))

(defn astral-text-ids
  "Ids of texts whose body contains astral characters. Pre-filters in SQL to
  non-ASCII bodies (a cheap superset — any astral body is necessarily multibyte
  UTF-8) so the JVM only loads candidate rows, then confirms astral in-JVM."
  [db]
  (->> (psc/q db ["SELECT id, body FROM texts WHERE length(body) <> length(CAST(body AS BLOB))"])
       (filter #(astral? (:body %)))
       (mapv :id)))

(defn detect
  "Read-only pre-flight. Returns
  {:astral-texts [{:id .. :token-count .. :converted? bool} ..]
   :pending-texts N :pending-tokens N}."
  [db]
  (let [rows (mapv (fn [tid]
                     (let [n (-> (psc/q db {:select [[[:count :*] :n]]
                                            :from :tokens
                                            :where [:= :text_id tid]})
                                 first :n)]
                       {:id tid :token-count n :converted? (marked? db (text-marker tid))}))
                   (astral-text-ids db))
        pending (remove :converted? rows)]
    {:astral-texts rows
     :pending-texts (count pending)
     :pending-tokens (reduce + 0 (map :token-count pending))}))

(defn convert-text!
  "Convert one text's tokens from UTF-16 to code-point offsets, audited under a
  `:text/migrate-offsets` op, recording the idempotency marker in the same tx.
  No-op (`:skipped true`) when already converted. `user-id` attributes the op."
  [db text-id user-id]
  (if (marked? db (text-marker text-id))
    {:success true :skipped true}
    (let [text-row (psc/fetch-by-id db :texts text-id)
          did (:document_id text-row)
          pid (text/project-id db text-id)]
      (submit-operation!
       [tx db {:type :text/migrate-offsets
               :project pid
               :document did
               :description (str "Reinterpret token offsets of text " text-id
                                 " as Unicode code points")
               :user user-id}]
       (let [body (:body (psc/fetch-by-id tx :texts text-id))
             tokens (psc/q tx {:select [:id :begin :end_]
                               :from :tokens
                               :where [:= :text_id text-id]})
             updates (mapv (fn [{:keys [id begin end_]}]
                             [id {:begin (cp/utf16->cp body begin)
                                  :end_ (cp/utf16->cp body end_)}])
                           tokens)]
         (when (seq updates)
           (psc/bulk-update-by-id! tx :tokens updates))
         ;; Idempotency marker, in the SAME tx as the rewrites above.
         (psc/execute! tx {:insert-into :data_migrations
                           :values [{:id (text-marker text-id)}]})
         {:converted-tokens (count updates)})))))

(defn run!
  "Convert every astral text's tokens to code-point offsets (idempotent).
  `user-id` attributes the audited ops. Returns a summary map."
  [db user-id]
  (let [ids (astral-text-ids db)
        results (mapv (fn [tid] (assoc (convert-text! db tid user-id) :text-id tid)) ids)]
    {:astral-texts (count ids)
     ;; Classify by :success/:skipped so a failed conversion isn't miscounted
     ;; as converted (failures carry {:success false}, no :skipped key).
     :converted (count (filter #(and (:success %) (not (:skipped %))) results))
     :skipped (count (filter :skipped results))
     :failed (count (remove :success results))
     :results results}))

(defn- first-admin-id [db]
  (-> (psc/q db {:select [:id] :from :users
                 :where [:= :is_admin 1]
                 :order-by [[:id :asc]] :limit 1})
      first :id))

(defn ensure-converted!
  "Startup hook (called from plaid.server.sql after migrations): run the one-time
  UTF-16 -> code-point token-offset conversion exactly once.

  Fast-paths on the global `complete` marker so steady-state boots do NO corpus
  scan. Otherwise scans for pending astral texts; converts them (attributed to
  the first admin); and sets the `complete` marker only once nothing remains
  pending — so a no-admin or partial-failure boot is retried next time rather
  than wrongly marked done. No user lookup happens when there's no astral text."
  [db]
  (when-not (marked? db complete-marker)
    (let [pending (remove #(marked? db (text-marker %)) (astral-text-ids db))]
      (cond
        ;; Nothing to convert (no astral text, or all already converted) → the
        ;; one-time migration is done; record it so future boots short-circuit.
        (empty? pending)
        (mark! db complete-marker)

        :else
        (if-let [admin-id (first-admin-id db)]
          (do (log/info "codepoint-offsets data migration:" (run! db admin-id))
              (when (empty? (remove #(marked? db (text-marker %)) (astral-text-ids db)))
                (mark! db complete-marker)))
          (log/warn "codepoint-offsets data migration:" (count pending)
                    "astral text(s) need conversion but no admin user exists to"
                    "attribute it — skipping. Run plaid.migrate.codepoint-offsets/run! manually."))))))
