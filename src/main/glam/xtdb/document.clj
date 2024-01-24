(ns glam.xtdb.document
  (:require [xtdb.api :as xt]
            [glam.xtdb.common :as gxc]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.text :as text])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/project])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :document/project gxc/identize :project/id))))

(defn create* [{:document/keys [id] :as attrs}]
  (gxe/put* (gxc/create-record "document" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:document/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:document/id id})))

(defmulti get-doc-info (fn [node doc-id parent-id [key id]] key))
(defmethod get-doc-info :document/id [node doc-id parent-id [key id]]
  (let [txtl-ids (map first (xt/q
                              (xt/db node)
                              '{:find  [?txtl]
                                :where [[?prj :project/text-layers ?txtl]
                                        [?doc :document/project ?prj]]
                                :in    [?doc]}
                              id))]
    {:document/id          id
     :document/text-layers (mapv #(get-doc-info node doc-id id [:text-layer/id %]) txtl-ids)}))
(defmethod get-doc-info :text-layer/id [node doc-id parent-id [key id]]
  (let [tokl-ids (map first (xt/q
                              (xt/db node)
                              '{:find  [?tokl]
                                :where [[?txtl :text-layer/token-layers ?tokl]]
                                :in    [?txtl]}
                              id))]
    {:text-layer/id id
     :text-layer/text {:text/id (gxe/find-entity-id node [[:text/document parent-id]
                                                          [:text/layer id]])}
     :text-layer/token-layers (mapv #(get-doc-info node doc-id id [:token-layer/id %]) tokl-ids)}))
(defmethod get-doc-info :token-layer/id [node doc-id parent-id [key id]]
  (let [sl-ids (map first (xt/q (xt/db node)
                               '{:find  [?sl]
                                 :where [[?tokl :token-layer/span-layers ?sl]]
                                 :in    [?tokl]}
                                id))
        tokens (->> (xt/q (xt/db node)
                          '{:find [(pull ?tok [:token/id :token/begin :token/end :token/text])]
                            :where [[?tok :token/text ?txt]
                                    [?tok :token/layer ?tokl]
                                    [?txt :text/layer ?txtl]
                                    [?txt :text/document ?doc]]
                            :in [[?txtl ?doc ?tokl]]}
                          [parent-id doc-id id])
                    (mapv first))]
    {:token-layer/id          id
     :token-layer/tokens      tokens
     :token-layer/span-layers (mapv #(get-doc-info node doc-id id [:span-layer/id %]) sl-ids)}))
(defmethod get-doc-info :span-layer/id [node doc-id parent-id [key id]]
  (let [spans (->> (xt/q (xt/db node)
                         '{:find [(pull ?s [:span/id :span/value :span/tokens])]
                           :where [[?s :span/tokens ?tok]
                                   [?s :span/layer ?sl]
                                   [?tok :token/layer ?tokl]
                                   [?tok :token/text ?txt]
                                   [?txt :text/document ?doc]]
                           :in [[?tokl ?doc ?sl]]}
                         [parent-id doc-id id])
                   (mapv (fn [[id]] {:span/id id})))]
    {:span-layer/id     id
     :span-layer/spans spans}))

(defn get-with-layer-data-for-pathom
  [node id]
  (get-doc-info node id nil [:document/id id]))

(defn get-text-layers
  [node id]
  (->> (xt/q (xt/db node)
             '{:find  [?txtl]
               :where [[?doc :document/project ?prj]
                       [?prj :project/text-layers ?txtl]]
               :in    [?doc]}
             id)
       (mapv #(hash-map :text-layer/id (first %)))))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gxe/merge node eid (select-keys m [:document/name])))

(gxe/deftx delete [node eid]
  (let [text-ids (map first (xt/q (xt/db node)
                                  '{:find  [?txt]
                                    :where [[?txt :text/document ?doc]]
                                    :in    [?doc]}
                                  eid))
        text-deletes (reduce into (map #(text/delete** node %) text-ids))]
    (conj text-deletes (gxe/delete* eid))))

(gxe/deftx acquire-lock [node eid user-id]
  (let [{existing :document/lock-holder :as doc} (gxe/entity node eid)]
    (if (and (nil? existing)
             (some? doc))
      [(gxe/put* (assoc doc :document/lock-holder user-id))]
      [])))

(gxe/deftx release-lock [node eid]
  (let [doc (gxe/entity node eid)]
    (if (some? doc)
      [(gxe/put* (dissoc doc :document/lock-holder))]
      [])))
