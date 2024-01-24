(ns glam.models.document
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.xtdb.project :as prj])
            #?(:clj [glam.xtdb.document :as doc])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.xtdb.easy :as gxe])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [xtdb.api :as xt])))

(def document-keys [:document/name :document/project :document/text-layers])

(defn valid-name [name] (and (string? name) (<= 1 (count name) 80)))
(defn- field-valid [field v]
  (case field
    :document/name (valid-name v)))

(defn document-valid [form field]
  (let [v (get form field)]
    (field-valid field v)))

(defn record-valid? [record]
  (every? (fn [[k v]]
            (field-valid k v)) (log/spy record)))

(def validator (fs/make-validator document-valid))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-document [{:keys [node]} {:document/keys [id]}]
     {::pc/input     #{:document/id}
      ::pc/output    [:document/id :document/name]
      ::pc/transform (ma/readable-required :document/id)}
     (doc/get node id)))

#?(:clj
   (pc/defresolver get-full-document [{:keys [node]} {:document/keys [id]}]
     {::pc/input #{:document/id}
      ::pc/output [{:document/text-layers
                    [:text-layer/id
                     {:text-layer/text [:text/id :text/body]}
                     {:text-layer/token-layers
                      [:token-layer/id
                       {:token-layer/tokens [:token/id :token/begin :token/end :token/text]}
                       {:token-layer/span-layers
                        [:span-layer/id
                         {:span-layer/spans [:span/id :span/value :span/tokens]}]}]}]}]}
     (doc/get-with-layer-data-for-pathom node id)))

#?(:clj
   (pc/defmutation create-document [{:keys [node]} {delta :delta [_ temp-id] :ident [_ parent-id] :parent-ident :as params}]
     {::pc/transform (ma/writeable-required :project/id :parent-id)
      ::pc/output    [:server/error? :server/message]}
     (let [new-document (-> {}
                            (mc/apply-delta delta)
                            (select-keys [:document/name])
                            (assoc :document/project parent-id))]
       (cond (nil? (:project/id (gxe/entity node parent-id)))
             (server-error "Invalid project.")

             (mc/validate-delta record-valid? delta)
             (server-error (str "Document is not valid, refusing to create: " delta))

             :else
             (let [{:keys [id success]} (doc/create node new-document)]
               (if-not success
                 (server-error (str "Failed to create document, please refresh and try again"))
                 {:tempids {temp-id id}}))))))

#?(:clj
   (pc/defmutation save-document [{:keys [node] :as env} {delta :delta [_ id] :ident :as params}]
     {::pc/transform (ma/writeable-required :document/id (comp second :ident))}
     (let [valid? (mc/validate-delta record-valid? delta)]
       (cond
         (nil? (:document/id (gxe/entity node id)))
         (server-error (str "Document doesn't exist with ID: " id))

         (not valid?)
         (server-error (str "Document is not valid, refusing to save: " delta))

         (not (ma/ident-locked? env [:document/id id]))
         (server-error (ma/lock-holder-error-msg env [:document/id id]))

         :else
         (if (doc/merge node id (mc/apply-delta {} delta))
           (server-message "Document saved")
           (server-error "Document failed to save"))))))

#?(:clj
   (pc/defmutation delete-document [{:keys [node] :as env} {[_ id] :ident :as params}]
     {::pc/transform (ma/writeable-required :document/id (comp second :ident))}
     (let [{:document/keys [name] :as record} (gxe/entity node id)]
       (cond
         (nil? (:document/id record))
         (server-error (str "Document not found with ID: " id))

         (not (ma/ident-locked? env [:document/id id]))
         (server-error (ma/lock-holder-error-msg env [:document/id id]))

         :else
         (if-not (doc/delete node id)
           (server-error (str "Failed to delete document " name ". Please refresh and try again"))
           (server-message (str "Document " name " deleted")))))))

#?(:clj
   (pc/defmutation acquire-lock [{:keys [node current-user] :as env} {doc-id :document/id}]
     {::pc/transform (ma/writeable-required :document/id)}
     (let [{name :document/name :as doc} (gxe/entity node doc-id)]
       (cond
         (nil? (:document/id doc))
         (server-error (str "Document not found with ID: " doc-id))

         (some? (:document/lock-holder doc))
         (server-error (ma/lock-holder-error-msg env [:document/id doc-id]))

         :else
         (if-not (doc/acquire-lock node doc-id current-user)
           (server-error (str "Failed to acquire lock on " name "."))
           (server-message (str "Lock acquired on document " name ".")))))))

#?(:clj
   (pc/defmutation release-lock [{:keys [node current-user] :as env} {doc-id :document/id}]
     {::pc/transform (ma/writeable-required :document/id)}
     (let [{name :document/name :as doc} (gxe/entity node doc-id)]
       (cond
         (nil? (:document/id doc))
         (server-error (str "Document not found with ID: " doc-id))

         (and (some? (:document/lock-holder doc)) (not= current-user (:document/lock-holder doc)))
         (server-error "Locks may only be released by their owners.")

         :else
         (if-not (doc/release-lock node doc-id)
           (server-error (str "Failed to release lock on " name "."))
           (server-message (str "Lock released on document " name ".")))))))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def document-resolvers [get-document get-full-document create-document save-document delete-document
                            acquire-lock release-lock]))

