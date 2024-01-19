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
            #?(:clj [glam.server.id-counter :refer [id?]])
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
   (pc/defmutation update-value [{:keys [node] :as env} {:span/keys [id value] :as span}]
     {::pc/transform (ma/writeable-required :span/id)}
     (cond
       (nil? (s/get node id))
       (server-error (str "Span with id " id " does not exist."))

       (not (ma/ident-locked? env [:span/id id]))
       (server-error (ma/lock-holder-error-msg env [:span/id id]))

       :else
       (if-let [result (s/merge node id {:span/value value})]
         (server-message "Successfully updated span's value")
         (server-error (str "Failed to update span " id))))))

#?(:clj
   (pc/defmutation update-tokens [{:keys [node] :as env} {:span/keys [id tokens] :as span}]
     {::pc/transform (ma/writeable-required :span/id)}

     (let [associated-doc-id (s/get-doc-id-of-span node id)
           token-doc-ids (set (map #(tok/get-doc-id-of-token node %) tokens))]
       (println token-doc-ids)
       (cond
         (nil? (s/get node id))
         (server-error (str "Span with id " id " does not exist."))

         (not (every? #(some? (:token/id %)) (gxe/entities node (map vector tokens))))
         (server-error (str "IDs provided do not all point to valid tokens."))

         (not (= (count (set tokens)) (count tokens)))
         (server-error (str "Tokens must not be associated more than once with a span."))

         (= (count tokens) 0)
         (server-error (str "Empty spans are not allowed."))

         (not (and (= 1 (count token-doc-ids))
                   (id? (first token-doc-ids))))
         (server-error (str "All tokens must exist within the same document."))

         (not= associated-doc-id (first token-doc-ids))
         (server-error (str "Associated tokens must appear in the same document as this span."))

         (not (ma/ident-locked? env [:span/id id]))
         (server-error (ma/lock-holder-error-msg env [:span/id id]))

         :else
         (if-let [result (s/merge node id {:span/tokens tokens})]
           (server-message "Successfully updated span's associated tokens")
           (server-error (str "Failed to update span " id)))))))


#?(:clj
   ;; TODO this needs span-snapshots
   (pc/defmutation create-span
     [{:keys [node] :as env} {:span/keys [id value layer tokens] :as span}]
     {::pc/transform (ma/writeable-required :span-layer/id :span/layer)}
     (cond
       (not (sl/get node layer))
       (server-error "Span layer does not exist")

       (some nil? (map #(tok/get node %) tokens))
       (server-error "Not all tokens exist for this span")

       (not (ma/ident-locked? env [:span/id id]))
       (server-error (ma/lock-holder-error-msg env [:span/id id]))

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

     (not (ma/ident-locked? env [:document/id document-id]))
     (server-error (ma/lock-holder-error-msg env [:document/id document-id]))

     (let [success (s/batched-update node document-id span-layer-id span-snapshots updates)]
       (if-not success
         (server-error "Failed to update document, please try again")
         (server-message "Updates applied")))))

#?(:clj
   (pc/defmutation multi-layer-batched-update
     [{:keys [node] :as env} {document-id :document/id
                              batches     :batches
                              :as         args}]
     {::pc/transform (ma/writeable-required :document/id)}

     (not (ma/ident-locked? env [:document/id document-id]))
     (server-error (ma/lock-holder-error-msg env [:document/id document-id]))

     (let [success (s/multi-batched-update node document-id batches)]
       (if-not success
         (server-error "Failed to update document, please try again")
         (server-message "Updates applied")))))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (def span-resolvers [get-span update-value update-tokens create-span batched-update multi-layer-batched-update]))