(ns glam.models.span
  (:require [clojure.set :refer [rename-keys]]
            [com.wsscode.pathom.connect :as pc]
            [taoensso.timbre :as log]
            #?(:cljs [glam.models.common :as mc]
               :clj  [glam.models.common :as mc :refer [server-error server-message]])
            #?(:clj [glam.xtdb.token :as tok])
            #?(:clj [glam.xtdb.span :as s])
            #?(:clj [glam.xtdb.span-layer :as sl])
            #?(:clj [glam.models.auth :as ma])
            #?(:clj [glam.xtdb.easy :as gxe])
            [com.fulcrologic.fulcro.algorithms.tempid :as tempid]))

#?(:cljs
   (defn get-span-snapshots [fulcro-db doc-id span-layer-id]
     (:document/id fulcro-db)
     (let [spans (->> (:span/id fulcro-db)
                      vals
                      (filter #(not (tempid/tempid? (:span/id %))))
                      (filter #(= doc-id (mc/get-document fulcro-db %))))
           snapshots (map #(select-keys % [:span/id :span/value :span/tokens]) spans)]
       snapshots)))

;; user --------------------------------------------------------------------------------
#?(:clj
   (pc/defresolver get-span [{:keys [node] :as env} {:span/keys [id]}]
     {::pc/input     #{:span/id}
      ::pc/output    [:span/id :span/tokens :span/value :span/layer]
      ::pc/transform (ma/readable-required :span/id)}
     (s/get node id)))

#?(:clj
   ;; TODO this needs span-snapshots
   (pc/defmutation save-span [{:keys [node] :as env} {:span/keys [id value] :as span}]
     {::pc/transform (ma/writeable-required :span/id)}
     (cond
       (nil? (s/get node id))
       (server-error (str "Span with id " id " does not exist."))

       (not (string? value))
       (server-error "Value must be a string.")

       :else
       (if-let [result (s/merge node id {:span/value value})]
         (server-message "Successfully saved span")
         (server-error (str "Failed to save span " id))))))

#?(:clj
   ;; TODO this needs span-snapshots
   (pc/defmutation create-span
     [{:keys [node] :as env} {:span/keys [id value layer tokens] :as span}]
     {::pc/transform (ma/writeable-required :span-layer/id :span/layer)}
     (cond
       (not (string? value))
       (server-error "Value must be a string.")

       (not (sl/get node layer))
       (server-error "Span layer does not exist")

       (some nil? (map #(tok/get node %) tokens))
       (server-error "Not all tokens exist for this span")

       :else
       (let [{:keys [success] new-id :id} (s/create node {:span/value  value
                                                          :span/layer  layer
                                                          :span/tokens (into [] tokens)})]
         (if-not success
           (server-error "Failed to create span, please try again")
           (merge {:tempids {id new-id}} (server-message "Span created")))))))

#?(:clj
   (pc/defmutation batched-update
     [{:keys [node] :as env} {document-id    :document/id
                              span-layer-id  :span-layer/id
                              span-snapshots :span-snapshots
                              updates        :updates
                              :as            args}]
     {::pc/transform (ma/writeable-required :span-layer/id)}
     (let [success (s/batched-update node document-id span-layer-id span-snapshots updates)]
       (if-not success
         (server-error "Failed to update document, please try again")
         (server-message "Updates applied")))))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (def span-resolvers [get-span save-span create-span]))