(ns glam.models.token-layer
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.mutations :as m]
            #?(:clj [xtdb.api :as xt])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-message server-error]])
            #?(:clj [glam.xtdb.document :as doc])
            #?(:clj [glam.xtdb.text-layer :as txtl])
            #?(:clj [glam.xtdb.text :as txt])
            #?(:clj [glam.xtdb.token-layer :as tokl])
            #?(:clj [glam.xtdb.easy :as gxe])
            #?(:clj [glam.xtdb.token :as tok])))

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
   (pc/defresolver get-token-layer [{:keys [node]} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [:token-layer/id :token-layer/name :token-layer/span-layers]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (tokl/get node id)))

#?(:clj
   (pc/defresolver get-tokens [{:keys [node] :as env} {:token-layer/keys [id]}]
     {::pc/input     #{:token-layer/id}
      ::pc/output    [{:token-layer/tokens [:token/id :token/text :token/begin :token/end :token/layer]}]
      ::pc/transform (ma/readable-required :token-layer/id)}
     (when-let [[_ doc-id] (mc/try-get-document-ident env)]
       (when-let [tokens (mapv (fn [token]
                                 (log/info token)
                                 (-> token
                                     (update :token/text (fn [id] {:text/id id}))
                                     (update :token/layer (fn [id] {:token-layer/id id}))))
                               (tok/get-tokens node id doc-id))]
         {:token-layer/tokens tokens}))))

#?(:clj
   (pc/defmutation whitespace-tokenize [{:keys [node] :as env} {:token-layer/keys [id]
                                                                doc-id            :document/id
                                                                text-id           :text/id}]
     {::pc/transform (ma/writeable-required :token-layer/id)}
     (cond
       (nil? (tokl/get node id))
       (server-error (str "Token layer does not exist:" id))

       (nil? (txt/get node text-id))
       (server-error (str "Text does not exist:" text-id))

       (nil? (doc/get node doc-id))
       (server-error (str "Doc does not exist:" doc-id))

       :else
       (let [success (tokl/whitespace-tokenize node id doc-id text-id)]
         (if success
           (server-message "Tokenization successful")
           (server-error "Tokenization failed"))))))

;; admin --------------------------------------------------------------------------------
;;
#?(:clj
   (pc/defmutation create-token-layer [{:keys [node]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (let [new-token-layer (-> {} (mc/apply-delta delta) (select-keys token-layer-keys))]
       (let [{:keys [id success]} (tokl/create node new-token-layer)]
         (txtl/add-token-layer node parent-id id)
         (if-not success
           (server-error (str "Failed to create token-layer, please refresh and try again"))
           {:tempids {temp-id id}})))))

#?(:clj
   (pc/defmutation save-token-layer [{:keys [node]} {delta :delta [_ id] :ident :as params}]
     {::pc/transform ma/admin-required
      ::pc/output    [:server/error? :server/message]}
     (log/info (str "id:" (:ident params)))
     (let [valid? (mc/validate-delta record-valid? delta)]
       (cond
         ;; must be valid
         (not valid?)
         (server-error (str "Token layer delta invalid: " delta))
         :else
         (if-not (tokl/merge node id (mc/apply-delta {} delta))
           (server-error (str "Failed to save token-layer information, please refresh and try again"))
           (gxe/entity node id))))))

#?(:clj
   (pc/defmutation delete-token-layer [{:keys [node]} {[_ id] :ident :as params}]
     {::pc/transform ma/admin-required}
     (cond
       ;; ensure the token layer to be deleted exists
       (not (gxe/entity node id))
       (server-error (str "Token layer not found by ID " id))
       ;; otherwise, go ahead
       :else
       (let [name (:token-layer/name (gxe/entity node id))
             parent-id (tokl/parent-id node id)
             tx (into (txtl/remove-token-layer** node parent-id id)
                      (tokl/delete** node id))
             success (gxe/submit! node tx)]
         (if-not success
           (server-error (str "Failed to delete token layer " name ". Please refresh and try again"))
           (server-message (str "Token layer " name " deleted")))))))

#?(:clj
   (def token-layer-resolvers [get-token-layer get-tokens create-token-layer save-token-layer delete-token-layer
                               whitespace-tokenize]))

