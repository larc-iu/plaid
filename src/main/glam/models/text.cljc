(ns glam.models.text
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            #?(:clj [glam.xtdb.text :as text])
            #?(:clj [glam.xtdb.text-layer :as text-layer])
            #?(:clj [glam.xtdb.document :as doc])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.token :as tok])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])
            ))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-text [{:keys [node] :as env} {:text/keys [id]}]
     {::pc/input     #{:text/id}
      ::pc/output    [:text/id :text/body :text/layer :text/document]
      ::pc/transform (ma/readable-required :text/id)}
     (text/get node id)))

;; TODO probably best to refactor this into two
#?(:clj
   (pc/defmutation create-text
     [{:keys [node] :as env} {:text/keys [id] :keys [body] document-id :document/id tl-id :text-layer/id}]
     {::pc/transform (ma/writeable-required :document/id)}
     (cond
       (not (string? body))
       (server-error "Text body must be a string")

       (nil? (doc/get node document-id))
       (server-error (str "Document does not exist: " document-id))

       (nil? (text-layer/get node tl-id))
       (server-error (str "Text layer does not exist: " tl-id))

       ;; TODO: we actually need a match here in the tx to ensure no other text exists
       :else
       (let [{:keys [success] new-id :id} (text/create node {:text/body     body
                                                             :text/layer    tl-id
                                                             :text/document document-id})]
         (if-not success
           (server-error "Failed to create text, please try again")
           (merge {:tempids {id new-id}} (server-message "Text created")))))))

#?(:clj
   (pc/defmutation save-text
     [{:keys [node] :as env} {:text/keys [id] :keys [new-body old-body ops] document-id :document/id tl-id :text-layer/id}]
     {::pc/transform (ma/writeable-required :document/id)}
     (cond (not (string? new-body))
           (server-error "Text body must be a string")

           (not (string? old-body))
           (server-error "Old value of text body must be supplied")

           (nil? (doc/get node document-id))
           (server-error (str "Document does not exist: " document-id))

           (nil? (text-layer/get node tl-id))
           (server-error (str "Text layer does not exist: " tl-id))

           :else
           (if (text/update-body node id old-body ops)
             (server-message "Update successful")
             (server-error "Failed to create text, please try again")))))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def text-resolvers [get-text create-text save-text]))