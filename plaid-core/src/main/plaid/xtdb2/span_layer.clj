(ns plaid.xtdb2.span-layer
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.relation-layer :as rl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span-layer/id
                :span-layer/name
                :span-layer/relation-layers
                :config])

;; Queries ------------------------------------------------------------------------

(defn get
  [node-or-map id]
  (when-let [e (pxc/entity node-or-map :span-layers id)]
    (when (:span-layer/id e)
      (pxc/deserialize-config (select-keys e attr-keys)))))

(defn- parent-id [node sl-id]
  (:span-layer/token-layer (pxc/entity node :span-layers sl-id)))

(defn project-id [node-or-map id]
  (:span-layer/project (pxc/entity node-or-map :span-layers id)))

;; Mutations ----------------------------------------------------------------------

(defn create* [xt-map {:span-layer/keys [id] :as attrs} token-layer-id]
  (let [node (pxc/->node xt-map)
        tokl (pxc/entity-with-sys-from node :token-layers token-layer-id)
        prj-id (:token-layer/project tokl)
        {:span-layer/keys [name id] :as record}
        (-> (clojure.core/merge (pxc/new-record "span-layer" id)
                               {:span-layer/relation-layers []
                                :span-layer/token-layer token-layer-id
                                :span-layer/project prj-id}
                               (select-keys attrs attr-keys))
            (update :config pxc/serialize-config))]
    (pxc/valid-name? name)
    (when (pxc/entity node :span-layers id)
      (throw (ex-info (pxc/err-msg-already-exists "Span layer" id) {:id id :code 409})))
    (when (nil? (:token-layer/id tokl))
      (throw (ex-info (pxc/err-msg-not-found "Token layer" token-layer-id) {:id token-layer-id :code 400})))
    [(pxc/match* :token-layers tokl)
     [:put-docs :token-layers (-> tokl
                                  (pxc/strip-temporal)
                                  (update :token-layer/span-layers conj id))]
     [:put-docs :span-layers record]]))

(defn create-operation [xt-map attrs token-layer-id]
  (let [{:span-layer/keys [name]} attrs
        tx-ops (create* xt-map attrs token-layer-id)
        prj-id (:token-layer/project (pxc/entity xt-map :token-layers token-layer-id))]
    (op/make-operation
     {:type :span-layer/create
      :project prj-id
      :document nil
      :description (str "Create span layer \"" name "\" in token layer " token-layer-id)
      :tx-ops tx-ops})))

(defn create [xt-map attrs token-layer-id user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs token-layer-id)] user-id
                      #(-> % last last :xt/id)))

(defn merge-operation [xt-map eid m]
  (when-let [name (:span-layer/name m)]
    (pxc/valid-name? name))
  (let [tx-ops (pxc/merge* xt-map :span-layers :span-layer/id eid
                           (select-keys m [:span-layer/name]))]
    (op/make-operation
     {:type :span-layer/update
      :project (project-id xt-map eid)
      :document nil
      :description (str "Update span layer " eid)
      :tx-ops tx-ops})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(def shift-span-layer*
  (pxc/make-shift-layer* :token-layers :token-layer/id :span-layers :span-layer/id :token-layer/span-layers :span-layer/token-layer))

(defn shift-span-layer-operation [xt-map sl-id up?]
  (op/make-operation
   {:type :span-layer/shift
    :project (project-id xt-map sl-id)
    :document nil
    :description (str "Shift span layer " sl-id " " (if up? "up" "down"))
    :tx-ops (shift-span-layer* xt-map sl-id up?)}))

(defn shift-span-layer [xt-map sl-id up? user-id]
  (submit-operations! xt-map [(shift-span-layer-operation xt-map sl-id up?)] user-id))

(defn delete*
  "Delete a span layer and all its relation-layers and spans. Does NOT remove ref from parent."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        sl (pxc/entity-with-sys-from node :span-layers eid)]
    (when (nil? (:span-layer/id sl))
      (throw (ex-info (pxc/err-msg-not-found "Span layer" eid) {:code 404})))
    (let [relation-layer-ids (:span-layer/relation-layers sl)
          ;; Batch-fetch all relation-layers (1 query instead of N)
          rl-entities (pxc/entities-with-sys-from node :relation-layers relation-layer-ids)
          ;; Find ALL relations across ALL relation-layers in one query
          all-relations (if (empty? relation-layer-ids) []
                          (let [ph (str/join ", " (repeat (count relation-layer-ids) "?"))]
                            (xt/q node (into [(str "SELECT *, _system_from FROM relations"
                                                   " WHERE relation$layer IN (" ph ")")]
                                             relation-layer-ids))))
          spans (pxc/find-entities-with-sys-from node :spans {:span/layer eid})]
      (reduce into
              [(pxc/batch-delete-ops :relations all-relations)
               (pxc/batch-delete-ops :relation-layers rl-entities)
               (pxc/batch-delete-ops :spans spans)
               [(pxc/match* :span-layers sl)
                [:delete-docs :span-layers eid]]]))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        sl (pxc/entity node :span-layers eid)
        prj-id (:span-layer/project sl)
        tokl-id (parent-id node eid)
        tokl (pxc/entity-with-sys-from node :token-layers tokl-id)
        base-tx (delete* xt-map eid)
        unlink-tx [(pxc/match* :token-layers tokl)
                   [:put-docs :token-layers (-> tokl
                                                (pxc/strip-temporal)
                                                (pxc/remove-id :token-layer/span-layers eid))]]
        all-tx (into base-tx unlink-tx)]
    (op/make-operation
     {:type :span-layer/delete
      :project prj-id
      :document nil
      :description (str "Delete span layer " eid " with "
                        (count (:span-layer/relation-layers sl)) " relation layers")
      :tx-ops all-tx})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))
