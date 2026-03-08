(ns plaid.test-helpers
  (:require [clojure.string]
            [ring.mock.request]
            [plaid.fixtures :refer [api-call assert-created]]))

;; Project/Document helpers
(defn create-test-project [user-request-fn project-name]
  (let [response (api-call user-request-fn {:method :post
                                            :path "/api/v1/projects"
                                            :body {:name project-name}})]
    (assert-created response)
    (-> response :body :id)))

(defn get-test-project [user-request-fn project-id]
  (api-call user-request-fn {:method :get :path (str "/api/v1/projects/" project-id)}))

(defn delete-test-project [user-request-fn project-id]
  (api-call user-request-fn {:method :delete :path (str "/api/v1/projects/" project-id)}))

(defn create-test-document [user-request-fn project-id doc-name]
  (let [response (api-call user-request-fn {:method :post
                                            :path "/api/v1/documents"
                                            :body {:project-id project-id :name doc-name}})]
    (assert-created response)
    (-> response :body :id)))

;; Layer creation helpers
(defn create-text-layer [user-request-fn project-id name]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/text-layers"
                             :body {:project-id project-id :name name}}))

(defn create-token-layer [user-request-fn text-layer-id name]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/token-layers"
                             :body {:text-layer-id text-layer-id :name name}}))

(defn create-span-layer [user-request-fn token-layer-id name]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/span-layers"
                             :body {:token-layer-id token-layer-id :name name}}))

(defn create-relation-layer [user-request-fn span-layer-id name]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/relation-layers"
                             :body {:span-layer-id span-layer-id :name name}}))

;; Text helpers
(defn create-text
  ([user-request-fn text-layer-id document-id body]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/texts"
                              :body {:text-layer-id text-layer-id
                                     :document-id document-id
                                     :body body}}))
  ([user-request-fn text-layer-id document-id body metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/texts"
                              :body {:text-layer-id text-layer-id
                                     :document-id document-id
                                     :body body
                                     :metadata metadata}})))

(defn get-text [user-request-fn text-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/texts/" text-id)}))

(defn update-text [user-request-fn text-id new-body]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/texts/" text-id)
                             :body {:body new-body}}))

(defn update-text-metadata [user-request-fn text-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/texts/" text-id "/metadata")
                             :body metadata}))

(defn delete-text-metadata [user-request-fn text-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/texts/" text-id "/metadata")}))

(defn delete-text [user-request-fn text-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/texts/" text-id)}))

;; Token helpers
(defn create-token
  ([user-request-fn token-layer-id text-id begin end]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/tokens"
                              :body {:token-layer-id token-layer-id
                                     :text text-id
                                     :begin begin
                                     :end end}}))
  ([user-request-fn token-layer-id text-id begin end precedence]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/tokens"
                              :body (cond-> {:token-layer-id token-layer-id
                                             :text text-id
                                             :begin begin
                                             :end end}
                                      (some? precedence) (assoc :precedence precedence))}))
  ([user-request-fn token-layer-id text-id begin end precedence metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/tokens"
                              :body (cond-> {:token-layer-id token-layer-id
                                             :text text-id
                                             :begin begin
                                             :end end}
                                      (some? precedence) (assoc :precedence precedence)
                                      (some? metadata) (assoc :metadata metadata))})))

(defn get-token [user-request-fn token-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/tokens/" token-id)}))

(defn update-token [user-request-fn token-id & {:keys [begin end precedence]}]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/tokens/" token-id)
                             :body (cond-> {}
                                     begin (assoc :begin begin)
                                     end (assoc :end end)
                                     precedence (assoc :precedence precedence))}))

(defn update-token-metadata [user-request-fn token-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/tokens/" token-id "/metadata")
                             :body metadata}))

(defn delete-token-metadata [user-request-fn token-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/tokens/" token-id "/metadata")}))

(defn delete-token [user-request-fn token-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/tokens/" token-id)}))

;; Span helpers
(defn create-span
  ([user-request-fn span-layer-id tokens value]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/spans"
                              :body {:span-layer-id span-layer-id
                                     :tokens tokens
                                     :value value}}))
  ([user-request-fn span-layer-id tokens value metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/spans"
                              :body {:span-layer-id span-layer-id
                                     :tokens tokens
                                     :value value
                                     :metadata metadata}})))

(defn get-span [user-request-fn span-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/spans/" span-id)}))

(defn update-span [user-request-fn span-id & {:keys [value]}]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/spans/" span-id)
                             :body {:value value}}))

(defn update-span-metadata [user-request-fn span-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/spans/" span-id "/metadata")
                             :body metadata}))

(defn delete-span-metadata [user-request-fn span-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/spans/" span-id "/metadata")}))

(defn update-span-tokens [user-request-fn span-id tokens]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/spans/" span-id "/tokens")
                             :body {:tokens tokens}}))

(defn delete-span [user-request-fn span-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/spans/" span-id)}))

;; Relation helpers
(defn create-relation
  ([user-request-fn layer-id source-id target-id value]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/relations"
                              :body {:layer-id layer-id
                                     :source-id source-id
                                     :target-id target-id
                                     :value value}}))
  ([user-request-fn layer-id source-id target-id value metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/relations"
                              :body {:layer-id layer-id
                                     :source-id source-id
                                     :target-id target-id
                                     :value value
                                     :metadata metadata}})))

(defn get-relation [user-request-fn relation-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/relations/" relation-id)}))

(defn update-relation [user-request-fn relation-id value]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/relations/" relation-id)
                             :body {:value value}}))

(defn update-relation-source [user-request-fn relation-id span-id]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/relations/" relation-id "/source")
                             :body {:span-id span-id}}))

(defn update-relation-target [user-request-fn relation-id span-id]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/relations/" relation-id "/target")
                             :body {:span-id span-id}}))

(defn update-relation-metadata [user-request-fn relation-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/relations/" relation-id "/metadata")
                             :body metadata}))

(defn delete-relation-metadata [user-request-fn relation-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/relations/" relation-id "/metadata")}))

(defn delete-relation [user-request-fn relation-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/relations/" relation-id)}))

;; Bulk helpers
(defn bulk-create-tokens [user-request-fn tokens]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/tokens/bulk"
                             :body tokens}))

(defn bulk-delete-tokens [user-request-fn token-ids]
  (api-call user-request-fn {:method :delete
                             :path "/api/v1/tokens/bulk"
                             :body token-ids}))

(defn bulk-create-spans [user-request-fn spans]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/spans/bulk"
                             :body spans}))

(defn bulk-delete-spans [user-request-fn span-ids]
  (api-call user-request-fn {:method :delete
                             :path "/api/v1/spans/bulk"
                             :body span-ids}))

(defn bulk-create-relations [user-request-fn relations]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/relations/bulk"
                             :body relations}))

(defn bulk-delete-relations [user-request-fn relation-ids]
  (api-call user-request-fn {:method :delete
                             :path "/api/v1/relations/bulk"
                             :body relation-ids}))

;; Project access control helpers
(defn add-project-reader [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/projects/" project-id "/readers/" user-id)}))

(defn add-project-writer [user-request-fn project-id user-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/projects/" project-id "/writers/" user-id)}))

;; Lock helpers
(defn acquire-lock [user-request-fn document-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/documents/" document-id "/lock")}))

(defn check-lock [user-request-fn document-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/documents/" document-id "/lock")}))

(defn release-lock [user-request-fn document-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/documents/" document-id "/lock")}))

;; Audit helpers
(defn get-project-audit
  ([user-request-fn project-id]
   (api-call user-request-fn {:method :get
                              :path (str "/api/v1/projects/" project-id "/audit")}))
  ([user-request-fn project-id start-time end-time]
   (let [params (cond-> []
                  start-time (conj (str "start-time=" start-time))
                  end-time (conj (str "end-time=" end-time)))
         query-string (when (seq params) (str "?" (clojure.string/join "&" params)))]
     (api-call user-request-fn {:method :get
                                :path (str "/api/v1/projects/" project-id "/audit" query-string)}))))

(defn get-document-audit [user-request-fn document-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/documents/" document-id "/audit")}))

(defn get-user-audit [user-request-fn user-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/users/" user-id "/audit")}))

;; Vocab layer helpers
(defn create-vocab-layer
  ([user-request-fn name]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-layers"
                              :body {:name name}}))
  ([user-request-fn name _config]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-layers"
                              :body {:name name}})))

(defn get-vocab-layer
  ([user-request-fn vocab-id]
   (api-call user-request-fn {:method :get
                              :path (str "/api/v1/vocab-layers/" vocab-id)}))
  ([user-request-fn vocab-id include-items?]
   (api-call user-request-fn {:method :get
                              :path (str "/api/v1/vocab-layers/" vocab-id
                                         (when include-items? "?include-items=true"))})))

(defn update-vocab-layer [user-request-fn vocab-id updates]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/vocab-layers/" vocab-id)
                             :body updates}))

(defn delete-vocab-layer [user-request-fn vocab-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-layers/" vocab-id)}))

(defn add-vocab-maintainer [user-request-fn vocab-id user-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/vocab-layers/" vocab-id "/maintainers/" user-id)}))

(defn remove-vocab-maintainer [user-request-fn vocab-id user-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-layers/" vocab-id "/maintainers/" user-id)}))

;; Vocab item helpers
(defn create-vocab-item
  ([user-request-fn vocab-layer-id form]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-items"
                              :body {:vocab-layer-id vocab-layer-id :form form}}))
  ([user-request-fn vocab-layer-id form metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-items"
                              :body {:vocab-layer-id vocab-layer-id :form form :metadata metadata}})))

(defn get-vocab-item [user-request-fn item-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/vocab-items/" item-id)}))

(defn update-vocab-item [user-request-fn item-id new-form]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/vocab-items/" item-id)
                             :body {:form new-form}}))

(defn update-vocab-item-metadata [user-request-fn item-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/vocab-items/" item-id "/metadata")
                             :body metadata}))

(defn delete-vocab-item-metadata [user-request-fn item-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-items/" item-id "/metadata")}))

(defn delete-vocab-item [user-request-fn item-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-items/" item-id)}))

;; Vocab link helpers
(defn create-vocab-link
  ([user-request-fn vocab-item-id tokens]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-links"
                              :body {:vocab-item vocab-item-id :tokens tokens}}))
  ([user-request-fn vocab-item-id tokens metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/vocab-links"
                              :body {:vocab-item vocab-item-id :tokens tokens :metadata metadata}})))

(defn get-vocab-link [user-request-fn link-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/vocab-links/" link-id)}))

(defn update-vocab-link-metadata [user-request-fn link-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/vocab-links/" link-id "/metadata")
                             :body metadata}))

(defn delete-vocab-link-metadata [user-request-fn link-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-links/" link-id "/metadata")}))

(defn delete-vocab-link [user-request-fn link-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-links/" link-id)}))

;; Document metadata helpers
(defn get-document [user-request-fn document-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/documents/" document-id)}))

(defn update-document-metadata [user-request-fn document-id metadata]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/documents/" document-id "/metadata")
                             :body metadata}))

(defn delete-document-metadata [user-request-fn document-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/documents/" document-id "/metadata")}))

;; Project vocab linking helpers
(defn link-vocab-to-project [user-request-fn project-id vocab-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/projects/" project-id "/vocabs/" vocab-id)}))

(defn unlink-vocab-from-project [user-request-fn project-id vocab-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/projects/" project-id "/vocabs/" vocab-id)}))

;; Health & OpenAPI helpers
(defn get-health []
  (api-call (fn [method path]
              (-> (ring.mock.request/request method path)
                  (ring.mock.request/header "accept" "application/edn")))
            {:method :get :path "/api/v1/health"}))

(defn get-openapi [user-request-fn]
  (api-call user-request-fn {:method :get :path "/api/v1/openapi.json"}))
