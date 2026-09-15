(ns plaid.rest-api.v1.guideline
  "REST surface for guidelines — a project's own annotation manual, as a flat
  list of short Markdown documents. See `plaid.sql.guideline` for the shape and
  the migration for the design.

  ## Permissions

  A guideline takes the project's standing: reading is a project READ, writing
  a project WRITE. Writers rather than maintainers, matching comments, because
  the people who annotate are the people who discover what the conventions have
  to be.

  `wrap-writer-required` already means writer-or-maintainer (`:project/writers`
  resolves to both in `plaid.rest-api.v1.auth`), so there is one gate here and
  not two.

  ## What is audited, and what that means

  Every write goes through `plaid.sql.operation/submit-operation!`, so a
  guideline change appears in the project's audit feed with pre and post images
  and announces on the project's SSE stream. It is NOT time-travelable:
  `?as-of=` and restore are document-scoped, and these routes sit inside the
  `wrap-reject-as-of` group, so `?as-of=` here is a 400 and not a wrong answer."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.sql.guideline :as pgl]
            [reitit.coercion.malli]))

;; ============================================================
;; Project resolvers (for the ACL middlewares)
;; ============================================================

(defn- get-project-id
  "The project this request is about, from either path shape: the collection
  under a project, or one guideline by id. A guideline that does not exist
  resolves to nil, which the middleware turns into a fail-closed 403 rather
  than confirming to a non-member that some id is real — the same trade every
  other route makes."
  [{db :db params :parameters}]
  (or (-> params :path :id)
      (some->> (-> params :path :guideline-id) (pgl/project-id db))))

;; ============================================================
;; Routes
;; ============================================================

(def ^:private list-query-params
  (into [:map
         [:include-bodies {:optional true} boolean?]]
        pagination/query-params))

(defn- not-found [guideline-id]
  {:status 404 :body {:error (str "Guideline not found with id `" guideline-id "`")}})

(defn- from-result
  "The uniform ending for a write: the operation's result, or its error with
  the code the SQL layer chose."
  [result on-success]
  (if (:success result)
    (on-success result)
    {:status (or (:code result) 500)
     :body   {:error (or (:error result) "Internal server error")}}))

(def guideline-routes
  [["/projects/:id/guidelines"
    {:openapi    {:security [{:auth []}]}
     :parameters {:path [:map [:id :uuid]]}}

    [""
     {:get {:summary (str "List a project's guidelines, by title; keyset-paginated. Each entry "
                          "carries <code>body-chars</code>, the length of its body, so a caller "
                          "can budget before fetching any. Set <query>include-bodies</query> to "
                          "true to get the Markdown itself on every entry instead. Pinned "
                          "guidelines are not sorted first — <code>pinned</code> is on every "
                          "entry and grouping is the caller's.")
            :middleware [[pra/wrap-reader-required get-project-id]]
            :parameters {:query list-query-params}
            :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                       (pagination/list-response
                        query
                        (fn [opts]
                          (pgl/list-in-project db id (assoc opts :include-bodies?
                                                            (:include-bodies query))))))}

      :post {:summary (str "Create a guideline. <body>title</body> is the handle and is unique "
                           "within the project, so a title already in use is a 409. "
                           "<body>summary</body> is the one line that says what the guideline "
                           "covers. <body>body</body> is Markdown and may be empty. A "
                           "<body>pinned</body> guideline is one the assistant is given in full "
                           "on every turn.")
             :middleware [[pra/wrap-writer-required get-project-id]]
             :parameters {:body [:map
                                 [:title :string]
                                 [:summary :string]
                                 [:body {:optional true} :string]
                                 [:pinned {:optional true} boolean?]]}
             :handler (fn [{{{:keys [id]} :path
                             {:keys [title summary body pinned]} :body} :parameters
                            db :db user-id :user/id}]
                        (from-result
                         (pgl/create db id
                                     {:guideline/title   title
                                      :guideline/summary summary
                                      :guideline/body    body
                                      :guideline/pinned  pinned}
                                     user-id)
                         (fn [result] {:status 201 :body {:id (:extra result)}})))}}]]

   ["/guidelines"
    {:openapi {:security [{:auth []}]}}

    ["/:guideline-id"
     {:parameters {:path [:map [:guideline-id :uuid]]}}
     [""
      {:get {:summary "Read one guideline, Markdown body included."
             :middleware [[pra/wrap-reader-required get-project-id]]
             :handler (fn [{{{:keys [guideline-id]} :path} :parameters db :db}]
                        (if-let [g (pgl/get db guideline-id)]
                          {:status 200 :body g}
                          (not-found guideline-id)))}

       :patch {:summary (str "Update a guideline. Every field is optional and an omitted one is "
                             "left alone, so an edit to the body need not restate the title. "
                             "Renaming to a title another guideline in the project already has "
                             "is a 409.")
               :middleware [[pra/wrap-writer-required get-project-id]]
               :parameters {:body [:map
                                   [:title {:optional true} :string]
                                   [:summary {:optional true} :string]
                                   [:body {:optional true} :string]
                                   [:pinned {:optional true} boolean?]]}
               :handler (fn [{{{:keys [guideline-id]} :path body :body} :parameters
                              db :db user-id :user/id}]
                          (let [m (cond-> {}
                                    (contains? body :title)   (assoc :guideline/title (:title body))
                                    (contains? body :summary) (assoc :guideline/summary (:summary body))
                                    (contains? body :body)    (assoc :guideline/body (:body body))
                                    (contains? body :pinned)  (assoc :guideline/pinned (:pinned body)))]
                            (from-result
                             (pgl/merge db guideline-id m user-id)
                             (fn [_] {:status 200 :body (pgl/get db guideline-id)}))))}

       :delete {:summary "Delete a guideline."
                :middleware [[pra/wrap-writer-required get-project-id]]
                :handler (fn [{{{:keys [guideline-id]} :path} :parameters db :db user-id :user/id}]
                           (from-result
                            (pgl/delete db guideline-id user-id)
                            (fn [_] {:status 204})))}}]]]])
