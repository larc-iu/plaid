(ns glam.models.relation-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-message server-error]])
            #?(:clj [glam.xtdb.token-layer :as tokl])
            #?(:clj [glam.xtdb.span-layer :as sl])
            #?(:clj [glam.xtdb.relation-layer :as rl])
            #?(:clj [glam.xtdb.easy :as gxe])
            #?(:clj [glam.xtdb.span :as s])))

(def relation-layer-keys [:relation-layer/name])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :span-layer/name (valid-name v)))

(defn relation-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]]
            (field-valid k v)) (log/spy record)))

(def validator (fs/make-validator relation-layer-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-relation-layer [{:keys [node]} {:relation-layer/keys [id]}]
     {::pc/input     #{:relation-layer/id}
      ::pc/output    [:relation-layer/id :relation-layer/name :config]
      ::pc/transform (ma/readable-required :relation-layer/id)}
     (rl/get node id)))

#?(:clj
   (pc/defresolver get-relations [{:keys [node] :as env} {:relation-layer/keys [id]}]
     {::pc/input     #{:relation-layer/id}
      ::pc/output    [{:relation-layer/relations [:relation/id :relation/value :relation/layer :relation/source :relation/target]}]}))

;; admin --------------------------------------------------------------------------------
;;

#?(:clj
   (pc/defmutation create-relation-layer [{:keys [node]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-relation-layer (-> {} (mc/apply-delta delta) (select-keys relation-layer-keys))]
       (let [{:keys [id success]} (rl/create node new-relation-layer)]
         (sl/add-relation-layer node parent-id id)
         (if-not success
           (server-error (str "Failed to create relation-layer, please refresh and try again"))
           {:tempids {temp-id id}})))))

#?(:clj
   (pc/defmutation save-relation-layer [{:keys [node]} {delta :delta [_ id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [valid? (mc/validate-delta record-valid? delta)]
       (cond
         ;; must be valid
         (not valid?)
         (server-error (str "Relation layer delta invalid: " delta))
         :else
         (if-not (rl/merge node id (mc/apply-delta {} delta))
           (server-error (str "Failed to save relation-layer information, please refresh and try again"))
           (gxe/entity node id))))))

#?(:clj
   (pc/defmutation delete-relation-layer [{:keys [node]} {[_ id] :ident :as params}]
     {::pc/transform ma/admin-required}
     (cond
       ;; ensure the relation layer to be deleted exists
       (not (gxe/entity node id))
       (server-error (str "Relation layer not found by ID " id))
       ;; otherwise, go ahead
       :else
       (let [name (:relation-layer/name (gxe/entity node id))
             parent-id (rl/parent-id node id)
             tx (into (rl/delete** node id)
                      (sl/remove-relation-layer** node parent-id id))
             success (gxe/submit! node tx)]
         (if-not success
           (server-error (str "Failed to delete relation layer " parent-id ". Please refresh and try again"))
           (server-message (str "Relation layer " name " deleted")))))))

#?(:clj
   (def relation-layer-resolvers [get-relation-layer get-relations create-relation-layer save-relation-layer delete-relation-layer]))
