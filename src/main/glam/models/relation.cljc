(ns glam.models.relation
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            #?(:cljs [glam.models.common :as mc]
               :clj  [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [glam.xtdb.token :as tok])
            #?(:clj [glam.xtdb.span :as s])
            #?(:clj [glam.xtdb.relation :as r])
            #?(:clj [glam.xtdb.relation-layer :as rl])
            #?(:clj [glam.xtdb.span-layer :as sl])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.xtdb.easy :as gxe])
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-relation [{:keys [node] :as env} {:relation/keys [id]}]
     {::pc/input     #{:relation/id}
      ::pc/output    [:relation/id :relation/layer :relation/source :relation/target :relation/value]
      ::pc/transform (ma/readable-required :relation/id)}
     (r/get node id)))

#?(:clj
   (pc/defmutation save-relation [{:keys [node] :as env} {:relation/keys [id value] :as relation}]
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
         (server-message "Successfully saved relation")
         (server-error (str "Failed to save relation " id))))))

#?(:clj
   (pc/defmutation create-relation
     [{:keys [node] :as env} {:relation/keys [id value layer source target] :as relation}]
     {::pc/transform (ma/writeable-required :relation-layer/id :relation/layer)}
     (cond
       (not (string? value))
       (server-error "Value must be a string.")

       (not (rl/get node layer))
       (server-error "Relation layer does not exist")

       (not (s/get node source))
       (server-error "Source span does not exist")

       (not (s/get node target))
       (server-error "Target span does not exist")

       (not (ma/ident-locked? env [:relation/id id]))
       (server-error (ma/lock-holder-error-msg env [:relation/id id]))

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
   (def relation-resolvers [get-relation save-relation create-relation]))