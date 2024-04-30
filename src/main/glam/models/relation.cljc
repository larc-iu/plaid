(ns glam.models.relation
  (:require [com.wsscode.pathom.connect :as pc]
            #?(:cljs [glam.models.common :as mc]
               :clj  [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [glam.xtdb.span :as s])
            #?(:clj [glam.xtdb.relation :as r])
            #?(:clj [glam.xtdb.relation-layer :as rl])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.xtdb.easy :as gxe])))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-relation [{:keys [node] :as env} {:relation/keys [id]}]
     {::pc/input     #{:relation/id}
      ::pc/output    [:relation/id :relation/layer :relation/source :relation/target :relation/value]
      ::pc/transform (ma/readable-required :relation/id)}
     (r/get node id)))

#?(:clj
   (pc/defmutation set-value [{:keys [node] :as env} {:relation/keys [id value] :as relation}]
     {::pc/transform (ma/writeable-required :relation/id)}
     (cond
       (nil? (r/get node id))
       (server-error (str "Relation with id " id " does not exist."))

       (not (string? value))
       (server-error "Value must be a string.")

       (not (ma/ident-locked? env [:relation/id id]))
       (server-error (ma/lock-holder-error-msg env [:relation/id id]))

       :else
       (if-let [result (r/merge node id {:relation/value value})]
         (server-message (str "Successfully set relation value to " value))
         (server-error (str "Failed to modify relation " id))))))

#?(:clj
   (pc/defmutation set-source [{:keys [node] :as env} {:relation/keys [id source] :as relation}]
     {::pc/transform (ma/writeable-required :relation/id)}
     (cond
       (nil? (r/get node id))
       (server-error (str "Relation with id " id " does not exist."))

       (not (:span/id (s/get node source)))
       (server-error "Source span does not exist")

       (not (ma/ident-locked? env [:relation/id id]))
       (server-error (ma/lock-holder-error-msg env [:relation/id id]))

       :else
       (if-let [result (r/merge node id {:relation/source source})]
         (server-message (str "Successfully set relation source to " source))
         (server-error (str "Failed to modify relation " id))))))

#?(:clj
   (pc/defmutation set-target [{:keys [node] :as env} {:relation/keys [id target] :as relation}]
     {::pc/transform (ma/writeable-required :relation/id)}
     (cond
       (nil? (r/get node id))
       (server-error (str "Relation with id " id " does not exist."))

       (not (:span/id (s/get node target)))
       (server-error "Source span does not exist")

       (not (ma/ident-locked? env [:relation/id id]))
       (server-error (ma/lock-holder-error-msg env [:relation/id id]))

       :else
       (if-let [result (r/merge node id {:relation/target target})]
         (server-message (str "Successfully set relation target to " target))
         (server-error (str "Failed to modify relation " id))))))

#?(:clj
   (pc/defmutation delete-relation [{:keys [node] :as env} {:relation/keys [id] :as relation}]
     {::pc/transform (ma/writeable-required :relation/id)}
     (cond
       (nil? (:relation/id (gxe/entity node id)))
       (server-error 404 (str "Relation does not exist with ID " id))

       :else
       (if-let [result (s/delete node id)]
         (server-message (str "Successfully deleted relation " id))
         (server-error 500 (str "Failed to delete relation " id))))))

#?(:clj
   (pc/defmutation create-relation
     [{:keys [node] :as env} {:relation/keys [id value layer source target] :as relation}]
     {::pc/transform (ma/writeable-required :relation-layer/id :relation/layer)}
     (cond
       (not (string? value))
       (server-error "Value must be a string.")

       (not (:relation-layer/id (rl/get node layer)))
       (server-error "Relation layer does not exist")

       (not (:span/id (s/get node source)))
       (server-error "Source span does not exist")

       (not (:span/id (s/get node target)))
       (server-error "Target span does not exist")

       (not (ma/ident-locked? env [:span/id source]))
       (server-error (ma/lock-holder-error-msg env [:span/id source]))

       :else
       (let [{:keys [success] new-id :id} (r/create node {:relation/value  value
                                                          :relation/layer  layer
                                                          :relation/source source
                                                          :relation/target target})]
         (if-not success
           (server-error "Failed to create relation, please try again")
           (merge {:tempids {id new-id}} (server-message "Relation created")))))))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (def relation-resolvers [get-relation set-value set-source set-target delete-relation create-relation]))