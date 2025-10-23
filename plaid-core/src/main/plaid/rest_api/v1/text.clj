(ns plaid.rest-api.v1.text
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.xtdb.text-layer :as txtl]
            [plaid.xtdb.text :as txt]))

(defn get-project-id [{db :db params :parameters}]
  (let [txtl-id (-> params :body :text-layer-id)
        text-id (-> params :path :text-id)]
    (cond
      txtl-id (txtl/project-id db txtl-id)
      text-id (txt/project-id db text-id)
      :else nil)))

(defn get-document-id [{db :db params :parameters}]
  (let [document-id (-> params :body :document-id)
        text-id (-> params :path :text-id)]
    (cond
      document-id document-id
      text-id (:text/document (txt/get db text-id))
      :else nil)))

(def text-routes
  ["/texts"

   ["" {:post {:summary (str "Create a new text in a document's text layer. A text is simply a container for one "
                             "long string in <body>body</body> for a given layer."
                             "\n"
                             "\n<body>text-layer-id</body>: the text's associated layer."
                             "\n<body>document-id</body>: the text's associated document."
                             "\n<body>body</body>: the string which is the content of this text.")
               :middleware [[pra/wrap-writer-required get-project-id]
                            [prm/wrap-document-version get-document-id]]
               :parameters {:query [:map [:document-version {:optional true} :uuid]]
                            :body [:map
                                   [:text-layer-id :uuid]
                                   [:document-id :uuid]
                                   [:body string?]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [text-layer-id document-id body metadata]} :body} :parameters xtdb :xtdb user-id :user/id}]
                          (let [attrs {:text/layer text-layer-id
                                       :text/document document-id
                                       :text/body body}
                                result (txt/create {:node xtdb} attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-versions-in-header
                                {:status 201
                                 :body {:id (:extra result)}}
                                result)
                              {:status (or (:code result) 500)
                               :body {:error (:error result)}})))}}]

   ["/:text-id"
    {:parameters {:path [:map [:text-id :uuid]]}}

    ["" {:get {:summary "Get a text."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :handler (fn [{{{:keys [text-id]} :path} :parameters db :db}]
                          (let [text (txt/get db text-id)]
                            (if (some? text)
                              {:status 200
                               :body text}
                              {:status 404
                               :body {:error "Text not found"}})))}
         :patch {:summary (str "Update a text's <body>body</body>. A diff is computed between the new and old "
                               "bodies, and a best effort is made to minimize Levenshtein distance between the two. "
                               "Token indices are updated so that tokens remain intact. Tokens which fall within "
                               "a range of deleted text are either shrunk appropriately if there is partial overlap "
                               "or else deleted if there is whole overlap."
                               "\n\n"
                               "If preferred, body can instead be a list of edit directives such as:\n"
                               "  {type: \"delete\", index: 5, value: 3} (delete 3 chars at index 5)\n"
                               "  {type: \"insert\", index: 0, value: \"abc\"} (insert \"abc\" at the front)")
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:query [:map [:document-version {:optional true} :uuid]]
                              ;; TODO figure out how to make malli happy with something like this
                              ;; [:map [:body {:optional true} string?]
                              ;;  [:ops {:optional true} [:sequential [:map
                              ;;                                       [:type [:enum "delete" "insert"]]
                              ;;                                       [:index int?]
                              ;;                                      [:value [:or string? int?]]]]]]
                              :body any?}
                 :handler (fn [{{{:keys [text-id]} :path {:keys [body]} :body} :parameters xtdb :xtdb user-id :user/id}]
                            (let [{:keys [success code error] :as result} (txt/update-body {:node xtdb} text-id body user-id)]
                              (if success
                                (prm/assoc-document-versions-in-header
                                  {:status 200
                                   :body (txt/get xtdb text-id)}
                                  result)
                                {:status (or code 500)
                                 :body {:error (or error "Internal server error")}})))}
         :delete {:summary "Delete a text and all dependent data."
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :parameters {:query [:map [:document-version {:optional true} :uuid]]}
                  :handler (fn [{{{:keys [text-id]} :path} :parameters xtdb :xtdb user-id :user/id}]
                             (let [{:keys [success code error] :as result} (txt/delete {:node xtdb} text-id user-id)]
                               (if success
                                 (prm/assoc-document-versions-in-header
                                   {:status 204}
                                   result)
                                 {:status (or code 500)
                                  :body {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "text" :text-id get-project-id get-document-id txt/get txt/set-metadata txt/delete-metadata)]])