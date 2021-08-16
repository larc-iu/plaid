(ns glam.models.text
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [com.fulcrologic.fulcro.algorithms.form-state :as fs]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.project :as prj])
            #?(:clj [glam.crux.text :as doc])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.crux.easy :as gce])
            #?(:clj [glam.models.common :as mc :refer [server-error server-message]])))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-text [{:keys [crux] :as env} {:text/keys [id]}]
     {::pc/input     #{:text/id}
      ::pc/output    [:text/id :text/body :text/layer :text/document]
      ::pc/transform (ma/readable-required :text/id)}
     (doc/get crux id)))

;; admin --------------------------------------------------------------------------------

#?(:clj
   (def text-resolvers [get-text]))