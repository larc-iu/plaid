(ns glam.models.text-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.xtdb.project :as prj])
            #?(:clj [glam.xtdb.text-layer :as txtl])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.xtdb.easy :as gxe])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [xtdb.api :as xt])))

(def text-layer-keys [:text-layer/name :text-layer/token-layers])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :text-layer/name (valid-name v)))

(defn text-layer-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]]
            (field-valid k v)) (log/spy record)))

(def validator (fs/make-validator text-layer-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-text-layer [{:keys [node]} {:text-layer/keys [id]}]
     {::pc/input     #{:text-layer/id}
      ::pc/output    [:text-layer/id :text-layer/name :text-layer/token-layers]
      ::pc/transform (ma/readable-required :text-layer/id)}
     (txtl/get node id)))

#?(:clj
   (pc/defresolver get-text [{:keys [node] :as env} {:text-layer/keys [id]}]
     {::pc/input     #{:text-layer/id}
      ::pc/output    [:text-layer/text]
      ::pc/transform (ma/readable-required :text-layer/id)}
     (when-let [[_ doc-id] (mc/try-get-document-ident env)]
       (when-let [text-id (ffirst (xt/q (xt/db node)
                                          '{:find  [?txt]
                                            :where [[?txt :text/document ?doc]
                                                    [?txt :text/layer ?txtl]]
                                            :in    [[?txtl ?doc]]}
                                          [id doc-id]))]
         {:text-layer/text {:text/id text-id}}))))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (pc/defmutation create-text-layer [{:keys [node]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-text-layer (-> {} (mc/apply-delta delta) (select-keys text-layer-keys))]
       (let [{:keys [id success]} (txtl/create node new-text-layer)]
         (prj/add-text-layer node parent-id id)
         (if-not success
           (server-error (str "Failed to create text-layer, please refresh and try again"))
           {:tempids {temp-id id}})))))

#?(:clj
   (pc/defmutation save-text-layer [{:keys [node]} {delta :delta [_ id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (log/info (str "id:" (:ident params)))
     (let [valid? (mc/validate-delta record-valid? delta)]
       (cond
         ;; must be valid
         (not valid?)
         (server-error (str "Text layer delta invalid: " delta))
         :else
         (if-not (txtl/merge node id (mc/apply-delta {} delta))
           (server-error (str "Failed to save text-layer information, please refresh and try again"))
           (gxe/entity node id))))))

#?(:clj
   (pc/defmutation delete-text-layer [{:keys [node]} {[_ id] :ident :as params}]
     {::pc/transform ma/admin-required}
     (cond
       ;; ensure the text layer to be deleted exists
       (not (gxe/entity node id))
       (server-error (str "Text layer not found by ID " id))
       ;; otherwise, go ahead
       :else
       (let [name (:text-layer/name (gxe/entity node id))
             parent-id (txtl/parent-id node id)
             tx (into (txtl/delete** node id)
                      (prj/remove-text-layer** node parent-id id))
             success (gxe/submit! node tx)]
         (if-not success
           (server-error (str "Failed to delete text layer " name ". Please refresh and try again"))
           (server-message (str "Text layer " name " deleted")))))))

#?(:clj
   (def text-layer-resolvers [get-text-layer get-text create-text-layer save-text-layer delete-text-layer]))

