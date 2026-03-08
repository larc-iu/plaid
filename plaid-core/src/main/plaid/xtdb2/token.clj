(ns plaid.xtdb2.token
  (:require [xtdb.api :as xt]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.span :as s]
            [plaid.xtdb2.metadata :as metadata]
            [taoensso.timbre :as log])
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
  (let [t (pxc/entity node-or-map :tokens id)
        txtl-id (when-let [tokl-id (:token/layer t)]
                  (:token-layer/text-layer (pxc/entity node-or-map :token-layers tokl-id)))]
    (when txtl-id
      (:text-layer/project (pxc/entity node-or-map :text-layers txtl-id)))))

(defn- project-id-from-layer [node layer-id]
  (let [txtl-id (:token-layer/text-layer (pxc/entity node :token-layers layer-id))]
    (when txtl-id
      (:text-layer/project (pxc/entity node :text-layers txtl-id)))))

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
        {:token/keys [text layer] :as token}
        (clojure.core/merge (pxc/new-record "token")
                            {:token/document (get-doc-id-of-text node (:token/text attrs))}
                            (into {} token-attrs))
        text-e (pxc/entity-with-sys-from node :texts text)
        layer-e (pxc/entity-with-sys-from node :token-layers layer)]
    (schema-check! node token)
    [[:sql "ASSERT NOT EXISTS (SELECT 1 FROM tokens WHERE _id = ?)" [(:xt/id token)]]
     (pxc/match* :token-layers layer-e)
     (pxc/match* :texts text-e)
     [:put-docs :tokens token]]))

(defn create-operation [xt-map attrs metadata]
  (let [node (pxc/->node xt-map)
        {:token/keys [layer text begin end]} attrs
        doc-id (get-doc-id-of-text node text)
        meta-attrs (metadata/transform-metadata-for-storage metadata "token")
        attrs-with-meta (clojure.core/merge attrs meta-attrs)
        tx-ops (create* xt-map attrs-with-meta)]
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
                       #(-> % last last :xt/id))))

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

(defn merge-operation [xt-map eid attrs]
  (let [node (pxc/->node xt-map)
        token (pxc/entity node :tokens eid)
        doc-id (:token/document token)
        changes (cond-> []
                  (contains? attrs :token/begin) (conj "start")
                  (contains? attrs :token/end) (conj "end")
                  (contains? attrs :token/precedence) (conj "precedence"))]
    (op/make-operation
     {:type :token/update
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Update " (clojure.string/join ", " changes) " of token " eid)
      :tx-ops (merge* xt-map eid attrs)})))

(defn merge [xt-map eid attrs user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid attrs)] user-id))

(defn set-metadata [xt-map eid metadata user-id]
  (metadata/set-metadata xt-map eid metadata user-id "token" project-id :token/document))

(defn delete-metadata [xt-map eid user-id]
  (metadata/delete-metadata xt-map eid user-id "token" project-id :token/document))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        t (pxc/entity-with-sys-from node :tokens eid)]
    (when (nil? (:token/id t))
      (throw (ex-info (pxc/err-msg-not-found "Token" eid) {:code 404 :id eid})))
    (let [span-ids (get-span-ids node eid)
          vl-ids (->> (xt/q node (xt/template
                          (-> (from :vocab-links [{:xt/id vlid :vocab-link/tokens toks}])
                              (unnest {:t toks})
                              (where (= t ~eid))
                              (return vlid))))
                      (map :vlid))
          vl-ops (vec (mapcat (fn [vlid]
                                (let [vl (pxc/entity-with-sys-from node :vocab-links vlid)]
                                  [(pxc/match* :vocab-links vl)
                                   [:delete-docs :vocab-links vlid]]))
                              vl-ids))]
      (reduce into
              [vl-ops
               (vec (mapcat #(s/remove-token* xt-map % eid) span-ids))
               [(pxc/match* :tokens t)
                [:delete-docs :tokens eid]]]))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        t (pxc/entity node :tokens eid)
        doc-id (when t (:token/document t))]
    (op/make-operation
     {:type :token/delete
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Delete token " eid)
      :tx-ops (delete* xt-map eid)})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn multi-delete* [xt-map eids]
  (let [node (pxc/->node xt-map)
        eids-set (set eids)
        ;; Find all spans containing any of these tokens via unnest
        all-span-ids (->> eids
                          (mapcat (fn [tid]
                                    (->> (xt/q node (xt/template
                                           (-> (from :spans [{:xt/id sid :span/tokens toks}])
                                               (unnest {:t toks})
                                               (where (= t ~tid))
                                               (return sid))))
                                         (map :sid))))
                          distinct)
        all-spans (mapv #(pxc/entity node :spans %) all-span-ids)
        span-updates (mapv (fn [span]
                             (let [remaining (remove eids-set (:span/tokens span))]
                               {:span span
                                :remaining remaining
                                :should-delete? (empty? remaining)}))
                           all-spans)
        spans-to-delete (filter :should-delete? span-updates)
        spans-to-update (remove :should-delete? span-updates)
        span-ids-to-delete (set (map #(-> % :span :xt/id) spans-to-delete))
        ;; Find all relations that reference spans being deleted using scalar WHERE
        rels-to-delete (->> span-ids-to-delete
                            (mapcat (fn [sid]
                                      (concat
                                       (pxc/find-entities node :relations {:relation/source sid})
                                       (pxc/find-entities node :relations {:relation/target sid}))))
                            (map :xt/id)
                            distinct
                            (map #(pxc/entity-with-sys-from node :relations %)))
        ;; Vocab-links for all tokens being deleted via unnest
        vl-ids (distinct
                (mapcat (fn [tid]
                          (->> (xt/q node (xt/template
                                 (-> (from :vocab-links [{:xt/id vlid :vocab-link/tokens toks}])
                                     (unnest {:t toks})
                                     (where (= t ~tid))
                                     (return vlid))))
                               (map :vlid)))
                        eids))
        vl-ops (vec (mapcat (fn [vlid]
                              (let [vl (pxc/entity-with-sys-from node :vocab-links vlid)]
                                [(pxc/match* :vocab-links vl)
                                 [:delete-docs :vocab-links vlid]]))
                            vl-ids))]
    (vec
     (concat
      vl-ops
      ;; Delete tokens
      (for [eid eids
            :let [te (pxc/entity-with-sys-from node :tokens eid)]
            :when (:token/id te)
            op [(pxc/match* :tokens te) [:delete-docs :tokens eid]]]
        op)
      ;; Update spans with remaining tokens
      (for [{:keys [span remaining]} spans-to-update
            :let [se (pxc/entity-with-sys-from node :spans (:xt/id span))]
            op [(pxc/match* :spans se)
                [:put-docs :spans (-> se
                                      (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                                      (assoc :span/tokens (vec remaining)))]]]
        op)
      ;; Delete spans with no remaining tokens
      (for [{:keys [span]} spans-to-delete
            :let [sid (:xt/id span)
                  se (pxc/entity-with-sys-from node :spans sid)]
            op [(pxc/match* :spans se) [:delete-docs :spans sid]]]
        op)
      ;; Delete relations referencing deleted spans
      (for [re rels-to-delete
            :when (:relation/id re)
            op [(pxc/match* :relations re) [:delete-docs :relations (:xt/id re)]]]
        op)))))

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
    {:tx-ops
     (vec
      (concat
       [(pxc/match* :token-layers layer-e)
        (pxc/match* :texts text-e)]
       (reduce
        (fn [tx-ops attrs]
          (let [token-attrs (filter (fn [[k _]] (token-attr? k)) attrs)
                {:token/keys [id begin end precedence] :as token}
                (clojure.core/merge (pxc/new-record "token")
                                    {:token/document doc-id}
                                    (into {} token-attrs))]
            (check-token-bounds! begin end text-body)
            (check-token-precedence! precedence)
            (into tx-ops [[:sql "ASSERT NOT EXISTS (SELECT 1 FROM tokens WHERE _id = ?)" [id]]
                          [:put-docs :tokens token]])))
        []
        tokens-attrs)))
     :doc-id doc-id
     :project-id project-id}))

(defn bulk-create-operation [xt-map tokens-attrs]
  (let [{:keys [tx-ops doc-id project-id]} (bulk-create* xt-map tokens-attrs)
        layer (-> tokens-attrs first :token/layer)]
    (op/make-operation
     {:type :token/bulk-create
      :project project-id
      :document doc-id
      :description (str "Bulk create " (count tokens-attrs) " tokens in layer " layer)
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
        first-t (pxc/entity node :tokens (first eids))
        doc-id (when first-t (:token/document first-t))]
    (op/make-operation
     {:type :token/bulk-delete
      :project (when first-t (project-id xt-map (first eids)))
      :document doc-id
      :description (str "Bulk delete " (count eids) " tokens")
      :tx-ops (multi-delete* xt-map eids)})))

(defn bulk-delete [xt-map eids user-id]
  (submit-operations! xt-map [(bulk-delete-operation xt-map eids)] user-id))
