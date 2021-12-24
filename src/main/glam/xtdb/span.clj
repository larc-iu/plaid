(ns glam.xtdb.span
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span/id
                :span/tokens
                :span/value
                :span/layer])

(def snapshot-attrs [:span/id :span/value :span/tokens])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :span/layer xutil/identize :span-layer/id)
        (update :span/tokens xutil/identize :token/id))))

(defn create* [{:span/keys [id] :as attrs}]
  (gxe/put* (xutil/create-record "span" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:span/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:span/id id})))

(defn get-doc-id-of-span
  "Get document id of a span"
  [node span-id]
  (ffirst
    (xt/q (xt/db node)
          '{:find  [?doc]
            :where [[?s :span/tokens ?tok]
                    [?tok :token/text ?txt]
                    [?txt :text/document ?doc]]
            :in    [?s]}
          span-id)))

(defn get-span-ids
  "Get span ids for a given doc and layer"
  [node doc-id span-layer-id]
  (map first
       (xt/q (xt/db node)
             '{:find  [?s]
               :where [[?s :span/layer ?sl]
                       [?s :span/tokens ?tok]
                       [?tok :token/text ?txt]
                       [?txt :text/document ?doc]]
               :in    [[?sl ?doc]]}
             [span-layer-id doc-id])))

(defn get-spans
  "Get spans for a given doc and layer"
  [node doc-id span-layer-id]
  (map first
       (xt/q (xt/db node)
             '{:find  [(pull ?s [:span/layer :span/tokens :span/id :span/value])]
               :where [[?s :span/layer ?sl]
                       [?s :span/tokens ?tok]
                       [?tok :token/text ?txt]
                       [?txt :text/document ?doc]]
               :in    [[?sl ?doc]]}
             [span-layer-id doc-id])))

(defn get-span-snapshots
  "Get span snapshots for a given doc and layer. A snapshot is a particular view of
  an entity that contains a subset of attributes and is used to comparison with
  client-provided values."
  [node doc-id span-layer-id]
  (map first (xt/q (xt/db node)
                   {:find  [(list 'pull '?s snapshot-attrs)]
                    :where '[[?s :span/layer ?sl]
                             [?s :span/tokens ?tok]
                             [?tok :token/text ?txt]
                             [?txt :text/document ?doc]]
                    :in    '[[?sl ?doc]]}
                   [span-layer-id doc-id])))

;; Mutations --------------------------------------------------------------------------------
(defn merge [node eid m]
  (gxe/merge node eid (select-keys m [:span/value :span/tokens])))

(defn delete** [node eid]
  [(gxe/delete* eid)])
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))

(declare add-token**)
(gxe/deftx add-token [node span-id token-id]
  (xutil/add-join** node span-id :span/tokens token-id))

;; Note: this should NOT be used more than once in a single transaction on a given span, or else its
;; deletion behavior will not work properly.
;; TODO: is this still true now that this is a tx fn?
(declare remove-token**)
(gxe/deftx remove-token [node span-id token-id]
  (let [base-txs (xutil/remove-join** node span-id :span/tokens token-id)]
    (if (= 1 (-> (gxe/entity node span-id) :span/tokens count))
      (into base-txs [(gxe/delete* span-id)])
      base-txs)))


;; Given the following:
;; - a node
;; - a doc id
;; - a span layer id
;; - a snapshot of existing spans on that layer and doc
;; - a vec of changes (this is a DSL) to make to the spans on the layer,
;; check that the client-supplied snapshot matches the current state of the DB and
;; apply the changes only if they do match
(declare batched-update**)
(gxe/deftx batched-update [node doc-id span-layer-id client-spans updates]
  (let [current-spans (set (get-span-snapshots node doc-id span-layer-id))
        client-spans (set client-spans)]
    (when-not (= current-spans client-spans)
      (throw (ex-info (str "Aborting batched update: client-provided span snapshot"
                           " does not match current span snapshot")
                      {:current current-spans
                       :client  client-spans})))

    (let [tx (mapv (fn [[op & args :as update]]
                     (case op
                       ;; [:delete :span-id]
                       :delete
                       (gxe/delete* (first args))

                       ;; [:merge {:span/id :s1, :span/value "foo", ...}]
                       :merge
                       (let [{:span/keys [id] :as span} (first args)]
                         (when-not (some #(= (:span/id %) id) current-spans)
                           (throw (ex-info "Attempted to merge into a non-existent span:" {:span/id id})))
                         (gxe/put* (clojure.core/merge (gxe/entity node id)
                                                       (select-keys span snapshot-attrs))))

                       ;; [:create {:span/id :s1, :span/value "foo", ...}]
                       :create
                       (let [{:span/keys [value tokens] :as span} (first args)]
                         (when-not (map? span)
                           (throw (ex-info "Span being :put must have be a map" span)))
                         (when-not (string? value)
                           (throw (ex-info ":span/value must be a string" span)))
                         (when-not (and (not-empty tokens) (every? #(:token/id (gxe/entity node %)) tokens))
                           (throw (ex-info ":span/tokens must point to at least one token" span)))
                         (create* (clojure.core/merge span {:span/layer span-layer-id})))

                       (throw (ex-info "Unknown op in batched update:" {:op op :valid [:delete :merge :create]}))))
                   updates)]
      (log/debug "Submitting " (count tx) " batched span updates: " (clojure.string/join "," (map (comp name first) tx)))
      tx)))

(gxe/deftx multi-batched-update [node doc-id batches]
  (let [tx (reduce into (map (fn [{span-layer-id :span-layer/id
                                   client-spans  :client-spans
                                   updates       :updates}]
                               (batched-update** node doc-id span-layer-id client-spans updates))
                             batches))]
    tx))
