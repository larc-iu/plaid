(ns plaid.xtdb2.vocab-link
  (:require [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.metadata :as metadata])
  (:refer-clojure :exclude [get format]))

(def attr-keys [:vocab-link/id
                :vocab-link/vocab-item
                :vocab-link/tokens])

;; Reads -------------------------------------------------------------------------

(defn format [raw-record]
  (let [core-attrs (select-keys raw-record attr-keys)]
    (metadata/add-metadata-to-response core-attrs raw-record "vocab-link")))

(defn get
  "Get a vocab-link by ID, formatted for external consumption."
  [node-or-map id]
  (when-let [e (pxc/entity node-or-map :vocab-links id)]
    (when (:vocab-link/id e)
      (format e))))

(defn project-id-from-token
  [node-or-map token-id]
  (let [doc-id (:token/document (pxc/entity node-or-map :tokens token-id))]
    (:document/project (pxc/entity node-or-map :documents doc-id))))

(defn document-id-from-token
  [node-or-map token-id]
  (:token/document (pxc/entity node-or-map :tokens token-id)))

(defn project-id [node-or-map eid]
  (let [vl (pxc/entity node-or-map :vocab-links eid)
        first-token-id (first (:vocab-link/tokens vl))]
    (when first-token-id (project-id-from-token node-or-map first-token-id))))

(defn get-vocab-layer
  "Get vocab layer ID for a vocab-link."
  [node-or-map id]
  (let [vocab-link (pxc/entity node-or-map :vocab-links id)
        vocab-item-id (:vocab-link/vocab-item vocab-link)
        vocab-item (pxc/entity node-or-map :vocab-items vocab-item-id)]
    (:vocab-item/layer vocab-item)))

;; Mutations ---------------------------------------------------------------------

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        attrs (into {} (filter (fn [[k _]] (= "vocab-link" (namespace k))) attrs))
        {:vocab-link/keys [id vocab-item tokens] :as record} (clojure.core/merge
                                                              (pxc/new-record "vocab-link")
                                                              attrs)
        item-e (pxc/entity node :vocab-items vocab-item)]
    (when-not item-e
      (throw (ex-info (pxc/err-msg-not-found "Vocab item" vocab-item) {:code 400 :id vocab-item})))

    (when (or (empty? tokens)
              (not (every? #(:token/id (pxc/entity node :tokens %)) tokens)))
      (throw (ex-info "Vocab link must reference at least one token" {:code 400})))

    (let [token-records (mapv #(pxc/entity node :tokens %) tokens)]
      (when (> (->> token-records (map :token/layer) set count) 1)
        (throw (ex-info "Tokens inside vocab link must all belong to the same layer" {:code 400})))
      (when (> (->> token-records (map :token/text) set count) 1)
        (throw (ex-info "Tokens inside vocab link must all belong to the same text" {:code 400})))

      (let [project-id (project-id-from-token node (first tokens))
            {vocab-layer-id :vocab-item/layer} item-e
            project-vocabs (set (:project/vocabs (pxc/entity node :projects project-id)))]
        (when-not (project-vocabs vocab-layer-id)
          (throw (ex-info "Cannot create vocab link: project is not linked to the vocab layer"
                          {:code 400 :project-id project-id :vocab-layer-id vocab-layer-id}))))

      (let [token-matches (mapv (fn [t]
                                  (pxc/match* :tokens (pxc/entity-with-sys-from node :tokens (:token/id t))))
                                token-records)
            item-e-with-sys (pxc/entity-with-sys-from node :vocab-items vocab-item)
            other-ops [(pxc/match* :vocab-items item-e-with-sys)
                       [:put-docs :vocab-links record]]]
        (into token-matches other-ops)))))

(defn create-operation
  ([xt-map attrs]
   (create-operation xt-map attrs nil))
  ([xt-map attrs metadata-map]
   (let [node (pxc/->node xt-map)
         first-token-id (first (:vocab-link/tokens attrs))
         project-id (when first-token-id (project-id-from-token node first-token-id))
         document-id (when first-token-id (document-id-from-token node first-token-id))
         metadata-attrs (metadata/transform-metadata-for-storage metadata-map "vocab-link")
         attrs-with-metadata (clojure.core/merge attrs metadata-attrs)]
     (op/make-operation
      {:type :vocab-link/create
       :description (str "Create vocab mapping"
                         (when metadata-map (str " with " (count metadata-map) " metadata keys")))
       :tx-ops (create* xt-map attrs-with-metadata)
       :project project-id
       :document document-id}))))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata-map]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata-map)] user-id
                       #(-> % last last :xt/id))))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        record (pxc/entity-with-sys-from node :vocab-links eid)]
    (when-not (:vocab-link/id record)
      (throw (ex-info (pxc/err-msg-not-found "Vocab link" eid) {:code 404 :id eid})))
    [(pxc/match* :vocab-links record)
     [:delete-docs :vocab-links eid]]))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        vocab-link (pxc/entity node :vocab-links eid)
        first-token-id (first (:vocab-link/tokens vocab-link))
        project-id (when first-token-id (project-id-from-token node first-token-id))
        document-id (when first-token-id (document-id-from-token node first-token-id))]
    (op/make-operation
     {:type :vocab-link/delete
      :description "Delete vocab mapping"
      :tx-ops (delete* xt-map eid)
      :project project-id
      :document document-id})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn set-metadata [xt-map eid metadata-map user-id]
  (metadata/set-metadata xt-map eid metadata-map user-id "vocab-link"
                         project-id
                         #(document-id-from-token xt-map (first (:vocab-link/tokens %)))))

(defn delete-metadata [xt-map eid user-id]
  (metadata/delete-metadata xt-map eid user-id "vocab-link"
                            project-id
                            #(document-id-from-token xt-map (first (:vocab-link/tokens %)))))
