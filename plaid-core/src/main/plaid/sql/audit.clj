(ns plaid.sql.audit
  "Audit log reads for the SQL port. Replaces plaid.xtdb2.audit.

  Where the v2 schema had a separate `audits` table grouping one or more
  operations under a single audit-id (with project/document sets as columns),
  the SQL schema collapses to a single `operations` table — one row per
  logical operation, with the per-row writes living in `audit_writes`.

  To preserve the v2 API shape for REST consumers, this namespace projects
  each operations row into the v2 audit-entry shape (single-element
  :audit/ops vector, single-project / single-document lists)."
  (:require [plaid.sql.common :as psc]
            [plaid.sql.pagination :as pagination]))

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

(defn- query-ops
  "Build + run a keyset-paginated query over operations rows, ordered
  deterministically by (ts, id) — both TEXT columns, so the shared
  lexicographic seek applies.

  - `from-spec`   — HoneySQL `:from` value. Either `[:operations]` (project /
                    user scopes, narrowed by `scope-where`) or a subquery that
                    already encodes the scope (the document UNION below).
  - `scope-where` — clause ANDed into WHERE to scope the operations table, or
                    nil when `from-spec` already encodes the scope.
  - `time-range`  — `[start end]` ISO-string range; either may be nil.
  - `eff-limit`   — already-clamped page size.
  - `cursor-vals` — `[ts id]` of the LAST row from the previous page (or
                    nil for the first page); results start strictly after it."
  [db from-spec scope-where time-range eff-limit cursor-vals]
  (let [ts-clauses (ts-where (first time-range) (second time-range))
        seek (pagination/keyset-where [:ts :id] cursor-vals)
        clauses (cond-> []
                  scope-where (conj scope-where)
                  :always (into ts-clauses)
                  seek (conj seek))
        where (case (count clauses)
                0 nil
                1 (first clauses)
                (into [:and] clauses))]
    (psc/q db (cond-> {:select [:*]
                       :from from-spec
                       :order-by [:ts :id]
                       :limit eff-limit}
                where (assoc :where where)))))

(defn- audit-page
  "Fetch + enrich one keyset page into the uniform envelope
  `{:entries [...] :next-cursor [ts id]-or-nil}`. `opts` carries
  `{:limit n :cursor-vals [ts id]}`; the audit log is now always
  paginated (default page 100, max 1000)."
  [db from-spec scope-where time-range {:keys [limit cursor-vals]}]
  (let [eff (pagination/clamp-limit limit)
        rows (query-ops db from-spec scope-where time-range eff cursor-vals)
        next-cursor (when (= (count rows) eff)
                      (let [r (peek (vec rows))] [(:ts r) (:id r)]))]
    {:entries (enrich-ops db rows)
     :next-cursor next-cursor}))

(defn get-project-audit-log
  ([db project-id]
   (get-project-audit-log db project-id nil nil nil))
  ([db project-id start-time end-time]
   (get-project-audit-log db project-id start-time end-time nil))
  ([db project-id start-time end-time opts]
   (audit-page db [:operations] [:= :project_id project-id] [start-time end-time] opts)))

(defn- document-ops-source
  "A UNION subquery yielding every operations row that affects `document-id`,
  either directly (`operations.document_id`) or via an `audit_writes` row that
  touched the documents row — e.g. a doc-version bump fired by
  `bump-document-versions!` under a parent vocab/delete op whose own
  `document_id` is nil (task #91).

  UNION of two index-friendly branches rather than `OR`/correlated-EXISTS on
  the operations table: branch 1 hits `idx_operations_document_ts`, branch 2's
  `IN` list hits `idx_audit_writes_target`, and the cost scales with the result
  size — not the (append-only, ever-growing) operations table. The OR form
  forced a full `SCAN operations` with a per-row subquery probe (~12s on a
  ~117k-row log). Each branch is one-row-per-op so there are no spurious
  duplicates; UNION dedupes the overlap (an op that both targets the doc AND
  bumps its version)."
  [document-id]
  [[{:union [{:select [:*]
              :from [:operations]
              :where [:= :document_id document-id]}
             {:select [:o.*]
              :from [[:operations :o]]
              :where [:in :o.id {:select [:op_id]
                                 :from [:audit_writes]
                                 :where [:and
                                         [:= :target_table "documents"]
                                         [:= :target_id document-id]]}]}]}
    :ops]])

(defn get-document-audit-log
  "Audit entries that affect `document-id`. Returns ops whose
  `documents.id = document-id` AND/OR whose `audit_writes` row touched the
  documents row for `document-id` (e.g. doc-version-bump rows emitted
  under a parent vocab/delete op that itself carries `document_id = nil`).
  See `document-ops-source` for why the second branch is a UNION rather than
  an `OR`/correlated-EXISTS. Without that branch, doc-version bumps fired by
  `bump-document-versions!` from vocab/delete or project/remove-vocab
  silently disappear from the per-doc endpoint (task #91)."
  ([db document-id]
   (get-document-audit-log db document-id nil nil nil))
  ([db document-id start-time end-time]
   (get-document-audit-log db document-id start-time end-time nil))
  ([db document-id start-time end-time opts]
   (audit-page db (document-ops-source document-id) nil [start-time end-time] opts)))

(defn get-user-audit-log
  ([db user-id]
   (get-user-audit-log db user-id nil nil nil))
  ([db user-id start-time end-time]
   (get-user-audit-log db user-id start-time end-time nil))
  ([db user-id start-time end-time opts]
   (audit-page db [:operations] [:= :user_id user-id] [start-time end-time] opts)))
