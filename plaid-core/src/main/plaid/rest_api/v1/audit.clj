(ns plaid.rest-api.v1.audit
  (:require [clojure.string]
            [plaid.history.changes :as changes]
            [plaid.history.read :as hread]
            [plaid.rest-api.v1.schema :as schema]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.sql.audit :as audit]
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
       "the rest of an entry ?ops-limit cut."))

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
       "audit read). Each row has kind (document, text, token, span, relation, vocab-link, vocab-item, "
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
