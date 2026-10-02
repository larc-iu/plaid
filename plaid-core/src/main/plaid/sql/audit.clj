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

  A page walks the scope's operations from its edge in the direction asked
  for and stops once it holds N units (see `audit-page`), so a unit never
  straddles a page boundary: a page is N units, each carrying its full
  membership (within the requested scope and time window). A unit takes its
  place from the first of its members the walk meets, its newest member
  when paging newest-first and its oldest when paging oldest-first. So a
  long-open group sits under its first operation in an oldest-first read,
  and under its latest one in a newest-first read.

  A group is NOT a transaction: members that committed before a failing
  step stay in the log under the group. If a step needs all-or-nothing,
  that is a batch's job (and a batch may sit inside a group).

  Three things scope a read, and all three scope MEMBERS, not units: the
  entity scope (project / document / user), the `[start end]` time window,
  and the optional `:op-types` filter. A unit surfaces iff some member
  survives all three, and carries only the members that did. So a batch
  that created a span layer and fifty spans, read with
  `:op-types` of just `span-layer/create`, comes back as that batch holding its
  one layer-create op.

  The optional `:kinds` filter is a fourth, and the one that scopes UNITS: it
  keeps the operations whose group has one of those kinds, and every member
  of such a group has the group's id, so a unit is kept or dropped whole. A
  batch or a lone write has no group and so no kind, and never passes it."
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

;; The avatar hash rides along with the name because a screen that shows a
;; face needs it to know there is no face: without it, every person here who
;; has never uploaded a picture costs a request that can only 404.
(defn- select-user [u]  (when u {:user/id (:id u)
                                 :user/display-name (:display_name u)
                                 :user/avatar-hash (:avatar_hash u)}))
(defn- select-proj [p]  (when p {:project/id (:id p) :project/name (:name p)}))
(defn- select-doc  [d]  (when d {:document/id (:id d) :document/name (:name d)}))
(defn- select-token [t] (when t {:token/id (:id t) :token/name (:name t)}))

(def ^:private unit-key
  "The fold key: group → batch → the op itself."
  [:coalesce :group_id :batch_id :id])

(defn- row-unit [row]
  (or (:group_id row) (:batch_id row) (:id row)))

(defn- batch-ends
  "`{batch-id -> ts of the batch's last op}` for `batch-ids`, over the WHOLE
  batch rather than the members a read kept.

  An entry's members are scoped (to a document, a time window, op types), so
  its last member can sit in the middle of a batch that went on to write
  something else, such as another document or a vocabulary entry. An as-of
  read at a time strictly inside a batch goes back to before the batch
  (`plaid.history.read` never serves a state no reader could have seen), so
  the last member's own ts reads as the state BEFORE the entry, and a restore
  there undoes it. The batch's last op is the first time at which the batch
  reads as done. Served by `idx_operations_batch`."
  [db batch-ids]
  (let [ids (->> batch-ids (filter some?) distinct vec)]
    (if (empty? ids)
      {}
      (into {}
            (map (juxt :batch_id :ts))
            (psc/q db {:select [:batch_id [[:max :ts] :ts]]
                       :from [:operations]
                       :where [:in :batch_id ids]
                       :group-by [:batch_id]})))))

(defn- enrich-units
  "Project the paged units (`{:unit :head_ts}`, in page order) plus their
  member operations rows into audit entries. The referenced user / project /
  document / api-token / group rows are batch-hydrated once per page.

  Entry shape:
    :audit/id        the unit key (group id, batch id, or the op id)
    :audit/time      head ts (first member)
    :audit/end-time  the time to read the document at to see the state AFTER
                     the whole operation, which is what a UI time-travels to
                     and a restore restores to. The ts of the last member,
                     or, when that member ran in an atomic batch, the ts of
                     the batch's own last op (see `batch-ends`)
    :audit/user      the head op's user (per-op users are on each op)
    :audit/projects / :audit/documents  distinct across members
    :audit/ops       every member, oldest first. An op's :op/end-time is the
                     time to read at to see that op done: its own ts, or its
                     batch's last op when it ran in one
    :audit/group-id + :audit/message   when the unit is a logical group
                     (message absent if the client never labeled it)
    :audit/kind + :audit/ref  the group's kind (one of
                     `plaid.sql.operation-group/kinds`) and what it refers
                     to, each present only when the client gave one
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
        batch-end (batch-ends db (keep :batch_id member-rows))
        ;; the time to read at to see this op done: its own, or its batch's end
        end-time  (fn [row] (or (some-> (:batch_id row) batch-end) (:ts row)))
        op-summary (fn [row]
                     (let [proj (some-> (:project_id row) projects select-proj)
                           doc  (some-> (:document_id row) documents select-doc)]
                       (cond-> {:op/id (:id row)
                                :op/type (some-> (:op_type row) keyword)
                                :op/description (:description row)
                                :op/time (:ts row)
                                :op/end-time (end-time row)
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
                       :audit/end-time (end-time (peek ops))
                       :audit/user (some-> (:user_id head) users select-user)
                       ;; `keep`, not `mapv`: an op can reference a project or
                       ;; document that has since been DELETED, and its row is
                       ;; gone, so the hydrate misses and `select-*` gives nil.
                       ;; A nil in the array is useless to every reader (there
                       ;; is no name left to show) and a null every one of them
                       ;; has to defend against, so a vanished entity is simply
                       ;; absent. The per-op :op/project and :op/document are
                       ;; already omitted the same way.
                       :audit/projects (->> ops (keep :project_id) distinct
                                            (keep #(select-proj (get projects %)))
                                            vec)
                       :audit/documents (->> ops (keep :document_id) distinct
                                             (keep #(select-doc (get documents %)))
                                             vec)
                       :audit/ops (mapv op-summary ops)}
                (:group_id head) (assoc :audit/group-id unit)
                (:message group) (assoc :audit/message (:message group))
                (:kind group) (assoc :audit/kind (:kind group))
                (:ref group) (assoc :audit/ref (:ref group))
                (and (not (:group_id head)) (:batch_id head)) (assoc :audit/batch-id unit)
                token (assoc :audit/api-token token))))
          units)))

(defn- ts-where
  "Build a HoneySQL conjunction for an optional, inclusive :ts time range.
  Callers pass Instants (the routes parse the query string to one, keeping
  every digit) or ISO-8601 strings.

  `ts` is stored with nine fraction digits and compared as a string, so each
  bound is rendered in that same fixed width first. A shorter rendering
  sorts wrong: `...59.313Z` sorts AFTER `...59.313199571Z`, which dropped the
  very entry whose time a caller resumed from.

  `ts-col` is the column expression to compare, `:ts` unless a caller has
  reason to keep SQLite off the `ts` index (see `unit-members`)."
  ([start-time end-time]
   (ts-where start-time end-time :ts))
  ([start-time end-time ts-col]
   (let [->iso (fn [x]
                 (cond
                   (nil? x) nil
                   (string? x) (psc/instant->iso (java.time.Instant/parse x))
                   (instance? java.time.Instant x) (psc/instant->iso x)
                   :else (throw (ex-info (str "Cannot use as an audit time bound: " (pr-str x))
                                         {:value x}))))
         from (->iso start-time)
         to   (->iso end-time)]
     (cond-> []
       from (conj [:>= ts-col from])
       to   (conj [:<= ts-col to])))))

(defn- op-type-where
  "Restrict to operations whose `op_type` is one of `op-types` (the same
  `entity/verb` strings the read surfaces as `:op/type`)."
  [op-types]
  [:in :op_type (vec op-types)])

(defn- kind-where
  "Restrict to operations in a group whose kind is one of `kinds` (see
  `plaid.sql.operation-group/kinds`). The groups are a list built once per
  query, not a probe per row."
  [kinds]
  [:in :group_id {:select [:id]
                  :from [:operation_groups]
                  :where [:in :kind (vec kinds)]}])

(defn- conj-where [clauses]
  (case (count clauses)
    0 nil
    1 (first clauses)
    (into [:and] clauses)))

(defn- no-index
  "`col` written `+col`, which SQLite never serves from an index. The
  members of a unit are found through the unit's own column (group, batch,
  or id); a scope or time term on an indexed column would otherwise tempt
  the planner into walking the whole scope instead (the statistics of a
  mostly NULL group or batch column make a unit look large)."
  [col]
  [:raw (str "+" (name col))])

;; ============================================================
;; Paging: walk the scope from the page's edge
;; ============================================================

;; A scope says where a read finds its operations. `:source` and `:where`
;; are what the walk reads: a HoneySQL `:from` value (the operations table,
;; or a subquery that already encodes the scope) and a clause that narrows
;; it, or nil. `:member?` is the same scope as a condition on one row of
;; `operations`, or nil for the whole server, which is how a unit's other
;; members are checked once the unit is found.

(def walk-chunk
  "Operations read per step of the walk. A page of N entries usually needs
  about N operations, a page of batches or groups fewer steps than that.
  Public so a test can shrink it and put step boundaries inside units."
  250)

(defn- walk-ops
  "Up to `n` of the scope's operations that pass `filters`, strictly beyond
  `edge` (a ts, or nil for the start), in walk order. Each scope has an index
  led by its own column and `ts` (the unscoped feed has one on `ts` alone),
  so this is a seek and a short range, however long the history."
  [db {:keys [source where]} filters edge desc? n]
  (let [clause (conj-where (cond-> filters
                             where (conj where)
                             edge (conj [(if desc? :< :>) :ts edge])))]
    (psc/q db (cond-> {:select [:*]
                       :from source
                       :order-by [[:ts (if desc? :desc :asc)]]
                       :limit n}
                clause (assoc :where clause)))))

(defn- unit-members
  "Every operation of `units` in the scope that passes the time window and
  `op-types` and `kinds`, oldest first. A unit is found through the column
  its key came from (group, batch, or the op itself), each indexed, and a row
  counts only when its own unit is one of `units`: an op in both a group and
  a batch belongs to the group."
  [db {:keys [member?]} [start-time end-time] op-types kinds units]
  (if (empty? units)
    []
    (let [wanted (set units)
          ids (mapv str units)
          filters (cond-> (ts-where start-time end-time (no-index :ts))
                    (seq op-types) (conj (op-type-where op-types))
                    (seq kinds) (conj (kind-where kinds))
                    member? (conj member?))
          branch (fn [col]
                   {:select [:*]
                    :from [:operations]
                    :where (conj-where (conj filters [:in col ids]))})]
      (->> (psc/q db {:union [(branch :group_id) (branch :batch_id) (branch :id)]
                      :order-by [:ts :id]})
           (filterv #(contains? wanted (row-unit %)))))))

(defn- ts-max [a b] (if (pos? (compare a b)) a b))
(defn- ts-min [a b] (if (neg? (compare a b)) a b))

(defn- audit-page
  "One page of units in the uniform envelope `{:entries [...] :next-cursor
  [position unit]-or-nil}`. `opts` carries `{:limit n :cursor-vals
  [position unit] :op-types [...] :kinds [...] :order :asc|:desc}`; the audit log is
  always paginated (default page 100 units, max 1000).

  The page walks the scope's operations from its edge (the previous page's
  last unit, or the start) and stops once it holds `limit` units, so a page
  costs about its own size, not the project's whole history. A unit takes
  its place in the order from the first of its members the walk meets: its
  newest member walking newest-first, its oldest walking oldest-first. A
  unit met again on a later page, through an older member of a long-running
  group, already had its place and is skipped, which the walk can tell
  because that unit has a member beyond the page's edge.

  Every operation has a ts of its own (stamped under the write lock,
  strictly increasing), so the position alone orders units. The cursor
  keeps the unit beside it all the same."
  [db scope time-range {:keys [limit cursor-vals op-types kinds order]}]
  (let [eff (pagination/clamp-limit limit)
        desc? (= order :desc)
        filters (cond-> (ts-where (first time-range) (second time-range))
                  (seq op-types) (conj (op-type-where op-types))
                  (seq kinds) (conj (kind-where kinds)))
        page-edge (first cursor-vals)
        beyond-page-edge? (fn [ts] (and page-edge
                                        (if desc?
                                          (not (neg? (compare ts page-edge)))
                                          (not (pos? (compare ts page-edge))))))
        position (fn [members] (reduce (if desc? ts-max ts-min) (map :ts members)))]
    (loop [edge page-edge
           seen #{}
           picked []
           members-of {}]
      (let [chunk (when (< (count picked) eff)
                    (walk-ops db scope filters edge desc? walk-chunk))
            fresh (->> chunk (map row-unit) (remove seen) distinct vec)
            by-unit (group-by row-unit (unit-members db scope time-range op-types kinds fresh))
            placed (for [u fresh
                         :let [p (position (by-unit u))]
                         :when (not (beyond-page-edge? p))]
                     {:unit u :position p})
            picked (into picked placed)
            members-of (merge members-of (select-keys by-unit (map :unit placed)))]
        (if (and (seq chunk) (= (count chunk) walk-chunk) (< (count picked) eff))
          (recur (:ts (last chunk)) (into seen fresh) picked members-of)
          ;; The page is full, or the scope ends here.
          (let [units (vec (take eff picked))]
            {:entries (enrich-units db
                                    (mapv (fn [{:keys [unit]}]
                                            {:unit unit
                                             :head_ts (:ts (first (members-of unit)))})
                                          units)
                                    (mapcat (comp members-of :unit) units))
             :next-cursor (when (= (count units) eff)
                            (let [u (peek units)] [(:position u) (str (:unit u))]))}))))))

(defn get-project-audit-log
  ([db project-id]
   (get-project-audit-log db project-id nil nil nil))
  ([db project-id start-time end-time]
   (get-project-audit-log db project-id start-time end-time nil))
  ([db project-id start-time end-time opts]
   (audit-page db {:source [:operations]
                   :where [:= :project_id project-id]
                   :member? [:= (no-index :project_id) project-id]}
               [start-time end-time] opts)))

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
   (audit-page db {:source (document-ops-source document-id)
                   ;; The second arm is a list built once per query, not a
                   ;; probe per row: the documents row of a long-edited
                   ;; document has a row for every op on it, and a probe
                   ;; walked all of them for each candidate.
                   :member? [:or
                             [:= (no-index :document_id) document-id]
                             [:in :id {:select [:op_id]
                                       :from [:audit_writes]
                                       :where [:and
                                               [:= :target_table "documents"]
                                               [:= :target_id document-id]]}]]}
               [start-time end-time] opts)))

(defn- vocab-writes-where
  "The audit_writes rows that wrote vocabulary `vocab-id`, or with `item-id`
  only those that wrote that one entry of it. An entry's rows are found by
  target (`idx_audit_writes_target`), and the vocabulary term keeps an entry
  of another vocabulary out."
  [vocab-id item-id]
  (if item-id
    [:and
     [:= :target_table "vocab_items"]
     [:= :target_id item-id]
     [:= :vocab_layer_id vocab-id]]
    [:= :vocab_layer_id vocab-id]))

(defn- vocab-ops-source
  "A subquery yielding every operations row that wrote a row of vocabulary
  `vocab-id`: the vocabulary itself (name, configuration, maintainers) or
  one of its entries, or with `item-id` that one entry. Found through
  `audit_writes.vocab_layer_id`, so an op that ran with no project and no
  document, as every vocabulary write does, is still found. Links are not
  rows of the vocabulary: linking a word is annotation, and shows in the
  document's history."
  [vocab-id item-id]
  [[{:select [:o.*]
     :from [[:operations :o]]
     :where [:in :o.id {:select [:op_id]
                        :from [:audit_writes]
                        :where (vocab-writes-where vocab-id item-id)}]}
    :ops]])

(defn get-vocab-audit-log
  "Audit entries that changed vocabulary `vocab-id` or its entries, with the
  same fold, window, `:op-types` filter and paging as the document read. A
  unit that also wrote elsewhere (a batch that renamed an entry and edited a
  document) shows here with only its members that wrote the vocabulary.
  `:item-id` in `opts` narrows it to the changes that wrote that one entry,
  each unit with only its members that did."
  ([db vocab-id]
   (get-vocab-audit-log db vocab-id nil nil nil))
  ([db vocab-id start-time end-time {:keys [item-id] :as opts}]
   (audit-page db {:source (vocab-ops-source vocab-id item-id)
                   :member? [:exists {:select [1]
                                      :from [:audit_writes]
                                      :where [:and
                                              [:= :audit_writes.op_id :operations.id]
                                              (vocab-writes-where vocab-id item-id)]}]}
               [start-time end-time] opts)))

(defn get-user-audit-log
  ([db user-id]
   (get-user-audit-log db user-id nil nil nil))
  ([db user-id start-time end-time]
   (get-user-audit-log db user-id start-time end-time nil))
  ([db user-id start-time end-time opts]
   (audit-page db {:source [:operations]
                   :where [:= :user_id user-id]
                   :member? [:= (no-index :user_id) user-id]}
               [start-time end-time] opts)))

(defn last-edits-in-project
  "`{document-id -> ts}`: when `user-id` last wrote to each document in
  `project-id`. One grouped read, in the spirit of `comment/count-in-project`,
  so a client can mark up a whole document list without asking per document.

  Read from the log rather than kept as a column on the document. It is
  already true of every document that exists, including all the ones written
  before anyone wanted to see it, and it counts every writer of the substrate
  (this app, another one, a script through a client library, a service)
  without any of them having to remember to stamp a field.

  An app's repair on open (an operation in a group of kind `repair`) is not
  an edit: opening a document never makes it the opener's last edit
  (H9-FIRST-OPEN-5).

  `idx_operations_user_ts` serves the scan, and one person's own rows are the
  small side of a table that holds everybody's."
  [db project-id user-id]
  (into {}
        (map (juxt :document_id :ts))
        (psc/q db {:select   [:o.document_id [[:max :o.ts] :ts]]
                   :from     [[:operations :o]]
                   :where    [:and
                              [:= :o.project_id project-id]
                              [:= :o.user_id user-id]
                              [:not= :o.document_id nil]
                              [:not [:exists {:select [1] :from [[:operation_groups :g]]
                                              :where [:and [:= :g.id :o.group_id] [:= :g.kind "repair"]]}]]]
                   :group-by [:o.document_id]})))

(defn get-audit-log
  "Every operation on the server, unscoped. Same fold, window and `:op-types`
  filter as the per-project read, only the entity scope is dropped. The walk
  goes through `idx_operations_ts`, so a page costs about its own size here
  too. The route is admin-only."
  ([db] (get-audit-log db nil nil nil))
  ([db start-time end-time] (get-audit-log db start-time end-time nil))
  ([db start-time end-time opts]
   (audit-page db {:source [:operations]} [start-time end-time] opts)))

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
