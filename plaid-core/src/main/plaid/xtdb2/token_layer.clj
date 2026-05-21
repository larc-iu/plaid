(ns plaid.xtdb2.token-layer
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.span-layer :as sl]
            [plaid.xtdb2.constraints.token :as tc])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/span-layers
                :token-layer/overlap-mode
                :token-layer/parent-token-layer
                :config])

;; Queries ------------------------------------------------------------------------

(defn get [node-or-map id]
  (when-let [e (pxc/entity node-or-map :token-layers id)]
    (when (:token-layer/id e)
      (-> (select-keys e attr-keys)
          (update :token-layer/overlap-mode #(or % :any))
          (pxc/deserialize-config)))))

(defn- parent-id [node tokl-id]
  (:token-layer/text-layer (pxc/entity node :token-layers tokl-id)))

(defn project-id [node-or-map id]
  (:token-layer/project (pxc/entity node-or-map :token-layers id)))

;; Single source of truth lives in the constraint layer (used heavily in the
;; enforce hot path); delegate so the default-:any logic isn't duplicated.
(defn overlap-mode [node-or-map id]
  (tc/layer-overlap-mode node-or-map id))

(defn sort-token-records [tokens]
  (->> tokens
       (sort-by #(or (:token/precedence %) 0) <)
       (sort-by :token/begin)))

;; Mutations ----------------------------------------------------------------------

(def valid-overlap-modes #{:any :non-overlapping :partitioning})

(defn create* [xt-map {:token-layer/keys [id] :as attrs} text-layer-id]
  (let [node (pxc/->node xt-map)
        txtl (pxc/entity-with-sys-from node :text-layers text-layer-id)
        prj-id (:text-layer/project txtl)
        overlap-mode (or (:token-layer/overlap-mode attrs) :any)
        _ (when-not (valid-overlap-modes overlap-mode)
            (throw (ex-info (str "Invalid overlap-mode: " overlap-mode
                                 ". Must be one of: " (str/join ", " (map name valid-overlap-modes)))
                            {:overlap-mode overlap-mode :code 400})))
        ;; Optional parent token layer (immutable; child tokens must nest within parent tokens)
        parent-tl-id (:token-layer/parent-token-layer attrs)
        parent-tl (when parent-tl-id (pxc/entity-with-sys-from node :token-layers parent-tl-id))
        _ (when parent-tl-id
            (cond
              ;; Partitioning is only meaningful for a layer that tiles the whole
              ;; text — a root layer. On a nested layer it would only ever tile
              ;; "each parent token", an invariant that is leaky (un-segmented
              ;; parents) and not cleanly maintainable, so it is disallowed.
              (= :partitioning overlap-mode)
              (throw (ex-info (str "A nested token layer may not use overlap-mode :partitioning"
                                   " (partitioning is only allowed on root token layers).")
                              {:overlap-mode overlap-mode :parent-token-layer parent-tl-id :code 400}))
              (nil? (:token-layer/id parent-tl))
              (throw (ex-info (pxc/err-msg-not-found "Parent token layer" parent-tl-id)
                              {:id parent-tl-id :code 400}))
              ;; Same text layer ⇒ same text body (so offset containment is meaningful) and same project
              (not= (:token-layer/text-layer parent-tl) text-layer-id)
              (throw (ex-info "Parent token layer must belong to the same text layer as this layer."
                              {:parent-token-layer parent-tl-id :code 400}))
              ;; Parent tokens must be disjoint so each child has at most one
              ;; containing parent (offset-derived containment is otherwise
              ;; ambiguous). Only the disjoint modes qualify; :any (incl. the
              ;; nil default) is rejected.
              (not (#{:non-overlapping :partitioning} (:token-layer/overlap-mode parent-tl)))
              (throw (ex-info (str "Parent token layer must be :non-overlapping or :partitioning"
                                   " (a parent's tokens must be disjoint so child containment is unambiguous).")
                              {:parent-token-layer parent-tl-id
                               :parent-overlap-mode (:token-layer/overlap-mode parent-tl)
                               :code 400}))))
        {:token-layer/keys [name id] :as record}
        (-> (clojure.core/merge (pxc/new-record "token-layer" id)
                                {:token-layer/span-layers []
                                 :token-layer/text-layer text-layer-id
                                 :token-layer/project prj-id
                                 :token-layer/overlap-mode overlap-mode}
                                (select-keys attrs attr-keys))
            (update :config pxc/serialize-config))]
    (pxc/valid-name? name)
    (when (pxc/entity node :token-layers id)
      (throw (ex-info (pxc/err-msg-already-exists "Token layer" id) {:id id :code 409})))
    (when (nil? (:text-layer/id txtl))
      (throw (ex-info (pxc/err-msg-not-found "Text layer" text-layer-id) {:id text-layer-id :code 400})))
    ;; NB: keep [:put-docs :token-layers record] LAST — create's get-extra reads
    ;; (-> tx-ops last last :xt/id) to return the new layer id. Parent match* goes first.
    (vec (concat (when parent-tl [(pxc/match* :token-layers parent-tl)])
                 [(pxc/match* :text-layers txtl)
                  [:put-docs :text-layers (-> txtl
                                              (pxc/strip-temporal)
                                              (update :text-layer/token-layers conj id))]
                  [:put-docs :token-layers record]]))))

(defn create-operation [xt-map attrs text-layer-id]
  (let [{:token-layer/keys [name]} attrs
        tx-ops (create* xt-map attrs text-layer-id)
        prj-id (:text-layer/project (pxc/entity xt-map :text-layers text-layer-id))]
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

(defn- delete-layers*-impl
  "Delete a SET of token-layers (pre-fetched entities, with sys-from) and ALL their
  data — span-layers, relation-layers, spans, relations, tokens, and the vocab-links
  referencing those tokens — batched across the whole set (deduped via IN queries).
  Does NOT remove the layers' refs from their text-layer. Callers pass the target
  layer plus its descendant token-layers so a hierarchy is torn down atomically."
  [node tokls]
  (let [tokl-ids (mapv :xt/id tokls)
        span-layer-ids (vec (mapcat :token-layer/span-layers tokls))
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
        ;; All tokens across all token-layers (1 query)
        all-tokens (if (empty? tokl-ids) []
                       (let [ph (str/join ", " (repeat (count tokl-ids) "?"))]
                         (xt/q node (into [(str "SELECT *, _system_from FROM tokens"
                                                " WHERE token$layer IN (" ph ")")]
                                          tokl-ids))))
        token-ids (mapv :xt/id all-tokens)
        ;; All vocab-links referencing any of those tokens (1 query; deduped by id —
        ;; a multi-token link spanning two deleted layers is removed once)
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
             (pxc/batch-delete-ops :tokens all-tokens)
             (pxc/batch-delete-ops :token-layers tokls)])))

(defn delete*
  "Delete a token-layer, all its DESCENDANT token-layers (transitive children in the
  parent-token-layer hierarchy), and all of their span-layers, tokens, spans,
  relations, and vocab-links. Cascading to child layers is required: a nested layer
  derives containment from its parent layer, so leaving one behind would orphan its
  tokens (un-editable) and dangle its parent ref. Does NOT remove refs from the
  text-layer (see delete-operation)."
  [xt-map eid]
  (let [node (pxc/->node xt-map)
        tokl (pxc/entity-with-sys-from node :token-layers eid)]
    (when (nil? (:token-layer/id tokl))
      (throw (ex-info (pxc/err-msg-not-found "Token layer" eid) {:code 404})))
    (let [descendant-ids (tc/descendant-layer-ids node eid)
          descendant-entities (pxc/entities-with-sys-from node :token-layers descendant-ids)]
      (delete-layers*-impl node (into [tokl] descendant-entities)))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        tokl (pxc/entity node :token-layers eid)
        prj-id (:token-layer/project tokl)
        txtl-id (parent-id node eid)
        txtl (pxc/entity-with-sys-from node :text-layers txtl-id)
        ;; the delete cascades to descendant token-layers; unlink ALL of them from
        ;; the text-layer's token-layers list (each token-layer, nested or not, is
        ;; listed there) so no dangling id is left behind
        descendant-ids (tc/descendant-layer-ids node eid)
        deleted-ids (set (cons eid descendant-ids))
        base-tx (delete* xt-map eid)
        unlink-tx [(pxc/match* :text-layers txtl)
                   [:put-docs :text-layers (-> txtl
                                               (pxc/strip-temporal)
                                               (update :text-layer/token-layers
                                                       (fn [ids] (vec (remove deleted-ids ids)))))]]
        all-tx (into base-tx unlink-tx)]
    (op/make-operation
     {:type :token-layer/delete
      :project prj-id
      :document nil
      :description (str "Delete token layer " eid
                        (when (seq descendant-ids)
                          (str " (cascading to " (count descendant-ids) " child token layer(s))")))
      :tx-ops all-tx})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))
