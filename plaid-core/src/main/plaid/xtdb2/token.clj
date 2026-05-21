(ns plaid.xtdb2.token
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.span :as s]
            [plaid.xtdb2.metadata :as metadata]
            [plaid.xtdb2.constraints.token :as tc])
  (:refer-clojure :exclude [get merge format]))

(def attr-keys [:token/id
                :token/text
                :token/begin
                :token/end
                :token/layer
                :token/precedence])

;; Queries ------------------------------------------------------------------------

(defn format [raw-record]
  (let [core-attrs (select-keys raw-record attr-keys)]
    (metadata/add-metadata-to-response core-attrs raw-record "token")))

(defn get [node-or-map id]
  (when-let [e (pxc/entity node-or-map :tokens id)]
    (when (:token/id e)
      (format e))))

(defn project-id [node-or-map id]
  (when-let [tokl-id (:token/layer (pxc/entity node-or-map :tokens id))]
    (:token-layer/project (pxc/entity node-or-map :token-layers tokl-id))))

(defn- project-id-from-layer [node layer-id]
  (:token-layer/project (pxc/entity node :token-layers layer-id)))

(defn get-tokens [node-or-map layer-id doc-id]
  (let [tokens (pxc/find-entities node-or-map :tokens {:token/layer layer-id :token/document doc-id})]
    (if-not (seq tokens)
      []
      (when-let [{:text/keys [body]} (pxc/entity node-or-map :texts (:token/text (first tokens)))]
        (map #(assoc % :token/value (subs body (:token/begin %) (:token/end %))) tokens)))))

(defn get-span-ids [node-or-map eid]
  (->> (xt/q (pxc/->node node-or-map)
             (xt/template
              (-> (from :spans [{:xt/id sid :span/tokens toks}])
                  (unnest {:t toks})
                  (where (= t ~eid))
                  (return sid))))
       (map :sid)))

(defn get-doc-id-of-text [node-or-map text-id]
  (:text/document (pxc/entity node-or-map :texts text-id)))

;; Mutations ----------------------------------------------------------------------

(defn- check-token-bounds! [begin end text-body]
  (cond
    (or (not (int? end)) (not (int? begin)))
    (throw (ex-info "Token end and begin must be numeric" {:end end :begin begin :code 400}))
    (neg? (- end begin))
    (throw (ex-info "Token has non-positive extent" {:begin begin :end end :code 400}))
    (< begin 0)
    (throw (ex-info "Token has a negative start index" {:begin begin :code 400}))
    (> end (count text-body))
    (throw (ex-info "Token ends beyond the end of its associated text"
                    {:end end :text-length (count text-body) :code 400}))))

(defn- check-token-precedence! [precedence]
  (when-not (or (nil? precedence) (int? precedence))
    (throw (ex-info "Precedence must either be not supplied or an integer."
                    {:code 400 :precedence precedence}))))

(defn- check-tokens-consistency! [tokens-attrs]
  (when-not (= 1 (->> tokens-attrs (map :token/text) distinct count))
    (throw (ex-info "Tokens must all belong to the same text" {:code 400})))
  (when-not (= 1 (->> tokens-attrs (map :token/layer) distinct count))
    (throw (ex-info "Tokens must all belong to the same layer" {:code 400}))))

(defn schema-check!
  ([node token] (schema-check! node token false))
  ([node {:token/keys [id end begin text layer precedence] :as token} token-only?]
   (let [{text-body :text/body text-layer-id :text/layer :as text-record}
         (pxc/entity node :texts text)
         {token-layers :text-layer/token-layers}
         (pxc/entity node :text-layers text-layer-id)]
     (when (pxc/entity node :tokens id)
       (throw (ex-info (pxc/err-msg-already-exists "Token" id) {:id id :code 409})))
     (when (and (not token-only?) (nil? (:token-layer/id (pxc/entity node :token-layers layer))))
       (throw (ex-info (pxc/err-msg-not-found "Token layer" layer) {:id layer :code 400})))
     (when (and (not token-only?) (nil? (:text/id text-record)))
       (throw (ex-info (pxc/err-msg-not-found "Text" text) {:id text :code 400})))
     (when (and (not token-only?) (not (some #{layer} token-layers)))
       (throw (ex-info (str "Text layer " text-layer-id " is not linked to token layer " layer ".")
                       {:text-layer-id text-layer-id :token-layer-id layer})))
     (check-token-bounds! begin end text-body)
     (check-token-precedence! precedence))))

(defn- token-attr? [k]
  (= "token" (namespace k)))

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        token-attrs (filter (fn [[k _]] (token-attr? k)) attrs)
        {:token/keys [text layer begin end] :as token}
        (clojure.core/merge (pxc/new-record "token")
                            {:token/document (get-doc-id-of-text node (:token/text attrs))}
                            (into {} token-attrs))
        text-e (pxc/entity-with-sys-from node :texts text)
        layer-e (pxc/entity-with-sys-from node :token-layers layer)]
    (schema-check! node token)
    [(pxc/match* :token-layers layer-e)
     (pxc/match* :texts text-e)
     [:put-docs :tokens token]]))

(defn create-operation [xt-map attrs metadata]
  (let [node (pxc/->node xt-map)
        {:token/keys [layer text begin end]} attrs
        doc-id (get-doc-id-of-text node text)
        meta-attrs (metadata/transform-metadata-for-storage metadata "token")
        attrs-with-meta (clojure.core/merge attrs meta-attrs)
        base-ops (create* xt-map attrs-with-meta)
        tx-ops (tc/enforce :create node
                           {:layer layer :doc-id doc-id :begin begin :end end}
                           base-ops)]
    (op/make-operation
     {:type :token/create
      :project (project-id-from-layer node layer)
      :document doc-id
      :description (str "Create token " begin "-" end " in layer " layer)
      :tx-ops tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata)] user-id
                       (fn [ops] (->> ops
                                      (some #(when (and (vector? %) (= :put-docs (first %)) (= :tokens (second %)))
                                               (:xt/id (nth % 2)))))))))

(defn- set-extent [node eid {new-begin :token/begin new-end :token/end}]
  (let [{:token/keys [begin end text] :as token} (pxc/entity node :tokens eid)
        new-begin (or new-begin begin)
        new-end (or new-end end)
        {text-body :text/body} (pxc/entity node :texts text)]
    (when (nil? token)
      (throw (ex-info "Token does not exist" {:id eid :code 404})))
    (check-token-bounds! new-begin new-end text-body)
    {:token/begin new-begin :token/end new-end}))

(defn- set-precedence [node eid precedence]
  (let [token (pxc/entity node :tokens eid)]
    (when (nil? token)
      (throw (ex-info "Token does not exist" {:id eid :code 404})))
    (check-token-precedence! precedence)
    (if (nil? precedence) {} {:token/precedence precedence})))

(defn merge* [xt-map eid attrs]
  (let [node (pxc/->node xt-map)
        {text-id :token/text} (pxc/entity node :tokens eid)
        extent-attrs (set-extent node eid (select-keys attrs [:token/begin :token/end]))
        prec-attrs (set-precedence node eid (:token/precedence attrs))
        text-e (pxc/entity-with-sys-from node :texts text-id)
        merge-ops (pxc/merge* xt-map :tokens :token/id eid (clojure.core/merge extent-attrs prec-attrs))
        base (into [(pxc/match* :texts text-e)] merge-ops)]
    (if (and (contains? attrs :token/precedence) (nil? (:token/precedence attrs)))
      ;; Remove precedence key from the :put-docs op's record map
      (mapv (fn [op]
              (if (and (vector? op) (= :put-docs (first op)))
                (update op 2 dissoc :token/precedence)
                op))
            base)
      base)))

(declare resize-child-cascade*)

(defn merge-operation [xt-map eid attrs]
  (let [node (pxc/->node xt-map)
        {:token/keys [begin end layer document]} (pxc/entity node :tokens eid)
        new-begin (or (:token/begin attrs) begin)
        new-end (or (:token/end attrs) end)
        extents-changing? (or (contains? attrs :token/begin) (contains? attrs :token/end))
        base-ops (merge* xt-map eid attrs)
        ;; a direct extent change cascades to nested descendants, same as shift.
        ;; Resolve descendant layers once (only when extents change) and reuse for
        ;; both the cascade and enforce's parent-side guard.
        dlids (when extents-changing? (tc/descendant-layer-ids node layer))
        cascade-ops (if extents-changing?
                      (resize-child-cascade* xt-map dlids layer document begin end new-begin new-end)
                      [])
        tx-ops (tc/enforce :update node
                           {:layer layer :doc-id document :eid eid
                            :begin begin :end end
                            :new-begin new-begin :new-end new-end
                            :extents-changing? extents-changing?
                            :dlids dlids}
                           (into (vec base-ops) cascade-ops))
        changes (cond-> []
                  (contains? attrs :token/begin) (conj "start")
                  (contains? attrs :token/end) (conj "end")
                  (contains? attrs :token/precedence) (conj "precedence"))]
    (op/make-operation
     {:type :token/update
      :project (project-id xt-map eid)
      :document document
      :description (str "Update " (clojure.string/join ", " changes) " of token " eid)
      :tx-ops tx-ops})))

(defn merge [xt-map eid attrs user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid attrs)] user-id))

(defn set-metadata [xt-map eid metadata user-id]
  (metadata/set-metadata xt-map eid metadata user-id "token" project-id :token/document))

(defn delete-metadata [xt-map eid user-id]
  (metadata/delete-metadata xt-map eid user-id "token" project-id :token/document))

;; Single-token delete is just multi-delete* of one id (declared below); see
;; multi-delete* for the span/relation/vocab-link cascade.
(declare multi-delete*)

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        t (pxc/entity node :tokens eid)
        doc-id (when t (:token/document t))
        ;; Cascade: deleting a parent token deletes all descendant tokens nested in
        ;; it (and, via multi-delete*, their spans/relations/vocab-links) — same
        ;; "delete dependents that can no longer validly exist" pattern as token→span.
        dlids (when t (tc/descendant-layer-ids node (:token/layer t)))
        descendant-ids (when t (tc/descendant-token-ids-in-extent
                                node dlids doc-id
                                (:token/begin t) (:token/end t)))
        base-ops (multi-delete* xt-map (cons eid descendant-ids))
        tx-ops (tc/enforce :delete node {:layer (when t (:token/layer t))
                                         :doc-id doc-id
                                         :begin (:token/begin t) :end (:token/end t)
                                         :dlids dlids}
                           base-ops)]
    (op/make-operation
     {:type :token/delete
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Delete token " eid
                        (when (seq descendant-ids)
                          (str " (cascading to " (count descendant-ids) " nested token(s))")))
      :tx-ops tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn multi-delete* [xt-map eids]
  (let [node (pxc/->node xt-map)
        eids-set (set eids)
        ;; Batch-fetch all tokens with sys-from (1 query)
        token-map (pxc/entities-with-sys-from-by-id node :tokens eids)
        ;; Find all spans containing any of these tokens (1 query using SQL IN)
        placeholders (str/join ", " (repeat (count eids) "?"))
        all-spans (when (seq eids)
                    (xt/q node (into [(str "SELECT *, _system_from FROM spans s, UNNEST(s.span$tokens) AS t(tid)"
                                           " WHERE t.tid IN (" placeholders ")")]
                                     eids)))
        ;; Deduplicate spans (a span may match multiple tokens). Drop the `:tid`
        ;; column the UNNEST alias adds — otherwise the span-update branch would
        ;; persist it (a stray, now-deleted token id) back onto the surviving span.
        span-by-id (into {} (map (juxt :xt/id #(dissoc % :tid))) all-spans)
        span-updates (mapv (fn [span]
                             (let [remaining (vec (remove eids-set (:span/tokens span)))]
                               {:span span
                                :remaining remaining
                                :should-delete? (empty? remaining)}))
                           (vals span-by-id))
        spans-to-delete (filter :should-delete? span-updates)
        spans-to-update (remove :should-delete? span-updates)
        span-ids-to-delete (set (map #(-> % :span :xt/id) spans-to-delete))
        ;; Find all relations referencing deleted spans (1 query using SQL IN + OR)
        rels-to-delete (if (empty? span-ids-to-delete)
                         []
                         (let [ph (str/join ", " (repeat (count span-ids-to-delete) "?"))
                               sids (vec span-ids-to-delete)]
                           (->> (xt/q node (into [(str "SELECT *, _system_from FROM relations"
                                                       " WHERE relation$source IN (" ph ")"
                                                       " OR relation$target IN (" ph ")")]
                                                 (concat sids sids)))
                                (into {} (map (juxt :xt/id identity)))
                                vals)))
        ;; Find all vocab-links for these tokens (1 query using SQL IN)
        vl-entities (if (empty? eids)
                      []
                      (xt/q node (into [(str "SELECT *, _system_from FROM vocab_links vl, UNNEST(vl.vocab_link$tokens) AS t(tid)"
                                             " WHERE t.tid IN (" placeholders ")")]
                                       eids)))
        ;; Drop the UNNEST `:tid` alias — we now re-put trimmed vocab-links (like
        ;; spans), so a stray deleted-token id must not be persisted onto them.
        vl-by-id (into {} (map (juxt :xt/id #(dissoc % :tid))) vl-entities)
        vl-updates (mapv (fn [vl]
                           (let [remaining (vec (remove eids-set (:vocab-link/tokens vl)))]
                             {:vl vl :remaining remaining :should-delete? (empty? remaining)}))
                         (vals vl-by-id))
        vls-to-delete (filter :should-delete? vl-updates)
        vls-to-update (remove :should-delete? vl-updates)]
    (vec
     (concat
      ;; Trim vocab-links to their remaining tokens (delete only those left empty),
      ;; mirroring the span handling below.
      (mapcat (fn [{:keys [vl remaining]}]
                [(pxc/match* :vocab-links vl)
                 [:put-docs :vocab-links (-> vl (pxc/strip-temporal) (assoc :vocab-link/tokens remaining))]])
              vls-to-update)
      (pxc/batch-delete-ops :vocab-links (map :vl vls-to-delete))
      ;; Delete tokens
      (mapcat (fn [eid]
                (when-let [te (clojure.core/get token-map eid)]
                  (when (:token/id te)
                    [(pxc/match* :tokens te) [:delete-docs :tokens eid]])))
              eids)
      ;; Update spans with remaining tokens
      (mapcat (fn [{:keys [span remaining]}]
                (let [se (clojure.core/get span-by-id (:xt/id span))]
                  [(pxc/match* :spans se)
                   [:put-docs :spans (-> se
                                         (pxc/strip-temporal)
                                         (assoc :span/tokens remaining))]]))
              spans-to-update)
      ;; Delete spans with no remaining tokens
      (mapcat (fn [{:keys [span]}]
                (let [se (clojure.core/get span-by-id (:xt/id span))]
                  [(pxc/match* :spans se) [:delete-docs :spans (:xt/id span)]]))
              spans-to-delete)
      ;; Delete relations referencing deleted spans
      (mapcat (fn [re]
                (when (:relation/id re)
                  [(pxc/match* :relations re) [:delete-docs :relations (:xt/id re)]]))
              rels-to-delete)))))

(defn bulk-create* [xt-map tokens-attrs]
  (let [node (pxc/->node xt-map)
        layer (-> tokens-attrs first :token/layer)
        layer-e (pxc/entity-with-sys-from node :token-layers layer)
        text (-> tokens-attrs first :token/text)
        text-e (pxc/entity-with-sys-from node :texts text)
        text-body (:text/body text-e)
        text-layer-id (:text/layer text-e)
        {token-layers :text-layer/token-layers :as text-layer-e}
        (pxc/entity node :text-layers text-layer-id)
        doc-id (:text/document text-e)
        project-id (:text-layer/project text-layer-e)
        tokens-attrs (for [attrs tokens-attrs]
                       (if-let [metadata (:metadata attrs)]
                         (clojure.core/merge (dissoc attrs :metadata)
                                             (metadata/transform-metadata-for-storage metadata "token"))
                         (dissoc attrs :metadata)))]
    (check-tokens-consistency! tokens-attrs)
    ;; Validate layer/text existence and linkage once
    (when (nil? layer-e)
      (throw (ex-info (pxc/err-msg-not-found "Token layer" layer) {:id layer :code 400})))
    (when (nil? (:text/id text-e))
      (throw (ex-info (pxc/err-msg-not-found "Text" text) {:id text :code 400})))
    (when-not (some #{layer} token-layers)
      (throw (ex-info (str "Text layer " text-layer-id " is not linked to token layer " layer ".")
                      {:text-layer-id text-layer-id :token-layer-id layer})))
    ;; Build token records
    (let [token-records
          (mapv (fn [attrs]
                  (let [token-attrs (filter (fn [[k _]] (token-attr? k)) attrs)
                        {:token/keys [id begin end precedence] :as token}
                        (clojure.core/merge (pxc/new-record "token")
                                            {:token/document doc-id}
                                            (into {} token-attrs))]
                    (check-token-bounds! begin end text-body)
                    (check-token-precedence! precedence)
                    token))
                tokens-attrs)]
      {:tx-ops
       (vec
        (concat
         [(pxc/match* :token-layers layer-e)
          (pxc/match* :texts text-e)]
         (mapv (fn [token] [:put-docs :tokens token]) token-records)))
       :doc-id doc-id
       :project-id project-id})))

(defn bulk-create-operation [xt-map tokens-attrs]
  (let [node (pxc/->node xt-map)
        layer-id (-> tokens-attrs first :token/layer)
        text-id (-> tokens-attrs first :token/text)
        text-body (:text/body (pxc/entity node :texts text-id))
        {:keys [tx-ops doc-id project-id]} (bulk-create* xt-map tokens-attrs)
        tx-ops (tc/enforce :bulk-create node
                           {:layer layer-id :doc-id doc-id :text-length (count text-body)}
                           tx-ops)]
    (op/make-operation
     {:type :token/bulk-create
      :project project-id
      :document doc-id
      :description (str "Bulk create " (count tokens-attrs) " tokens in layer " layer-id)
      :tx-ops tx-ops})))

(defn bulk-create [xt-map tokens-attrs user-id]
  (submit-operations!
   xt-map
   [(bulk-create-operation xt-map tokens-attrs)]
   user-id
   (fn [entity-ops]
     (vec (for [[op-type _table record] entity-ops
                :when (and (= op-type :put-docs) (:token/id record))]
            (:token/id record))))))

(defn bulk-delete-operation [xt-map eids]
  (let [node (pxc/->node xt-map)
        token-map (pxc/entities-with-sys-from-by-id node :tokens eids)
        tokens-by-layer (group-by :token/layer (vals token-map))
        first-t (clojure.core/get token-map (first eids))
        doc-id (when first-t (:token/document first-t))
        ;; Cascade: each requested token also drags down its nested descendants.
        ;; Resolve descendant layers ONCE per distinct parent layer (was a BFS per
        ;; token), then reuse for every token in that layer.
        dlids-by-layer (into {} (map (fn [[lid _]] [lid (tc/descendant-layer-ids node lid)]))
                             tokens-by-layer)
        descendant-ids (mapcat (fn [t] (tc/descendant-token-ids-in-extent
                                        node (clojure.core/get dlids-by-layer (:token/layer t))
                                        (:token/document t)
                                        (:token/begin t) (:token/end t)))
                               (vals token-map))
        all-ids (distinct (concat eids descendant-ids))
        base-ops (multi-delete* xt-map all-ids)
        ;; enforce asserts (per requested token's extent) that no descendant slips in
        tx-ops (tc/enforce :bulk-delete node {:tokens-by-layer tokens-by-layer
                                              :dlids-by-layer dlids-by-layer} base-ops)]
    (op/make-operation
     {:type :token/bulk-delete
      :project (when first-t (project-id xt-map (first eids)))
      :document doc-id
      :description (str "Bulk delete " (count eids) " tokens"
                        (when (seq descendant-ids)
                          (str " (cascading to " (count (distinct descendant-ids)) " nested token(s))")))
      :tx-ops tx-ops})))

(defn bulk-delete [xt-map eids user-id]
  (submit-operations! xt-map [(bulk-delete-operation xt-map eids)] user-id))

;; ---------------------------------------------------------------------------
;; Split / Merge / Shift operations
;; ---------------------------------------------------------------------------

(defn- split-token-ops
  "Pure tx-op builder: split a pre-fetched token entity t (with :xt/system-from)
   at position, given its pre-fetched text entity text-e. Returns
   {:new-token-id .. :tx-ops ..}. Fetching is the caller's job so batch callers can
   read the token + text once (split* re-reads per call)."
  [t text-e position]
  (let [{:token/keys [begin end layer document text]} t]
    (when-not (and (int? position) (> position begin) (< position end))
      (throw (ex-info "Split position must be strictly between token begin and end"
                      {:code 400 :position position :begin begin :end end})))
    (let [new-id (random-uuid)
          left-token (-> t
                         (pxc/strip-temporal)
                         (assoc :token/end position))
          right-token (-> (pxc/new-record "token" new-id)
                          (assoc :token/begin position
                                 :token/end end
                                 :token/text text
                                 :token/layer layer
                                 :token/document document))]
      {:new-token-id new-id
       :tx-ops [(pxc/match* :tokens t)
                (pxc/match* :texts text-e)
                [:put-docs :tokens left-token]
                [:put-docs :tokens right-token]]})))

(defn split* [xt-map token-id position]
  (let [node (pxc/->node xt-map)
        t (pxc/entity-with-sys-from node :tokens token-id)]
    (when (nil? (:token/id t))
      (throw (ex-info (pxc/err-msg-not-found "Token" token-id) {:code 404 :id token-id})))
    (split-token-ops t (pxc/entity-with-sys-from node :texts (:token/text t)) position)))

(defn- split-straddlers*
  "tx-ops splitting each token in straddler-ids at position, batching the token +
   text reads (split* re-reads the text per call → an N+1 across a cascade)."
  [xt-map straddler-ids position]
  (if (empty? straddler-ids)
    []
    (let [node (pxc/->node xt-map)
          token-map (pxc/entities-with-sys-from-by-id node :tokens straddler-ids)
          text-ids (distinct (keep :token/text (vals token-map)))
          text-map (into {} (map (fn [tid] [tid (pxc/entity-with-sys-from node :texts tid)])) text-ids)]
      (vec (mapcat (fn [tid]
                     (let [t (clojure.core/get token-map tid)]
                       (when (:token/id t)
                         (:tx-ops (split-token-ops t (clojure.core/get text-map (:token/text t)) position)))))
                   straddler-ids)))))

(defn split-operation [xt-map token-id position]
  (let [node (pxc/->node xt-map)
        t (pxc/entity node :tokens token-id)
        doc-id (when t (:token/document t))
        ;; split* throws 404 if the token is missing, so t exists past this point
        {:keys [tx-ops new-token-id]} (split* xt-map token-id position)
        ;; Cascade: also split every descendant token that straddles the position,
        ;; so the split never orphans a nested child (their parent re-derives by
        ;; offset). Splitting at the same position keeps containment and per-parent
        ;; tiling intact at every level.
        dlids (tc/descendant-layer-ids node (:token/layer t))
        straddler-ids (tc/straddling-descendant-token-ids-in
                       node dlids doc-id
                       (:token/begin t) (:token/end t) position)
        cascade-tx (split-straddlers* xt-map straddler-ids position)
        ;; parent-side guard appends a TOCTOU no-straddler assert over descendants
        tx-ops (tc/enforce :split node
                           {:layer (:token/layer t) :doc-id doc-id
                            :begin (:token/begin t) :end (:token/end t)
                            :position position
                            :dlids dlids}
                           (into (vec tx-ops) cascade-tx))]
    {:operation (op/make-operation
                 {:type :token/split
                  :project (project-id xt-map token-id)
                  :document doc-id
                  :description (str "Split token " token-id " at position " position)
                  :tx-ops tx-ops})
     :new-token-id new-token-id}))

(defn split [xt-map token-id position user-id]
  (submit-operations! xt-map
                      (let [{:keys [operation]} (split-operation xt-map token-id position)]
                        [operation])
                      user-id
                      (fn [entity-ops]
      ;; Find the new (right half) token ID - it's the put-docs with a different ID
                        (some (fn [[op-type _table record]]
                                (when (and (= op-type :put-docs) (:token/id record)
                                           (not= (:xt/id record) token-id))
                                  (:xt/id record)))
                              entity-ops))))

(defn merge-tokens* [xt-map token-id-1 token-id-2]
  (let [node (pxc/->node xt-map)
        t1 (pxc/entity-with-sys-from node :tokens token-id-1)
        t2 (pxc/entity-with-sys-from node :tokens token-id-2)]
    (when (nil? (:token/id t1))
      (throw (ex-info (pxc/err-msg-not-found "Token" token-id-1) {:code 404 :id token-id-1})))
    (when (nil? (:token/id t2))
      (throw (ex-info (pxc/err-msg-not-found "Token" token-id-2) {:code 404 :id token-id-2})))
    ;; Must be same layer and document
    (when (not= (:token/layer t1) (:token/layer t2))
      (throw (ex-info "Tokens must belong to the same layer" {:code 400})))
    (when (not= (:token/document t1) (:token/document t2))
      (throw (ex-info "Tokens must belong to the same document" {:code 400})))
    ;; Determine left/right by begin
    (let [[left right] (if (<= (:token/begin t1) (:token/begin t2)) [t1 t2] [t2 t1])
          left-id (:xt/id left)
          right-id (:xt/id right)
          layer-id (:token/layer left)]
      ;; Merged token: left survives with expanded extent
      (let [merged-token (-> left
                             (pxc/strip-temporal)
                             (assoc :token/begin (min (:token/begin left) (:token/begin right))
                                    :token/end (max (:token/end left) (:token/end right))))
            ;; Find spans referencing the right token and reparent to left
            right-span-ids (get-span-ids node right-id)
            span-map (pxc/entities-with-sys-from-by-id node :spans right-span-ids)
            span-reparent-ops
            (vec (mapcat (fn [[_sid span]]
                           (let [new-tokens (mapv #(if (= % right-id) left-id %) (:span/tokens span))
                                 ;; Deduplicate if left was already in span
                                 new-tokens (vec (distinct new-tokens))]
                             [(pxc/match* :spans span)
                              [:put-docs :spans (-> span
                                                    (pxc/strip-temporal)
                                                    (assoc :span/tokens new-tokens))]]))
                         span-map))
            ;; Reparent vocab-links referencing right token
            vl-entities (->> (xt/q node (xt/template
                                         (-> (from :vocab-links [{:xt/id vlid :vocab-link/tokens toks}])
                                             (unnest {:t toks})
                                             (where (= t ~right-id))
                                             (return vlid))))
                             (map :vlid))
            vl-map (pxc/entities-with-sys-from-by-id node :vocab-links vl-entities)
            vl-reparent-ops
            (vec (mapcat (fn [[_vlid vl]]
                           (let [new-tokens (mapv #(if (= % right-id) left-id %) (:vocab-link/tokens vl))
                                 new-tokens (vec (distinct new-tokens))]
                             [(pxc/match* :vocab-links vl)
                              [:put-docs :vocab-links (-> vl
                                                          (pxc/strip-temporal)
                                                          (assoc :vocab-link/tokens new-tokens))]]))
                         vl-map))
            text-e (pxc/entity-with-sys-from node :texts (:token/text left))]
        {:surviving-id left-id
         :tx-ops (reduce into
                         [[(pxc/match* :tokens left)
                           (pxc/match* :tokens right)
                           (pxc/match* :texts text-e)
                           [:put-docs :tokens merged-token]
                           [:delete-docs :tokens right-id]]
                          span-reparent-ops
                          vl-reparent-ops])}))))

(defn merge-tokens-operation [xt-map token-id-1 token-id-2]
  (let [node (pxc/->node xt-map)
        t1 (pxc/entity node :tokens token-id-1)
        t2 (pxc/entity node :tokens token-id-2)
        doc-id (when t1 (:token/document t1))
        ;; merge-tokens* throws 404 if either token is missing, so t1/t2 exist here
        {:keys [tx-ops surviving-id]} (merge-tokens* xt-map token-id-1 token-id-2)
        tx-ops (tc/enforce :merge node
                           {:layer (:token/layer t1) :doc-id doc-id
                            :t1 t1 :t2 t2 :surviving-id surviving-id}
                           tx-ops)]
    {:operation (op/make-operation
                 {:type :token/merge
                  :project (project-id xt-map token-id-1)
                  :document doc-id
                  :description (str "Merge tokens " token-id-1 " and " token-id-2)
                  :tx-ops tx-ops})
     :surviving-id surviving-id}))

(defn merge-tokens [xt-map token-id-1 token-id-2 user-id]
  (submit-operations! xt-map
                      (let [{:keys [operation]} (merge-tokens-operation xt-map token-id-1 token-id-2)]
                        [operation])
                      user-id
                      (fn [entity-ops]
      ;; Find the surviving token ID from the put-docs ops
                        (some (fn [[op-type _table record]]
                                (when (and (= op-type :put-docs) (:token/id record))
                                  (:xt/id record)))
                              entity-ops))))

(defn shift-boundary* [xt-map token-id attrs]
  (let [node (pxc/->node xt-map)
        t (pxc/entity-with-sys-from node :tokens token-id)]
    (when (nil? (:token/id t))
      (throw (ex-info (pxc/err-msg-not-found "Token" token-id) {:code 404 :id token-id})))
    (let [{:token/keys [begin end layer document text]} t
          new-begin (or (:token/begin attrs) begin)
          new-end (or (:token/end attrs) end)
          text-body (:text/body (pxc/entity node :texts text))
          _ (check-token-bounds! new-begin new-end text-body)
          text-e (pxc/entity-with-sys-from node :texts text)
          updated (-> t (pxc/strip-temporal) (assoc :token/begin new-begin :token/end new-end))]
      [(pxc/match* :tokens t)
       (pxc/match* :texts text-e)
       [:put-docs :tokens updated]])))

(defn- resize-child-cascade*
  "Cascade a parent token resize ([begin,end] → [nb,ne]) to its descendant tokens.
   - :partitioning parent (its neighbor grows to cover the freed region): split each
     descendant straddling a moved boundary so the outside half re-homes to the
     neighbor by offset containment.
   - non-overlapping / :any parent (no neighbor): delete descendants that retain no
     positive overlap with the new extent (left fully outside it, or collapsed when
     the parent shrinks to zero width) along with their dependents, and trim those
     straddling the new edge to fit.
   Descendants are processed across all levels by offset, so nesting stays valid at
   every depth. `dlids` (descendant layer ids) is precomputed by the caller and also
   threaded into `enforce` so the BFS runs once per op."
  [xt-map dlids layer doc-id begin end nb ne]
  (let [node (pxc/->node xt-map)]
    (cond
      (empty? dlids) []

      (= :partitioning (tc/layer-overlap-mode node layer))
      (let [moved (cond-> []
                    (not= nb begin) (conj nb)
                    (not= ne end) (conj ne))]
        ;; doc-wide scan: a partitioning parent is disjoint, so a moved boundary p
        ;; sits in exactly one parent pre-shift — this catches the straddler whether
        ;; we shrank (straddler is our child) or grew into the neighbor (its child).
        (vec (mapcat (fn [p]
                       (split-straddlers* xt-map
                                          (tc/straddling-descendant-token-ids-at node dlids doc-id p)
                                          p))
                     moved)))

      :else
      (let [descendants (tc/descendant-token-entities-in-extent node dlids doc-id begin end)
            ;; A descendant survives only if it keeps POSITIVE overlap with the new
            ;; extent. Clipped extent = [max(begin,nb), min(end,ne)]:
            ;;   lo >= hi  → no positive overlap (fully outside, or collapsed to
            ;;               zero when the parent itself shrinks to zero width) → delete
            ;;   unchanged → fully inside → keep untouched
            ;;   else      → straddles the new edge → trim to fit
            classify (fn [d]
                       (let [lo (max (:token/begin d) nb)
                             hi (min (:token/end d) ne)]
                         (cond
                           (>= lo hi) :delete
                           (and (= lo (:token/begin d)) (= hi (:token/end d))) :keep
                           :else :trim)))
            {to-delete :delete to-trim :trim} (group-by classify descendants)
            delete-tx (if (seq to-delete) (vec (multi-delete* xt-map (mapv :xt/id to-delete))) [])
            trim-tx (vec (mapcat (fn [d]
                                   [(pxc/match* :tokens d)
                                    [:put-docs :tokens (-> d
                                                           (pxc/strip-temporal)
                                                           (assoc :token/begin (max (:token/begin d) nb)
                                                                  :token/end (min (:token/end d) ne)))]])
                                 to-trim))]
        (into delete-tx trim-tx)))))

(defn shift-boundary-operation [xt-map token-id attrs]
  (let [node (pxc/->node xt-map)
        t (pxc/entity node :tokens token-id)
        doc-id (when t (:token/document t))
        {:token/keys [begin end layer text]} (or t {})
        new-begin (or (:token/begin attrs) begin)
        new-end (or (:token/end attrs) end)
        text-length (when text (count (:text/body (pxc/entity node :texts text))))
        ;; shift-boundary* throws 404 if the token is missing
        base-ops (shift-boundary* xt-map token-id attrs)
        ;; resolve descendant layers once; reuse for the cascade and enforce's guard
        dlids (when t (tc/descendant-layer-ids node layer))
        ;; cascade the resize to nested descendants (split-rebalance / trim+delete)
        cascade-ops (if t (resize-child-cascade* xt-map dlids layer doc-id begin end new-begin new-end) [])
        tx-ops (tc/enforce :shift node
                           {:layer layer :doc-id doc-id :token-id token-id
                            :begin begin :end end :new-begin new-begin :new-end new-end
                            :text-length text-length
                            :dlids dlids}
                           (into (vec base-ops) cascade-ops))]
    (op/make-operation
     {:type :token/shift-boundary
      :project (project-id xt-map token-id)
      :document doc-id
      :description (str "Shift boundary of token " token-id)
      :tx-ops tx-ops})))

(defn shift-boundary [xt-map token-id attrs user-id]
  (submit-operations! xt-map [(shift-boundary-operation xt-map token-id attrs)] user-id))
