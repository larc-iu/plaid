(ns plaid.xtdb.span
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.relation :as r]
            [clojure.string :as str])
  (:refer-clojure :exclude [get merge]))

(def core-attr-keys [:span/id
                     :span/tokens
                     :span/value
                     :span/layer])

;; Queries ------------------------------------------------------------------------
(defn get
  "Get a span by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [span-entity (pxc/find-entity (pxc/->db db-like) {:span/id id})]
    (let [core-attrs (select-keys span-entity [:span/id :span/value :span/tokens])
          metadata-attrs (->> span-entity
                             (filter (fn [[k v]]
                                       (and (= "span" (namespace k))
                                            (str/starts-with? (name k) "_")
                                            (not (nil? v)))))  ; Filter out nil values
                             (reduce (fn [m [k v]]
                                       (assoc m (subs (name k) 1) v))
                                     {}))]
      (if (empty? metadata-attrs)
        core-attrs
        (assoc core-attrs :metadata metadata-attrs)))))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tokl :token-layer/span-layers ?sl]
                      [?s :span/layer ?sl]]
              :in    [?s]}
            id)
      first
      first))

(defn get-relation-ids [db-like eid]
  (map first (xt/q (pxc/->db db-like)
                   '{:find  [?relation]
                     :where [(or [?relation :relation/source ?id] [?relation :relation/target ?id])]
                     :in    [?id]}
                   eid)))

(defn- project-id-from-layer [db-like layer-id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tokl :token-layer/span-layers ?sl]]
              :in    [?sl]}
            layer-id)
      first
      first))

(defn- get-doc-id-of-token
  [db-like token-id]
  (ffirst
    (xt/q (pxc/->db db-like)
          '{:find  [?doc]
            :where [[?tok :token/text ?txt]
                    [?txt :text/document ?doc]]
            :in    [?tok]}
          token-id)))

;; Mutations --------------------------------------------------------------------------------
(defn- validate-atomic-value! [value]
  (when-not (or (nil? value)
                (string? value)
                (number? value)
                (boolean? value))
    (throw (ex-info "Span value must be atomic (string, number, boolean, or null)"
                    {:value value :code 400}))))

(defn- check-tokens! [db {:span/keys [tokens layer]} token-records]
  (let [{token-layer-id :token/layer} (first token-records)
        {span-layers :token-layer/span-layers} (pxc/entity db token-layer-id)]
    (cond
      (or (not (seq token-records)) (empty? token-records))
      (throw (ex-info "Token list is empty or malformed" {:code 400}))

      (nil? (:span-layer/id (pxc/entity db layer)))
      (throw (ex-info (pxc/err-msg-not-found "Span layer" layer) {:id layer :code 400}))

      ;; All tokens exist?
      (not (every? :token/id token-records))
      (throw (ex-info "Not all token IDs are valid." {:ids tokens :code 400}))

      ;; All tokens belong to the same layer?
      (not (and (some? token-layer-id)
                (every? #(= token-layer-id %) (map :token/layer token-records))))
      (throw (ex-info "Not all token IDs belong to the same layer."
                      {:layer-ids (map :token/layer token-records) :code 400}))

      ;; Tokens belong to a layer that is linked to the span layer?
      (not ((set span-layers) layer))
      (throw (ex-info (str "Token layer " token-layer-id " is not linked to span layer " layer)
                      {:token-layer-id token-layer-id :span-layer-id layer :code 400}))

      ;; All tokens belong to the same document?
      (not (= 1 (count (set (map (partial get-doc-id-of-token db) tokens)))))
      (throw (ex-info "Not all token IDs belong to the same document."
                      {:document-ids (map (partial get-doc-id-of-token db) tokens) :code 400})))))

(defn- span-attr? 
  "Check if an attribute key belongs to span namespace (including metadata attributes)."
  [k]
  (= "span" (namespace k)))

(defn create*
  [xt-map attrs]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        span-attrs (filter (fn [[k v]] (span-attr? k)) attrs)
        {:span/keys [id tokens layer value] :as span} (clojure.core/merge (pxc/new-record "span")
                                                                          (into {} span-attrs))
        token-records (map #(pxc/entity db %) tokens)]
    (validate-atomic-value! value)
    (check-tokens! db span token-records)
    (cond
      ;; ID is not already taken?
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Span" id) {:id id :code 409}))

      :else
      (let [token-matches (mapv (fn [[id record]]
                                  [::xt/match id record])
                                (map vector tokens token-records))
            matches (into [[::xt/match id nil]
                           [::xt/match layer (pxc/entity db layer)]]
                          token-matches)]
        (conj matches [::xt/put span])))))

(defn create-operation
  "Build an operation for creating a span"
  [xt-map attrs metadata]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:span/keys [layer tokens]} attrs
        project-id (project-id-from-layer db layer)
        doc-id (get-doc-id-of-token db (first tokens))
        ;; Expand metadata into span attributes
        metadata-attrs (if metadata
                         (reduce-kv (fn [m k v]
                                      (assoc m (keyword "span" (str "_" k)) v))
                                    {}
                                    metadata)
                         {})
        attrs-with-metadata (clojure.core/merge attrs metadata-attrs)
        tx-ops (create* xt-map attrs-with-metadata)]
    (op/make-operation
     {:type        :span/create
      :project     project-id
      :document    doc-id
      :description (str "Create span with " (count tokens) " tokens in layer " layer
                        (when metadata (str " and " (count metadata) " metadata keys")))
      :tx-ops      tx-ops})))

(defn create
  ([xt-map attrs user-id]
   (create xt-map attrs user-id nil))
  ([xt-map attrs user-id metadata]
   (submit-operations-with-extras! xt-map [(create-operation xt-map attrs metadata)] user-id #(-> % last last :xt/id))))

(defn merge-operation
  "Build an operation for updating a span's attributes"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        span (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (get-doc-id-of-token db (first (:span/tokens span)))
        span-attrs (filter (fn [[k v]] (span-attr? k)) m)
        updates (into {} span-attrs)]
    (op/make-operation
     {:type        :span/update-attributes
      :project     project-id
      :document    doc-id
      :description (str "Update attributes of span " eid)
      :tx-ops      (pxc/merge* xt-map eid updates)})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        relations (get-relation-ids db eid)
        relation-deletes (reduce into (mapv #(r/delete* xt-map %) relations))
        span-delete [[::xt/match eid (pxc/entity db eid)]
                     [::xt/delete eid]]]

    (when-not (:span/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Span" eid) {:code 404 :id eid})))

    (reduce into
            [relation-deletes
             span-delete])))

(defn delete-operation
  "Build an operation for deleting a span"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        span (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (when span (get-doc-id-of-token db (first (:span/tokens span))))
        tx-ops (delete* xt-map eid)]
    (op/make-operation
     {:type        :span/delete
      :project     project-id
      :document    doc-id
      :description (str "Delete span " eid " and its " (count (get-relation-ids db eid)) " relations")
      :tx-ops      tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

(defn set-tokens* [xt-map eid token-ids]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        token-records (map #(pxc/entity db %) token-ids)
        {:span/keys [layer] :as span} (pxc/entity db eid)]
    (check-tokens! db span token-records)

    (into (mapv (fn [[id record]]
                  [::xt/match id record])
                (map vector token-ids token-records))
          [[::xt/match layer (pxc/entity db layer)]
           [::xt/match eid span]
           [::xt/put (assoc span :span/tokens (vec token-ids))]])))

(defn set-tokens-operation
  "Build an operation for updating a span's tokens"
  [xt-map eid token-ids]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        span (pxc/entity db eid)
        project-id (project-id db eid)
        doc-id (get-doc-id-of-token db (first token-ids))
        tx-ops (set-tokens* xt-map eid token-ids)]
    (op/make-operation
     {:type        :span/update-tokens
      :project     project-id
      :document    doc-id
      :description (str "Update tokens of span " eid " to " (count token-ids) " tokens")
      :tx-ops      tx-ops})))

(defn set-tokens [xt-map eid token-ids user-id]
  (submit-operations! xt-map [(set-tokens-operation xt-map eid token-ids)] user-id))

(defn remove-token*
  [xt-map span-id token-id]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        span (pxc/entity db span-id)
        base-txs (pxc/remove-join* xt-map :span/id span-id :span/tokens :token/id token-id)]
    (if (and (= 1 (-> span :span/tokens count))
             (= token-id (first (:span/tokens span))))
      (into base-txs (delete* xt-map span-id))
      base-txs)))

(defn remove-token-operation
  "Build an operation for removing a token from a span"
  [xt-map span-id token-id]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        span (pxc/entity db span-id)
        project-id (project-id db span-id)
        doc-id (get-doc-id-of-token db token-id)
        tx-ops (remove-token* xt-map span-id token-id)
        will-delete (and (= 1 (-> span :span/tokens count))
                         (= token-id (first (:span/tokens span))))]
    (op/make-operation
     {:type        :span/remove-token
      :project     project-id
      :document    doc-id
      :description (if will-delete
                     (str "Remove token " token-id " from span " span-id " (deleting span)")
                     (str "Remove token " token-id " from span " span-id))
      :tx-ops      tx-ops})))

(defn remove-token [xt-map span-id token-id user-id]
  (submit-operations! xt-map [(remove-token-operation xt-map span-id token-id)] user-id))

(defn set-metadata*
  "Build transaction ops for replacing all metadata on a span"
  [xt-map eid metadata]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        existing-span (pxc/entity db eid)
        old-metadata-keys (->> existing-span
                              (filter (fn [[k _v]]
                                        (and (= "span" (namespace k))
                                             (str/starts-with? (name k) "_"))))
                              (map first))
        new-metadata (reduce-kv (fn [m k v]
                                  (assoc m (keyword "span" (str "_" k)) v))
                                {}
                                metadata)
        clear-old (reduce (fn [m k] (assoc m k nil)) {} old-metadata-keys)
        final-updates (clojure.core/merge clear-old new-metadata)]
    (pxc/merge* xt-map eid final-updates)))

(defn set-metadata-operation
  "Build an operation for replacing all metadata on a span"
  [xt-map eid metadata]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db eid)
        span (pxc/entity db eid)
        doc-id (get-doc-id-of-token db (first (:span/tokens span)))
        tx-ops (set-metadata* xt-map eid metadata)]
    (op/make-operation
     {:type        :span/set-metadata
      :project     project-id
      :document    doc-id
      :description (str "Set metadata on span " eid " with " (count metadata) " keys")
      :tx-ops      tx-ops})))

(defn set-metadata [xt-map eid metadata user-id]
  (submit-operations! xt-map [(set-metadata-operation xt-map eid metadata)] user-id))

(defn delete-metadata*
  "Build transaction ops for removing all metadata from a span"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        existing-span (pxc/entity db eid)
        old-metadata-keys (->> existing-span
                              (filter (fn [[k _v]]
                                        (and (= "span" (namespace k))
                                             (str/starts-with? (name k) "_"))))
                              (map first))
        clear-updates (reduce (fn [m k] (assoc m k nil)) {} old-metadata-keys)]
    (pxc/merge* xt-map eid clear-updates)))

(defn delete-metadata-operation
  "Build an operation for removing all metadata from a span"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db eid)
        span (pxc/entity db eid)
        doc-id (get-doc-id-of-token db (first (:span/tokens span)))
        tx-ops (delete-metadata* xt-map eid)]
    (op/make-operation
     {:type        :span/delete-metadata
      :project     project-id
      :document    doc-id
      :description (str "Delete all metadata from span " eid)
      :tx-ops      tx-ops})))

(defn delete-metadata [xt-map eid user-id]
  (submit-operations! xt-map [(delete-metadata-operation xt-map eid)] user-id))