(ns plaid.rest-api.v1.vocab-layer
  (:require [plaid.history.read :as hread]
            [plaid.history.vocab-restore :as vrestore]
            [plaid.rest-api.v1.audit :as audit-routes]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.rest-api.v1.layer :refer [layer-config-routes]]
            [plaid.rest-api.v1.pagination :as pagination]
            [reitit.coercion.malli]
            [plaid.sql.audit :as audit]
            [plaid.sql.common :as psc]
            [plaid.sql.project :as prj]
            [plaid.sql.user :as user]
            [plaid.sql.vocab-layer :as vocab])
  (:import (java.time Instant)
           (java.time.format DateTimeParseException)))

(defn get-vocab-id
  "Extract vocab ID from request parameters"
  [{params :parameters}]
  (-> params :path :id))

(def ^:private move-refusal vocab/move-refusal)

;; ============================================================
;; History
;;
;; A vocabulary's past is read from the audit log like a document's
;; (`plaid.history.read`): the vocabulary as it was at a time, one entry as
;; it was, the list of changes, and putting one entry back
;; (audit-vocab-history, ruled 2026-09-27). Access is today's: a reader of
;; the vocabulary now may read any of its past, and only a maintainer of its
;; home project may put an entry back.
;;
;; A vocabulary belongs to one project, its home (2026-11-12). Its rights
;; are that project's roles: a maintainer manages it, a writer adds and
;; edits entries, a reader reads. Another project may link it as a borrower,
;; read only. The routes that act on the vocabulary as a whole (rename,
;; move, delete, config, restore, its borrowers) carry
;; `:plaid/vocabulary-admin`, which refuses a delegated token
;; (`pra/token-scope-gate`).
;; ============================================================

(def ^:private as-of-routes
  "The routes of this group that take `?as-of=` themselves, as
  [method path-regex]. Every other one refuses it (`wrap-reject-as-of`)."
  [[:get #"/api/v1/vocab-layers/[0-9a-fA-F-]{36}/?"]
   [:get #"/api/v1/vocab-layers/[0-9a-fA-F-]{36}/items/[0-9a-fA-F-]{36}/?"]
   [:post #"/api/v1/vocab-layers/[0-9a-fA-F-]{36}/items/[0-9a-fA-F-]{36}/restore/?"]])

(defn wrap-reject-as-of-elsewhere
  "`wrap-reject-as-of` for every route of the vocabulary group but the three
  that read or restore at a time (`as-of-routes`), which parse the value
  themselves."
  [handler]
  (let [reject (prm/wrap-reject-as-of handler)]
    (fn [{:keys [request-method uri] :as request}]
      (if (some (fn [[m re]] (and (= m request-method) (re-matches re (or uri ""))))
                as-of-routes)
        (handler request)
        (reject request)))))

(defn- parse-as-of
  "The `?as-of=` value as an Instant, or nil when it does not parse."
  [s]
  (when s
    (try (Instant/parse s) (catch DateTimeParseException _ nil))))

(def ^:private invalid-as-of
  "Invalid as-of value (expected ISO-8601 instant, e.g. 2026-05-28T09:00:00Z): ")

(defn- history-error
  "A thrown history read as a response: a structured code where the throw
  carries one (404, 400), 400 for a time below the pruned history."
  [e]
  (let [{:keys [code type]} (ex-data e)]
    (if (= type :history/pruned)
      {:status 400 :body {:error (ex-message e)}}
      {:status (or code 500)
       :body {:error (if (and code (< code 500)) (ex-message e) "Internal error")}})))

(def vocab-layer-routes
  ["/vocab-layers"

   [""
    {:get {:summary "List all vocab layers accessible to user"
           :parameters {:query (into [:map] pagination/query-params)}
           :handler (fn [{db :db user-id :user/id {query :query} :parameters}]
                      (pagination/list-response
                       query
                       (fn [opts] (vocab/get-accessible db user-id opts))))}
     :post {:summary (str "Create a new vocab layer in project <body>project-id</body>, its home: the project's "
                          "maintainers manage it, its writers add and edit entries, its readers read it. Requires "
                          "maintainer rights on that project. "
                          "<body>id</body>, optional, is the new vocab layer's id, a UUIDv7 the client minted (else the server mints one). An id used before is refused with 409 and <body>id-taken</body>.")
            :middleware [[pra/wrap-maintainer-required (fn [{p :parameters}] (-> p :body :project-id))]]
            :parameters {:body [:map
                                [:id {:optional true} :uuid]
                                [:name string?]
                                [:project-id :uuid]]}
            :handler (fn [{{{:keys [id name project-id]} :body} :parameters db :db user-id :user/id :as req}]
                       (let [result (vocab/create db (cond-> {:vocab/name name
                                                              :vocab/project project-id}
                                                       (some? id) (assoc :vocab/id id))
                                                  user-id)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           (prm/op-error result {:extras? true}))))}}]

   ["/:id"
    {:parameters {:path [:map [:id :uuid]]}
     :get {:summary (str "Get a vocab layer by ID. <body>project</body> is its home project's id. With "
                         "<query>as-of</query> (an ISO-8601 instant), the vocabulary "
                         "as it was at that time, entries included with <query>include-items</query>, read from its "
                         "history; 404 when it did not exist then. A vocabulary read as of a time before it had a home "
                         "has <body>project</body> null. Rights are always the live home's.")
           :middleware [[pra/wrap-vocab-reader-required get-vocab-id]]
           :parameters {:query [:map
                                [:include-items {:optional true} boolean?]
                                [:as-of {:optional true} :string]]}
           :handler (fn [{{{:keys [id]} :path
                           {:keys [include-items as-of]} :query}
                          :parameters
                          db :db
                          :as req}]
                      (let [ts (parse-as-of as-of)]
                        (if (and as-of (nil? ts))
                          {:status 400 :body {:error (str invalid-as-of as-of)}}
                          (try
                            (let [vocab-layer (if ts
                                                (hread/get-vocab-at db id ts include-items)
                                                (vocab/get db id include-items))]
                              (if vocab-layer
                                {:status 200
                                 :body vocab-layer}
                                {:status 404
                                 :body {:error (if ts
                                                 "The vocabulary did not exist at that time."
                                                 "Vocab layer not found")}}))
                            (catch clojure.lang.ExceptionInfo e (history-error e))))))}

     :patch {:summary (str "Update a vocab layer's name. Requires maintainer rights on its home project. A new name "
                           "restates every document linking the vocabulary: "
                           "their versions are bumped and returned in X-Document-Versions.")
             :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]
             :plaid/vocabulary-admin true
             :parameters {:body [:map [:name string?]]}
             :handler (fn [{{{:keys [id]} :path {:keys [name]} :body} :parameters
                            db :db
                            user-id :user/id :as req}]
                        (let [{:keys [success documents] :as result} (vocab/merge db id {:vocab/name name} user-id)]
                          (if success
                            ;; A new name restates every linking document.
                            (prm/assoc-document-versions-in-header
                             {:status 200 :body (vocab/get db id)} db (pra/readable-document-ids req documents))
                            (prm/op-error result {:message nil}))))}

     :delete {:summary (str "Delete a vocab layer, with its entries and every link to them. Requires maintainer rights "
                            "on its home project. Refused (409) while another project links it, for everyone, admins "
                            "included, the body counting those projects as <body>other-projects</body> without naming "
                            "them. A project being deleted stands in no one's way. Takes no query parameter but the "
                            "audit labels (400 otherwise, nothing deleted). What it would remove is "
                            "GET /vocab-layers/{id}/deletion.")
              :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]
                           [prm/wrap-only-query-params #{}]]
              :plaid/vocabulary-admin true
              :handler (fn [{{{:keys [id]} :path} :parameters
                             db :db
                             user-id :user/id :as req}]
                         (let [{:keys [success documents] :as result} (vocab/delete db id user-id)]
                           (if success
                             ;; Deleting a vocabulary unlinks it from the
                             ;; documents that used it, which bumps their
                             ;; versions: a client told nothing here is
                             ;; refused on its own next write.
                             (prm/assoc-document-versions-in-header
                              {:status 204} db (pra/readable-document-ids req documents))
                             (prm/op-error result {:extras? true}))))}}]

   ["/:id/deletion"
    {:parameters {:path [:map [:id :uuid]]}
     :plaid/vocabulary-admin true
     :get {:summary (str "What deleting a vocab layer would remove, without writing: {links}, the links in its home's "
                         "documents. A read, never the delete. The same people may ask as may delete it, and it "
                         "answers the delete's refusals: 409 with <body>other-projects</body> while another project "
                         "links it, 404 for a vocabulary that is gone.")
           :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]
           :handler (fn [{{{:keys [id]} :path} :parameters db :db}]
                      (try
                        {:status 200 :body (vocab/delete-preview db id)}
                        (catch clojure.lang.ExceptionInfo e (prm/refusal-response e))))}}]

   ["/:id/move"
    {:parameters {:path [:map [:id :uuid]]}
     :plaid/vocabulary-admin true
     :post {:summary (str "Move a vocab layer to project <body>project-id</body>, which becomes its home. The old "
                          "home keeps it linked, as a borrower, and the new one links it if it did not. Requires "
                          "maintainer rights on both projects. A move to its current home changes nothing. Bumps "
                          "no document. Answers the vocabulary.")
            :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id move-refusal]]
            :parameters {:body [:map [:project-id :uuid]]}
            :handler (fn [{{{:keys [id]} :path {:keys [project-id]} :body} :parameters
                           db :db
                           user-id :user/id :as req}]
                       (cond
                         (and (user/admin? (:user/record req)) (prj/hidden? db project-id))
                         {:status 404 :body {:error "Project not found"}}

                         (not (pra/privileged? req :project/maintainers (constantly project-id)))
                         {:status 403 :body {:error move-refusal}}

                         :else
                         (let [result (vocab/move db id project-id user-id)]
                           (if (:success result)
                             {:status 200 :body (vocab/get db id)}
                             (prm/op-error result)))))}}]

   ["/:id/borrowers"
    {:parameters {:path [:map [:id :uuid]]}
     :plaid/vocabulary-admin true
     :get {:summary (str "The projects other than its home that link a vocab layer, its borrowers, ordered by id, as "
                         "[{id, name}]. <body>name</body> is null for a project the caller cannot read. Requires "
                         "maintainer rights on its home project, who may end any of them with "
                         "DELETE /projects/{id}/vocabs/{vocab-id}.")
           :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]
           :handler (fn [{{{:keys [id]} :path} :parameters db :db :as req}]
                      {:status 200
                       :body (mapv (fn [pid]
                                     {:id pid
                                      :name (when (pra/privileged? req :project/readers (constantly pid))
                                              (:name (psc/fetch-by-id db :projects pid)))})
                                   (vocab/borrower-ids db id))})}}]

   ["/:id/audit"
    {:parameters {:path [:map [:id :uuid]]}
     :get {:summary (str "Get the audit log of a vocabulary: every change to it or to its entries, "
                         "folded into entries the way the document log is. Links are not listed here, "
                         "they are part of the document they annotate. With <query>item-id</query>, only "
                         "the changes that wrote that one entry, each with only its operations that did. "
                         audit-routes/op-types-doc audit-routes/kinds-doc audit-routes/order-doc
                         audit-routes/ops-limit-doc)
           :middleware [[pra/wrap-vocab-reader-required get-vocab-id]]
           :parameters {:query (conj audit-routes/pagination-query [:item-id {:optional true} :uuid])}
           :handler (fn [{{{:keys [id]} :path {:keys [item-id] :as query} :query} :parameters db :db :as req}]
                      (audit-routes/audit-response
                       query
                       (fn [opts start end]
                         (audit/get-vocab-audit-log db id start end
                                                    (assoc opts
                                                           :item-id item-id
                                                           ;; Its operations belong to its home, which a
                                                           ;; borrower's reader may not read.
                                                           :readable? (pra/project-readable-fn req))))))}}]

   ["/:id/items/:item-id"
    {:parameters {:path [:map [:id :uuid] [:item-id :uuid]]}
     :get {:summary (str "Get one entry of the vocabulary as it was at <query>as-of</query> (an ISO-8601 "
                         "instant), read from its history, also when it has been deleted since. "
                         "404 when the entry was not in this vocabulary at that time.")
           :middleware [[pra/wrap-vocab-reader-required get-vocab-id]]
           :parameters {:query [:map [:as-of :string]]}
           :handler (fn [{{{:keys [id item-id]} :path {:keys [as-of]} :query} :parameters db :db}]
                      (if-let [ts (parse-as-of as-of)]
                        (try
                          (if-let [item (hread/get-vocab-item-at db id item-id ts)]
                            {:status 200 :body item}
                            {:status 404 :body {:error "The entry did not exist at that time."}})
                          (catch clojure.lang.ExceptionInfo e (history-error e)))
                        {:status 400 :body {:error (str invalid-as-of as-of)}}))}}]

   ["/:id/items/:item-id/restore"
    {:parameters {:path [:map [:id :uuid] [:item-id :uuid]]}
     :plaid/vocabulary-admin true
     :post {:summary (str "Put one entry of the vocabulary back as it was at <query>as-of</query> (an ISO-8601 "
                          "instant), as one operation. A deleted entry comes back under its original id with its "
                          "form and fields. A living entry has its form and fields set back. Links are not part "
                          "of an entry: a deleted entry's links come back through each document's own restore. "
                          "The response is a summary: <body>inserted</body>, <body>form</body> and "
                          "<body>metadata</body> say what changed, <body>total</body> is zero when nothing did. "
                          "With <query>dry-run</query> true nothing is written and the summary says what would "
                          "change. A form set back restates every document linking the entry: their versions are "
                          "bumped and returned in X-Document-Versions (past fifty documents, only their number, in X-Document-Versions-Omitted). Requires maintainer rights on the vocabulary's home project.")
            :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]
            :parameters {:query [:map
                                 [:as-of :string]
                                 [:dry-run {:optional true} boolean?]]}
            :handler (fn [{{{:keys [id item-id]} :path {:keys [as-of dry-run]} :query} :parameters
                           db :db
                           user-id :user/id :as req}]
                       (let [ts (parse-as-of as-of)]
                         (cond
                           (nil? ts)
                           {:status 400 :body {:error (str invalid-as-of as-of)}}

                           dry-run
                           (try
                             {:status 200 :body (vrestore/preview db id item-id ts)}
                             (catch clojure.lang.ExceptionInfo e (history-error e)))

                           :else
                           (let [{:keys [success extra documents] :as result}
                                 (vrestore/restore db id item-id ts user-id)]
                             (if success
                               (prm/assoc-document-versions-in-header
                                {:status 200 :body extra} db (pra/readable-document-ids req documents))
                               (prm/op-error result))))))}}]

   ;; Config endpoints
   ["/:id"
    {:middleware [[pra/wrap-vocab-maintainer-required get-vocab-id]]
     :plaid/vocabulary-admin true}
    (layer-config-routes :vocab_layers :id)]])
