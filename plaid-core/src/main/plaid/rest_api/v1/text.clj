(ns plaid.rest-api.v1.text
  (:require [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [reitit.coercion.malli]
            [plaid.sql.text-layer :as txtl]
            [plaid.sql.text :as txt]
            [plaid.util.digest :as digest]))

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
                             "\n<body>body</body>: the string which is the content of this text."
                             "\n<body>id</body>: optional, the new text's id, a UUIDv7 the client minted (else the server mints one). An id used before, even by a text since deleted, is refused with 409 and <body>id-taken</body>.")
               :middleware [[pra/wrap-writer-required get-project-id]
                            [prm/wrap-document-version get-document-id]
                            metadata/wrap-inline-metadata-shape-guard]
               :parameters {:query [:map [:document-version {:optional true} :int]]
                            :body [:map
                                   [:id {:optional true} :uuid]
                                   [:text-layer-id :uuid]
                                   [:document-id :uuid]
                                   [:body string?]
                                   [:metadata {:optional true} [:map-of string? any?]]]}
               :handler (fn [{{{:keys [id text-layer-id document-id body metadata]} :body} :parameters db :db user-id :user/id}]
                          (let [attrs (cond-> {:text/layer text-layer-id
                                               :text/document document-id
                                               :text/body body}
                                        (some? id) (assoc :text/id id))
                                result (txt/create db attrs user-id metadata)]
                            (if (:success result)
                              (prm/assoc-document-version-in-header
                               {:status 201
                                :body {:id (:extra result)}}
                               db document-id)
                              {:status (or (:code result) 500)
                               :body (prm/error-body result)})))}}]

   ["/:text-id"
    {:parameters {:path [:map [:text-id :uuid]]}}

    ;; `body` and `edits` reach `plaid.sql.text` as sent: an edit's
    ;; indices count the text it inserts as sent, and the save composes the
    ;; body it makes with the token offsets (see `prm/compose-text`).
    ["" {:plaid/raw-text #{:body :edits}
         :get {:summary "Get a text."
               :middleware [[pra/wrap-reader-required get-project-id]]
               :handler (fn [{{{:keys [text-id]} :path} :parameters db :db}]
                          (let [text (txt/get db text-id)]
                            (if (some? text)
                              {:status 200
                               :body text}
                              {:status 404
                               :body {:error "Text not found"}})))}
         :patch {:summary (str "Change a text's body, in one of two forms."
                               "\n\n"
                               "<body>edits</body> (with <body>base</body>): the edits made at the caret, as a list of "
                               "edit directives (below) applied in order, each index in the body the ones before it "
                               "left. Only their net change counts. A pure insert or delete stays exactly where it "
                               "was made, and a stretch both deleted and typed over is read as a whole-body update "
                               "reads the same change. The tokens then follow the rules a whole-body update follows. "
                               "<body>base</body> is the <body>digest</body> of the text the edits were made on, as "
                               "every read of a text gives it: the edit applies only to that body, and answers 409 "
                               "with <body>text-changed</body> true and the stored <body>digest</body> otherwise. "
                               "An edit with <body>base</body> needs no document version."
                               "\n\n"
                               "<body>body</body>: the whole new body. A diff is computed between the new and old "
                               "bodies, and a best effort is made to minimize Levenshtein distance between the two. "
                               "Token indices are updated so that tokens remain intact. Tokens which fall within "
                               "a range of deleted text are either shrunk appropriately if there is partial overlap "
                               "or else deleted if there is whole overlap."
                               "\n\n"
                               "If preferred, body can instead be a list of edit directives such as:\n"
                               "  {type: \"delete\", index: 5, value: 3} (delete 3 chars at index 5)\n"
                               "  {type: \"insert\", index: 0, value: \"abc\"} (insert \"abc\" at the front)\n"
                               "  {type: \"replace\", index: 5, length: 3, value: \"xy\"} (swap 3 chars at index 5 for \"xy\")\n"
                               "A replace differs from delete+insert in one way: a token covering the whole "
                               "replaced range is resized to keep it rather than deleted, so a word can be "
                               "respelled in place without losing its annotations. Indices are code points. A list "
                               "under <body>body</body> is applied exactly as sent. <body>base</body> may be sent "
                               "with either form of <body>body</body> too."
                               "\n\n"
                               "The answer is the text with its new <body>digest</body>, and <body>reshape</body>: "
                               "the tokens whose extent the update changed (<body>id</body>, <body>begin</body>, "
                               "<body>end</body>), the spans and vocabulary links whose token lists it changed "
                               "(<body>id</body>, <body>tokens</body>), and under <body>deleted</body> the ids of "
                               "the tokens, spans, relations and vocabulary links it deleted.")
                 :middleware [[pra/wrap-writer-required get-project-id]
                              [prm/wrap-document-version get-document-id]]
                 :parameters {:query [:map [:document-version {:optional true} :int]]
                              ;; `{body}` (a string or a list of delete, insert and
                              ;; replace directives) or `{edits}`, each with an
                              ;; optional `base`: read and refused with 400 by the
                              ;; handler below and by the text edit reader.
                              :body any?}
                 :handler (fn [{{{:keys [text-id]} :path params :body} :parameters db :db user-id :user/id}]
                            (let [doc-id (:text/document (txt/get db text-id))
                                  {:keys [body edits base]} (when (map? params) params)
                                  {:keys [success code error op text-changed]}
                                  (cond
                                    (not (map? params))
                                    {:code 400 :error "The request body must be a map with body or edits."}
                                    (and (contains? params :body) (contains? params :edits))
                                    {:code 400 :error "Send either body or edits, not both."}
                                    (and (some? base) (not (string? base)))
                                    {:code 400 :error "base must be a string."}
                                    (contains? params :edits)
                                    (txt/edit-body db text-id {:edits edits :base base} user-id)
                                    :else
                                    (txt/update-body db text-id body user-id base))]
                              (cond
                                success
                                (prm/assoc-document-version-in-header
                                 {:status 200
                                  ;; the body and digest the save wrote, not a
                                  ;; read after it that another save may have
                                  ;; changed, beside the reshape it made
                                  :body (assoc (txt/get db text-id)
                                               :text/body (:body op)
                                               :text/digest (digest/text-digest (:body op))
                                               :reshape (txt/reshape db op))}
                                 db doc-id)
                                text-changed
                                {:status 409
                                 :body {:error error
                                        :text-changed true
                                        :digest (:text/digest (txt/get db text-id))}}
                                :else
                                {:status (or code 500)
                                 :body {:error (or error "Internal server error")}})))}
         :delete {:summary "Delete a text and all dependent data."
                  :middleware [[pra/wrap-writer-required get-project-id]
                               [prm/wrap-document-version get-document-id]]
                  :parameters {:query [:map [:document-version {:optional true} :int]]}
                  :handler (fn [{{{:keys [text-id]} :path} :parameters db :db user-id :user/id}]
                             (let [doc-id (:text/document (txt/get db text-id))
                                   {:keys [success code error]} (txt/delete db text-id user-id)]
                               (if success
                                 (prm/assoc-document-version-in-header
                                  {:status 204}
                                  db doc-id)
                                 {:status (or code 500)
                                  :body {:error (or error "Internal server error")}})))}}]

    ;; Metadata operations
    (metadata/metadata-routes "text" :text-id get-project-id get-document-id txt/get txt/set-metadata txt/delete-metadata txt/patch-metadata)]])
