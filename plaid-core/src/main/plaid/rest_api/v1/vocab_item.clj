(ns plaid.rest-api.v1.vocab-item
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.sql.user :as user]
            [plaid.sql.vocab-item :as vocab-item]
            [plaid.sql.vocab-layer :as vocab-layer]))

(defn get-vocab-id-from-layer
  "Get vocab layer ID from request parameters (for create operations)"
  [{params :parameters}]
  (-> params :body :vocab-layer-id))

(defn get-vocab-id-from-item
  "Get vocab layer ID from existing vocab item (for operations on existing items)"
  [{db :db params :parameters}]
  (when-let [item-id (-> params :path :id)]
    (when-let [item (vocab-item/get db item-id)]
      (:vocab-item/layer item))))

;; Renaming or deleting an entry changes what every project the vocabulary
;; is shared with reads: a rename restates their documents, a delete takes
;; its links out of them. So those two verbs need maintainer rights on the
;; vocabulary itself (acl-shared-vocab-writers, ruled 2026-09-27). Adding
;; entries and linking words to them stay open to the writers of any
;; project the vocabulary is shared with, and so does editing an entry's
;; fields.
(def ^:private maintainers-only
  "Only a maintainer of the vocabulary can rename or delete its entries.")

(defn- maintainer-refusal
  "The 403 when the caller is neither an admin nor a maintainer of every
  vocabulary in `layer-ids`, or nil."
  [db layer-ids {user-id :user/id record :user/record}]
  (when-not (or (user/admin? record)
                (every? #(vocab-layer/maintainer? db % user-id) (distinct layer-ids)))
    {:status 403 :body {:error maintainers-only}}))

;; Bulk auth resolvers. Create reads :vocab-layer-id off an entry, delete
;; and update look the layer up from the entry's item id. All three take
;; the first entry that RESOLVES (`pra/bulk-resolver`); the handler then
;; checks every distinct layer.
(def bulk-get-layer-id
  (pra/bulk-resolver (fn [_db entry] (:vocab-layer-id entry))))

(def bulk-get-layer-id-from-item
  (pra/bulk-resolver (fn [db id]
                       (when (uuid? id)
                         (:vocab-item/layer (vocab-item/get db id))))))

(def bulk-get-layer-id-from-entry
  "The vocab layer the writer gate checks for a bulk update, resolved from
  the first entry that resolves (`pra/bulk-update-resolver`), as the token,
  span and relation bulk updates resolve theirs."
  (pra/bulk-update-resolver (fn [db id] (:vocab-item/layer (vocab-item/get db id)))))

(def vocab-item-routes
  ["/vocab-items"

   [""
    {:post {:summary "Create a new vocab item"
            :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-layer]
                         metadata/wrap-inline-metadata-shape-guard]
            :parameters {:body [:map
                                [:vocab-layer-id :uuid]
                                [:form string?]
                                [:metadata {:optional true} [:map-of string? any?]]]}
            :handler (fn [{{{:keys [vocab-layer-id form metadata]} :body} :parameters
                           db :db
                           user-id :user/id :as req}]
                       (let [attrs {:vocab-item/layer vocab-layer-id
                                    :vocab-item/form form}
                             result (vocab-item/create db attrs user-id metadata)]
                         (if (:success result)
                           {:status 201
                            :body {:id (:extra result)}}
                           {:status (or (:code result) 500)
                            :body {:error (:error result)}})))}}]

   ["/bulk" {:conflicting true
             :post {:summary (str "Create multiple vocab items in a single operation. Provide an array of objects whose keys are:\n"
                                  "<body>vocab-layer-id</body>, the vocab layer to create the item in\n"
                                  "<body>form</body>, the item's form\n"
                                  "<body>metadata</body>, an optional map of metadata\n"
                                  "Entries may target different vocab layers; the user must have write access to each.")
                    ;; vocab-WRITER on the first entry's layer is the coarse
                    ;; gate; the handler then checks write access on EVERY
                    ;; distinct layer, which the single-id middleware can't.
                    :middleware [[pra/wrap-vocab-writer-required bulk-get-layer-id]
                                 metadata/wrap-inline-metadata-shape-guard]
                    :parameters {:body [:sequential
                                        [:map
                                         [:vocab-layer-id :uuid]
                                         [:form string?]
                                         [:metadata {:optional true} [:map-of string? any?]]]]}
                    :handler (fn [{{items :body} :parameters db :db user-id :user/id}]
                               (or (pra/vocab-layers-refusal db (map :vocab-layer-id items) user-id)
                                   (let [attrs-vec (mapv (fn [{:keys [vocab-layer-id form metadata]}]
                                                           (cond-> {:vocab-item/layer vocab-layer-id
                                                                    :vocab-item/form form}
                                                             metadata (assoc :metadata metadata)))
                                                         items)
                                         result (vocab-item/bulk-create db attrs-vec user-id)]
                                     (if (:success result)
                                       {:status 201 :body {:ids (:extra result)}}
                                       {:status (or (:code result) 500)
                                        :body {:error (:error result)}}))))}
             :patch {:summary (str "Update multiple vocab items in a single operation. Provide an array of objects whose keys are:\n"
                                   "<body>id</body>, the vocab item to update\n"
                                   "<body>form</body>, an optional new form (set only when the key is present)\n"
                                   "<body>metadata</body>, an optional list of metadata ops, as for PATCH on one entry's metadata\n"
                                   "Entries may target different vocab layers; the user must have write access to each, and maintainer rights on the vocabulary of every entry whose form changes. An unknown id refuses the whole update, and an id may appear only once. "
                                   "Only an entry whose form actually changes restates the documents linking it; every document so restated has its version bumped, and their new versions are returned in X-Document-Versions.")
                     ;; Same two-step gate as the other bulk verbs: the coarse
                     ;; vocab-WRITER check runs on the first entry's layer, and
                     ;; the handler then checks every distinct layer.
                     :middleware [[pra/wrap-vocab-writer-required bulk-get-layer-id-from-entry]
                                  metadata/wrap-inline-metadata-shape-guard]
                     :parameters {:body [:sequential
                                         [:map
                                          [:id :uuid]
                                          [:form {:optional true} string?]
                                          [:metadata {:optional true} metadata/metadata-ops-schema]]]}
                     :handler (fn [{{items :body} :parameters db :db user-id :user/id :as req}]
                                (let [attrs-vec (mapv (fn [{:keys [id form metadata]}]
                                                        (cond-> {:id id}
                                                          (some? form) (assoc :vocab-item/form form)
                                                          metadata (assoc :metadata metadata)))
                                                      items)]
                                  (or (pra/vocab-layers-refusal db (vocab-item/get-layer-ids db (map :id items)) user-id)
                                      (maintainer-refusal db (vocab-item/renamed-layer-ids db attrs-vec) req)
                                      (let [{:keys [success code error extra documents]}
                                            (vocab-item/bulk-merge db attrs-vec user-id)]
                                        (if success
                                          (prm/assoc-document-versions-in-header
                                           {:status 200 :body {:count (count extra)}} db documents)
                                          {:status (or code 500)
                                           :body {:error (or error "Internal server error")}})))))}
             :delete {:summary (str "Delete multiple vocab items in a single operation. Provide an array of IDs. Needs maintainer rights on the vocabulary of every item. "
                                    "Each item's descendant vocab links are deleted too. Every document holding a link to the entry has its version bumped, and their new versions are returned in X-Document-Versions.")
                      :middleware [[pra/wrap-vocab-writer-required bulk-get-layer-id-from-item]]
                      :parameters {:body [:sequential :uuid]}
                      :handler (fn [{{ids :body} :parameters db :db user-id :user/id :as req}]
                                 (or (pra/vocab-layers-refusal db (vocab-item/get-layer-ids db ids) user-id)
                                     (maintainer-refusal db (vocab-item/get-layer-ids db ids) req)
                                     (let [{:keys [success code error documents]} (vocab-item/bulk-delete db ids user-id)]
                                       (if success
                                         (prm/assoc-document-versions-in-header
                                          {:status 204} db documents)
                                         {:status (or code 500)
                                          :body {:error (or error "Internal server error")}}))))}}]

   ["/:id"
    {:conflicting true
     :parameters {:path [:map [:id :uuid]]}
     :get {:summary "Get a vocab item by ID"
           :middleware [[pra/wrap-vocab-reader-required get-vocab-id-from-item]]
           :handler (fn [{{{:keys [id]} :path} :parameters
                          db :db :as req}]
                      (let [vi (vocab-item/get db id)]
                        (if vi
                          {:status 200
                           :body vi}
                          {:status 404
                           :body {:error "Vocab item not found"}})))}

     :patch {:summary (str "Update a vocab item's form. A document read carries the entry's form on "
                           "every link to it, so a rename restates those documents. Every document holding a link to the entry has its version bumped, and their new versions are returned in X-Document-Versions. "
                           "Changing the form needs maintainer rights on the vocabulary.")
             :middleware [[pra/wrap-vocab-writer-required get-vocab-id-from-item]]
             :parameters {:body [:map [:form string?]]}
             :handler (fn [{{{:keys [id]} :path {:keys [form]} :body} :parameters
                            db :db
                            user-id :user/id :as req}]
                        (or (maintainer-refusal db (vocab-item/renamed-layer-ids db [{:id id :vocab-item/form form}]) req)
                            (let [result (vocab-item/merge db id {:vocab-item/form form} user-id)]
                              (if (:success result)
                                ;; A rename restates every document that links this
                                ;; entry, so their versions moved: tell the client,
                                ;; or its next write to one of them is refused for a
                                ;; change it made itself.
                                (prm/assoc-document-versions-in-header
                                 {:status 200
                                  :body (vocab-item/get db id)}
                                 db (:documents result))
                                {:status (or (:code result) 500)
                                 :body {:error (:error result)}}))))}

     :delete {:summary (str "Delete a vocab item, and every link to it. Every document holding a link to the entry has its version bumped, and their new versions are returned in X-Document-Versions. "
                            "Needs maintainer rights on the vocabulary.")
              :middleware [[pra/wrap-vocab-maintainer-required get-vocab-id-from-item maintainers-only]]
              :handler (fn [{{{:keys [id]} :path} :parameters
                             db :db
                             user-id :user/id :as req}]
                         (let [{:keys [success code error documents]} (vocab-item/delete db id user-id)]
                           (if success
                             (prm/assoc-document-versions-in-header
                              {:status 204} db documents)
                             {:status (or code 500)
                              :body {:error (or error "Internal server error")}})))}}]

   ;; Metadata operations. A vocab item has no document, so no
   ;; ?document-version, and its gate is vocab write access.
   ["/:id/metadata"
    (assoc (metadata/metadata-route-data
            {:entity-type "vocab item"
             :entity-id-key :id
             :writer-middleware [pra/wrap-vocab-writer-required get-vocab-id-from-item]
             :get-fn vocab-item/get
             :set-fn vocab-item/set-metadata
             :patch-fn vocab-item/patch-metadata
             :delete-fn vocab-item/delete-metadata})
           :parameters {:path [:map [:id :uuid]]})]])
