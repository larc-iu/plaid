(ns plaid.rest-api.v1.document
  (:require [clojure.string]
            [plaid.rest-api.v1.auth :as pra]
            [plaid.rest-api.v1.metadata :as metadata]
            [plaid.rest-api.v1.middleware :as prm]
            [plaid.rest-api.v1.media :as media]
            [plaid.history.read :as hread]
            [plaid.history.restore :as restore]
            [plaid.server.locks :as locks]
            [reitit.coercion.malli]
            [plaid.sql.document :as doc])
  (:import (java.time Instant)
           (java.time.format DateTimeParseException)))

;; Defined below; forward-declared so the auth-path history read in
;; get-project-id can be timeout-bounded like the GET handler's read.
(defn get-project-id
  "Resolve the project id for permission checks.

  Order: explicit body `:project-id` wins (POST create); else look up
  the doc's project on the OLTP `:db`; else, for at-time GETs, fall
  through to audit-log reconstruction at `:as-of-ts` so docs that were
  deleted from OLTP but existed at `ts` still resolve their project
  (the privilege check then runs against CURRENT ACL membership —
  historical ACL is out of scope per design)."
  [{db :db params :parameters as-of-ts :as-of-ts}]
  (let [prj-id (-> params :body :project-id)
        doc-id (-> params :path :document-id)]
    (cond
      prj-id prj-id
      doc-id (or (-> (doc/get db doc-id) :document/project)
                 (when as-of-ts
                   ;; Reconstruction fallthrough: doc was deleted from
                   ;; OLTP but may have existed at ts. A :history/pruned
                   ;; throw propagates to wrap-route-as-of (outer to this
                   ;; auth middleware) for a structured 400.
                   (-> (hread/get-at db doc-id as-of-ts)
                       :document/project)))
      :else nil)))

(defn get-document-id [{params :parameters}]
  (-> params :path :document-id))

;; ---------------------------------------------------------------------------
;; ?layers= (issue #57)
;;
;; A deep read otherwise returns every layer in the document's project. An app
;; that touches only a couple of them pays for and parses all of it. `?layers=`
;; is a comma-separated list of layer ids of ANY kind (text / token / span /
;; relation); `doc/prune-to-layers` defines what survives.
;;
;; An id that is not a layer of this document's project is a 400 rather than a
;; silently smaller response: a typo'd or stale layer id would otherwise look
;; exactly like "that layer is empty", which is the worst possible failure for
;; a caller using this to decide what to render.
;; ---------------------------------------------------------------------------

(defn- parse-layer-ids
  "Split the comma-separated `?layers=` value into a set of UUIDs. Returns
  `{:layers #{...}}` (nil layers meaning no filter) or `{:invalid \"tok\"}`."
  [raw]
  (if-let [raw (not-empty (some-> raw clojure.string/trim))]
    (let [tokens (->> (clojure.string/split raw #",")
                      (map clojure.string/trim)
                      (remove empty?)
                      distinct)]
      (reduce (fn [acc t]
                (if-let [u (try (java.util.UUID/fromString t) (catch Exception _ nil))]
                  (update acc :layers (fnil conj #{}) u)
                  (reduced {:invalid t})))
              {:layers nil}
              tokens))
    {:layers nil}))

(defn- unknown-layers
  "Ids in `layers` that are not layers of `deep-doc`'s project, sorted for a
  stable error message."
  [deep-doc layers]
  (let [known (->> (doc/layer-ids-by-kind deep-doc) vals (reduce into #{}))]
    (sort (map str (remove known layers)))))

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

    ["" {:get {:summary (str "Get a document. Set <query>include-body</query> to true in order to "
                             "include all data contained in the document. With a body read, "
                             "<query>layers</query> takes a comma-separated list of layer ids "
                             "(of any kind) and returns only those layers' contents: a layer "
                             "survives when it is named or is an ancestor of a named layer, and "
                             "carries its own texts/tokens/spans/relations/vocabs only when it "
                             "is itself named.")
               :middleware [[pra/wrap-reader-required get-project-id]]
               :parameters {:query [:map
                                    [:include-body {:optional true} boolean?]
                                    [:layers {:optional true} string?]]}
               :handler (fn [{{{:keys [document-id]} :path
                               {:keys [include-body layers]} :query} :parameters
                              db :db
                              as-of-ts :as-of-ts}]
                          ;; `wrap-route-as-of` injects :as-of-ts when ?as-of=
                          ;; was supplied. In that case serve the read from the
                          ;; audit log (plaid.history.read); the SQL deep-read
                          ;; shape is the contract on both sides. The version
                          ;; header is OLTP-only — at-time reads can't usefully
                          ;; advise OCC against the current row.
                          (let [{:keys [invalid] named :layers} (parse-layer-ids layers)]
                            (cond
                              invalid
                              {:status 400
                               :body {:error (str "Invalid layer id " (pr-str invalid)
                                                  ". ?layers= is a comma-separated list of layer UUIDs.")}}

                              (and named (not include-body))
                              {:status 400
                               :body {:error "?layers= selects which layers a body read returns, so it requires include-body=true."}}

                              :else
                              (let [document (cond
                                               (and as-of-ts include-body)
                                               (hread/get-with-layer-data-at db document-id as-of-ts)
                                               as-of-ts
                                               (hread/get-at db document-id as-of-ts)
                                               ;; The `named` arg only narrows which rows are
                                               ;; fetched; prune-to-layers below is what shapes
                                               ;; the response, on this path and the as-of one
                                               ;; alike.
                                               include-body
                                               (doc/get-with-layer-data db document-id named)
                                               :else
                                               (doc/get db document-id))
                                    bad (when (and named document) (unknown-layers document named))]
                                (cond
                                  (nil? document)
                                  {:status 404 :body {:error "Document not found"}}

                                  (seq bad)
                                  {:status 400
                                   :body {:error (str "No such layer in this document's project: "
                                                      (clojure.string/join ", " bad))}}

                                  :else
                                  (let [body (doc/prune-to-layers document named)]
                                    (if as-of-ts
                                      {:status 200 :body body}
                                      (prm/assoc-document-version-in-header
                                       {:status 200 :body body}
                                       db document-id))))))))}
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

    ["/restore"
     {:post {:summary (str "Restore the document to its state at <query>as-of</query> (an ISO-8601 instant), "
                           "as one operation: what was deleted since then comes back under its original id, "
                           "what was added since is removed, and what changed is set back, across every layer. "
                           "A layer deleted since then, or a vocabulary entry that no longer exists, is skipped and "
                           "reported under <body>skipped</body>. The response is a summary of the changes. "
                           "With <query>dry-run</query> true nothing is written and the summary says what would change. "
                           "Requires maintainer privileges.")
             :middleware [[pra/wrap-maintainer-required get-project-id]
                          [prm/wrap-document-version get-document-id]]
             :parameters {:query [:map
                                  [:as-of :string]
                                  [:dry-run {:optional true} boolean?]
                                  [:document-version {:optional true} :int]]}
             :handler (fn [{{{:keys [document-id]} :path
                             {:keys [as-of dry-run]} :query} :parameters
                            db :db
                            user-id :user/id}]
                        (let [ts (try (Instant/parse as-of)
                                      (catch DateTimeParseException _ nil))]
                          (cond
                            (nil? ts)
                            {:status 400
                             :body {:error (str "Invalid as-of value (expected ISO-8601 instant, e.g. "
                                                "2026-05-28T09:00:00Z): " as-of)}}

                            dry-run
                            (try
                              {:status 200 :body (restore/preview db document-id ts)}
                              (catch clojure.lang.ExceptionInfo e
                                (let [{:keys [code type]} (ex-data e)]
                                  (if (= type :history/pruned)
                                    {:status 400 :body {:error (ex-message e)}}
                                    {:status (or code 500)
                                     :body {:error (if (and code (< code 500)) (ex-message e) "Internal error")}}))))

                            :else
                            (let [{:keys [success extra code error]} (restore/restore db document-id ts user-id)]
                              (if success
                                (prm/assoc-document-version-in-header
                                 {:status 200 :body extra}
                                 db document-id)
                                {:status (or code 500)
                                 :body {:error (or error "Internal server error")}})))))}}]

    ["/copy"
     {:post {:summary (str "Copy the document and everything in it into a new document of the same "
                           "project, named <body>name</body>, as one operation. Every layer and every "
                           "vocabulary entry the source points at is shared with the copy, whose texts, "
                           "tokens, spans, relations and vocab links are the source's under fresh ids, "
                           "with their metadata. Comments do not travel. The media file does, unless "
                           "<body>include-media</body> is false; if it cannot be copied the response "
                           "carries <body>media-error</body> and the copy is otherwise complete. "
                           "Requires writer privileges.")
             :middleware [[pra/wrap-writer-required get-project-id]]
             :parameters {:body [:map
                                 [:name :string]
                                 [:include-media {:optional true} boolean?]]}
             :handler (fn [{{{:keys [document-id]} :path
                             {:keys [name include-media]} :body} :parameters
                            db :db
                            user-id :user/id}]
                        (let [{:keys [success extra code error]}
                              (doc/copy db document-id name user-id
                                        {:include-media? (if (some? include-media) include-media true)})]
                          (if success
                            (prm/assoc-document-version-in-header
                             {:status 201 :body extra}
                             db (:id extra))
                            {:status (or code 500)
                             :body {:error (or error "Internal server error")}})))}}]

    ["/lock"
     {:get {:summary "Get information about a document lock"
            :middleware [[pra/wrap-reader-required get-project-id]]
            :handler (fn [{{{:keys [document-id]} :path} :parameters}]
                       (if-let [lock-info (locks/get-lock-info document-id)]
                         {:status 200
                          :body {:user-id (:user-id lock-info)
                                 :expires-at (:expires-at lock-info)}}
                         {:status 204}))}

      :post {:summary "Acquire or refresh a document lock"
             :middleware [[pra/wrap-writer-required get-project-id]]
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
               :handler (fn [{{{:keys [document-id]} :path} :parameters user-id :user/id}]
                          (let [result (locks/release-lock! document-id user-id)]
                            (case result
                              :released {:status 204}
                              :not-held {:status 204})))}}]

    ;; Media operations
    media/media-routes

    ;; Metadata operations
    (metadata/metadata-routes "document" :document-id get-project-id get-document-id doc/get doc/set-metadata doc/delete-metadata doc/patch-metadata)]])
