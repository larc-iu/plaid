(ns plaid.rest-api.v1.comment
  "REST surface for comments — free-text discussion anchored to a document,
  text, token, span, or relation, or to a vocabulary entry. See
  `plaid.sql.comment` for why these are a table rather than a corner of
  `entity_metadata`, and for why a comment outlives its anchor.

  ## Permissions

  A comment takes the standing of the thing it hangs off:

    * a project-scoped anchor: reading is a project READ, posting a project
      WRITE. A comment is a mark left on someone's data, so it takes the
      same standing that annotating takes, and readers are deliberately
      excluded;
    * a vocab item: the vocab layer's own gates, which already answer the
      question for entries (a maintainer, an admin, or a writer of a project
      that links the vocabulary may write; anyone with a role on such a
      project may read).

  On top of that role, two rules are the whole point of the feature:

    * Only the AUTHOR may edit a comment. Nobody else, maintainers and
      admins included — rewriting someone else's words under their name is
      not an administrative action.
    * The author OR a maintainer of the owner (project or vocab layer) may
      delete one. Maintainers need a way to clear something abusive or
      misfiled, and deleting attributes nothing to anyone.

  `author_id` is always stamped from the authenticated caller and is never
  read off the request body."
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.pagination :as pagination]
            [plaid.server.events :as events]
            [plaid.sql.comment :as pcm]
            [plaid.sql.user :as user]
            [plaid.sql.vocab-layer :as vocab]
            [reitit.coercion.malli]))

;; ============================================================
;; Owner resolvers (for the ACL middlewares)
;; ============================================================

(defn- path-id [{params :parameters}]
  (-> params :path :id))

(defn- body-owner
  "Owner of the entity a POST is anchoring to. An anchor that does not exist
  resolves to nil, so the privilege check fails closed with a 403 rather
  than confirming to a non-member that some id is or isn't real — the same
  trade every other create route makes."
  [{db :db params :parameters}]
  (let [{:keys [entity-type entity-id]} (:body params)]
    (when (and entity-type entity-id)
      (pcm/resolve-anchor db entity-type entity-id))))

(defn- comment-owner
  "Owner of an existing comment, off its denormalized columns: the anchor
  itself may be gone by now, and the comment is still readable."
  [{db :db params :parameters}]
  (when-let [id (-> params :path :comment-id)]
    (pcm/owner-of (pcm/get-internal db id))))

(defn- wrap-owner-required
  "Route the request through the project middleware or the vocab middleware
  according to who owns the anchor. `project-wrap` and `vocab-wrap` are the
  `pra/wrap-*-required` constructors for the level wanted; `resolve-owner`
  answers `{:project-id ..}` or `{:vocab-layer-id ..}` (or nil, which the
  project branch turns into the fail-closed 403)."
  [handler project-wrap vocab-wrap resolve-owner]
  (let [via-project (project-wrap handler (comp :project-id resolve-owner))
        via-vocab   (vocab-wrap handler (comp :vocab-layer-id resolve-owner))]
    (fn [{db :db params :parameters :as request}]
      (if (:vocab-layer-id (resolve-owner {:db db :parameters params}))
        (via-vocab request)
        (via-project request)))))

(defn- wrap-owner-reader-required [handler resolve-owner]
  (wrap-owner-required handler pra/wrap-reader-required pra/wrap-vocab-reader-required resolve-owner))

(defn- wrap-owner-writer-required [handler resolve-owner]
  (wrap-owner-required handler pra/wrap-writer-required pra/wrap-vocab-writer-required resolve-owner))

;; ============================================================
;; Authorship middleware
;; ============================================================

(defn- fetch-for-authorship
  "The comment row plus the caller's id, or a 404 response map. Both author
  middlewares run AFTER the owner-role middleware, so reaching here means
  the caller may already write to the owner."
  [{db :db params :parameters :as request}]
  (let [id (-> params :path :comment-id)]
    (if-let [row (pcm/get-internal db id)]
      {:row row :user-id (pra/->user-id request)}
      {:response {:status 404 :body {:error (str "Comment not found with id `" id "`")}}})))

(defn wrap-author-required
  "Only the comment's author may proceed. Deliberately admits nobody else:
  an edit rewrites text that stays attributed to the author."
  [handler]
  (fn [request]
    (let [{:keys [row user-id response]} (fetch-for-authorship request)]
      (cond
        response response
        (not= (:author_id row) user-id)
        {:status 403 :body {:error "You can only edit your own comments."}}
        :else (handler request)))))

(defn- owner-maintainer?
  "Is the caller an admin, or a maintainer of the comment's owner (its
  project, or its vocab layer)?"
  [{db :db :as request} row]
  (or (user/admin? (:user/record request))
      (if-let [vid (:vocab_layer_id row)]
        (vocab/maintainer? db vid (pra/->user-id request))
        (pra/privileged? request :project/maintainers (constantly (:project_id row))))))

(defn wrap-author-or-maintainer-required
  "The comment's author, or a maintainer of its owner (or an admin), may
  proceed. Used for delete: removing a comment misattributes nothing, and a
  maintainer needs recourse against something abusive or misfiled."
  [handler]
  (fn [request]
    (let [{:keys [row user-id response]} (fetch-for-authorship request)]
      (cond
        response response
        (or (= (:author_id row) user-id) (owner-maintainer? request row))
        (handler request)
        :else
        {:status 403
         :body {:error "You can only delete your own comments unless you maintain the project or vocabulary."}}))))

;; ============================================================
;; Live updates
;; ============================================================

(defn- announce!
  "Publish a comment change on the project's SSE stream.

  Deliberately a NOTIFICATION, not the comment itself: it carries only what
  a client needs to invalidate precisely (which entity's thread changed) and
  to ignore the echo of its own write (`author-id`). A client that cares
  re-reads that one thread. Keeping bodies off the bus means there is no
  second serialization shape of a comment to keep in sync with the REST one,
  and no partial-update merge for clients to get wrong.

  A comment on a vocabulary entry has no project stream to go on (streams
  are per project, a vocabulary belongs to none), so nothing is published:
  a vocabulary's threads are re-read when they are opened."
  [action {:comment/keys [id project-id document-id entity-type entity-id author-id]}]
  (when project-id
    (events/publish-message! project-id
                             {:type        "comment"
                              :action      action
                              :comment-id  id
                              :document-id document-id
                              :entity-type entity-type
                              :entity-id   entity-id
                              :author-id   author-id}
                             author-id)))

;; ============================================================
;; Routes
;; ============================================================

(def ^:private entity-type-schema
  "The commentable set as a malli enum, single-sourced from the SQL layer.
  Declaring it in the schema means an uncommentable type is a 400 at
  coercion, BEFORE the ACL middleware — otherwise a client bug would surface
  as a 403 (the anchor resolves to no owner, so the privilege check fails
  closed) and read as a permissions problem instead of a bad request. It also
  puts the allowed values in the OpenAPI spec."
  (into [:enum] (sort pcm/commentable-types)))

(def ^:private list-query-params
  (into [:map
         [:document-id {:optional true} uuid?]
         [:entity-type {:optional true} entity-type-schema]
         [:entity-id {:optional true} uuid?]]
        pagination/query-params))

(def ^:private vocab-list-query-params
  (into [:map [:entity-id {:optional true} uuid?]] pagination/query-params))

(defn- filters [{:keys [document-id entity-type entity-id]}]
  {:document-id document-id :entity-type entity-type :entity-id entity-id})

(defn- not-found [comment-id]
  {:status 404 :body {:error (str "Comment not found with id `" comment-id "`")}})

(def comment-routes
  [["/projects/:id/comments"
    {:openapi {:security [{:auth []}]}
     :parameters {:path [:map [:id :uuid]]}}

    [""
     {:get {:summary (str "List comments in a project, oldest first; keyset-paginated. "
                          "Narrow with <query>document-id</query> (every comment anywhere in one "
                          "document — the read an editor makes on open) or with "
                          "<query>entity-type</query> + <query>entity-id</query> (one entity's "
                          "thread). Filters apply under the project scope, so an id from another "
                          "project simply matches nothing. A comment whose anchor has since been "
                          "deleted is still listed; <code>anchor-label</code> says what it was about.")
            :middleware [[pra/wrap-reader-required path-id]]
            :parameters {:query list-query-params}
            :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                       (pagination/list-response
                        query
                        (fn [opts] (pcm/list-in-project db id (merge opts (filters query))))))}}]

    ["/counts"
     {:get {:summary (str "Comment counts per entity, as an <code>{entity-id: n}</code> map, over "
                          "the same scope and filters as the list endpoint. One cheap request "
                          "paints a comment indicator on every annotated item in a document "
                          "without paging through the bodies.")
            :middleware [[pra/wrap-reader-required path-id]]
            :parameters {:query [:map
                                 [:document-id {:optional true} uuid?]
                                 [:entity-type {:optional true} entity-type-schema]
                                 [:entity-id {:optional true} uuid?]]}
            :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                       {:status 200 :body (pcm/count-in-project db id (filters query))})}}]]

   ["/vocab-layers/:id/comments"
    {:openapi {:security [{:auth []}]}
     :parameters {:path [:map [:id :uuid]]}}

    [""
     {:get {:summary (str "List comments on a vocabulary's entries, oldest first; keyset-paginated. "
                          "Narrow with <query>entity-id</query> to one entry's thread. Requires "
                          "read access to the vocabulary. A comment on an entry since deleted is "
                          "still listed; <code>anchor-label</code> says what it was about.")
            :middleware [[pra/wrap-vocab-reader-required path-id]]
            :parameters {:query vocab-list-query-params}
            :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                       (pagination/list-response
                        query
                        (fn [opts] (pcm/list-in-vocab db id (merge opts {:entity-id (:entity-id query)})))))}}]

    ["/counts"
     {:get {:summary (str "Comment counts per entry, as an <code>{entity-id: n}</code> map, over "
                          "a whole vocabulary or one entry.")
            :middleware [[pra/wrap-vocab-reader-required path-id]]
            :parameters {:query [:map [:entity-id {:optional true} uuid?]]}
            :handler (fn [{{{:keys [id]} :path query :query} :parameters db :db}]
                       {:status 200 :body (pcm/count-in-vocab db id {:entity-id (:entity-id query)})})}}]]

   ["/comments"
    {:openapi {:security [{:auth []}]}}

    [""
     {:post {:summary (str "Post a comment on an entity. Commentable types: document, text, "
                           "token, span, relation, vocab-item. Requires write access to the "
                           "entity's project, or to the vocabulary for a vocab-item; the author is "
                           "the authenticated caller. <code>anchor-label</code> is an optional "
                           "caption saying what the comment is about (at most 200 characters), "
                           "shown once the anchor has been deleted. Comments are not audited and "
                           "do not bump the document version.")
             :middleware [[wrap-owner-writer-required body-owner]]
             :parameters {:body [:map
                                 [:entity-type entity-type-schema]
                                 [:entity-id uuid?]
                                 [:body string?]
                                 [:anchor-label {:optional true} [:maybe string?]]]}
             :handler (fn [{{body :body} :parameters db :db user-id :user/id}]
                        (try
                          (let [created (pcm/create! db body user-id)]
                            (announce! "created" created)
                            {:status 201 :body created})
                          (catch clojure.lang.ExceptionInfo e
                            {:status (or (:code (ex-data e)) 500)
                             :body {:error (ex-message e)}})))}}]

    ["/:comment-id"
     {:parameters {:path [:map [:comment-id :uuid]]}}
     [""
      {:get {:summary "Read one comment."
             :middleware [[wrap-owner-reader-required comment-owner]]
             :handler (fn [{{{:keys [comment-id]} :path} :parameters db :db}]
                        (if-let [c (pcm/get db comment-id)]
                          {:status 200 :body c}
                          (not-found comment-id)))}

       :patch {:summary (str "Edit a comment's body. Only the comment's AUTHOR may do this — "
                             "not maintainers, not admins. Sets <code>edited</code> on the "
                             "comment by moving <code>updated-at</code> past "
                             "<code>created-at</code>.")
               :middleware [[wrap-owner-writer-required comment-owner]
                            wrap-author-required]
               :parameters {:body [:map [:body string?]]}
               :handler (fn [{{{:keys [comment-id]} :path {new-body :body} :body} :parameters db :db}]
                          (try
                            (if-let [updated (pcm/update! db comment-id new-body)]
                              (do (announce! "updated" updated)
                                  {:status 200 :body updated})
                              (not-found comment-id))
                            (catch clojure.lang.ExceptionInfo e
                              {:status (or (:code (ex-data e)) 500)
                               :body {:error (ex-message e)}})))}

       :delete {:summary (str "Delete a comment. The author may delete their own; a maintainer of "
                              "its project or vocabulary (or an admin) may delete any.")
                :middleware [[wrap-owner-writer-required comment-owner]
                             wrap-author-or-maintainer-required]
                :handler (fn [{{{:keys [comment-id]} :path} :parameters db :db}]
                           ;; Read before deleting: the announcement needs the
                           ;; anchor, which is gone once the row is.
                           (let [existing (pcm/get db comment-id)]
                             (if (pcm/delete! db comment-id)
                               (do (announce! "deleted" existing)
                                   {:status 204})
                               (not-found comment-id))))}}]]]])
