(ns glam.models.text
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            #?(:clj [glam.crux.text :as text])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-text [{:keys [crux] :as env} {:text/keys [id]}]
     {::pc/input     #{:text/id}
      ::pc/output    [:text/id :text/body :text/layer :text/document]
      ::pc/transform (ma/readable-required :text/id)}
     (text/get crux id)))

#?(:cljs
   (m/defmutation save-text
     [params]
     (action [{:keys [app]}] (log/info "Beginning save text"))
     (remote [env]
             (-> env
                 (m/with-params (dissoc params :join-class)))))
   :clj
   (pc/defmutation save-text
     [{:keys [crux] :as env} {:text/keys [id] :keys [new-body old-body] document-id :document/id tl-id :text-layer/id}]
     {::pc/transform (ma/writeable-required :text/id)}
     (if (tempid/tempid? id)
       (let [{:keys [success] new-id :id} (text/create crux {:text/body     new-body
                                                             :text/layer    tl-id
                                                             :text/document document-id})]
         (if-not success
           (server-error "Failed to create text, please try again")
           {:tempids {id new-id}}))
       (if (text/update-body crux id old-body new-body)
         (server-message "Update successful")
         (server-error "Failed to create text, please try again")))))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def text-resolvers [get-text save-text]))