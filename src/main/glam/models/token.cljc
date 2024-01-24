(ns glam.models.token
  (:require [clojure.set :refer [rename-keys]]
            [clojure.spec.alpha :as s]
            [com.fulcrologic.guardrails.core :refer [>defn >def]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            #?(:clj [glam.xtdb.text :as txt])
            #?(:clj [glam.xtdb.token :as tok])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [glam.xtdb.easy :as gxe])))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-token [{:keys [node] :as env} {:token/keys [id]}]
     {::pc/input     #{:token/id}
      ::pc/output    [:token/id :token/begin :token/end :token/layer :token/text]
      ::pc/transform (ma/readable-required :token/id)}
     (tok/get node id)))

#?(:clj
   (pc/defresolver get-token-value [{:keys [node]} {:token/keys [id]}]
     {::pc/input     #{:token/id}
      ::pc/output    [:token/value]
      ::pc/transform (ma/readable-required :token/id)}
     (let [{:token/keys [begin end text] :as token} (gxe/entity node id)
           {:text/keys [body] :as text} (txt/get node text)]
       (try
         {:token/value (subs body begin end)}
         (catch StringIndexOutOfBoundsException e
           (log/error (str "Token's indexes were out of bounds! Token: " (pr-str token)
                           "  Text: " (pr-str text)))
           (log/error (str "Exception message: " (.getMessage e))))))))

#?(:clj
   (pc/defmutation set-extent [{:keys [node] :as env} {:token/keys [id] :as params}]
     {::pc/output    [:server/message :server/error?]
      ::pc/transform (ma/writeable-required :token/id)}
     (let [token (gxe/entity node id)]
       (cond
         (nil? (:token/id token))
         (server-error 404 (str "Token does not exist with id: " id))

         (not (ma/ident-locked? env [:token/id id]))
         (server-error 403 (ma/lock-holder-error-msg env [:token/id id]))

         :else
         (if-not (tok/set-extent node id (select-keys params [:new-begin :new-end :delta-begin :delta-end]))
           (server-error 500 "Retokenization failed")
           (server-message "Token boundaries updated"))))))

#?(:clj
   (pc/defmutation delete [{:keys [node] :as env} {:token/keys [id] :as params}]
     {::pc/output    [:server/message :server/error?]
      ::pc/transform (ma/writeable-required :token/id)}
     (let [token (gxe/entity node id)]
       (cond
         (nil? (:token/id token))
         (server-error 404 (str "Token does not exist with id: " id))

         (not (ma/ident-locked? env [:token/id id]))
         (server-error 403 (ma/lock-holder-error-msg env [:token/id id]))

         :else
         (if-not (tok/delete node id)
           (server-error 500 "Token deletion failed")
           (server-message "Token deleted"))))))

#?(:clj
   (pc/defmutation create [{:keys [node] :as env} {:token/keys [layer text] :as token}]
     {::pc/output    [:server/message :server/error?]
      ::pc/transform (ma/writeable-required :token-layer/id :token/layer)}
     (let [token-layer (gxe/entity node layer)
           text (gxe/entity node text)
           text-layer (gxe/entity node (:text/layer text))]
       (cond
         (nil? (:text/id text))
         (server-error 400 "Token must have an associated text.")

         (nil? (:token-layer/id token-layer))
         (server-error 400 (str "Token layer does not exist with ID " layer))

         (not (contains? (set (:text-layer/token-layers text-layer)) layer))
         (server-error 400 (str "Text associated with a token must have a text layer associated with the token layer."))

         (not (ma/ident-locked? env [:text/id (:token/text token)]))
         (server-error 403 (ma/lock-holder-error-msg env [:text/id (:token/text token)]))

         :else
         (let [{:keys [success] new-id :id} (tok/safe-create node token)]
           (if-not success
             (server-error 500 "Token creation failed")
             (merge {:tempids {(:token/id token) new-id}} (server-message "Text created"))))))))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def token-resolvers [get-token get-token-value set-extent delete create]))