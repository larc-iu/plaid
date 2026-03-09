(ns plaid.xtdb2.relation-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:relation-layer/id
                :relation-layer/name
                :relation-layer/project
                :config])

;; Queries ------------------------------------------------------------------------

(defn get
  "Get a relation layer by ID, formatted for external consumption."
  [node-or-map id]
  (when-let [e (pxc/entity node-or-map :relation-layers id)]
    (when (:relation-layer/id e)
      (pxc/deserialize-config (select-keys e attr-keys)))))

(defn- parent-id
  "Find the span-layer containing this relation-layer."
  [node rl-id]
  (:relation-layer/span-layer (pxc/entity node :relation-layers rl-id)))

(defn project-id [node-or-map id]
  (:relation-layer/project (pxc/entity node-or-map :relation-layers id)))

;; Mutations ----------------------------------------------------------------------

(defn create* [xt-map {:relation-layer/keys [id] :as attrs} span-layer-id]
  (let [node (pxc/->node xt-map)
        sl (pxc/entity-with-sys-from node :span-layers span-layer-id)
        prj-id (:span-layer/project sl)
        {:relation-layer/keys [name id] :as record}
        (-> (clojure.core/merge (pxc/new-record "relation-layer" id)
                               {:relation-layer/span-layer span-layer-id
                                :relation-layer/project prj-id}
                               (select-keys attrs attr-keys))
            (update :config pxc/serialize-config))]
    (pxc/valid-name? name)
    (when (pxc/entity node :relation-layers id)
      (throw (ex-info (pxc/err-msg-already-exists "Relation layer" id) {:id id :code 409})))
    (when (nil? (:span-layer/id sl))
      (throw (ex-info (pxc/err-msg-not-found "Span layer" span-layer-id) {:id span-layer-id :code 400})))
    [(pxc/match* :span-layers sl)
     [:put-docs :span-layers (-> sl
                                 (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                                 (update :span-layer/relation-layers conj id))]
     [:put-docs :relation-layers record]]))

(defn create-operation [xt-map attrs span-layer-id]
  (let [{:relation-layer/keys [name]} attrs
        tx-ops (create* xt-map attrs span-layer-id)
        prj-id (:relation-layer/project (nth (last tx-ops) 2))]
    (op/make-operation
     {:type :relation-layer/create
      :project prj-id
      :document nil
      :description (str "Create relation layer \"" name "\" in span layer " span-layer-id)
      :tx-ops tx-ops})))

(defn create [xt-map attrs span-layer-id user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs span-layer-id)] user-id
                      #(-> % last last :xt/id)))

(defn merge-operation [xt-map eid m]
  (when-let [name (:relation-layer/name m)]
    (pxc/valid-name? name))
  (let [tx-ops (pxc/merge* xt-map :relation-layers :relation-layer/id eid
                           (select-keys m [:relation-layer/name]))]
    (op/make-operation
     {:type :relation-layer/update
      :project (project-id xt-map eid)
      :document nil
      :description (str "Update relation layer " eid)
      :tx-ops tx-ops})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(def shift-relation-layer*
  (pxc/make-shift-layer* :span-layers :span-layer/id :relation-layers :relation-layer/id :span-layer/relation-layers :relation-layer/span-layer))

(defn shift-relation-layer-operation [xt-map rl-id up?]
  (op/make-operation
   {:type :relation-layer/shift
    :project (project-id xt-map rl-id)
    :document nil
    :description (str "Shift relation layer " rl-id " " (if up? "up" "down"))
    :tx-ops (shift-relation-layer* xt-map rl-id up?)}))

(defn shift-relation-layer [xt-map rl-id up? user-id]
  (submit-operations! xt-map [(shift-relation-layer-operation xt-map rl-id up?)] user-id))

(defn delete*
  "Delete a relation layer and all its relations. Does NOT remove the ref from the parent span-layer."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        rl (pxc/entity-with-sys-from node :relation-layers eid)]
    (when (nil? (:relation-layer/id rl))
      (throw (ex-info (pxc/err-msg-not-found "Relation layer" eid) {:code 404})))
    (let [relations (pxc/find-entities-with-sys-from node :relations {:relation/layer eid})]
      (into (pxc/batch-delete-ops :relations relations)
            [(pxc/match* :relation-layers rl)
             [:delete-docs :relation-layers eid]]))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        rl (pxc/entity node :relation-layers eid)
        prj-id (:relation-layer/project rl)
        sl-id (parent-id node eid)
        sl (pxc/entity-with-sys-from node :span-layers sl-id)
        base-tx (delete* xt-map eid)
        unlink-tx [(pxc/match* :span-layers sl)
                   [:put-docs :span-layers (-> sl
                                               (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                                               (pxc/remove-id :span-layer/relation-layers eid))]]
        all-tx (into base-tx unlink-tx)]
    (op/make-operation
     {:type :relation-layer/delete
      :project prj-id
      :document nil
      :description (str "Delete relation layer " eid)
      :tx-ops all-tx})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))
