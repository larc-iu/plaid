(ns plaid.xtdb.document
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.text :as text]
            [plaid.xtdb.token-layer :as tokl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:document/id
                :document/name
                :document/project])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (let [db (pxc/->db db-like)]
    (pxc/find-entity db {:document/id id})))

(defmulti get-doc-info (fn [db doc-id parent-id [key id]] key))

(defmethod get-doc-info :document/id [db doc-id parent-id [key id]]
  (let [txtl-ids (map first (xt/q
                              db
                              '{:find  [?txtl]
                                :where [[?prj :project/text-layers ?txtl]
                                        [?doc :document/project ?prj]]
                                :in    [?doc]}
                              id))]
    {:document/text-layers (mapv #(get-doc-info db doc-id id [:text-layer/id %]) txtl-ids)}))

(defmethod get-doc-info :text-layer/id [db doc-id parent-id [key id]]
  (let [tokl-ids (map first (xt/q
                              db
                              '{:find  [?tokl]
                                :where [[?txtl :text-layer/token-layers ?tokl]]
                                :in    [?txtl]}
                              id))
        text (pxc/find-entity db [[:text/document parent-id]
                                  [:text/layer id]])
        token-layers (mapv #(get-doc-info db doc-id id [:token-layer/id %]) tokl-ids)]
    (cond-> {:text-layer/id           id
             :text-layer/token-layers token-layers}
            (some? text) (assoc :text-layer/text (select-keys text [:text/body :text/id])))))

(defmethod get-doc-info :token-layer/id [db doc-id parent-id [key id]]
  (let [sl-ids (map first (xt/q db
                                '{:find  [?sl]
                                  :where [[?tokl :token-layer/span-layers ?sl]]
                                  :in    [?tokl]}
                                id))
        tokens (->> (xt/q db
                          '{:find  [(pull ?tok [:token/id :token/begin :token/end :token/text :token/precedence])]
                            :where [[?tok :token/text ?txt]
                                    [?tok :token/layer ?tokl]
                                    [?txt :text/layer ?txtl]
                                    [?txt :text/document ?doc]]
                            :in    [[?txtl ?doc ?tokl]]}
                          [parent-id doc-id id])
                    (mapv first)
                    tokl/sort-token-records)]
    {:token-layer/id          id
     :token-layer/tokens      tokens
     :token-layer/span-layers (mapv #(get-doc-info db doc-id id [:span-layer/id %]) sl-ids)}))

(defmethod get-doc-info :span-layer/id [db doc-id parent-id [key id]]
  (let [rl-ids (map first (xt/q db
                                '{:find  [?rl]
                                  :where [[?sl :span-layer/relation-layers ?rl]]
                                  :in    [?sl]}
                                id))
        spans (->> (xt/q db
                         '{:find  [(pull ?s [:span/id :span/value :span/tokens])]
                           :where [[?s :span/tokens ?tok]
                                   [?s :span/layer ?sl]
                                   [?tok :token/layer ?tokl]
                                   [?tok :token/text ?txt]
                                   [?txt :text/document ?doc]]
                           :in    [[?tokl ?doc ?sl]]}
                         [parent-id doc-id id])
                   (mapv (fn [[id]] {:span/id id})))]
    {:span-layer/id              id
     :span-layer/spans           spans
     :span-layer/relation-layers (mapv #(get-doc-info db doc-id id [:relation-layer/id %]) rl-ids)}))

(defmethod get-doc-info :relation-layer/id [db doc-id parent-id [key id]]
  (let [relations (->> (xt/q db
                             '{:find  [(pull ?r [:relation/id :relation/value :relation/source :relation/target])]
                               :where [[?r :relation/source ?s]
                                       [?r :relation/layer ?rl]
                                       [?s :span/layer ?sl]
                                       [?s :span/tokens ?tok]
                                       [?tok :token/text ?txt]
                                       [?txt :text/document ?doc]]
                               :in    [[?sl ?doc ?rl]]}
                             [parent-id doc-id id])
                       (mapv (fn [[id]] {:relation/id id})))]
    {:relation-layer/id        id
     :relation-layer/relations relations}))

(defn get-with-layer-data
  [xt-map id]
  (let [{:keys [db]} (pxc/ensure-db xt-map)]
    (get-doc-info db id nil [:document/id id])))

(defn get-text-layers
  [db-like id]
  (let [db (pxc/->db db-like)]
    (->> (xt/q db
               '{:find  [?txtl]
                 :where [[?doc :document/project ?prj]
                         [?prj :project/text-layers ?txtl]]
                 :in    [?doc]}
               id)
         (mapv #(hash-map :text-layer/id (first %))))))

(defn get-text-ids [db-like eid]
  (map first (xt/q (pxc/->db db-like)
                   '{:find  [?txt]
                     :where [[?txt :text/document ?doc]]
                     :in    [?doc]}
                   eid)))

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:document/keys [id project] :as record} (clojure.core/merge (pxc/new-record "document")
                                                                     (select-keys attrs attr-keys))
        tx [[::xt/match project (pxc/entity db project)]
            [::xt/match id nil]
            [::xt/put record]]]
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Document" id) {:id id :code 409}))

      (nil? (:project/id (pxc/entity db project)))
      (throw (ex-info (pxc/err-msg-not-found "Project" project) {:id project :code 400}))

      :else
      tx)))

(defn create [{:keys [node] :as xt-map} attrs]
  (pxc/submit-with-extras! node (create* xt-map attrs) #(-> % last last :xt/id)))

(defn merge
  [{:keys [node db] :as xt-map} eid m]
  (pxc/submit! node (pxc/merge* node eid (select-keys m [:document/name]))))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        text-ids (get-text-ids db eid)
        text-deletes (reduce into (mapv #(text/delete* xt-map %) text-ids))]

    (when-not (:document/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Document" eid) {:code 404 :id eid})))

    (reduce into [text-deletes
                  [[::xt/match eid (pxc/entity db eid)]
                   [::xt/delete eid]]])))

(defn delete [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)]
    (pxc/submit! node (delete* xt-map eid))))

