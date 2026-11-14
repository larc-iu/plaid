(ns plaid.rest-api.v1.audit
  (:require [clojure.string]
            [plaid.history.changes :as changes]
            [plaid.history.read :as hread]
            [plaid.history.undo :as undo]
            [plaid.rest-api.v1.schema :as schema]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.sql.audit :as audit]
            [plaid.sql.common :as psc]
            [plaid.sql.document :as doc]
            [plaid.sql.operation-group :as og]
            [plaid.sql.user :as user])
  (:import (java.time Instant)
           (java.time.format DateTimeParseException)))

(defn get-project-id-from-audit-path
  "Extract project ID from audit path parameters"
  [{params :parameters}]
  (-> params :path :project-id))

(defn get-project-id-from-document
  "Get project ID from document ID in path"
  [{db :db params :parameters}]
  (doc/project-id db (-> params :path :document-id)))

;; `?op-types=` takes a comma-separated list of the SAME `entity/verb`
;; strings the response spells in `op/type` (e.g. `span-layer/create`), so a
;; caller can copy a value straight out of a previous read. Values are shape-
;; checked rather than checked against a registry of known types: there is no
;; central enum of op types to check against, but the shape check does catch
;; the one confusion worth catching — the SSE audit-log stream spells the
;; same operation `span_layer:create` (snake_case, colon), and pasting that
;; here would otherwise silently match nothing.
(def ^:private op-type-pattern #"[a-z][a-z0-9-]*/[a-z][a-z0-9-]*")

(def op-types-doc
  (str "Pass ?op-types= with a comma-separated list of op types "
       "(e.g. span-layer/create,span-layer/delete) to return only matching "
       "operations, spelled exactly as an entry's op/type. Filtering applies "
       "to individual operations, like the time window does: an entry appears "
       "when one of its operations matches, carrying only the operations that "
       "did."))

(defn- parse-op-types
  "Split the comma-separated `?op-types=` value. Returns `{:op-types [...]}`
  (nil op-types meaning no filter) or `{:invalid \"bad-token\"}`, so the
  handler can 400 rather than quietly return an empty page."
  [raw]
  (if-let [raw (not-empty (some-> raw clojure.string/trim))]
    (let [tokens (->> (clojure.string/split raw #",")
                      (map clojure.string/trim)
                      (remove empty?)
                      distinct
                      vec)]
      (if-let [bad (first (remove #(re-matches op-type-pattern %) tokens))]
        {:invalid bad}
        {:op-types (not-empty tokens)}))
    {:op-types nil}))

;; `?kinds=` takes a comma-separated list of operation kinds, the same closed
;; list a write's `?group-kind=` is checked against, and a kind outside it is
;; a 400 for the same reason: `assistant_plan` would match nothing and read as
;; "no such activity".
(def kinds-doc
  (str " Pass ?kinds= with a comma-separated list of operation kinds (e.g. "
       "review,guess-adoption) to return only the entries of operations of those "
       "kinds, each whole. An entry with no kind never matches."))

(defn- sorted-kinds [] (clojure.string/join ", " (sort og/kinds)))

(defn- parse-kinds
  "Split the comma-separated `?kinds=` value. Returns `{:kinds [...]}` (nil
  meaning no filter) or `{:invalid \"bad-kind\"}`."
  [raw]
  (if-let [raw (not-empty (some-> raw clojure.string/trim))]
    (let [tokens (->> (clojure.string/split raw #",")
                      (map clojure.string/trim)
                      (remove empty?)
                      distinct
                      vec)]
      (if-let [bad (first (remove og/kinds tokens))]
        {:invalid bad}
        {:kinds (not-empty tokens)}))
    {:kinds nil}))

;; A time-window bound, parsed to an Instant with every digit it was given.
;; `inst?` coerced to a Date, which keeps milliseconds only, so a start at an
;; entry's own time also took the entries earlier in that millisecond and an
;; end there took the later ones. An entry's time has nine fraction digits.
(def ^:private instant-param
  [:fn {:decode/string (fn [x]
                         (if (string? x)
                           (try (Instant/parse x) (catch DateTimeParseException _ x))
                           x))
        :error/message "should be an ISO-8601 instant, e.g. 2026-05-28T09:00:00Z"
        :json-schema/type "string"
        :json-schema/format "date-time"}
   #(instance? Instant %)])

;; Pagination query schema: shared by all three audit endpoints. The audit
;; log is always paginated into the uniform `{:entries :next-cursor}`
;; envelope (default page 100, max 1000); `:cursor` is the opaque token from
;; the previous page's `:next-cursor`. Adds the audit-only time-window
;; params on top of the shared `?limit`/`?cursor`.
(def pagination-query
  (into [:map
         [:start-time {:optional true} instant-param]
         [:end-time {:optional true} instant-param]
         [:op-types {:optional true} string?]
         [:kinds {:optional true} string?]
         [:order {:optional true} [:enum "asc" "desc"]]
         [:ops-limit {:optional true} [:int {:min 1 :max 1000}]]
         [:entry-id {:optional true} :uuid]]
        pagination/query-params))

(def ops-limit-doc
  (str " Pass ?ops-limit=N to carry at most each entry's oldest N operations in "
       "ops, the first among them. Every entry has op-count, how many operations "
       "it has in the read. Pass ?entry-id= to read that one entry instead of a "
       "page (no entries when the window and filters leave none of its "
       "operations), which with ?start-time= at the last operation held fetches "
       "the rest of an entry ?ops-limit cut. The id of an operation inside a group or a batch reads as an "
       "entry of that one operation."))

(def order-doc
  (str " Pass ?order=desc to page newest-first, which is what a feed wants; the "
       "default is oldest-first. A cursor belongs to the direction that "
       "produced it and must not be replayed against the other one."))

(defn audit-response
  "Shared handler body: parse `?op-types=` and `?kinds=`, then page. A
  malformed op type or an unknown kind is a 400 — silently returning nothing
  would look like 'no such activity'."
  [{:keys [start-time end-time op-types kinds order ops-limit entry-id] :as query} fetch]
  (let [{invalid :invalid parsed :op-types} (parse-op-types op-types)
        {bad-kind :invalid parsed-kinds :kinds} (parse-kinds kinds)]
    (cond
      invalid
      {:status 400
       :body {:error (str "Invalid op type " (pr-str invalid)
                          ". Op types are spelled entity/verb, e.g. span-layer/create"
                          " — exactly as they appear in an entry's op/type.")}}

      bad-kind
      {:status 400
       :body {:error (str "Invalid kind " (pr-str bad-kind)
                          ". kinds must be one of " (sorted-kinds) ".")}}

      :else
      (pagination/list-response
       query
       (fn [opts] (fetch (assoc opts
                                :op-types parsed
                                :kinds parsed-kinds
                                :ops-limit ops-limit
                                :entry-id entry-id
                                :order (if (= order "desc") :desc :asc))
                         start-time end-time))))))

(def ^:private tally-query
  [:map
   [:start-time {:optional true} instant-param]
   [:end-time {:optional true} instant-param]
   [:daily {:optional true} boolean?]])

(def ^:private tally-doc
  (str "Per-user activity counts. <code>changes</code> is the number of "
       "logical actions, folded the same way the audit feed folds them, so a "
       "single \"Confirm word analysis\" counts once however many rows it "
       "wrote; <code>operations</code> is the unfolded row count. "
       "<code>documents</code> counts distinct documents touched. An "
       "operation of kind <code>repair</code> is nobody's activity and is not "
       "counted, though the feed still shows it. Only users "
       "who did something appear — subtract from the roster you already hold "
       "to find the ones who did not. Pass <code>?daily=true</code> to add "
       "<code>by-day</code>, a list of <code>{date, changes}</code> oldest "
       "first, at the cost of a second grouped scan. Not paginated: the row count is the number of "
       "people, not the number of operations."))

;; What one entry changed, row by row (`plaid.history.changes`). An entry is
;; the unit every audit read already names (`audit/id`, `?entry-id=`), and its
;; rows can lie in many documents and a vocabulary, in more than one project
;; (a merge rewrites links in every project that borrows the vocabulary). So
;; the read hangs off the unscoped `/audit` and is gated row by row: a row of
;; a document or vocabulary the caller cannot read is left out, the way a
;; scoped audit read keeps only the members in its scope. The entry itself
;; follows the unknown-id ruling: an id no entry has is a 404 to an admin and
;; a 403 with `unresolved: true` to anyone else, and an entry none of whose
;; projects, documents or vocabularies the caller may read is a 403.
(def ^:private changes-query
  (into [:map
         [:document-id {:optional true} :uuid]
         [:vocab-layer-id {:optional true} :uuid]]
        pagination/query-params))

(def ^:private changes-doc
  (str "What one audit entry changed, row by row: every row of a document or a vocabulary that the entry's "
       "operations wrote (a logical group, an atomic batch or one operation, as ?entry-id= names it in every "
       "audit read). The id of an operation inside a group or a batch reads what that operation alone changed. Each row has kind (document, text, token, span, relation, vocab-link, vocab-item, "
       "vocab-layer), id, document or vocab-layer, layer (texts, tokens, spans, relations), text (tokens), "
       "before (the row just before the entry's first write to it, absent when the entry made it), after "
       "(just after its last write to it, absent when the entry deleted it), changed-since (an operation "
       "after the entry's last write changed the row) and changed-between (an operation outside the entry "
       "changed it between the entry's first and last write). before and after are the entities a document "
       "or vocabulary read serves, without versions or times. A row that shows the same before and after is "
       "left out, and so is a row of a document or vocabulary the caller cannot read. Pass ?document-id= or "
       "?vocab-layer-id= for the rows of that document or vocabulary only. Paginated, in a fixed order that "
       "new writes do not disturb."))

(defn- entry-changes
  [{db :db {{:keys [entry-id]} :path query :query} :parameters :as request}]
  (let [user-id (pra/->user-id request)
        record (:user/record request)
        readable-project? (pra/project-readable-fn request)
        readable-document? (memoize (fn [doc-id]
                                      (boolean (when-let [p (changes/document-project db doc-id)]
                                                 (and (hread/project-live? db p) (readable-project? p))))))
        readable-vocab? (memoize (fn [vocab-id] (pra/vocab-reader? db vocab-id user-id record)))
        ops (changes/unit-ops db entry-id)
        seen? (fn []
                (or (some readable-project? (distinct (keep :project_id ops)))
                    (let [{:keys [documents vocabs]} (changes/unit-scopes db ops)]
                      (or (some readable-document? documents)
                          (some readable-vocab? vocabs)))))]
    (cond
      (and (empty? ops) (user/admin? record))
      {:status 404 :body {:error "Entry not found"}}

      (empty? ops)
      {:status 403 :body {:error (str "User " user-id " lacks sufficient privileges to read this entry")
                          :unresolved true}}

      (not (seen?))
      {:status 403 :body {:error (str "User " user-id " lacks sufficient privileges to read this entry")}}

      :else
      (try
        (pagination/list-response
         query
         (fn [{:keys [limit cursor-vals]}]
           (changes/changes-page db entry-id {:limit limit
                                              :cursor-vals cursor-vals
                                              :document-id (:document-id query)
                                              :vocab-id (:vocab-layer-id query)
                                              :readable-document? readable-document?
                                              :readable-vocab? readable-vocab?})))
        (catch clojure.lang.ExceptionInfo e
          (if (= 400 (:code (ex-data e)))
            {:status 400 :body {:error (ex-message e)}}
            (throw e)))))))

(def ^:private undo-query
  [:map
   [:dry-run {:optional true} boolean?]
   [:document-id {:optional true} :uuid]
   [:vocab-layer-id {:optional true} :uuid]])

(def ^:private undo-doc
  (str "Undo one audit entry (a group, a batch, one operation, or an action inside one, as the changes read takes "
       "it), as one operation of type audit-entry/undo: every row the entry wrote is put back as it was just before "
       "the entry. A row it made is deleted, one it deleted is inserted again under its old id, one it changed is "
       "set back, in its documents and its vocabularies together. A row is left as it is, and listed under skipped "
       "({kind, id, document or vocab-layer, reason}, the first 1,000, skipped-count for all), when: a later "
       "operation wrote it (changed-since), someone else wrote it between the entry's own writes (changed-between), "
       "the caller may not maintain it (not-permitted), another user holds its document's lock (locked), it is a "
       "vocabulary's own name or settings (not-undone), the entry made it and a row that stays names it (built-on, "
       "with by naming that row: a span, link, child token or comment on a token, a link to an entry or a reference "
       "to it in metadata, and for a document anything written in it since), it needs a row that will not be there "
       "(needs, naming it: a parent gone since, or a row of this undo that is left), its offsets belong to a text "
       "that does not go back (text-changed-since: a text is put back only when nothing in its document wrote a "
       "text or a token since the entry began), a document's name another document holds now (name-taken), its "
       "document's layers would not hold, so all that document's rows are left (does-not-fit), or a closed list no "
       "longer allows its value (value-not-allowed), or its place is taken: a text where its layer holds another text "
       "of the document now (place-taken). A row of a document or vocabulary the caller cannot read is neither "
       "counted nor listed. Leaving is closed under dependency. Changes to a project, its "
       "layers, a vocabulary's name or settings, users and memberships are not undone: not-undone lists the "
       "entry's operations that made them ({op-type, count}). A project's deletion is not an entry: it cannot be "
       "undone. The response counts what was undone per kind (undone: {inserted, updated, deleted} for documents, "
       "texts, tokens, spans, relations, vocab-links and vocab-items), total, rows (the entry's rows) and, when the "
       "call wrote, operation (the undo's own id, an entry that can be undone in turn). An entry undone twice finds "
       "nothing left the second time and writes nothing. Pass ?document-id= for that document's rows only (its "
       "links included), or ?vocab-layer-id= for that vocabulary's entries and the links that name one of them, "
       "before or after. With dry-run true nothing is written and the answer is what the call would do. Requires "
       "maintainer rights: on a document's project for its rows, on a vocabulary's home project for its entries. "
       "Rows the caller may not maintain are skipped, and a caller who may maintain none is refused 403. A "
       "delegated token undoes only document rows of the projects it reaches. An entry of more than "
       (format "%,d" undo/max-rows) " rows is refused 413. The versions of the documents written are returned in "
       "X-Document-Versions."))

(defn- undo-gates
  "The predicates an undo is held to row by row, for `request`'s caller."
  [{db :db :as request}]
  (let [user-id (pra/->user-id request)
        record (:user/record request)
        scoped? (some? (:auth/token-scope request))
        maintains? (memoize (fn [pid] (boolean (pra/privileged? request :project/maintainers (constantly pid)))))
        readable-project? (pra/project-readable-fn request)
        in-live? (fn [ok? doc-id] (boolean (when-let [p (changes/document-project db doc-id)]
                                             (and (hread/project-live? db p) (ok? p)))))]
    {:maintains? maintains?
     :may-document? (memoize #(in-live? maintains? %))
     ;; As the entry restore route: a delegated token puts back no entry.
     :may-vocab? (memoize (fn [vocab-id]
                            (boolean (and (not scoped?) vocab-id
                                          (pra/vocab-maintainer? db vocab-id user-id record)))))
     :readable-document? (memoize #(in-live? readable-project? %))
     :readable-vocab? (memoize (fn [vocab-id] (boolean (and vocab-id (pra/vocab-reader? db vocab-id user-id record)))))}))

(defn- undo-refusal [request]
  {:status 403 :body {:error (str "User " (pra/->user-id request) " lacks sufficient privileges to undo this entry")}})

(defn- nothing-to-undo
  "The summary of an undo with no entry to undo (a job that wrote nothing)."
  [ids dry-run?]
  (let [zero {:inserted 0 :updated 0 :deleted 0}]
    {:entries (vec ids) :dry-run (boolean dry-run?)
     :undone (zipmap [:documents :texts :tokens :spans :relations :vocab-links :vocab-items] (repeat zero))
     :total 0 :rows 0 :skipped [] :skipped-count 0 :not-undone []}))

(defn- undo-answer
  "Run the undo of `ids` (one entry id, or a collection read as one) whose
  operations are `ops`, and answer it: 403 when the caller maintains none of
  its rows, the summary otherwise."
  [{db :db :as request} ids ops opts]
  (let [{:keys [maintains?] :as gates} (undo-gates request)
        {:keys [summary documents error code]}
        (undo/undo db ids (merge (select-keys gates [:may-document? :may-vocab? :readable-document? :readable-vocab?])
                                 {:user (pra/->user-id request)}
                                 opts))]
    (cond
      error {:status code :body {:error error}}

      (if (pos? (:rows summary))
        (zero? (:permitted summary))
        (not-any? maintains? (distinct (keep :project_id ops))))
      (undo-refusal request)

      :else
      (prm/assoc-document-versions-in-header
       {:status 200 :body (dissoc summary :permitted)}
       db (pra/readable-document-ids request documents)))))

(defn- unknown-entry
  "The answer to entry ids no entry has: 404 to an admin (422 for a
  project's deletion, which is no entry anyone can undo), 403 unresolved to
  anyone else."
  [{db :db :as request} ids]
  (if (user/admin? (:user/record request))
    (if (psc/q1 db {:select [:id] :from [:operations]
                    :where [:and [:= :op_type "project/delete"]
                            [:or [:in :id (mapv str ids)] [:in :group_id (mapv str ids)]
                             [:in :batch_id (mapv str ids)]]]})
      {:status 422 :body {:error "A project's deletion cannot be undone."}}
      {:status 404 :body {:error "Entry not found"}})
    (assoc-in (undo-refusal request) [:body :unresolved] true)))

(defn- entry-undo
  [{db :db {{:keys [entry-id]} :path query :query} :parameters :as request}]
  (let [ops (changes/unit-ops db entry-id)]
    (if (empty? ops)
      (unknown-entry request [entry-id])
      (undo-answer request entry-id ops {:dry-run? (boolean (:dry-run query))
                                         :document-id (:document-id query)
                                         :vocab-id (:vocab-layer-id query)}))))

(defn- entries-undo
  [{db :db {{:keys [entries]} :body query :query} :parameters :as request}]
  (let [ids (vec (distinct entries))]
    (if (some #(empty? (changes/unit-ops db %)) ids)
      (unknown-entry request (remove #(seq (changes/unit-ops db %)) ids))
      (undo-answer request ids (changes/units-ops db ids) {:dry-run? (boolean (:dry-run query))}))))

(defn- job-label
  "What a job's undo names it by: the message of its first group (the
  worker's label for the job), else its id."
  [db job-id groups]
  (or (some #(:message (psc/q1 db {:select [:message] :from [:operation_groups] :where [:= :id (str %)]})) groups)
      (str "job " job-id)))

(defn- job-undo
  [{db :db {{:keys [job-id]} :path query :query} :parameters :as request}]
  (let [job (psc/q1 db {:select [:id :project_id :state] :from [:jobs] :where [:= :id (str job-id)]})
        dry-run? (boolean (:dry-run query))]
    (cond
      (nil? job)
      (if (user/admin? (:user/record request))
        {:status 404 :body {:error "Job not found"}}
        (assoc-in (undo-refusal request) [:body :unresolved] true))

      (not (pra/privileged? request :project/readers (constantly (:project_id job))))
      (undo-refusal request)

      (contains? #{"waiting" "running" "stopping"} (:state job))
      {:status 409 :body {:error "This job has not ended. A job is undone once it has stopped."}}

      :else
      ;; Every group the job wrote under: each document's gloss pass and its
      ;; harmonize pass, read from its own rows, so a caller names the job only.
      (let [groups (->> (psc/q db {:select [:gloss_group :harmonize_group] :from [:job_documents]
                                   :where [:= :job_id (str job-id)] :order-by [:position]})
                        (mapcat (juxt :gloss_group :harmonize_group))
                        (remove nil?)
                        (map str)
                        distinct
                        vec)
            ops (changes/units-ops db groups)]
        (if (empty? ops)
          {:status 200 :body (nothing-to-undo groups dry-run?)}
          (undo-answer request groups ops {:dry-run? dry-run?
                                           :description (str "Undo job: " (job-label db job-id groups))
                                           :group-ref (str "job:" job-id "/undo")}))))))

(def audit-routes
  [["/projects/:project-id/audit"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    (str "Get audit log for a project. " op-types-doc kinds-doc order-doc ops-limit-doc)
           :middleware [[pra/wrap-reader-required get-project-id-from-audit-path]]
           :parameters {:query pagination-query}
           :handler    (fn [{{{:keys [project-id]} :path query :query} :parameters db :db :as req}]
                         (audit-response
                          query
                          (fn [opts start end]
                            (audit/get-project-audit-log db project-id start end
                                                         (assoc opts :readable? (pra/project-readable-fn req))))))}}]

   ["/projects/:project-id/audit/last-edits"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    (str "When the calling user last wrote to each document in a project, as a "
                            "<code>{document-id: timestamp}</code> map. Documents they have never "
                            "written to are absent. One cheap request marks up a whole document "
                            "list without asking per document.")
           :middleware [[pra/wrap-reader-required get-project-id-from-audit-path]]
           :handler    (fn [{{{:keys [project-id]} :path} :parameters db :db user-id :user/id}]
                         {:status 200
                          :body (audit/last-edits-in-project db project-id user-id)})}}]

   ["/documents/:document-id/audit"
    {:parameters {:path [:map [:document-id :uuid]]}
     :get {:summary    (str "Get audit log for a document. " op-types-doc kinds-doc order-doc ops-limit-doc)
           :middleware [[pra/wrap-reader-required get-project-id-from-document]
                        [pra/wrap-entity-required {:table :documents :label "Document" :history? true
                                                   :get-id #(-> % :parameters :path :document-id)}]]
           :parameters {:query pagination-query}
           :handler    (fn [{{{:keys [document-id]} :path query :query} :parameters db :db :as req}]
                         (audit-response
                          query
                          (fn [opts start end]
                            (audit/get-document-audit-log db document-id start end
                                                          (assoc opts :readable? (pra/project-readable-fn req))))))}}]

   ["/users/:user-id/audit"
    {:parameters {:path [:map [:user-id schema/user-id]]}
     :get        {:summary    (str "Get audit log for a user's actions. " op-types-doc kinds-doc order-doc ops-limit-doc)
                  :middleware [[pra/wrap-admin-required]  ; Only admins can view other users' audit logs
                               [pra/wrap-path-user-required]]
                  :parameters {:query pagination-query}
                  :handler    (fn [{{{:keys [user-id]} :path query :query} :parameters db :db}]
                                (audit-response
                                 query
                                 (fn [opts start end] (audit/get-user-audit-log db user-id start end opts))))}}]

   ["/projects/:project-id/audit/tally"
    {:parameters {:path [:map [:project-id :uuid]]}
     :get {:summary    (str "Per-user activity in a project. " tally-doc)
           :middleware [[pra/wrap-maintainer-required get-project-id-from-audit-path]]
           :parameters {:query tally-query}
           :handler    (fn [{{{:keys [project-id]} :path {:keys [start-time end-time daily]} :query} :parameters db :db}]
                         {:status 200
                          :body   {:entries (audit/activity-tally db {:project-id  project-id
                                                                      :start-time  start-time
                                                                      :end-time    end-time
                                                                      :daily?      daily})}})}}]

   ["/audit/entries/:entry-id/changes"
    {:parameters {:path [:map [:entry-id :uuid]]}
     ;; Gated row by row in the handler, through the same project and
     ;; vocabulary checks a scoped token is held to elsewhere.
     :plaid/token-scope (fn [_ _] nil)
     :get {:summary    changes-doc
           :parameters {:query changes-query}
           :handler    entry-changes}}]

   ["/audit/entries/:entry-id/undo"
    {:parameters {:path [:map [:entry-id :uuid]]}
     ;; Gated row by row in the handler, as the changes read is, through the
     ;; same maintainer and vocabulary checks a scoped token is held to.
     :plaid/token-scope (fn [_ _] nil)
     :post {:summary    undo-doc
            :parameters {:query undo-query}
            :handler    entry-undo}}]

   ["/audit/undo"
    {:plaid/token-scope (fn [_ _] nil)
     :post {:summary    (str "Undo several audit entries as ONE operation, as one entry's undo does one: the rows of "
                             "all of them, each put back as it was before the earliest of them wrote it, a write by one "
                             "of them none of the others' changed-since. The body is entries, the ids of the entries "
                             "(groups, batches, operations). Same answer, with entries in place of entry, the same dry "
                             "run, the same access row by row and the same limit over all their rows (413, with rows). "
                             "Narrowing is not taken. A job is undone by POST /jobs/{id}/undo.")
            :parameters {:query [:map [:dry-run {:optional true} boolean?]]
                         :body [:map [:entries [:vector {:min 1 :max 1000} :uuid]]]}
            :handler    entries-undo}}]

   ["/jobs/:job-id/undo"
    {:parameters {:path [:map [:job-id :uuid]]}
     :plaid/token-scope (fn [_ _] nil)
     :post {:summary    (str "Undo everything a job wrote, as one operation named \"Undo job: <label>\": every group "
                             "of every document of it, its gloss pass and its harmonize pass, its lexicon writes among "
                             "them, read from the job's own rows, undone together as POST /audit/undo does. A job "
                             "still waiting, running or stopping is refused 409. Same answer, dry run, access and "
                             "limit as an entry's undo, with entries naming the job's groups.")
            :parameters {:query [:map [:dry-run {:optional true} boolean?]]}
            :handler    job-undo}}]

   ["/audit"
    {:get {:summary    (str "Get the audit log across every project. Admin only. " op-types-doc kinds-doc order-doc ops-limit-doc)
           :middleware [[pra/wrap-admin-required]]
           :parameters {:query pagination-query}
           :handler    (fn [{{query :query} :parameters db :db}]
                         (audit-response
                          query
                          (fn [opts start end] (audit/get-audit-log db start end opts))))}}]

   ["/audit/tally"
    {:get {:summary    (str "Per-user activity across every project. Admin only. " tally-doc)
           :middleware [[pra/wrap-admin-required]]
           :parameters {:query tally-query}
           :handler    (fn [{{{:keys [start-time end-time daily]} :query} :parameters db :db}]
                         {:status 200
                          :body   {:entries (audit/activity-tally db {:start-time start-time
                                                                      :end-time   end-time
                                                                      :daily?     daily})}})}}]])
