(ns plaid.xtdb2.span
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.relation :as r]
            [plaid.xtdb2.metadata :as metadata])
  (:refer-clojure :exclude [get merge format]))

(def core-attr-keys [:span/id
                     :span/tokens
                     :span/value
                     :span/layer])

;; Queries ------------------------------------------------------------------------

(defn format [raw-record]
  (let [core-attrs (select-keys raw-record [:span/id :span/value :span/tokens])]
    (metadata/add-metadata-to-response core-attrs raw-record "span")))

(defn get [node-or-map id]
  (when-let [e (pxc/entity node-or-map :spans id)]
    (when (:span/id e)
      (format e))))

(defn project-id [node-or-map id]
  (let [s (pxc/entity node-or-map :spans id)
        tokl-id (when-let [sl-id (:span/layer s)]
                  (:span-layer/token-layer (pxc/entity node-or-map :span-layers sl-id)))
        txtl-id (when tokl-id (:token-layer/text-layer (pxc/entity node-or-map :token-layers tokl-id)))]
    (when txtl-id
      (:text-layer/project (pxc/entity node-or-map :text-layers txtl-id)))))

(defn get-relation-ids [node-or-map eid]
  (let [node (pxc/->node node-or-map)]
    (->> (xt/q node ["SELECT _id FROM relations WHERE relation$source = ? OR relation$target = ?" eid eid])
         (map :xt/id))))

(defn get-doc-id-of-token [node-or-map token-id]
  (:token/document (pxc/entity node-or-map :tokens token-id)))

(defn- project-id-from-layer [node layer-id]
  (:span-layer/project (pxc/entity node :span-layers layer-id)))

;; Mutations ----------------------------------------------------------------------

(defn- validate-atomic-value! [value]
  (when-not (or (nil? value) (string? value) (number? value) (boolean? value))
    (throw (ex-info "Span value must be atomic (string, number, boolean, or null)"
                    {:value value :code 400}))))

(defn- check-tokens! [node {:span/keys [tokens layer document]} token-records]
  (let [{token-layer-id :token/layer} (first token-records)
        sl (pxc/entity node :span-layers layer)]
    (cond
      (or (not (seq token-records)) (empty? token-records))
      (throw (ex-info "Token list is empty or malformed" {:code 400}))

      (nil? (:span-layer/id sl))
      (throw (ex-info (pxc/err-msg-not-found "Span layer" layer) {:id layer :code 400}))

      (not (every? :token/id token-records))
      (throw (ex-info "Not all token IDs are valid." {:ids tokens :code 400}))

      (not (and (some? token-layer-id)
                (every? #(= token-layer-id %) (map :token/layer token-records))))
      (throw (ex-info "Not all token IDs belong to the same layer."
                      {:layer-ids (map :token/layer token-records) :code 400}))

      (not (some #{layer} (:token-layer/span-layers (pxc/entity node :token-layers token-layer-id))))
      (throw (ex-info (str "Token layer " token-layer-id " is not linked to span layer " layer)
                      {:token-layer-id token-layer-id :span-layer-id layer :code 400}))

      (not (= 1 (count (distinct (map :token/document token-records)))))
      (throw (ex-info "Not all token IDs belong to the same document." {:code 400}))

      (and (some? document)
           (not (every? #(= document (:token/document %)) token-records)))
      (throw (ex-info "Not all token IDs belong to the same document."
                      {:code 400})))))

(defn- span-attr? [k]
  (= "span" (namespace k)))

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        span-attrs (filter (fn [[k _]] (span-attr? k)) attrs)
        {:span/keys [id tokens layer value] :as span}
        (clojure.core/merge (pxc/new-record "span")
                            {:span/document (get-doc-id-of-token node (-> attrs :span/tokens first))}
                            (into {} span-attrs))
        token-map (pxc/entities-with-sys-from-by-id node :tokens tokens)
        token-records (mapv #(clojure.core/get token-map %) tokens)]
    (validate-atomic-value! value)
    (check-tokens! node span token-records)
    (when (pxc/entity node :spans id)
      (throw (ex-info (pxc/err-msg-already-exists "Span" id) {:id id :code 409})))
    (let [layer-e (pxc/entity-with-sys-from node :span-layers layer)
          token-matches (mapv (fn [tok-id]
                                (pxc/match* :tokens (clojure.core/get token-map tok-id)))
                              tokens)]
      (into [(pxc/match* :span-layers layer-e)]
            (conj token-matches [:put-docs :spans span])))))

(defn create-operation [xt-map attrs metadata]
  (let [node (pxc/->node xt-map)
        {:span/keys [layer tokens]} attrs
        doc-id (get-doc-id-of-token node (first tokens))
        meta-attrs (metadata/transform-metadata-for-storage metadata "span")
        attrs-with-meta (clojure.core/merge attrs meta-attrs)
        tx-ops (create* xt-map attrs-with-meta)]
    (op/make-operation
     {:type :span/create
      :project (project-id-from-layer node layer)
      :document doc-id
      :description (str "Create span with " (count tokens) " tokens in layer " layer)
      :tx-ops tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations! xt-map [(create-operation xt-map attrs metadata)] user-id
                       #(-> % last last :xt/id))))

(defn merge-operation [xt-map eid m]
  (let [node (pxc/->node xt-map)
        s (pxc/entity node :spans eid)
        doc-id (:span/document s)
        updates (into {} (filter (fn [[k _]] (span-attr? k)) m))]
    (op/make-operation
     {:type :span/update-attributes
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Update attributes of span " eid)
      :tx-ops (pxc/merge* xt-map :spans :span/id eid updates)})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        s (pxc/entity-with-sys-from node :spans eid)]
    (when (nil? (:span/id s))
      (throw (ex-info (pxc/err-msg-not-found "Span" eid) {:code 404 :id eid})))
    (let [rel-ids (get-relation-ids node eid)
          rel-entities (pxc/entities-with-sys-from node :relations rel-ids)]
      (into (pxc/batch-delete-ops :relations rel-entities)
            [(pxc/match* :spans s)
             [:delete-docs :spans eid]]))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        s (pxc/entity node :spans eid)
        doc-id (when s (:span/document s))]
    (op/make-operation
     {:type :span/delete
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Delete span " eid " and its " (count (get-relation-ids node eid)) " relations")
      :tx-ops (delete* xt-map eid)})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn set-tokens* [xt-map eid token-ids]
  (let [node (pxc/->node xt-map)
        token-map (pxc/entities-with-sys-from-by-id node :tokens token-ids)
        token-records (mapv #(clojure.core/get token-map %) token-ids)
        {:span/keys [layer] :as s} (pxc/entity node :spans eid)]
    (check-tokens! node s token-records)
    (let [s-e (pxc/entity-with-sys-from node :spans eid)
          layer-e (pxc/entity-with-sys-from node :span-layers layer)
          token-matches (mapv (fn [tid]
                                (pxc/match* :tokens (clojure.core/get token-map tid)))
                              token-ids)]
      (into token-matches
            [(pxc/match* :span-layers layer-e)
             (pxc/match* :spans s-e)
             [:put-docs :spans (-> s-e
                                   (dissoc :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                                   (assoc :span/tokens (vec token-ids)))]]))))

(defn set-tokens-operation [xt-map eid token-ids]
  (let [node (pxc/->node xt-map)
        doc-id (:span/document (pxc/entity node :spans eid))]
    (op/make-operation
     {:type :span/update-tokens
      :project (project-id xt-map eid)
      :document doc-id
      :description (str "Update tokens of span " eid " to " (count token-ids) " tokens")
      :tx-ops (set-tokens* xt-map eid token-ids)})))

(defn set-tokens [xt-map eid token-ids user-id]
  (submit-operations! xt-map [(set-tokens-operation xt-map eid token-ids)] user-id))

(defn remove-token* [xt-map span-id token-id]
  (let [node (pxc/->node xt-map)
        s (pxc/entity node :spans span-id)]
    (if (and (= 1 (-> s :span/tokens count))
             (= token-id (first (:span/tokens s))))
      (delete* xt-map span-id)
      (pxc/remove-join* xt-map :spans :span/id span-id :span/tokens :tokens :token/id token-id))))

(defn remove-token-operation [xt-map span-id token-id]
  (let [node (pxc/->node xt-map)
        s (pxc/entity node :spans span-id)
        doc-id (get-doc-id-of-token node token-id)
        will-delete (and (= 1 (-> s :span/tokens count))
                         (= token-id (first (:span/tokens s))))]
    (op/make-operation
     {:type :span/remove-token
      :project (project-id xt-map span-id)
      :document doc-id
      :description (if will-delete
                     (str "Remove token " token-id " from span " span-id " (deleting span)")
                     (str "Remove token " token-id " from span " span-id))
      :tx-ops (remove-token* xt-map span-id token-id)})))

(defn remove-token [xt-map span-id token-id user-id]
  (submit-operations! xt-map [(remove-token-operation xt-map span-id token-id)] user-id))

;; Metadata
(defn set-metadata [xt-map eid metadata user-id]
  (metadata/set-metadata xt-map eid metadata user-id "span" project-id :span/document))

(defn delete-metadata [xt-map eid user-id]
  (metadata/delete-metadata xt-map eid user-id "span" project-id :span/document))

;; Bulk operations
(defn bulk-create* [xt-map spans-attrs]
  (let [node (pxc/->node xt-map)
        layer (-> spans-attrs first :span/layer)
        layer-e (pxc/entity-with-sys-from node :span-layers layer)
        sl (pxc/entity node :span-layers layer)
        ;; Collect all referenced token IDs and fetch them in bulk
        all-token-ids (->> spans-attrs (mapcat :span/tokens) distinct)
        token-cache (pxc/entities-with-sys-from-by-id node :tokens all-token-ids)
        ;; Derive doc-id and validate consistency from cached tokens
        first-token (clojure.core/get token-cache (-> spans-attrs first :span/tokens first))
        doc-id (:token/document first-token)
        token-layer-id (:token/layer first-token)
        token-layer-e (when token-layer-id (pxc/entity node :token-layers token-layer-id))
        spans-attrs (mapv (fn [attrs]
                            (if (:metadata attrs)
                              (clojure.core/merge (dissoc attrs :metadata)
                                                  (metadata/transform-metadata-for-storage (:metadata attrs) "span"))
                              (dissoc attrs :metadata)))
                          spans-attrs)]
    ;; Consistency checks
    (when-not (= 1 (->> spans-attrs (map :span/layer) distinct count))
      (throw (ex-info "Spans must all belong to the same layer" {:code 400})))
    (let [doc-ids (->> all-token-ids (map #(:token/document (clojure.core/get token-cache %))) distinct)]
      (when-not (= 1 (count doc-ids))
        (throw (ex-info "Not all spans belong to the same document" {:document-ids doc-ids :code 400}))))
    ;; Layer existence
    (when (nil? (:span-layer/id sl))
      (throw (ex-info (pxc/err-msg-not-found "Span layer" layer) {:id layer :code 400})))
    ;; Token-layer linkage (checked once)
    (when-not (some #{layer} (:token-layer/span-layers token-layer-e))
      (throw (ex-info (str "Token layer " token-layer-id " is not linked to span layer " layer)
                      {:token-layer-id token-layer-id :span-layer-id layer :code 400})))
    {:tx-ops
     (vec
      (concat
       [(pxc/match* :span-layers layer-e)]
       (reduce
        (fn [tx-ops attrs]
          (let [span-attrs (filter (fn [[k _]] (span-attr? k)) attrs)
                {:span/keys [id tokens value] :as span}
                (clojure.core/merge (pxc/new-record "span")
                                    {:span/document doc-id}
                                    (into {} span-attrs))
                token-records (mapv #(clojure.core/get token-cache %) tokens)]
            (validate-atomic-value! value)
            ;; Validate tokens exist and belong to same layer
            (when (or (not (seq token-records)) (empty? token-records))
              (throw (ex-info "Token list is empty or malformed" {:code 400})))
            (when-not (every? :token/id token-records)
              (throw (ex-info "Not all token IDs are valid." {:ids tokens :code 400})))
            (when-not (every? #(= token-layer-id (:token/layer %)) token-records)
              (throw (ex-info "Not all token IDs belong to the same layer."
                              {:layer-ids (map :token/layer token-records) :code 400})))
            (let [token-matches (mapv (fn [tid]
                                        (pxc/match* :tokens (clojure.core/get token-cache tid)))
                                      tokens)]
              (into tx-ops (concat
                            token-matches
                            [[:put-docs :spans span]])))))
        []
        spans-attrs)))
     :doc-id doc-id
     :project-id (:text-layer/project
                   (when-let [txtl-id (:token-layer/text-layer token-layer-e)]
                     (pxc/entity node :text-layers txtl-id)))}))

(defn bulk-create-operation [xt-map spans-attrs]
  (let [{:keys [tx-ops doc-id project-id]} (bulk-create* xt-map spans-attrs)
        layer (-> spans-attrs first :span/layer)]
    (op/make-operation
     {:type :span/bulk-create
      :project project-id
      :document doc-id
      :description (str "Bulk create " (count spans-attrs) " spans in layer " layer)
      :tx-ops tx-ops})))

(defn bulk-create [xt-map spans-attrs user-id]
  (submit-operations!
   xt-map
   [(bulk-create-operation xt-map spans-attrs)]
   user-id
   (fn [entity-ops]
     (vec (for [[op-type _table record] entity-ops
                :when (and (= op-type :put-docs) (:span/id record))]
            (:span/id record))))))

(defn bulk-delete* [xt-map eids]
  (let [node (pxc/->node xt-map)
        span-map (pxc/entities-with-sys-from-by-id node :spans eids)
        spans (mapv #(clojure.core/get span-map %) eids)]
    (let [doc-ids (->> spans (keep :span/document) distinct)]
      (when-not (= 1 (count doc-ids))
        (throw (ex-info "Not all spans belong to the same document" {:document-ids doc-ids :code 400}))))
    (let [;; Single SQL query for all relations referencing any of these spans
          placeholders (str/join ", " (repeat (count eids) "?"))
          rel-entities (when (seq eids)
                         (xt/q node (into [(str "SELECT *, _system_from FROM relations"
                                                " WHERE relation$source IN (" placeholders ")"
                                                " OR relation$target IN (" placeholders ")")]
                                          (concat eids eids))))
          rel-ops (pxc/batch-delete-ops :relations rel-entities)
          span-entities (filter :span/id (vals span-map))
          span-ops (pxc/batch-delete-ops :spans span-entities)]
      (into rel-ops span-ops))))

(defn bulk-delete-operation [xt-map eids]
  (let [node (pxc/->node xt-map)
        first-s (pxc/entity node :spans (first eids))
        doc-id (when first-s (:span/document first-s))]
    (op/make-operation
     {:type :span/bulk-delete
      :project (when first-s (project-id xt-map (first eids)))
      :document doc-id
      :description (str "Bulk delete " (count eids) " spans")
      :tx-ops (bulk-delete* xt-map eids)})))

(defn bulk-delete [xt-map eids user-id]
  (submit-operations! xt-map [(bulk-delete-operation xt-map eids)] user-id))
