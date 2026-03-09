(ns plaid.xtdb2.token-layer
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.span-layer :as sl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/span-layers
                :token-layer/project
                :config])

;; Queries ------------------------------------------------------------------------

(defn get [node-or-map id]
  (when-let [e (pxc/entity node-or-map :token-layers id)]
    (when (:token-layer/id e)
      (pxc/deserialize-config (select-keys e attr-keys)))))

(defn- parent-id [node tokl-id]
  (:token-layer/text-layer (pxc/entity node :token-layers tokl-id)))

(defn project-id [node-or-map id]
  (:token-layer/project (pxc/entity node-or-map :token-layers id)))

(defn sort-token-records [tokens]
  (->> tokens
       (sort-by #(or (:token/precedence %) 0) <)
       (sort-by :token/begin)))

;; Mutations ----------------------------------------------------------------------

(defn create* [xt-map {:token-layer/keys [id] :as attrs} text-layer-id]
  (let [node (pxc/->node xt-map)
        txtl (pxc/entity-with-sys-from node :text-layers text-layer-id)
        prj-id (:text-layer/project txtl)
        {:token-layer/keys [name id] :as record}
        (-> (clojure.core/merge (pxc/new-record "token-layer" id)
                               {:token-layer/span-layers []
                                :token-layer/text-layer text-layer-id
                                :token-layer/project prj-id}
                               (select-keys attrs attr-keys))
            (update :config pxc/serialize-config))]
    (pxc/valid-name? name)
    (when (pxc/entity node :token-layers id)
      (throw (ex-info (pxc/err-msg-already-exists "Token layer" id) {:id id :code 409})))
    (when (nil? (:text-layer/id txtl))
      (throw (ex-info (pxc/err-msg-not-found "Text layer" text-layer-id) {:id text-layer-id :code 400})))
    [(pxc/match* :text-layers txtl)
     [:put-docs :text-layers (-> txtl
                                 (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                                 (update :text-layer/token-layers conj id))]
     [:put-docs :token-layers record]]))

(defn create-operation [xt-map attrs text-layer-id]
  (let [{:token-layer/keys [name]} attrs
        tx-ops (create* xt-map attrs text-layer-id)
        ;; project-id is now stored in the record we just built
        prj-id (:token-layer/project (nth (last tx-ops) 2))]
    (op/make-operation
     {:type :token-layer/create
      :project prj-id
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
                           (select-keys m [:token-layer/name]))]
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

(defn- delete*-impl
  "Delete a token-layer given a pre-fetched entity (with sys-from). Does NOT remove ref from parent."
  [node tokl]
  (let [eid (:xt/id tokl)
        span-layer-ids (:token-layer/span-layers tokl)
        ;; Flatten span-layer cascade: batch across all span-layers
        sl-entities (pxc/entities-with-sys-from node :span-layers span-layer-ids)
        all-rl-ids (vec (mapcat :span-layer/relation-layers sl-entities))
        rl-entities (pxc/entities-with-sys-from node :relation-layers all-rl-ids)
        ;; All relations across all relation-layers (1 query)
        all-relations (if (empty? all-rl-ids) []
                        (let [ph (str/join ", " (repeat (count all-rl-ids) "?"))]
                          (xt/q node (into [(str "SELECT *, _system_from FROM relations"
                                                 " WHERE relation$layer IN (" ph ")")]
                                           all-rl-ids))))
        ;; All spans across all span-layers (1 query)
        all-spans (if (empty? span-layer-ids) []
                    (let [ph (str/join ", " (repeat (count span-layer-ids) "?"))]
                      (xt/q node (into [(str "SELECT *, _system_from FROM spans"
                                              " WHERE span$layer IN (" ph ")")]
                                        span-layer-ids))))
        ;; Tokens + vocab-links
        tokens (pxc/find-entities-with-sys-from node :tokens {:token/layer eid})
        token-ids (mapv :xt/id tokens)
        vl-entities (if (empty? token-ids)
                      []
                      (let [ph (str/join ", " (repeat (count token-ids) "?"))]
                        (xt/q node (into [(str "SELECT *, _system_from FROM vocab_links vl, UNNEST(vl.vocab_link$tokens) AS t(tid)"
                                               " WHERE t.tid IN (" ph ")")]
                                         token-ids))))
        vl-by-id (into {} (map (juxt :xt/id identity) vl-entities))]
    (reduce into
            [(pxc/batch-delete-ops :vocab-links (vals vl-by-id))
             (pxc/batch-delete-ops :relations all-relations)
             (pxc/batch-delete-ops :relation-layers rl-entities)
             (pxc/batch-delete-ops :spans all-spans)
             (pxc/batch-delete-ops :span-layers sl-entities)
             (pxc/batch-delete-ops :tokens tokens)
             [(pxc/match* :token-layers tokl)
              [:delete-docs :token-layers eid]]])))

(defn delete*
  "Delete a token-layer and all its span-layers, tokens, and vocab-links. Does NOT remove ref from parent."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        tokl (pxc/entity-with-sys-from node :token-layers eid)]
    (when (nil? (:token-layer/id tokl))
      (throw (ex-info (pxc/err-msg-not-found "Token layer" eid) {:code 404})))
    (delete*-impl node tokl)))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        tokl (pxc/entity node :token-layers eid)
        prj-id (:token-layer/project tokl)
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
