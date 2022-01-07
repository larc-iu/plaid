(ns glam.models.text
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            [com.fulcrologic.fulcro.mutations :as m :refer [defmutation]]
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]
            #?(:clj [glam.xtdb.text :as text])
            #?(:clj [glam.xtdb.text-layer :as txtl])
            #?(:clj [glam.xtdb.document :as doc])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.token :as tok])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [glam.xtdb.token-layer :as tokl])))

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

       (nil? (txtl/get node tl-id))
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
     [{:keys [node] :as env} {:text/keys [id] :keys [new-body ops] document-id :document/id tl-id :text-layer/id}]
     {::pc/transform (ma/writeable-required :document/id)}
     (cond (not (string? new-body))
           (server-error "Text body must be a string")

           (nil? (doc/get node document-id))
           (server-error (str "Document does not exist: " document-id))

           (nil? (txtl/get node tl-id))
           (server-error (str "Text layer does not exist: " tl-id))

           :else
           (if (text/update-body node id ops)
             (server-message "Update successful")
             (server-error "Failed to create text, please try again")))))

#?(:clj
   (pc/defmutation save-and-morpheme-tokenize
     [{:keys [node] :as env} {:text/keys [id] :keys [new-body ops]
                              doc-id     :document/id tl-id :text-layer/id tokl-id :token-layer/id}]
     {::pc/transform (ma/writeable-required :document/id)}
     (cond (not (string? new-body))
           (server-error "Text body must be a string")

           (nil? (doc/get node doc-id))
           (server-error (str "Document does not exist: " doc-id))

           (nil? (txtl/get node tl-id))
           (server-error (str "Text layer does not exist: " tl-id))

           (nil? (tokl/get node tokl-id))
           (server-error (str "Token layer does not exist: " tokl-id))

           :else
           (if (tokl/update-body-and-morpheme-tokenize node tokl-id id ops)
             (server-message "Update successful")
             (server-error "Failed to create text, please try again")))))

#?(:clj
   (pc/defmutation create-and-morpheme-tokenize
     [{:keys [node] :as env} {:text/keys [id] :keys [body] document-id :document/id tl-id :text-layer/id tokl-id :token-layer/id}]
     {::pc/transform (ma/writeable-required :document/id)}
     (cond
       (not (string? body))
       (server-error "Text body must be a string")

       (nil? (doc/get node document-id))
       (server-error (str "Document does not exist: " document-id))

       (nil? (txtl/get node tl-id))
       (server-error (str "Text layer does not exist: " tl-id))

       (nil? (tokl/get node tokl-id))
       (server-error (str "Token layer does not exist: " tokl-id))

       :else
       (let [{:keys [success] new-id :id} (tokl/create-text-and-morpheme-tokenize
                                            node
                                            {:text/body     body
                                             :text/layer    tl-id
                                             :text/document document-id}
                                            tokl-id)]
         (if-not success
           (server-error "Failed to create text, please try again")
           (merge {:tempids {id new-id}} (server-message "Text created")))))))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def text-resolvers [get-text create-text save-text save-and-morpheme-tokenize create-and-morpheme-tokenize]))