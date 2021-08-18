(ns glam.models.span
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.token :as tok])
            #?(:clj [glam.crux.span :as s])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [glam.crux.easy :as gce])))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-span [{:keys [crux] :as env} {:span/keys [id]}]
     {::pc/input     #{:span/id}
      ::pc/output    [:span/id :span/tokens :span/value :span/layer]
      ::pc/transform (ma/readable-required :span/id)}
     (s/get crux id)))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (def span-resolvers [get-span]))