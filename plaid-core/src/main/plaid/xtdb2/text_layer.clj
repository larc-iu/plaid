(ns plaid.xtdb2.text-layer
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.token-layer :as tokl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text-layer/id
                :text-layer/name
                :text-layer/token-layers
                :config])

;; Queries ------------------------------------------------------------------------

(defn get [node-or-map id]
  (when-let [e (pxc/entity node-or-map :text-layers id)]
    (when (:text-layer/id e)
      (pxc/deserialize-config (select-keys e attr-keys)))))

(defn- parent-id [node txtl-id]
  (:text-layer/project (pxc/entity node :text-layers txtl-id)))

(defn project-id [node-or-map id]
  (parent-id node-or-map id))

;; Mutations ----------------------------------------------------------------------

(defn create* [xt-map {:text-layer/keys [id] :as attrs} project-id]
  (let [node (pxc/->node xt-map)
        {:text-layer/keys [name id] :as record}
        (clojure.core/merge (pxc/new-record "text-layer" id)
                            {:text-layer/token-layers []
                             :text-layer/project project-id}
                            (select-keys attrs attr-keys))
        prj (pxc/entity-with-sys-from node :projects project-id)]
    (pxc/valid-name? name)
    (when (pxc/entity node :text-layers id)
      (throw (ex-info (pxc/err-msg-already-exists "Text layer" id) {:id id :code 409})))
    (when (nil? (:project/id prj))
      (throw (ex-info (pxc/err-msg-not-found "Project" project-id) {:id project-id :code 400})))
    [(pxc/match* :projects prj)
     [:put-docs :projects (-> prj
                              (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                              (update :project/text-layers conj id))]
     [:put-docs :text-layers record]]))

(defn create-operation [xt-map attrs project-id]
  (let [{:text-layer/keys [name]} attrs
        tx-ops (create* xt-map attrs project-id)]
    (op/make-operation
     {:type :text-layer/create
      :project project-id
      :document nil
      :description (str "Create text layer \"" name "\" in project " project-id)
      :tx-ops tx-ops})))

(defn create [xt-map attrs project-id user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs project-id)] user-id
                      #(-> % last last :xt/id)))

(defn merge-operation [xt-map eid m]
  (when-let [name (:text-layer/name m)]
    (pxc/valid-name? name))
  (let [tx-ops (pxc/merge* xt-map :text-layers :text-layer/id eid
                           (select-keys m [:text-layer/name :config]))]
    (op/make-operation
     {:type :text-layer/update
      :project (project-id xt-map eid)
      :document nil
      :description (str "Update text layer " eid)
      :tx-ops tx-ops})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(def shift-text-layer*
  (pxc/make-shift-layer* :projects :project/id :text-layers :text-layer/id :project/text-layers :text-layer/project))

(defn shift-text-layer-operation [xt-map txtl-id up?]
  (op/make-operation
   {:type :text-layer/shift
    :project (project-id xt-map txtl-id)
    :document nil
    :description (str "Shift text layer " txtl-id " " (if up? "up" "down"))
    :tx-ops (shift-text-layer* xt-map txtl-id up?)}))

(defn shift-text-layer [xt-map txtl-id up? user-id]
  (submit-operations! xt-map [(shift-text-layer-operation xt-map txtl-id up?)] user-id))

(defn delete*
  "Delete a text-layer and all its token-layers and texts. Does NOT remove ref from parent project."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        txtl (pxc/entity-with-sys-from node :text-layers eid)]
    (when (nil? (:text-layer/id txtl))
      (throw (ex-info (pxc/err-msg-not-found "Text layer" eid) {:code 404})))
    (let [token-layer-ids (:text-layer/token-layers txtl)
          ;; Batch-fetch all token-layers (1 query)
          tokl-entities (pxc/entities-with-sys-from node :token-layers token-layer-ids)
          ;; Collect all span-layer IDs across all token-layers
          all-sl-ids (vec (mapcat :token-layer/span-layers tokl-entities))
          sl-entities (pxc/entities-with-sys-from node :span-layers all-sl-ids)
          ;; Collect all relation-layer IDs across all span-layers
          all-rl-ids (vec (mapcat :span-layer/relation-layers sl-entities))
          rl-entities (pxc/entities-with-sys-from node :relation-layers all-rl-ids)
          ;; All relations across all relation-layers (1 query)
          all-relations (if (empty? all-rl-ids) []
                          (let [ph (str/join ", " (repeat (count all-rl-ids) "?"))]
                            (xt/q node (into [(str "SELECT *, _system_from FROM relations"
                                                   " WHERE relation$layer IN (" ph ")")]
                                             all-rl-ids))))
          ;; All spans across all span-layers (1 query)
          all-spans (if (empty? all-sl-ids) []
                      (let [ph (str/join ", " (repeat (count all-sl-ids) "?"))]
                        (xt/q node (into [(str "SELECT *, _system_from FROM spans"
                                                " WHERE span$layer IN (" ph ")")]
                                          all-sl-ids))))
          ;; All tokens across all token-layers (1 query)
          all-tokens (if (empty? token-layer-ids) []
                       (let [ph (str/join ", " (repeat (count token-layer-ids) "?"))]
                         (xt/q node (into [(str "SELECT *, _system_from FROM tokens"
                                                 " WHERE token$layer IN (" ph ")")]
                                           token-layer-ids))))
          token-ids (mapv :xt/id all-tokens)
          ;; All vocab-links for all tokens (1 query)
          vl-entities (if (empty? token-ids)
                        []
                        (let [ph (str/join ", " (repeat (count token-ids) "?"))]
                          (xt/q node (into [(str "SELECT *, _system_from FROM vocab_links vl, UNNEST(vl.vocab_link$tokens) AS t(tid)"
                                                 " WHERE t.tid IN (" ph ")")]
                                           token-ids))))
          vl-by-id (into {} (map (juxt :xt/id identity) vl-entities))
          ;; Texts for this text-layer (1 query, no double-fetch)
          texts (pxc/find-entities-with-sys-from node :texts {:text/layer eid})]
      (reduce into
              [(pxc/batch-delete-ops :vocab-links (vals vl-by-id))
               (pxc/batch-delete-ops :relations all-relations)
               (pxc/batch-delete-ops :relation-layers rl-entities)
               (pxc/batch-delete-ops :spans all-spans)
               (pxc/batch-delete-ops :span-layers sl-entities)
               (pxc/batch-delete-ops :tokens all-tokens)
               (pxc/batch-delete-ops :token-layers tokl-entities)
               (pxc/batch-delete-ops :texts texts)
               [(pxc/match* :text-layers txtl)
                [:delete-docs :text-layers eid]]]))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        txtl (pxc/entity node :text-layers eid)
        prj-id (parent-id node eid)
        prj (pxc/entity-with-sys-from node :projects prj-id)
        base-tx (delete* xt-map eid)
        unlink-tx [(pxc/match* :projects prj)
                   [:put-docs :projects (-> prj
                                            (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                                            (pxc/remove-id :project/text-layers eid))]]
        all-tx (into base-tx unlink-tx)]
    (op/make-operation
     {:type :text-layer/delete
      :project prj-id
      :document nil
      :description (str "Delete text layer " eid " with "
                        (count (:text-layer/token-layers txtl)) " token layers")
      :tx-ops all-tx})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))
