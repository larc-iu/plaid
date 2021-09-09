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
      ::pc/output    [:token/id :token/begin :token/end]
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

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def token-resolvers [get-token get-token-value]))