(ns plaid.xtdb2.token-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.span-layer :as sl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/span-layers
                :config])

;; Queries ------------------------------------------------------------------------

(defn get [node-or-map id]
  (when-let [e (pxc/entity node-or-map :token-layers id)]
    (when (:token-layer/id e)
      (pxc/deserialize-config (select-keys e attr-keys)))))

(defn- parent-id [node tokl-id]
  (:token-layer/text-layer (pxc/entity node :token-layers tokl-id)))

(defn project-id [node-or-map id]
  (let [txtl-id (:token-layer/text-layer (pxc/entity node-or-map :token-layers id))]
    (when txtl-id
      (:text-layer/project (pxc/entity node-or-map :text-layers txtl-id)))))

(defn sort-token-records [tokens]
  (->> tokens
       (sort-by #(or (:token/precedence %) 0) <)
       (sort-by :token/begin)))

;; Mutations ----------------------------------------------------------------------

(defn create* [xt-map {:token-layer/keys [id] :as attrs} text-layer-id]
  (let [node (pxc/->node xt-map)
        {:token-layer/keys [name id] :as record}
        (clojure.core/merge (pxc/new-record "token-layer" id)
                            {:token-layer/span-layers []
                             :token-layer/text-layer text-layer-id}
                            (select-keys attrs attr-keys))
        txtl (pxc/entity-with-sys-from node :text-layers text-layer-id)]
    (pxc/valid-name? name)
    (when (pxc/entity node :token-layers id)
      (throw (ex-info (pxc/err-msg-already-exists "Token layer" id) {:id id :code 409})))
    (when (nil? (:text-layer/id txtl))
      (throw (ex-info (pxc/err-msg-not-found "Text layer" text-layer-id) {:id text-layer-id :code 400})))
    [(pxc/match* :text-layers txtl)
     [:put-docs :text-layers (-> txtl
                                 (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                                 (update :text-layer/token-layers conj id))]
     [:sql "ASSERT NOT EXISTS (SELECT 1 FROM token_layers WHERE _id = ?)" [id]]
     [:put-docs :token-layers record]]))

(defn create-operation [xt-map attrs text-layer-id]
  (let [{:token-layer/keys [name]} attrs
        tx-ops (create* xt-map attrs text-layer-id)]
    (op/make-operation
     {:type :token-layer/create
      :project (:text-layer/project (pxc/entity xt-map :text-layers text-layer-id))
      :document nil
      :description (str "Create token layer \"" name "\" in text layer " text-layer-id)
      :tx-ops tx-ops})))

(defn create [xt-map attrs text-layer-id user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs text-layer-id)] user-id
                      #(-> % last last :xt/id)))

(defn merge-operation [xt-map eid m]
  (when-let [name (:token-layer/name m)]
    (pxc/valid-name? name))
  (let [tx-ops (pxc/merge* xt-map :token-layers :token-layer/id eid
                           (select-keys m [:token-layer/name :config]))]
    (op/make-operation
     {:type :token-layer/update
      :project (project-id xt-map eid)
      :document nil
      :description (str "Update token layer " eid)
      :tx-ops tx-ops})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(def shift-token-layer*
  (pxc/make-shift-layer* :text-layers :text-layer/id :token-layers :token-layer/id :text-layer/token-layers :token-layer/text-layer))

(defn shift-token-layer-operation [xt-map tokl-id up?]
  (op/make-operation
   {:type :token-layer/shift
    :project (project-id xt-map tokl-id)
    :document nil
    :description (str "Shift token layer " tokl-id " " (if up? "up" "down"))
    :tx-ops (shift-token-layer* xt-map tokl-id up?)}))

(defn shift-token-layer [xt-map tokl-id up? user-id]
  (submit-operations! xt-map [(shift-token-layer-operation xt-map tokl-id up?)] user-id))

(defn delete*
  "Delete a token-layer and all its span-layers, tokens, and vocab-links. Does NOT remove ref from parent."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        tokl (pxc/entity-with-sys-from node :token-layers eid)]
    (when (nil? (:token-layer/id tokl))
      (throw (ex-info (pxc/err-msg-not-found "Token layer" eid) {:code 404})))
    (let [span-layer-ids (:token-layer/span-layers tokl)
          sl-ops (vec (mapcat #(sl/delete* xt-map %) span-layer-ids))
          token-ids (->> (pxc/find-entities node :tokens {:token/layer eid})
                         (map :xt/id))
          ;; Find all vocab-links for these tokens via unnest
          vocab-link-ids (distinct
                          (mapcat (fn [tid]
                                    (->> (xt/q node (xt/template
                                           (-> (from :vocab-links [{:xt/id vlid :vocab-link/tokens toks}])
                                               (unnest {:t toks})
                                               (where (= t ~tid))
                                               (return vlid))))
                                         (map :vlid)))
                                  token-ids))
          vl-ops (vec (mapcat (fn [vlid]
                                (let [vl (pxc/entity-with-sys-from node :vocab-links vlid)]
                                  [(pxc/match* :vocab-links vl)
                                   [:delete-docs :vocab-links vlid]]))
                              vocab-link-ids))
          tok-ops (vec (mapcat (fn [tid]
                                 (let [t (pxc/entity-with-sys-from node :tokens tid)]
                                   [(pxc/match* :tokens t)
                                    [:delete-docs :tokens tid]]))
                               token-ids))]
      (reduce into
              [vl-ops
               sl-ops
               tok-ops
               [(pxc/match* :token-layers tokl)
                [:delete-docs :token-layers eid]]]))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        tokl (pxc/entity node :token-layers eid)
        prj-id (project-id xt-map eid)
        txtl-id (parent-id node eid)
        txtl (pxc/entity-with-sys-from node :text-layers txtl-id)
        base-tx (delete* xt-map eid)
        unlink-tx [(pxc/match* :text-layers txtl)
                   [:put-docs :text-layers (-> txtl
                                               (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                                               (pxc/remove-id :text-layer/token-layers eid))]]
        all-tx (into base-tx unlink-tx)]
    (op/make-operation
     {:type :token-layer/delete
      :project prj-id
      :document nil
      :description (str "Delete token layer " eid " with "
                        (count (:token-layer/span-layers tokl)) " span layers")
      :tx-ops all-tx})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))
