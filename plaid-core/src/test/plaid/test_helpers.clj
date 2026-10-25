(ns plaid.test-helpers
  (:require [clojure.string]
            [clojure.test :refer [is]]
            [mount.core :as mount]
            [ring.mock.request]
            [plaid.fixtures :refer [admin-request api-call assert-created assert-status db]]
            [plaid.server.events]
            [plaid.sql.common :as psc])
  (:import [java.io File]
           [java.nio.file Files FileVisitOption LinkOption Path]))

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

(defn create-token-layer
  ([user-request-fn text-layer-id name]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/token-layers"
                              :body {:text-layer-id text-layer-id :name name}}))
  ([user-request-fn text-layer-id name overlap-mode]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/token-layers"
                              :body (cond-> {:text-layer-id text-layer-id :name name}
                                      overlap-mode (assoc :overlap-mode overlap-mode))})))

(defn create-token-layer-opts
  "Create a token layer with an opts map merged into the body, e.g.
  {:overlap-mode \"partitioning\" :parent-token-layer-id <uuid>}."
  [user-request-fn text-layer-id name opts]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/token-layers"
                             :body (merge {:text-layer-id text-layer-id :name name} opts)}))

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

(defn patch-text-metadata [user-request-fn text-id ops]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/texts/" text-id "/metadata")
                             :body ops}))

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

(defn patch-token-metadata [user-request-fn token-id ops]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/tokens/" token-id "/metadata")
                             :body ops}))

(defn delete-token [user-request-fn token-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/tokens/" token-id)}))

(defn split-token [user-request-fn token-id position]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/tokens/" token-id "/split")
                             :body {:position position}}))

(defn merge-tokens [user-request-fn token-id other-token-id]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/tokens/" token-id "/merge")
                             :body {:other-token-id other-token-id}}))

(defn shift-token-boundary [user-request-fn token-id & {:keys [begin end]}]
  (api-call user-request-fn {:method :post
                             :path (str "/api/v1/tokens/" token-id "/shift")
                             :body (cond-> {}
                                     begin (assoc :begin begin)
                                     end (assoc :end end))}))

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

(defn patch-span-metadata [user-request-fn span-id ops]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/spans/" span-id "/metadata")
                             :body ops}))

(defn update-span-tokens [user-request-fn span-id tokens]
  (api-call user-request-fn {:method :put
                             :path (str "/api/v1/spans/" span-id "/tokens")
                             :body {:tokens tokens}}))

(defn bulk-update-spans [user-request-fn items]
  (api-call user-request-fn {:method :patch
                             :path "/api/v1/spans/bulk"
                             :body items}))

(defn bulk-update-relations [user-request-fn items]
  (api-call user-request-fn {:method :patch
                             :path "/api/v1/relations/bulk"
                             :body items}))

(defn bulk-update-tokens [user-request-fn items]
  (api-call user-request-fn {:method :patch
                             :path "/api/v1/tokens/bulk"
                             :body items}))

(defn delete-span [user-request-fn span-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/spans/" span-id)}))

;; Relation helpers
(defn create-relation
  ([user-request-fn layer-id source-id target-id value]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/relations"
                              :body {:relation-layer-id layer-id
                                     :source source-id
                                     :target target-id
                                     :value value}}))
  ([user-request-fn layer-id source-id target-id value metadata]
   (api-call user-request-fn {:method :post
                              :path "/api/v1/relations"
                              :body {:relation-layer-id layer-id
                                     :source source-id
                                     :target target-id
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

(defn patch-relation-metadata [user-request-fn relation-id ops]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/relations/" relation-id "/metadata")
                             :body ops}))

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
(defn acquire-lock
  "Take a document's lock as a new holder, or with `lock-id`, renew the lock
  that id holds."
  ([user-request-fn document-id]
   (api-call user-request-fn {:method :post
                              :path (str "/api/v1/documents/" document-id "/lock")}))
  ([user-request-fn document-id lock-id]
   (api-call user-request-fn {:method :post
                              :path (str "/api/v1/documents/" document-id "/lock?lock-id=" lock-id)})))

(defn check-lock [user-request-fn document-id]
  (api-call user-request-fn {:method :get
                             :path (str "/api/v1/documents/" document-id "/lock")}))

(defn release-lock
  "Release the lock `lock-id` holds. Without an id the request names no holder."
  ([user-request-fn document-id]
   (api-call user-request-fn {:method :delete
                              :path (str "/api/v1/documents/" document-id "/lock")}))
  ([user-request-fn document-id lock-id]
   (api-call user-request-fn {:method :delete
                              :path (str "/api/v1/documents/" document-id "/lock?lock-id=" lock-id)})))

;; Audit helpers
(defn- audit-query-string [{:keys [start-time end-time limit cursor op-types kinds order]}]
  (let [params (cond-> []
                 start-time (conj (str "start-time=" start-time))
                 end-time   (conj (str "end-time=" end-time))
                 limit      (conj (str "limit=" limit))
                 cursor     (conj (str "cursor=" cursor))
                 order      (conj (str "order=" (name order)))
                 op-types   (conj (str "op-types="
                                       (java.net.URLEncoder/encode
                                        (if (string? op-types)
                                          op-types
                                          (clojure.string/join "," op-types))
                                        "UTF-8")))
                 kinds      (conj (str "kinds="
                                       (java.net.URLEncoder/encode
                                        (if (string? kinds)
                                          kinds
                                          (clojure.string/join "," kinds))
                                        "UTF-8"))))]
    (when (seq params) (str "?" (clojure.string/join "&" params)))))

(defn get-project-audit
  ([user-request-fn project-id]
   (get-project-audit user-request-fn project-id {}))
  ([user-request-fn project-id start-time end-time]
   (get-project-audit user-request-fn project-id {:start-time start-time :end-time end-time}))
  ([user-request-fn project-id query-params]
   (api-call user-request-fn
             {:method :get
              :path (str "/api/v1/projects/" project-id "/audit"
                         (audit-query-string query-params))})))

(defn get-audit
  "The instance-wide audit feed (admin only)."
  ([user-request-fn] (get-audit user-request-fn {}))
  ([user-request-fn query-params]
   (api-call user-request-fn
             {:method :get
              :path (str "/api/v1/audit" (audit-query-string query-params))})))

(defn get-audit-tally
  "Per-user activity counts. With `project-id`, the project-scoped read."
  ([user-request-fn] (get-audit-tally user-request-fn nil {}))
  ([user-request-fn project-id] (get-audit-tally user-request-fn project-id {}))
  ([user-request-fn project-id {:keys [start-time end-time daily]}]
   (let [params (cond-> []
                  start-time (conj (str "start-time=" start-time))
                  end-time   (conj (str "end-time=" end-time))
                  daily      (conj "daily=true"))]
     (api-call user-request-fn
               {:method :get
                :path (str (if project-id
                             (str "/api/v1/projects/" project-id "/audit/tally")
                             "/api/v1/audit/tally")
                           (when (seq params) (str "?" (clojure.string/join "&" params))))}))))

(defn get-document-audit
  ([user-request-fn document-id]
   (get-document-audit user-request-fn document-id {}))
  ([user-request-fn document-id query-params]
   (api-call user-request-fn
             {:method :get
              :path (str "/api/v1/documents/" document-id "/audit"
                         (audit-query-string query-params))})))

(defn get-user-audit
  ([user-request-fn user-id]
   (get-user-audit user-request-fn user-id {}))
  ([user-request-fn user-id query-params]
   (api-call user-request-fn
             {:method :get
              :path (str "/api/v1/users/" user-id "/audit"
                         (audit-query-string query-params))})))

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

(defn patch-vocab-item-metadata [user-request-fn item-id ops]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/vocab-items/" item-id "/metadata")
                             :body ops}))

(defn delete-vocab-item [user-request-fn item-id]
  (api-call user-request-fn {:method :delete
                             :path (str "/api/v1/vocab-items/" item-id)}))

(defn bulk-create-vocab-items
  "items is a vector of {:vocab-layer-id <id> :form <str> :metadata? {...}}."
  [user-request-fn items]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/vocab-items/bulk"
                             :body items}))

(defn bulk-update-vocab-items
  "items is a vector of {:id <id> :form? <str> :metadata? [op ...]}. The form
  is set when present, and metadata is a list of metadata ops."
  [user-request-fn items]
  (api-call user-request-fn {:method :patch
                             :path "/api/v1/vocab-items/bulk"
                             :body items}))

(defn bulk-delete-vocab-items [user-request-fn item-ids]
  (api-call user-request-fn {:method :delete
                             :path "/api/v1/vocab-items/bulk"
                             :body item-ids}))

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

(defn bulk-create-vocab-links
  "links is a vector of {:vocab-item <id> :tokens [<id> ...] :metadata? {...}}."
  [user-request-fn links]
  (api-call user-request-fn {:method :post
                             :path "/api/v1/vocab-links/bulk"
                             :body links}))

(defn bulk-delete-vocab-links [user-request-fn link-ids]
  (api-call user-request-fn {:method :delete
                             :path "/api/v1/vocab-links/bulk"
                             :body link-ids}))

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

(defn patch-vocab-link-metadata [user-request-fn link-id ops]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/vocab-links/" link-id "/metadata")
                             :body ops}))

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

(defn patch-document-metadata [user-request-fn document-id ops]
  (api-call user-request-fn {:method :patch
                             :path (str "/api/v1/documents/" document-id "/metadata")
                             :body ops}))

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

(defn get-info []
  (api-call (fn [method path]
              (-> (ring.mock.request/request method path)
                  (ring.mock.request/header "accept" "application/edn")))
            {:method :get :path "/api/v1/info"}))

(defn get-openapi [user-request-fn]
  (api-call user-request-fn {:method :get :path "/api/v1/openapi.json"}))

;; Response helpers
(defn id
  "The id a create answered with."
  [resp]
  (-> resp :body :id))

;; Database helpers
(defn latest-op-ts
  "The timestamp of the latest operation, for an as-of read or restore."
  []
  (:ts (psc/q1 db {:select [:ts] :from [:operations] :order-by [[:ts :desc] [:id :desc]] :limit 1})))

(defn evict-pool!
  "Close the pool's idle connections, so every later one loads the
  statistics as they are now, as after a restart."
  []
  (.softEvictConnections (.getHikariPoolMXBean db)))

(defn stale-statistics!
  "Statistics gathered on a tiny document (one relation, three spans), as an
  earlier test in the same JVM leaves them: `with-clean-db` deletes rows, not
  `sqlite_stat1`."
  []
  (let [p (create-test-project admin-request "Tiny")
        d (create-test-document admin-request p "d")
        tl (id (create-text-layer admin-request p "T"))
        wl (id (create-token-layer-opts admin-request tl "W" {:overlap-mode "non-overlapping"}))
        sl (id (create-span-layer admin-request wl "L"))
        rl (id (create-relation-layer admin-request sl "R"))
        tx (id (create-text admin-request tl d "a b c"))
        toks (for [i [0 2 4]]
               (id (api-call admin-request {:method :post :path "/api/v1/tokens"
                                            :body {:token-layer-id wl :text tx :begin i :end (inc i)}})))
        sps (vec (for [t toks]
                   (id (api-call admin-request {:method :post :path "/api/v1/spans"
                                                :body {:span-layer-id sl :tokens [t] :value "x"}}))))]
    (assert-status 201 (api-call admin-request {:method :post :path "/api/v1/relations"
                                                :body {:relation-layer-id rl :source (sps 0) :target (sps 1) :value "x"}}))
    (psc/execute! db ["ANALYZE"])))

;; Timing
(defn timed
  "Runs `(f)` and returns [its value, the milliseconds it took]. With
  `:warm n`, runs it n times first, untimed, so the JIT has compiled it.
  With `:runs n`, times n runs and keeps the quickest, which a pause for
  garbage collection or another process touches least. Only for an `f` that
  can run again."
  ([f] (timed f {}))
  ([f {:keys [warm runs] :or {warm 0 runs 1}}]
   (dotimes [_ warm] (f))
   (->> (repeatedly runs #(let [t0 (System/nanoTime)
                                v (f)]
                            [v (/ (- (System/nanoTime) t0) 1e6)]))
        (apply min-key second))))

(defn within-factor-of
  "Asserts that `big-ms` is under `factor` times `small-ms`, two cases timed
  on the same machine in the same run. A loaded runner slows both, so the
  bound holds where a fixed number of milliseconds fails (alpha.28 burned a
  release on one). Pick the cases so that the fault the test guards against
  grows the ratio well past `factor`: a scan of every row per row, say, goes
  from 10 to 100 when the big case is ten times the small one. `small-ms`
  counts as at least `floor-ms` (default 1), so a case too quick to time
  cannot make the bound nothing. Returns `big-ms`."
  ([factor small-ms big-ms] (within-factor-of factor small-ms big-ms {}))
  ([factor small-ms big-ms {:keys [floor-ms label] :or {floor-ms 1}}]
   (is (< big-ms (* factor (max small-ms floor-ms)))
       (format "%s%.0f ms, not under %s times the small case's %.0f ms"
               (if label (str label ": ") "") (double big-ms) factor (double small-ms)))
   big-ms))

;; Temporary files
(defn temp-db-path
  "A database path in a new temporary directory, for a test that needs its
  own database. `cleanup!` removes both."
  []
  (let [dir (File. (System/getProperty "java.io.tmpdir")
                   (str "plaid-test-" (System/nanoTime) "-" (rand-int 1000000)))]
    (.mkdirs dir)
    (.getAbsolutePath (File. dir "plaid.db"))))

(defn cleanup!
  "Delete a `temp-db-path` database, its WAL files and its directory."
  [db-path]
  (doseq [suffix ["" "-wal" "-shm"]]
    (let [f (File. (str db-path suffix))]
      (when (.exists f) (.delete f))))
  (let [parent (.getParentFile (File. ^String db-path))]
    (when (.exists parent) (.delete parent))))

(defn delete-tree!
  "Delete a directory and everything under it."
  [^Path root]
  (when (Files/exists root (make-array LinkOption 0))
    (with-open [paths (Files/walk root (make-array FileVisitOption 0))]
      (doseq [^Path path (reverse (vec (.toList paths)))]
        (Files/deleteIfExists path)))))

;; Mount states
(defn with-rpc-state-started
  "A fixture starting the service RPC and client registries of
  plaid.server.events, which the fixture chain leaves unstarted (it does not
  run mount)."
  [f]
  (mount/start #'plaid.server.events/service-channels
               #'plaid.server.events/inflight-requests
               #'plaid.server.events/client-registry
               #'plaid.server.events/channel-mappings
               #'plaid.server.events/heartbeat-registry)
  (f))
