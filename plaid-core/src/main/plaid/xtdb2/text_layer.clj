(ns plaid.xtdb2.text-layer
  (:require [xtdb.api :as xt]
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
          tokl-ops (vec (mapcat #(tokl/delete* xt-map %) token-layer-ids))
          text-ids (->> (pxc/find-entities node :texts {:text/layer eid})
                        (map :xt/id))
          text-ops (vec (mapcat (fn [tid]
                                  (let [t (pxc/entity-with-sys-from node :texts tid)]
                                    [(pxc/match* :texts t)
                                     [:delete-docs :texts tid]]))
                                text-ids))]
      (reduce into
              [tokl-ops
               text-ops
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
