(ns glam.models.span-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [xtdb.api :as xt])
            #?(:clj [glam.xtdb.span-layer :as sl])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-message server-error]])
            #?(:clj [glam.xtdb.token-layer :as tokl])
            #?(:clj [glam.xtdb.span-layer :as sl])
            #?(:clj [glam.xtdb.easy :as gxe])
            #?(:clj [glam.xtdb.span :as s])))

(def span-layer-keys [:span-layer/name
                      :span-layer/span-layers])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :span-layer/name (valid-name v)))

(defn span-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]]
            (field-valid k v)) (log/spy record)))

(def validator (fs/make-validator span-layer-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-span-layer [{:keys [node]} {:span-layer/keys [id]}]
     {::pc/input     #{:span-layer/id}
      ::pc/output    [:span-layer/id :span-layer/name]
      ::pc/transform (ma/readable-required :span-layer/id)}
     (sl/get node id)))

#?(:clj
   (pc/defresolver get-spans [{:keys [node] :as env} {:span-layer/keys [id]}]
     {::pc/input     #{:span-layer/id}
      ::pc/output    [{:span-layer/spans [:span/id :span/value :span/layer :span/tokens]}]
      ::pc/transform (ma/readable-required :span-layer/id)}
     (when-let [[_ doc-id] (mc/try-get-document-ident env)]
       (when-let [spans (mapv (fn [s]
                                (-> s
                                    (update :span/tokens #(mapv (fn [id] {:token/id id}) %))
                                    (update :span/layer (fn [id] {:span-layer/id id}))))
                              (s/get-spans node doc-id id))]
         {:span-layer/spans spans}))))

;; admin --------------------------------------------------------------------------------
;;

#?(:clj
   (pc/defmutation create-span-layer [{:keys [node]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-span-layer (-> {} (mc/apply-delta delta) (select-keys span-layer-keys))]
       (let [{:keys [id success]} (sl/create node new-span-layer)]
         (tokl/add-span-layer node parent-id id)
         (if-not success
           (server-error (str "Failed to create span-layer, please refresh and try again"))
           {:tempids {temp-id id}})))))

#?(:clj
   (pc/defmutation save-span-layer [{:keys [node]} {delta :delta [_ id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [valid? (mc/validate-delta record-valid? delta)]
       (cond
         ;; must be valid
         (not valid?)
         (server-error (str "Span layer delta invalid: " delta))
         :else
         (if-not (sl/merge node id (mc/apply-delta {} delta))
           (server-error (str "Failed to save span-layer information, please refresh and try again"))
           (gxe/entity node id))))))

#?(:clj
   (pc/defmutation delete-span-layer [{:keys [node]} {[_ id] :ident :as params}]
     {::pc/transform ma/admin-required}
     (cond
       ;; ensure the span layer to be deleted exists
       (not (gxe/entity node id))
       (server-error (str "Span layer not found by ID " id))
       ;; otherwise, go ahead
       :else
       (let [name (:span-layer/name (gxe/entity node id))
             parent-id (sl/parent-id node id)
             tx (into (tokl/remove-span-layer** node parent-id id)
                      (sl/delete** node id))
             success (gxe/submit! node tx)]
         (if-not success
           (server-error (str "Failed to delete span layer " name ". Please refresh and try again"))
           (server-message (str "Span layer " name " deleted")))))))

#?(:clj
   (def span-layer-resolvers [get-span-layer get-spans create-span-layer save-span-layer delete-span-layer]))
