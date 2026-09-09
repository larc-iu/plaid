(ns plaid.sql.audit
  "Audit log reads for the SQL port.

  One `operations` row per low-level write; the per-row images live in
  `audit_writes`. The read FOLDS operations into logical units so a
  user-meaningful action shows up as ONE expandable entry:

    unit key = COALESCE(group_id, batch_id, id)

  i.e. precedence: an explicit logical-operation group (client-minted
  `?group-id=`, see `plaid.sql.operation/*current-group-id*`), else the
  atomic batch the op ran in, else the op stands alone as a singleton.
  Nothing is merged or rewritten in storage — `audit_writes` drives `?as-of=`
  reconstruction and is never touched; the fold is purely read-time.

  Pagination is keyset by the unit's HEAD (`(min ts, unit)` — the ts of its
  first member), so a unit never straddles a page boundary: a page is N
  units, each carrying its full membership (within the requested scope +
  time window). A long-open group can therefore hold members later than a
  subsequent unit's head; it displays under the operation that STARTED
  first, and its slot in the ordering is stable as it grows.

  A group is NOT a transaction: members that committed before a failing
  step stay in the log under the group. If a step needs all-or-nothing,
  that is a batch's job (and a batch may sit inside a group).

  Three things scope a read, and all three scope MEMBERS, not units: the
  entity scope (project / document / user), the `[start end]` time window,
  and the optional `:op-types` filter. A unit surfaces iff some member
  survives all three, and carries only the members that did. So a batch
  that created a span layer and fifty spans, read with
  `:op-types` of just `span-layer/create`, comes back as that batch holding its
  one layer-create op."
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

(defn- select-user [u]  (when u {:user/id (:id u) :user/display-name (:display_name u)}))
(defn- select-proj [p]  (when p {:project/id (:id p) :project/name (:name p)}))
(defn- select-doc  [d]  (when d {:document/id (:id d) :document/name (:name d)}))
(defn- select-token [t] (when t {:token/id (:id t) :token/name (:name t)}))

(def ^:private unit-key
  "The fold key: group → batch → the op itself."
  [:coalesce :group_id :batch_id :id])

(defn- row-unit [row]
  (or (:group_id row) (:batch_id row) (:id row)))

(defn- enrich-units
  "Project the paged units (`{:unit :head_ts}`, in page order) plus their
  member operations rows into audit entries. The referenced user / project /
  document / api-token / group rows are batch-hydrated once per page.

  Entry shape:
    :audit/id        the unit key (group id, batch id, or the op id)
    :audit/time      head ts (first member)
    :audit/end-time  ts of the last member — the state AFTER the whole
                     operation, which is what a UI wants to time-travel to
    :audit/user      the head op's user (per-op users are on each op)
    :audit/projects / :audit/documents  distinct across members
    :audit/ops       every member, oldest first
    :audit/group-id + :audit/message   when the unit is a logical group
                     (message absent if the client never labeled it)
    :audit/batch-id  when the unit is an unlabeled atomic batch
    :audit/api-token present iff the head op ran under a named API token
                     (server-authoritative; absence marks session activity)"
  [db units member-rows]
  (let [by-unit   (group-by row-unit member-rows)
        users     (batch-fetch-by-ids db :users (mapv :user_id member-rows))
        projects  (batch-fetch-by-ids db :projects (mapv :project_id member-rows))
        documents (batch-fetch-by-ids db :documents (mapv :document_id member-rows))
        tokens    (batch-fetch-by-ids db :api_tokens (mapv :token_id member-rows))
        groups    (batch-fetch-by-ids db :operation_groups (mapv :group_id member-rows))
        op-summary (fn [row]
                     (let [proj (some-> (:project_id row) projects select-proj)
                           doc  (some-> (:document_id row) documents select-doc)]
                       (cond-> {:op/id (:id row)
                                :op/type (some-> (:op_type row) keyword)
                                :op/description (:description row)
                                :op/time (:ts row)
                                :op/user (some-> (:user_id row) users select-user)}
                         proj (assoc :op/project proj)
                         doc (assoc :op/document doc)
                         (:batch_id row) (assoc :op/batch-id (:batch_id row)))))]
    (mapv (fn [{:keys [unit head_ts]}]
            (let [ops   (vec (by-unit unit))
                  head  (first ops)
                  group (when (:group_id head) (get groups unit))
                  token (some-> (:token_id head) tokens select-token)]
              (cond-> {:audit/id unit
                       :audit/time head_ts
                       :audit/end-time (:ts (peek ops))
                       :audit/user (some-> (:user_id head) users select-user)
                       :audit/projects (->> ops (keep :project_id) distinct
                                            (mapv #(select-proj (get projects %))))
                       :audit/documents (->> ops (keep :document_id) distinct
                                             (mapv #(select-doc (get documents %))))
                       :audit/ops (mapv op-summary ops)}
                (:group_id head) (assoc :audit/group-id unit)
                (:message group) (assoc :audit/message (:message group))
                (and (not (:group_id head)) (:batch_id head)) (assoc :audit/batch-id unit)
                token (assoc :audit/api-token token))))
          units)))

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

(defn- op-type-where
  "Restrict to operations whose `op_type` is one of `op-types` (the same
  `entity/verb` strings the read surfaces as `:op/type`)."
  [op-types]
  [:in :op_type (vec op-types)])

(defn- conj-where [clauses]
  (case (count clauses)
    0 nil
    1 (first clauses)
    (into [:and] clauses)))

(defn- query-units
  "One keyset page of units, ordered by (head_ts, unit). The inner
  aggregate scans the scoped operations (index-friendly for every scope:
  `idx_operations_{project,document,user}_ts` or the document UNION
  subquery) and folds by `unit-key`; the outer select applies the seek so
  the page starts strictly after the previous page's last unit.

  - `from-spec`   — HoneySQL `:from` value. Either `[:operations]` (project /
                    user scopes, narrowed by `scope-where`) or a subquery that
                    already encodes the scope (the document UNION below).
  - `scope-where` — clause ANDed into WHERE to scope the operations table, or
                    nil when `from-spec` already encodes the scope.
  - `time-range`  — `[start end]` ISO-string range; either may be nil. Applies
                    to MEMBER ops (a member outside the window is excluded and
                    the head is the earliest in-window member).
  - `op-types`    — seq of `entity/verb` strings, or nil for no filter. Like
                    the time window, this scopes MEMBERS: a unit surfaces iff
                    some member matches, carrying only its matching members.
  - `eff-limit`   — already-clamped page size (in units).
  - `cursor-vals` — `[head_ts unit]` of the LAST unit on the previous page
                    (or nil for the first page).
  - `order`       — `:desc` to page newest-first, anything else oldest-first.
                    The seek flips with it, so a cursor is only ever valid
                    for the direction that produced it."
  [db from-spec scope-where time-range op-types eff-limit cursor-vals order]
  (let [scope (conj-where (cond-> (ts-where (first time-range) (second time-range))
                            scope-where (conj scope-where)
                            (seq op-types) (conj (op-type-where op-types))))
        inner (cond-> {:select [[unit-key :unit] [[:min :ts] :head_ts]]
                       :from from-spec
                       :group-by [unit-key]}
                scope (assoc :where scope))
        desc? (= order :desc)
        seek (pagination/keyset-where [:head_ts :unit] cursor-vals (if desc? :desc :asc))]
    (psc/q db (cond-> {:select [:unit :head_ts]
                       :from [[inner :u]]
                       :order-by (if desc?
                                   [[:head_ts :desc] [:unit :desc]]
                                   [:head_ts :unit])
                       :limit eff-limit}
                seek (assoc :where seek))
           {:uuid-cols [:unit]})))

(defn- query-members
  "Every scoped (and in-window, and op-type-matching) operations row belonging
  to `units`, oldest first."
  [db from-spec scope-where time-range op-types units]
  (if (empty? units)
    []
    (psc/q db {:select [:*]
               :from from-spec
               :where (conj-where (cond-> [[:in unit-key (mapv str units)]]
                                    scope-where (conj scope-where)
                                    (seq op-types) (conj (op-type-where op-types))
                                    :always (into (ts-where (first time-range) (second time-range)))))
               :order-by [:ts :id]})))

(defn- audit-page
  "Fetch + enrich one keyset page of units into the uniform envelope
  `{:entries [...] :next-cursor [head_ts unit]-or-nil}`. `opts` carries
  `{:limit n :cursor-vals [head_ts unit] :op-types [...] :order :asc|:desc}`;
  the audit log is always paginated (default page 100 units, max 1000)."
  [db from-spec scope-where time-range {:keys [limit cursor-vals op-types order]}]
  (let [eff (pagination/clamp-limit limit)
        units (query-units db from-spec scope-where time-range op-types eff cursor-vals order)
        members (query-members db from-spec scope-where time-range op-types (mapv :unit units))
        next-cursor (when (= (count units) eff)
                      (let [u (peek (vec units))] [(:head_ts u) (str (:unit u))]))]
    {:entries (enrich-units db units members)
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
  silently disappear from the per-doc endpoint (task #91).

  A unit (group/batch) that spans documents shows here with only the
  members that affect THIS document — the fold is within scope."
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

(defn last-edits-in-project
  "`{document-id -> ts}`: when `user-id` last wrote to each document in
  `project-id`. One grouped read, in the spirit of `comment/count-in-project`,
  so a client can mark up a whole document list without asking per document.

  Read from the log rather than kept as a column on the document. It is
  already true of every document that exists, including all the ones written
  before anyone wanted to see it, and it counts every writer of the substrate
  (this app, another one, a script through a client library, a service)
  without any of them having to remember to stamp a field.

  `idx_operations_user_ts` serves the scan, and one person's own rows are the
  small side of a table that holds everybody's."
  [db project-id user-id]
  (into {}
        (map (juxt :document_id :ts))
        (psc/q db {:select   [:document_id [[:max :ts] :ts]]
                   :from     [:operations]
                   :where    [:and
                              [:= :project_id project-id]
                              [:= :user_id user-id]
                              [:not= :document_id nil]]
                   :group-by [:document_id]})))

(defn get-audit-log
  "Every operation on the server, unscoped. Same fold, window and `:op-types`
  filter as the per-project read — only the entity scope is dropped, so the
  page is `eff-limit` units drawn from `operations` in head order.

  No index narrows this one: `query-units` groups over the whole table. That
  is the honest cost of an unscoped feed and the reason the route is
  admin-only. In practice a page is bounded by `limit` and the `[start end]`
  window, and a dashboard asks for the newest few hundred units of the last
  week, not the whole log."
  ([db] (get-audit-log db nil nil nil))
  ([db start-time end-time] (get-audit-log db start-time end-time nil))
  ([db start-time end-time opts]
   (audit-page db [:operations] nil [start-time end-time] opts)))

(defn- tally-scope
  "WHERE for the aggregate reads: an optional project scope plus the window."
  [project-id start-time end-time]
  (conj-where (cond-> (ts-where start-time end-time)
                project-id (conj [:= :project_id project-id]))))

(defn- tally-daily
  "`{user-id [{:date \"2026-09-08\" :changes n} ...]}`, oldest first. `ts` is
  stored as an ISO-8601 string, so the date is its first ten characters and
  the bucket needs no date parsing.

  A LIST of dated counts rather than a map keyed by date, deliberately. Both
  clients rewrite map keys into their language's casing on the way in, which
  turns \"2026-09-08\" into \"20260908\" and silently destroys the key. A
  date belongs in a value, never in a key."
  [db where]
  (->> (psc/q db (cond-> {:select   [:user_id
                                     [[:substr :ts 1 10] :day]
                                     [[:count [:distinct unit-key]] :changes]]
                          :from     [:operations]
                          :group-by [:user_id [:substr :ts 1 10]]}
                   where (assoc :where where)))
       (reduce (fn [acc {:keys [user_id day changes]}]
                 (update acc user_id (fnil conj []) {:date day :changes changes}))
               {})
       ;; Ordered here rather than in SQL: a GROUP BY expression is awkward to
       ;; name again in ORDER BY, and the result is users x days, not rows.
       (reduce-kv (fn [acc user-id days]
                    (assoc acc user-id (vec (sort-by :date days))))
                  {})))

(defn activity-tally
  "Per-user activity over an optional project scope and time window: how many
  raw operations, how many logical CHANGES (units, the same group/batch fold
  the feed shows, so one \"Confirm word analysis\" counts once however many
  rows it wrote), how many distinct documents were touched, and the first and
  last timestamps.

  One grouped scan, served by `idx_operations_project_ts` when a project is
  given. No post-images are read: this counts operations, it does not
  reconstruct anything, which is why it costs nothing like an as-of read.

  Only users who did something appear. Whoever wants \"and these members did
  nothing\" holds the roster already (a project's ACL, or the user directory)
  and subtracts.

  `:daily?` adds `:by-day`, a list of `{:date :changes}` per user, oldest
  first, for a sparkline. It is a second grouped scan, so it is opt-in."
  [db {:keys [project-id start-time end-time daily?]}]
  (let [where (tally-scope project-id start-time end-time)
        rows (psc/q db (cond-> {:select   [:user_id
                                           [[:count :*] :operations]
                                           [[:count [:distinct unit-key]] :changes]
                                           [[:count [:distinct :document_id]] :documents]
                                           [[:min :ts] :first_ts]
                                           [[:max :ts] :last_ts]]
                                :from     [:operations]
                                :group-by [:user_id]}
                         where (assoc :where where)))
        users (batch-fetch-by-ids db :users (map :user_id rows))
        by-day (when daily? (tally-daily db where))]
    (->> rows
         (mapv (fn [{:keys [user_id operations changes documents first_ts last_ts]}]
                 (cond-> {:user       (or (select-user (get users user_id))
                                          {:user/id user_id})
                          :operations operations
                          :changes    changes
                          :documents  documents
                          :first-ts   first_ts
                          :last-ts    last_ts}
                   daily? (assoc :by-day (get by-day user_id [])))))
         (sort-by :changes >)
         vec)))
