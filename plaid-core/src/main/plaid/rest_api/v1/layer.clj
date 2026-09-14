(ns plaid.rest-api.v1.layer
  "Routes shared by every layer kind: the editor-config sub-routes, and the
  create / read / rename / delete / shift set that text, token, span and
  relation layers all expose."
  (:require [clojure.string :as str]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.sql.project :as prj]))

(defn- config-handlers [id-keyword]
  {:put    {:summary    (str "Set a configuration value for a layer in an editor namespace. Intended for storing "
                             "metadata about how the layer is intended to be used, e.g. for morpheme tokenization "
                             "or sentence boundary marking.")
            :parameters {:path [:map [id-keyword :uuid] [:namespace string?] [:config-key string?]]
                         :body any?}
            :handler    (fn [{{{:keys [namespace config-key] id id-keyword} :path config-value :body} :parameters db :db user-id :user/id}]
                          (let [{:keys [success code error]} (prj/assoc-editor-config-pair db id namespace config-key config-value user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500)
                               :body   {:error (or error "Internal server error")}})))}

   :delete {:summary    "Remove a configuration value for a layer."
            :parameters {:path [:map [id-keyword :uuid] [:namespace string?] [:config-key string?]]}
            :handler    (fn [{{{:keys [namespace config-key] id id-keyword} :path} :parameters db :db user-id :user/id}]
                          (let [{:keys [success code error]} (prj/dissoc-editor-config-pair db id namespace config-key user-id)]
                            (if success
                              {:status 204}
                              {:status (or code 500)
                               :body   {:error (or error "Internal server error")}})))}})

(defn layer-config-routes
  "Generates config sub-routes for a layer.
  When get-project-id-fn is provided, applies wrap-maintainer-required middleware directly.
  When omitted, assumes the caller has already wrapped with appropriate auth middleware."
  ([id-keyword]
   ["/config/:namespace/:config-key"
    (config-handlers id-keyword)])
  ([id-keyword get-project-id-fn]
   ["/config/:namespace/:config-key"
    (assoc (config-handlers id-keyword)
           :middleware [[pra/wrap-maintainer-required get-project-id-fn]])]))

(defn layer-routes
  "The routes every layer kind has: POST to create, then GET / PATCH the name /
  DELETE / POST shift / the config sub-routes on one layer. Text, token, span and
  relation layers differ only in their nouns, their id parameter, and what a
  create takes, so the create block is supplied whole and the rest is built here.

  Spec:
    :path        the collection path, e.g. \"/span-layers\"
    :id-key      the path-parameter keyword, e.g. :span-layer-id
    :noun        lowercase noun for the summaries and the 404, e.g. \"span layer\"
    :project-fn  `(fn [request])` -> the project id the auth middleware guards
    :post        the create route's `{:summary :parameters :handler}` map (the
                 middleware is added here)
    :get-fn      `(fn [db id])`      -> the layer, or nil
    :merge-fn    `(fn [db id m user-id])` -> the operation result
    :name-key    the namespaced name attribute, e.g. :span-layer/name
    :delete-fn   `(fn [db id user-id])`   -> the operation result
    :shift-fn    `(fn [db id up? user-id])` -> the operation result
    :shift-summary  the shift route's summary (text layer's names the project)"
  [{:keys [path id-key noun project-fn post
           get-fn merge-fn name-key delete-fn shift-fn shift-summary]}]
  (let [Noun (str/capitalize noun)
        maintainer [[pra/wrap-maintainer-required project-fn]]
        id-of (fn [request] (get-in request [:parameters :path id-key]))
        ;; A write reports the operation's own :code. The fallback is 500 (a
        ;; failure with no code of its own is a server fault), except on shift,
        ;; where all four layer kinds have always answered 400.
        respond (fn [{:keys [success code error]} fallback-code fallback-msg on-success]
                  (if success
                    (on-success)
                    {:status (or code fallback-code)
                     :body {:error (or error fallback-msg)}}))]
    [path
     ["" {:post (assoc post :middleware maintainer)}]

     [(str "/:" (name id-key))
      {:parameters {:path [:map [id-key :uuid]]}}

      [""
       {:get {:summary (str "Get a " noun " by ID.")
              :middleware [[pra/wrap-reader-required project-fn]]
              :handler (fn [{db :db :as request}]
                         (if-let [layer (get-fn db (id-of request))]
                           {:status 200 :body layer}
                           {:status 404 :body {:error (str Noun " not found")}}))}
        :patch {:summary (str "Update a " noun "'s name.")
                :middleware maintainer
                :parameters {:body [:map [:name :string]]}
                :handler (fn [{{{:keys [name]} :body} :parameters db :db user-id :user/id :as request}]
                           (let [id (id-of request)]
                             (respond (merge-fn db id {name-key name} user-id)
                                      500 "Internal server error"
                                      (fn [] {:status 200 :body (get-fn db id)}))))}
        :delete {:summary (str "Delete a " noun ".")
                 :middleware maintainer
                 :handler (fn [{db :db user-id :user/id :as request}]
                            (respond (delete-fn db (id-of request) user-id)
                                     500 "Internal server error"
                                     (fn [] {:status 204})))}}]

      ["/shift"
       {:post {:summary shift-summary
               :middleware maintainer
               :parameters {:body [:map [:direction [:enum "up" "down"]]]}
               :handler (fn [{{{:keys [direction]} :body} :parameters db :db user-id :user/id :as request}]
                          (respond (shift-fn db (id-of request) (= direction "up") user-id)
                                   400 (str "Failed to shift " noun)
                                   (fn [] {:status 204})))}}]

      (layer-config-routes id-key project-fn)]]))
