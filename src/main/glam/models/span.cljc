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
       (nil? (:span/id (s/get node id)))
       (server-error 404 (str "Span with id " id " does not exist."))

       (not (ma/ident-locked? env [:span/id id]))
       (server-error 403 (ma/lock-holder-error-msg env [:span/id id]))

       :else
       (if-let [result (s/merge node id {:span/value value})]
         (server-message "Successfully updated span's value")
         (server-error 500 (str "Failed to update span " id))))))

#?(:clj
   (pc/defmutation update-tokens [{:keys [node] :as env} {:span/keys [id tokens] :as span}]
     {::pc/transform (ma/writeable-required :span/id)}

     (let [associated-doc-id (s/get-doc-id-of-span node id)
           token-doc-ids (set (map #(tok/get-doc-id-of-token node %) tokens))
           new-token-layers (->> tokens
                                 (map vector)
                                 (gxe/entities node)
                                 (map :token/layer)
                                 (filter some?)
                                 set)
           orig-token-layer (s/get-associated-token-layer node id)]
       (cond
         (nil? (:span/id (s/get node id)))
         (server-error 404 (str "Span with id " id " does not exist."))

         (not (every? #(some? (:token/id %)) (gxe/entities node (map vector tokens))))
         (server-error 400 (str "IDs provided do not all point to valid tokens."))

         (not (= (count (set tokens)) (count tokens)))
         (server-error 400 (str "Tokens must not be associated more than once with a span."))

         (= (count tokens) 0)
         (server-error 400 (str "Empty spans are not allowed."))

         (not (and (= 1 (count token-doc-ids))
                   (id? (first token-doc-ids))))
         (server-error 400 (str "All tokens must exist within the same document."))

         (not= associated-doc-id (first token-doc-ids))
         (server-error 400 (str "Associated tokens must appear in the same document as this span."))

         (not= 1 (count new-token-layers))
         (server-error 400 (str "Associated tokens must all appear in the same token layer."))

         (not= (first new-token-layers) orig-token-layer)
         (server-error 400 (str "New tokens must belong to the same token layer as the original tokens."))

         (not (ma/ident-locked? env [:span/id id]))
         (server-error 403 (ma/lock-holder-error-msg env [:span/id id]))

         :else
         (if-let [result (s/merge node id {:span/tokens tokens})]
           (server-message "Successfully updated span's associated tokens")
           (server-error 500 (str "Failed to update span " id)))))))

#?(:clj
   (pc/defmutation delete-span [{:keys [node] :as env} {:span/keys [id] :as span}]
     {::pc/transform (ma/writeable-required :span/id)}
     (cond
       (nil? (:span/id (gxe/entity node id)))
       (server-error 404 (str "Span does not exist with ID " id))

       :else
       (if-let [result (s/delete node id)]
         (server-message (str "Successfully deleted span " id))
         (server-error 500 (str "Failed to delete span " id))))))

#?(:clj
   ;; TODO this needs span-snapshots
   (pc/defmutation create-span
     [{:keys [node] :as env} {:span/keys [id value layer tokens] :as span}]
     {::pc/transform (ma/writeable-required :span-layer/id :span/layer)}
     (let [token-doc-ids (set (map #(tok/get-doc-id-of-token node %) tokens))
           new-token-layers (->> tokens
                                 (map vector)
                                 (gxe/entities node)
                                 (map :token/layer)
                                 (filter some?)
                                 set)]
       (cond
         (not (:span-layer/id (sl/get node layer)))
         (server-error 400 "Span layer does not exist.")

         (some nil? (map #(tok/get node %) tokens))
         (server-error 400 "Not all tokens exist for this span.")

         (not (and (= 1 (count token-doc-ids))
                   (id? (first token-doc-ids))))
         (server-error 400 "All tokens associated with span must be in a single document.")

         (not= 1 (count new-token-layers))
         (server-error 400 "All tokens associated with span must belong to a single token layer.")

         (not ((->> new-token-layers first (gxe/entity node) :token-layer/span-layers set)
               layer))
         (server-error 400 "Span must belong to a layer that is associated with its tokens' layer.")

         (not (ma/ident-locked? env [:token/id (first tokens)]))
         (server-error 403 (ma/lock-holder-error-msg env [:span/id id]))

         :else
         (let [{:keys [success] new-id :id} (s/create node {:span/value  value
                                                            :span/layer  layer
                                                            :span/tokens (into [] tokens)})]
           (if-not success
             (server-error 500 "Failed to create span, please try again")
             (merge {:tempids {id new-id}} (server-message "Span created"))))))))

#?(:clj
   (pc/defmutation batched-update
     [{:keys [node] :as env} {document-id    :document/id
                              span-layer-id  :span-layer/id
                              span-snapshots :span-snapshots
                              updates        :updates
                              :as            args}]
     {::pc/transform (ma/writeable-required :span-layer/id)}

     (not (ma/ident-locked? env [:document/id document-id]))
     (server-error 403 (ma/lock-holder-error-msg env [:document/id document-id]))

     (let [success (s/batched-update node document-id span-layer-id span-snapshots updates)]
       (if-not success
         (server-error 500 "Failed to update document, please try again")
         (server-message "Updates applied")))))

#?(:clj
   (pc/defmutation multi-layer-batched-update
     [{:keys [node] :as env} {document-id :document/id
                              batches     :batches
                              :as         args}]
     {::pc/transform (ma/writeable-required :document/id)}

     (not (ma/ident-locked? env [:document/id document-id]))
     (server-error 403 (ma/lock-holder-error-msg env [:document/id document-id]))

     (let [success (s/multi-batched-update node document-id batches)]
       (if-not success
         (server-error 500 "Failed to update document, please try again")
         (server-message "Updates applied")))))

;; admin --------------------------------------------------------------------------------
#?(:clj
   (def span-resolvers [get-span update-value update-tokens create-span batched-update multi-layer-batched-update
                        delete-span]))