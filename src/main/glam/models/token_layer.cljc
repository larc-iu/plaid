(ns glam.models.token-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [crux.api :as crux])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-message server-error]])
            #?(:clj [glam.crux.text-layer :as txtl])
            #?(:clj [glam.crux.token-layer :as tokl])
            #?(:clj [glam.crux.easy :as gce])))

(def token-layer-keys [:token-layer/name :token-layer/span-layers])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :token-layer/name (valid-name v)))

(defn token-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]]
            (field-valid k v)) (log/spy record)))

(def validator (fs/make-validator token-layer-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-token-layer [{:keys [crux]} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [:token-layer/id :token-layer/name :token-layer/span-layers]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (tokl/get crux id)))

#?(:clj
   (pc/defresolver get-tokens [{:keys [crux] :as env} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [:token-layer/tokens]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (when-let [[_ doc-id] (mc/try-get-document-ident env)]
       (when-let [tokens (mapv (fn [[id]] {:token/id id}) (crux/q (crux/db crux)
                                                                  '{:find  [?tok]
                                                                    :where [[?tok :token/layer ?tokl]
                                                                            [?tok :token/text ?txt]
                                                                            [?txt :text/document ?doc]]
                                                                    :in    [[?tokl ?doc]]}
                                                                  [id doc-id]))]
         {:token-layer/tokens tokens}))))

;; admin --------------------------------------------------------------------------------
;;
#?(:clj
   (pc/defmutation create-token-layer [{:keys [crux]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-token-layer (-> {} (mc/apply-delta delta) (select-keys token-layer-keys))]
       (let [{:keys [id success]} (tokl/create crux new-token-layer)]
         (txtl/add-token-layer crux parent-id id)
         (if-not success
           (server-error (str "Failed to create token-layer, please refresh and try again"))
           {:tempids {temp-id id}})))))

#?(:clj
   (pc/defmutation save-token-layer [{:keys [crux]} {delta :delta [_ id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (log/info (str "id:" (:ident params)))
     (let [valid? (mc/validate-delta record-valid? delta)]
       (cond
         ;; must be valid
         (not valid?)
         (server-error (str "Token layer delta invalid: " delta))
         :else
         (if-not (tokl/merge crux id (mc/apply-delta {} delta))
           (server-error (str "Failed to save token-layer information, please refresh and try again"))
           (gce/entity crux id))))))

#?(:clj
   (pc/defmutation delete-token-layer [{:keys [crux]} {[_ id] :ident :as params}]
     {::pc/transform ma/admin-required}
     (cond
       ;; ensure the token layer to be deleted exists
       (not (gce/entity crux id))
       (server-error (str "Token layer not found by ID " id))
       ;; otherwise, go ahead
       :else
       (let [name (:token-layer/name (gce/entity crux id))
             parent-id (tokl/parent-id crux id)
             tx (into (txtl/remove-token-layer** crux parent-id id)
                      (tokl/delete** crux id))
             success (gce/submit! crux tx)]
         (if-not success
           (server-error (str "Failed to delete token layer " name ". Please refresh and try again"))
           (server-message (str "Token layer " name " deleted")))))))


#?(:clj
   (def token-layer-resolvers [get-token-layer get-tokens create-token-layer save-token-layer delete-token-layer]))

