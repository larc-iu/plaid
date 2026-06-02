(ns plaid.sql.audit
  "Audit log reads for the SQL port. Replaces plaid.xtdb2.audit.

  Where the v2 schema had a separate `audits` table grouping one or more
  operations under a single audit-id (with project/document sets as columns),
  the SQL schema collapses to a single `operations` table — one row per
  logical operation, with the per-row writes living in `audit_writes`.

  To preserve the v2 API shape for REST consumers, this namespace projects
  each operations row into the v2 audit-entry shape (single-element
  :audit/ops vector, single-project / single-document lists)."
  (:require [plaid.sql.common :as psc]))

(defn- batch-fetch-by-ids
  "Returns a map of id → row for the given table + ids (distinct, non-nil)."
  [db table ids]
  (let [ids (->> ids (filter some?) distinct vec)]
    (if (empty? ids)
      {}
      (->> (psc/q db {:select [:*] :from [table] :where [:in :id ids]})
           (into {} (map (juxt :id identity)))))))

(defn- select-user [u]  (when u {:user/id (:id u) :user/username (:username u)}))
(defn- select-proj [p]  (when p {:project/id (:id p) :project/name (:name p)}))
(defn- select-doc  [d]  (when d {:document/id (:id d) :document/name (:name d)}))
(defn- select-token [t] (when t {:token/id (:id t) :token/name (:name t)}))

(defn- enrich-ops
  "Project each operations row into a v2 audit-entry shape, enriching the
  referenced user / project / document with names.

  `:audit/api-token` is present iff the op was performed under a named API
  token (`token_id` set) — server-authoritative proof of which credential
  acted. Its absence marks session/human activity."
  [db op-rows]
  (let [user-ids (mapv :user_id op-rows)
        proj-ids (mapv :project_id op-rows)
        doc-ids  (mapv :document_id op-rows)
        token-ids (mapv :token_id op-rows)
        users    (batch-fetch-by-ids db :users user-ids)
        projects (batch-fetch-by-ids db :projects proj-ids)
        documents (batch-fetch-by-ids db :documents doc-ids)
        tokens   (batch-fetch-by-ids db :api_tokens token-ids)]
    (mapv (fn [row]
            (let [proj (some-> (:project_id row) projects select-proj)
                  doc  (some-> (:document_id row) documents select-doc)
                  user (some-> (:user_id row) users select-user)
                  token (some-> (:token_id row) tokens select-token)
                  op-summary (-> {:op/id (:id row)
                                  :op/type (some-> (:op_type row) keyword)
                                  :op/description (:description row)}
                                 (cond-> proj (assoc :op/project proj))
                                 (cond-> doc  (assoc :op/document doc)))]
              (cond-> {:audit/id (:id row)
                       :audit/time (:ts row)
                       :audit/user user
                       :audit/projects (if proj [proj] [])
                       :audit/documents (if doc [doc] [])
                       :audit/ops [op-summary]}
                (:batch_id row) (assoc :audit/batch-id (:batch_id row))
                token (assoc :audit/api-token token))))
          op-rows)))

(defn- ts-where
  "Build a HoneySQL conjunction for an optional :ts time range. Times are
  ISO-8601 strings; callers may pass Instants which we render here."
  [start-time end-time]
  (let [->iso (fn [x]
                (cond
                  (nil? x) nil
                  (string? x) x
                  (instance? java.time.Instant x) (.toString x)
                  (instance? java.util.Date x) (.toString (.toInstant ^java.util.Date x))
                  (instance? java.time.ZonedDateTime x) (.toString (.toInstant ^java.time.ZonedDateTime x))
                  :else (str x)))
        from (->iso start-time)
        to   (->iso end-time)]
    (cond-> []
      from (conj [:>= :ts from])
      to   (conj [:<= :ts to]))))

(def ^:const default-limit
  "Default page size when no `:limit` is supplied. Keeps a long-lived
  project's audit response bounded for clients that just want the first
  page."
  100)

(def ^:const max-limit
  "Hard ceiling on `:limit`. Larger values are silently clamped at the
  SQL layer (REST validation also rejects them up front)."
  1000)

(defn- clamp-limit
  "Resolve an effective LIMIT from a user-supplied value. nil → default;
  values outside (0, max] are clamped into range. Always returns a
  positive integer."
  [limit]
  (let [n (cond
            (nil? limit) default-limit
            (integer? limit) limit
            :else (try (Long/parseLong (str limit))
                       (catch Exception _ default-limit)))]
    (cond
      (<= n 0) default-limit
      (> n max-limit) max-limit
      :else n)))

(defn- cursor-row
  "Resolve a cursor (operations.id) into the (ts, id) tuple needed for
  the seek-style keyset pagination predicate. Returns nil if the cursor
  doesn't exist (caller should treat as `no further pages`)."
  [db cursor]
  (when cursor
    (psc/q1 db {:select [:ts :id] :from [:operations] :where [:= :id cursor]})))

(defn- query-ops
  "Fetch a page of operations rows ordered deterministically by (ts, id).

  - `base-where` — caller-supplied scoping clause (e.g. `[:= :project_id pid]`).
  - `time-range` — `[start end]` ISO-string range; either may be nil.
  - `opts`       — `{:limit n :cursor op-id}`. `:cursor` is the op-id of
                   the LAST row from the previous page; results start
                   strictly after it (under the (ts, id) total order)."
  ([db base-where time-range]
   (query-ops db base-where time-range nil))
  ([db base-where time-range {:keys [limit cursor]}]
   (let [ts-clauses (ts-where (first time-range) (second time-range))
         eff-limit (clamp-limit limit)
         cur (cursor-row db cursor)
         ;; Keyset predicate: (ts, id) > (cur-ts, cur-id). Falls back to
         ;; a degenerate FALSE if the cursor was unknown so callers see
         ;; an empty page rather than the full result set.
         cursor-clauses (cond
                          (nil? cursor) []
                          (nil? cur) [[:= 1 0]]
                          :else [[:or
                                  [:> :ts (:ts cur)]
                                  [:and [:= :ts (:ts cur)] [:> :id (:id cur)]]]])
         all-extra (concat ts-clauses cursor-clauses)
         where (if (seq all-extra)
                 (into [:and base-where] all-extra)
                 base-where)]
     ;; No `:limit` supplied → return the full (time-windowed) set with
     ;; no LIMIT clause. A caller paging a huge log opts in via `?limit=`;
     ;; the `?cursor=` keyset still seeks off the last returned op-id.
     (psc/q db (cond-> {:select [:*]
                        :from [:operations]
                        :where where
                        :order-by [:ts :id]}
                 limit (assoc :limit eff-limit))))))

(defn- format-audit
  "Enrich a fetched page of operations rows into the external audit-entry
  shape. Returns a BARE vector (pagination intentionally deferred — when
  it's added back, wrap every list endpoint in the same envelope, not
  just this one). `?limit`/`?cursor` still work for callers paging a
  large log: the cursor is simply the `:audit/id` of the last entry."
  [db rows]
  (enrich-ops db rows))

(defn get-project-audit-log
  ([db project-id]
   (get-project-audit-log db project-id nil nil nil))
  ([db project-id start-time end-time]
   (get-project-audit-log db project-id start-time end-time nil))
  ([db project-id start-time end-time opts]
   (let [rows (query-ops db [:= :project_id project-id] [start-time end-time] opts)]
     (format-audit db rows))))

(defn get-document-audit-log
  "Audit entries that affect `document-id`. Returns ops whose
  `documents.id = document-id` AND/OR whose `audit_writes` row touched the
  documents row for `document-id` (e.g. doc-version-bump rows emitted
  under a parent vocab/delete op that itself carries `document_id = nil`).
  The second branch is implemented as an EXISTS subquery against
  `audit_writes` (NOT a JOIN — see the comment on `base-where` below for
  why). Without that branch, doc-version bumps fired by
  `bump-document-versions!` from vocab/delete or project/remove-vocab
  silently disappear from the per-doc endpoint (task #91)."
  ([db document-id]
   (get-document-audit-log db document-id nil nil nil))
  ([db document-id start-time end-time]
   (get-document-audit-log db document-id start-time end-time nil))
  ([db document-id start-time end-time opts]
   ;; The base-where is matched against the `operations` table by
   ;; `query-ops`. We use EXISTS subquery rather than a JOIN so the LEFT
   ;; side stays one row per operation (no DISTINCT needed, and the
   ;; ORDER BY (ts, id) doesn't have to fight duplicate join rows).
   (let [base-where [:or
                     [:= :document_id document-id]
                     [:exists {:select [1]
                               :from [:audit_writes]
                               :where [:and
                                       [:= :audit_writes.op_id :operations.id]
                                       [:= :audit_writes.target_table "documents"]
                                       [:= :audit_writes.target_id document-id]]}]]
         rows (query-ops db base-where [start-time end-time] opts)]
     (format-audit db rows))))

(defn get-user-audit-log
  ([db user-id]
   (get-user-audit-log db user-id nil nil nil))
  ([db user-id start-time end-time]
   (get-user-audit-log db user-id start-time end-time nil))
  ([db user-id start-time end-time opts]
   (let [rows (query-ops db [:= :user_id user-id] [start-time end-time] opts)]
     (format-audit db rows))))
