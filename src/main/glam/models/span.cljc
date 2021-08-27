(ns glam.models.span
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            #?(:clj [glam.crux.token :as tok])
            #?(:clj [glam.crux.span :as s])
            #?(:clj [glam.crux.span-layer :as sl])
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

#?(:clj
   (pc/defmutation save-span [{:keys [crux] :as env} {:span/keys [id value] :as span}]
     {::pc/transform (ma/writeable-required :span/id)}
     (cond
       (nil? (s/get crux id))
       (server-error (str "Span with id " id " does not exist."))

       (not (string? value))
       (server-error "Value must be a string.")

       :else
       (if-let [result (s/merge crux id {:span/value value})]
         (server-message "Successfully saved span")
         (server-error (str "Failed to save span " id))))))

#?(:clj
   (pc/defmutation create-span
     [{:keys [crux] :as env} {:span/keys [id value layer tokens] :as span}]
     {::pc/transform (ma/writeable-required :span-layer/id :span/layer)}
     (cond
       (not (string? value))
       (server-error "Value must be a string.")

       (not (sl/get crux layer))
       (server-error "Span layer does not exist")

       (some nil? (map #(tok/get crux %) tokens))
       (server-error "Not all tokens exist for this span")

       :else
       (let [{:keys [success] new-id :id} (s/create crux {:span/id     id
                                                          :span/value  value
                                                          :span/layer  layer
                                                          :span/tokens (into [] tokens)})]
         (if-not success
           (server-error "Failed to create span , please try again")
           (merge {:tempids {id new-id}} (server-message "Span created")))))))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (def span-resolvers [get-span save-span create-span]))