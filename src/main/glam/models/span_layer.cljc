(ns glam.models.span-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.span-layer :as sl])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-message server-error]])
            #?(:clj [glam.crux.token-layer :as tokl])
            #?(:clj [glam.crux.span-layer :as sl])
            #?(:clj [glam.crux.easy :as gce])))

(def span-layer-keys [:span-layer/name
                      :span-layer/span-layers
                      :span-layer/overlap
                      :span-layer/to-many])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :span-layer/name (valid-name v)
    :span-layer/overlap (boolean? v)
    :span-layer/to-many (boolean? v)))

(defn span-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]]
            (field-valid k v)) (log/spy record)))

(def validator (fs/make-validator span-layer-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-span-layer [{:keys [crux]} {:span-layer/keys [id]}]
     {::pc/input     #{:span-layer/id}
      ::pc/output    [:span-layer/id :span-layer/name :span-layer/overlap :span-layer/to-many]
      ::pc/transform (ma/readable-required :span-layer/id)}
     (sl/get crux id)))

;; admin --------------------------------------------------------------------------------
;;

#?(:clj
   (pc/defmutation create-span-layer [{:keys [crux]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-span-layer (-> {} (mc/apply-delta delta) (select-keys span-layer-keys))]
       (let [{:keys [id success]} (sl/create crux new-span-layer)]
         (tokl/add-span-layer crux parent-id id)
         (if-not success
           (server-error (str "Failed to create span-layer, please refresh and try again"))
           {:tempids {temp-id id}})))))

#?(:clj
   (pc/defmutation save-span-layer [{:keys [crux]} {delta :delta [_ id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (log/info (str "id:" (:ident params)))
     (let [valid? (mc/validate-delta record-valid? delta)]
       (cond
         ;; must be valid
         (not valid?)
         (server-error (str "Span layer delta invalid: " delta))
         :else
         (if-not (sl/merge crux id (mc/apply-delta {} delta))
           (server-error (str "Failed to save span-layer information, please refresh and try again"))
           (gce/entity crux id))))))

#?(:clj
   (pc/defmutation delete-span-layer [{:keys [crux]} {[_ id] :ident :as params}]
     {::pc/transform ma/admin-required}
     (cond
       ;; ensure the span layer to be deleted exists
       (not (gce/entity crux id))
       (server-error (str "Span layer not found by ID " id))
       ;; otherwise, go ahead
       :else
       (let [name (:span-layer/name (gce/entity crux id))
             parent-id (sl/parent-id crux id)
             tx (into (tokl/remove-span-layer** crux parent-id id)
                      (sl/delete** crux id))
             success (gce/submit! crux tx)]
         (if-not success
           (server-error (str "Failed to delete span layer " name ". Please refresh and try again"))
           (server-message (str "Span layer " name " deleted")))))))

#?(:clj
   (def span-layer-resolvers [get-span-layer create-span-layer save-span-layer delete-span-layer]))
