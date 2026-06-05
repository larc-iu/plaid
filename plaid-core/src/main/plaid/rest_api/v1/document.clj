(ns plaid.rest-api.v1.document
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.rest-api.v1.media :as media]
            [plaid.history.document :as history-doc]
            [plaid.server.locks :as locks]
            [reitit.coercion.malli]
            [plaid.sql.document :as doc]))

;; Defined below; forward-declared so the auth-path history read in
;; get-project-id can be timeout-bounded like the GET handler's read.
(declare with-history-timeout)

(defn get-project-id
  "Resolve the project id for permission checks.

  Order: explicit body `:project-id` wins (POST create); else look up
  the doc's project on the OLTP `:db`; else, for at-time GETs, fall
  through to the history replica at `:as-of-ts` so docs that were deleted
  from OLTP but existed at `ts` still resolve their project (and the
  privilege check then runs against CURRENT ACL membership — historical
  ACL is out of scope per design).

  Matches v2 behavior, where `(doc/get xt-map doc-id)` flowed
  `:snapshot-time` through and so deleted docs were still readable for
  users with current ACL membership."
  [{db :db params :parameters as-of-node :as-of-node as-of-ts :as-of-ts}]
  (let [prj-id (-> params :body :project-id)
        doc-id (-> params :path :document-id)]
    (cond
      prj-id prj-id
      doc-id (or (-> (doc/get db doc-id) :document/project)
                 (when (and as-of-node as-of-ts)
                   ;; history fallthrough: doc was deleted from OLTP but
                   ;; may have existed at ts. Let `:history/not-caught-up`
                   ;; / `:history/stalled` ex-infos propagate — `wrap-route-as-of`
                   ;; (outer to this auth middleware) maps them to 425/503
                   ;; with proper context; swallowing them here would
                   ;; quietly degrade to a 403 the user can't diagnose.
                   ;; `:oltp-db` not forwarded — this lookup is purely
                   ;; for the project id; media-url shaping happens in
                   ;; the GET handler below.
                   ;;
                   ;; Timeout-bounded: this runs in the auth middleware,
                   ;; BEFORE the GET handler's own with-history-timeout, so
                   ;; without this a hung XTDB query on the deleted-doc
                   ;; path would hold a request thread + connection
                   ;; unbounded — the exact failure with-history-timeout
                   ;; exists to prevent.
                   (-> (with-history-timeout
                         #(history-doc/get-at as-of-node doc-id as-of-ts))
                       :document/project)))
      :else nil)))

(defn get-document-id [{params :parameters}]
  (-> params :path :document-id))

(def ^:private history-read-timeout-ms
  "Hard cap on a single history at-time read. The history deep read hits XTDB;
  a hung XTDB query would otherwise hold a request thread + an XTDB
  connection indefinitely. JDK 21 + http-kit virtual threads make thread
  starvation a non-acute risk, but bounding a stuck query cleanly is
  still worth it. 30s is generous for a single-doc deep read yet short
  enough to free resources before a client gives up. Hardcoded by
  design; promote to config if operators ever need to tune it (#16)."
  30000)

(defn- with-history-timeout
  "Run `thunk` (an history read) on a future and deref with a bounded
  timeout. On timeout, throw `{:type :history/read-timeout}` which
  `wrap-route-as-of` maps to 503 — same family as `:history/stalled`.

  Any exception thrown inside `thunk` propagates with its ORIGINAL type
  preserved: `deref` on a future rethrows the worker's exception wrapped
  in a `j.u.c.ExecutionException`, which would defeat the middleware's
  `(instance? ExceptionInfo t)` type-routing and silently demote
  `:history/not-caught-up` / `:history/stalled` to the generic 503. We unwrap
  the cause and rethrow it so the typed ex-infos reach the middleware
  intact."
  [thunk]
  (let [fut (future (thunk))
        timeout-sentinel ::timeout
        result (try
                 (deref fut history-read-timeout-ms timeout-sentinel)
                 (catch java.util.concurrent.ExecutionException e
                   (throw (or (.getCause e) e))))]
    (if (= result timeout-sentinel)
      (do
        (future-cancel fut)
        (throw (ex-info "history read timed out"
                        {:type :history/read-timeout
                         :timeout-ms history-read-timeout-ms})))
      result)))

(def document-routes
  ["/documents"

   ["" {:post {:summary "Create a new document in a project. Requires <body>project-id</body> and <body>name</body>."
               :middleware [[pra/wrap-writer-required get-project-id]
                            metadata/wrap-inline-metadata-shape-guard]
               :parameters {:body [:map
                                   [:project-id :uuid]
                                   [:name :string]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [project-id name metadata]} :body} :parameters db :db user-id :user/id}]
                          (let [attrs {:document/project project-id
                                       :document/name name}
                                result (doc/create db attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-version-in-header
                               {:status 201
                                :body {:id (:extra result)}}
                               db (:extra result))
                              {:status (or (:code result) 500)
                               :body {:error (:error result)}})))}}]

   ["/:document-id"
    {:parameters {:path [:map [:document-id :uuid]]}}

    ["" {:get {:summary "Get a document. Set <query>include-body</query> to true in order to include all data contained in the document."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :parameters {:query [:map [:include-body {:optional true} boolean?]]}
               :handler (fn [{{{:keys [document-id]} :path
                               {:keys [include-body]} :query} :parameters
                              db :db
                              as-of-node :as-of-node
                              as-of-ts :as-of-ts}]
                          ;; `wrap-route-as-of` injects :as-of-node + :as-of-ts
                          ;; when ?as-of= was supplied and the history is enabled.
                          ;; In that case dispatch to the history read API; the
                          ;; SQL deep-read shape is the contract on both sides.
                          ;; The version header is OLTP-only — at-time reads
                          ;; can't usefully advise OCC against the current row.
                          ;; `:oltp-db db` to the history reads so they
                          ;; can suppress `:document/media-url` for docs
                          ;; deleted from OLTP — see
                          ;; `history-doc/attach-media-url` (option B).
                          (let [document (cond
                                           (and as-of-node include-body)
                                           (with-history-timeout
                                             #(history-doc/get-with-layer-data-at
                                               as-of-node document-id as-of-ts {:oltp-db db}))
                                           as-of-node
                                           (with-history-timeout
                                             #(history-doc/get-at as-of-node document-id as-of-ts {:oltp-db db}))
                                           include-body
                                           (doc/get-with-layer-data db document-id)
                                           :else
                                           (doc/get db document-id))]
                            (if (some? document)
                              (if as-of-node
                                {:status 200 :body document}
                                (prm/assoc-document-version-in-header
                                 {:status 200
                                  :body document}
                                 db document-id))
                              {:status 404
                               :body {:error "Document not found"}})))}
         :patch {:summary "Update a document. Supported keys:\n\n<body>name</body>: update a document's name."
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:body [:map [:name :string]]
                              :query [:map [:document-version {:optional true} :int]]}
                 :handler (fn [{{{:keys [document-id]} :path {:keys [name]} :body} :parameters db :db user-id :user/id}]
                            (let [{:keys [success code error]} (doc/merge db document-id {:document/name name} user-id)]
                              (if success
                                (prm/assoc-document-version-in-header
                                 {:status 200
                                  :body (doc/get db document-id)}
                                 db document-id)
                                {:status (or code 500)
                                 :body {:error (or error "Internal server error")}})))}
         :delete {:summary "Delete a document and all data contained."
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :parameters {:query [:map [:document-version {:optional true} :int]]}
                  :handler (fn [{{{:keys [document-id]} :path} :parameters db :db user-id :user/id}]
                             (let [{:keys [success code error]} (doc/delete db document-id user-id)]
                               (if success
                                 {:status 204}
                                 {:status (or code 500)
                                  :body {:error (or error "Internal server error")}})))}}]

    ["/lock"
     {:get {:summary "Get information about a document lock"
            :middleware [[pra/wrap-reader-required get-project-id]]
            :openapi {:x-client-method "check-lock"}
            :handler (fn [{{{:keys [document-id]} :path} :parameters}]
                       (if-let [lock-info (locks/get-lock-info document-id)]
                         {:status 200
                          :body {:user-id (:user-id lock-info)
                                 :expires-at (:expires-at lock-info)}}
                         {:status 204}))}

      :post {:summary "Acquire or refresh a document lock"
             :middleware [[pra/wrap-writer-required get-project-id]]
             :openapi {:x-client-method "acquire-lock"}
             :handler (fn [{{{:keys [document-id]} :path} :parameters user-id :user/id}]
                        (let [result (locks/acquire-lock! document-id user-id)]
                          (case result
                            :acquired {:status 200 :body (locks/get-lock-info document-id)}
                            :refreshed {:status 200 :body (locks/get-lock-info document-id)}
                            :conflict {:status 423
                                       :body {:error "Document is locked by another user"
                                              :user-id (:user-id (locks/get-lock-info document-id))}})))}

      :delete {:summary "Release a document lock"
               :middleware [[pra/wrap-writer-required get-project-id]]
               :openapi {:x-client-method "release-lock"}
               :handler (fn [{{{:keys [document-id]} :path} :parameters user-id :user/id}]
                          (let [result (locks/release-lock! document-id user-id)]
                            (case result
                              :released {:status 204}
                              :not-held {:status 204})))}}]

    ;; Media operations
    media/media-routes

    ;; Metadata operations
    (metadata/metadata-routes "document" :document-id get-project-id get-document-id doc/get doc/set-metadata doc/delete-metadata doc/patch-metadata)]])
