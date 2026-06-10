(ns plaid.rest-api.v1.token
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.sql.token :as tok]
            [plaid.sql.token-layer :as tokl]))

(defn get-project-id [{db :db params :parameters}]
  (let [tokl-id (or (-> params :body :token-layer-id))
        token-id (-> params :path :token-id)]
    (cond
      tokl-id (tokl/project-id db tokl-id)
      token-id (tok/project-id db token-id)
      :else nil)))

(defn bulk-get-project-id [{db :db params :parameters}]
  (let [tokl-id (or (-> params :body first :token-layer-id))
        token-id (-> params :body first)]
    (cond
      tokl-id (tokl/project-id db tokl-id)
      token-id (tok/project-id db token-id)
      :else nil)))

(defn get-document-id [{db :db params :parameters}]
  (let [token-id (-> params :path :token-id)
        text-id (-> params :body :text)]
    (cond
      token-id (when-let [token (tok/get db token-id)]
                 (tok/get-doc-id-of-text db (:token/text token)))
      text-id (tok/get-doc-id-of-text db text-id))))

(defn bulk-get-document-id [{db :db params :parameters}]
  (let [token-id (-> params :body first)
        text-id (when (map? token-id) (:text token-id))]
    (cond
      text-id (tok/get-doc-id-of-text db text-id)
      (uuid? token-id) (when-let [token (tok/get db token-id)]
                         (tok/get-doc-id-of-text db (:token/text token))))))

(def token-routes
  ["/tokens"

   ["" {:post {:summary (str "Create a new token in a token layer. Tokens define text substrings using "
                             "<body>begin</body> and <body>end</body> offsets in the text. On layers whose "
                             "<body>overlap-mode</body> is <body>any</body> (the default) tokens may be zero-width "
                             "and may overlap each other; <body>non-overlapping</body> layers reject a token that "
                             "overlaps an existing one (409); <body>partitioning</body> layers reject single creation "
                             "entirely (400) — use bulk-create to establish the partition. For tokens which share the "
                             "same <body>begin</body>, <body>precedence</body> may be used to indicate a preferred "
                             "linear ordering, with tokens with lower <body>precedence</body> occurring earlier."
                             "\n"
                             "\n<body>token-layer-id</body>: the layer in which to insert this token."
                             "\n<body>text</body>: the text in which this token is found."
                             "\nOffsets are 0-based indices in Unicode CODE POINTS (not UTF-16 code units or bytes): a supplementary-plane character such as an emoji or an SMP script counts as one."
                             "\n<body>begin</body>: the inclusive code-point offset at which this token begins in the body of the text specified by <body>text</body>"
                             "\n<body>end</body>: the exclusive code-point offset at which this token ends in the body of the text specified by <body>text</body>"
                             "\n<body>precedence</body>: used for tokens with the same <body>begin</body> value in order to indicate their preferred linear order.")
               :middleware [[pra/wrap-writer-required get-project-id]
                            [prm/wrap-document-version get-document-id]
                            metadata/wrap-inline-metadata-shape-guard]
               :parameters {:query [:map [:document-version {:optional true} :int]]
                            :body [:map
                                   [:token-layer-id :uuid]
                                   [:text :uuid]
                                   [:begin int?]
                                   [:end int?]
                                   [:precedence {:optional true} int?]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [token-layer-id text begin end precedence metadata]} :body} :parameters db :db user-id :user/id :as request}]
                          (let [attrs (cond-> {:token/layer token-layer-id
                                               :token/text text
                                               :token/begin begin
                                               :token/end end}
                                        (some? precedence) (assoc :token/precedence precedence))
                                doc-id (get-document-id request)
                                result (tok/create db attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-version-in-header
                               {:status 201 :body {:id (:extra result)}}
                               db doc-id)
                              {:status (or (:code result) 500) :body {:error (:error result)}})))}}]

   ["/bulk" {:conflicting true
             :post {:summary (str "Create multiple tokens in a single operation. Provide an array of objects whose keys "
                                  "are:\n"
                                  "<body>token-layer-id</body>, the token's layer\n"
                                  "<body>text</body>, the ID of the token's text\n"
                                  "<body>begin</body>, the inclusive Unicode code-point offset at which the token begins\n"
                                  "<body>end</body>, the exclusive Unicode code-point offset at which the token ends\n"
                                  "<body>precedence</body>, optional, an integer controlling which orders appear first in linear order when two or more tokens have the same <body>begin</body>\n"
                                  "<body>metadata</body>, an optional map of metadata")
                    :openapi {:x-client-method "bulk-create"}
                    :middleware [[pra/wrap-writer-required bulk-get-project-id]
                                 [prm/wrap-document-version bulk-get-document-id]
                                 metadata/wrap-inline-metadata-shape-guard]
                    :parameters {:query [:map [:document-version {:optional true} :int]]
                                 :body [:sequential
                                        [:map
                                         [:token-layer-id :uuid]
                                         [:text :uuid]
                                         [:begin int?]
                                         [:end int?]
                                         [:precedence {:optional true} int?]
                                         [:metadata {:optional true} [:map-of string? any?]]]]}
                    :handler (fn [{{tokens :body} :parameters db :db user-id :user/id :as request}]
                               (let [tokens-attrs (mapv (fn [token-data]
                                                          (let [{:keys [token-layer-id text begin end precedence metadata]} token-data
                                                                attrs (cond-> {:token/layer token-layer-id
                                                                               :token/text text
                                                                               :token/begin begin
                                                                               :token/end end}
                                                                        (some? precedence) (assoc :token/precedence precedence))]
                                                            (if metadata
                                                              (assoc attrs :metadata metadata)
                                                              attrs)))
                                                        tokens)
                                     doc-id (bulk-get-document-id request)
                                     result (tok/bulk-create db tokens-attrs user-id)]
                                 (if (:success result)
                                   (prm/assoc-document-version-in-header
                                    {:status 201 :body {:ids (:extra result)}}
                                    db doc-id)
                                   {:status (or (:code result) 500) :body {:error (:error result)}})))}
             :delete {:summary (str "Delete multiple tokens in a single operation. Provide an array of IDs. All "
                                    "tokens must belong to the same document (400 otherwise). As with "
                                    "single delete, each deleted token also drags down the descendant tokens nested "
                                    "within it (and their dependent spans, relations, and vocab-links) if the layer "
                                    "has child token layers.")
                      :openapi {:x-client-method "bulk-delete"}
                      :middleware [[pra/wrap-writer-required bulk-get-project-id]
                                   [prm/wrap-document-version bulk-get-document-id]]
                      :parameters {:query [:map [:document-version {:optional true} :int]]
                                   :body [:sequential :uuid]}
                      :handler (fn [{{token-ids :body} :parameters db :db user-id :user/id :as request}]
                                 (let [doc-id (bulk-get-document-id request)
                                       {:keys [success code error]} (tok/bulk-delete db token-ids user-id)]
                                   (if success
                                     (prm/assoc-document-version-in-header
                                      {:status 204}
                                      db doc-id)
                                     {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

   ["/:token-id"
    {:conflicting true
     :parameters {:path [:map [:token-id :uuid]]}}

    ["" {:get {:summary "Get a token."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :handler (fn [{{{:keys [token-id]} :path} :parameters db :db}]
                          (let [token (tok/get db token-id)]
                            (if (some? token)
                              {:status 200 :body token}
                              {:status 404 :body {:error "Token not found"}})))}
         :patch {:summary (str "Update a token. Supported keys:"
                               "\n"
                               "\n<body>begin</body>: start offset of the token (0-based, inclusive, Unicode code points)"
                               "\n<body>end</body>: end offset of the token (0-based, exclusive, Unicode code points)"
                               "\n<body>precedence</body>: ordering value for the token relative to other tokens with the same <body>begin</body>--lower means earlier"
                               "\n"
                               "\nExtent changes are subject to the layer's <body>overlap-mode</body>: on "
                               "<body>non-overlapping</body> layers an update that would overlap another token is "
                               "rejected (409); on <body>partitioning</body> layers direct extent changes are rejected "
                               "(400) — use the token shift endpoint instead. Non-extent updates (e.g. "
                               "<body>precedence</body>) are always allowed."
                               "\n"
                               "\n<body>precedence</body> may be set to <body>null</body> explicitly to clear it (revert "
                               "to no explicit ordering); a key that is omitted from the body is left unchanged."
                               "\n"
                               "\nIf the layer has child token layers, an extent change cascades to descendants exactly "
                               "as the shift endpoint does (straddlers split/trimmed, fully-outside children deleted).")
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:query [:map [:document-version {:optional true} :int]]
                              :body [:map
                                     [:begin {:optional true} int?]
                                     [:end {:optional true} int?]
                                     ;; [:maybe int?] so an explicit `null` is accepted (clears
                                     ;; precedence); `{:optional true}` distinguishes that from
                                     ;; an omitted key (left unchanged) — see handler's contains?.
                                     [:precedence {:optional true} [:maybe int?]]]}
                 :handler (fn [{{{:keys [token-id]} :path body :body} :parameters db :db user-id :user/id :as request}]
                            (let [{:keys [begin end]} body
                                  raw-attrs (cond-> {}
                                              (some? begin) (assoc :token/begin begin)
                                              (some? end) (assoc :token/end end)
                                              ;; contains? (not some?): an explicit precedence:null
                                              ;; clears the column; an omitted key is left untouched.
                                              ;; tok/merge already honors a nil :token/precedence.
                                              (contains? body :precedence) (assoc :token/precedence (:precedence body)))
                                  doc-id (get-document-id request)
                                  {success :success code :code error :error} (tok/merge db token-id raw-attrs user-id)]
                              (if success
                                (prm/assoc-document-version-in-header
                                 {:status 200 :body (tok/get db token-id)}
                                 db doc-id)
                                {:status (or code 500) :body {:error (or error "Internal server error")}})))}
         :delete {:summary (str "Delete a token and remove it from any spans. If this causes the span to have no "
                                "remaining associated tokens, the span will also be deleted. If the layer has child "
                                "token layers, deleting a parent token also deletes the descendant tokens nested "
                                "within its extent (and their dependent spans, relations, and vocab-links). On "
                                "<body>partitioning</body> layers single deletion is rejected (400) — use the token "
                                "merge endpoint to combine tokens, or bulk-delete to remove the whole partition.")
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :parameters {:query [:map [:document-version {:optional true} :int]]}
                  :handler (fn [{{{:keys [token-id]} :path} :parameters db :db user-id :user/id :as request}]
                             (let [doc-id (get-document-id request)
                                   {:keys [success code error]} (tok/delete db token-id user-id)]
                               (if success
                                 (prm/assoc-document-version-in-header
                                  {:status 204}
                                  db doc-id)
                                 {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

    ["/split"
     {:post {:summary (str "Split a token at <body>position</body>, a 0-based Unicode code-point offset into the text "
                           "body. The original token becomes the left half (keeps ID, "
                           "spans, vocab-links). Returns the new right token's ID. If the layer has child token "
                           "layers, every descendant token that straddles the split position is split there too, so "
                           "nesting is preserved at every level (a split aligned to an existing child boundary needs "
                           "no child split).")
             :middleware [[pra/wrap-writer-required get-project-id]
                          [prm/wrap-document-version get-document-id]]
             :parameters {:query [:map [:document-version {:optional true} :int]]
                          :body [:map [:position int?]]}
             :handler (fn [{{{:keys [token-id]} :path {:keys [position]} :body} :parameters db :db user-id :user/id :as request}]
                        (let [doc-id (get-document-id request)
                              {:keys [success code error extra]}
                              (tok/split db token-id position user-id)]
                          (if success
                            (prm/assoc-document-version-in-header
                             {:status 201 :body {:id extra}}
                             db doc-id)
                            {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

    ["/merge"
     {:post {:summary (str "Merge two tokens. The left token (smaller begin) survives with the combined extent; "
                           "the right is deleted, and spans and vocab-links referencing it are reparented to the "
                           "left. On <body>partitioning</body> layers the two tokens must be adjacent (400 "
                           "otherwise); on <body>non-overlapping</body> layers the merged extent must not engulf a "
                           "third token (409 otherwise). The merged token contains both originals, so any tokens "
                           "nested in either remain contained — nothing is orphaned.")
             :middleware [[pra/wrap-writer-required get-project-id]
                          [prm/wrap-document-version get-document-id]]
             :parameters {:query [:map [:document-version {:optional true} :int]]
                          :body [:map [:other-token-id :uuid]]}
             :handler (fn [{{{:keys [token-id]} :path {:keys [other-token-id]} :body} :parameters db :db user-id :user/id :as request}]
                        (let [doc-id (get-document-id request)
                              {:keys [success code error extra]}
                              (tok/merge-tokens db token-id other-token-id user-id)]
                          (if success
                            (prm/assoc-document-version-in-header
                             {:status 200 :body (tok/get db extra)}
                             db doc-id)
                            {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

    ["/shift"
     {:post {:summary (str "Shift a token's boundary (move its <body>begin</body> and/or <body>end</body>). On "
                           "<body>partitioning</body> layers the adjacent token auto-adjusts so coverage is preserved; "
                           "on <body>non-overlapping</body> layers the new extent is validated against overlap (409). "
                           "If the layer has child token layers the resize cascades to descendants: on partitioning "
                           "layers a descendant straddling the moved boundary is split so its outer part re-homes to "
                           "the grown neighbor; on non-overlapping/any layers descendants that retain no overlap with "
                           "the new extent are deleted (including every child if the parent collapses to zero width) "
                           "and straddlers are trimmed to fit.")
             :middleware [[pra/wrap-writer-required get-project-id]
                          [prm/wrap-document-version get-document-id]]
             :parameters {:query [:map [:document-version {:optional true} :int]]
                          :body [:map
                                 [:begin {:optional true} int?]
                                 [:end {:optional true} int?]]}
             :handler (fn [{{{:keys [token-id]} :path {:keys [begin end]} :body} :parameters db :db user-id :user/id :as request}]
                        (let [attrs (cond-> {}
                                      (some? begin) (assoc :token/begin begin)
                                      (some? end) (assoc :token/end end))
                              doc-id (get-document-id request)
                              {:keys [success code error]}
                              (tok/shift-boundary db token-id attrs user-id)]
                          (if success
                            (prm/assoc-document-version-in-header
                             {:status 200 :body (tok/get db token-id)}
                             db doc-id)
                            {:status (or code 500) :body {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "token" :token-id get-project-id get-document-id tok/get tok/set-metadata tok/delete-metadata tok/patch-metadata)]])
