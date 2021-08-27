(ns glam.crux.token-layer
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.span-layer :as sl]
            [glam.crux.text :as txt]
            [taoensso.timbre :as log]
            [glam.crux.token :as tok])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/span-layers])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :token-layer/span-layers cutil/identize :span-layer/id))))

(defn create [node {:token-layer/keys [id] :as attrs}]
  (let [{:token-layer/keys [id] :as record} (clojure.core/merge (cutil/new-record "token-layer" id)
                                                                {:token-layer/span-layers []}
                                                                (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:token-layer/id id})))

(defn parent-id [node id]
  (-> (crux/q (crux/db node)
              '{:find  [?txtl]
                :where [[?txtl :text-layer/token-layers ?tokl]]
                :in    [?tokl]}
              id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn merge
  "Note: don't include the join"
  [node eid m]
  (gce/merge node eid (select-keys m [:token-layer/name])))


(def whitespace-regexp #"\s|\n")
(defn whitespace? [s]
  (boolean (re-matches whitespace-regexp s)))

(defn get-whitespace-token-offsets [text]
  (loop [offsets []
         open nil
         i 0
         head (subs text 0 1)
         tail (subs text 1)]
    (if (nil? head)
      (if (some? open)
        (conj offsets [open i])
        offsets)
      (let [new-head (if (= i (dec (count text))) nil (subs tail 0 1))
            new-tail (if (= 0 (count tail)) nil (subs tail 1))]
        (cond
          (and (whitespace? head) (some? open))
          (recur (conj offsets [open i]) nil (inc i) new-head new-tail)

          (and (not (whitespace? head)) (nil? open))
          (recur offsets i (inc i) new-head new-tail)

          :else
          (recur offsets open (inc i) new-head new-tail))))))

(defn whitespace-tokenize [node eid document-id text-id]
  (let [existing-token-ids (map first (crux/q (crux/db node) '{:find  [?tok]
                                                               :where [[?prj :project/text-layers ?txtl]
                                                                       [?doc :document/project ?prj]
                                                                       [?txtl :text-layer/token-layers ?tokl]
                                                                       [?txt :text/document ?doc]
                                                                       [?tok :token/text ?txt]
                                                                       [?tok :token/layer ?tokl]]
                                                               :in    [[?tokl ?doc]]}
                                              [eid document-id]))
        deletions (mapv gce/delete* existing-token-ids)
        text-body (-> (txt/get node text-id) :text/body)
        offsets (get-whitespace-token-offsets text-body)]
    ;; todo: this will need cleanup for solving #5
    (let [res (gce/submit! node deletions)]
      (doseq [[b e] offsets]
        (tok/create node {:token/begin b
                          :token/end   e
                          :token/text  text-id
                          :token/layer eid}))
      res)))

(defn add-span-layer** [node token-layer-id span-layer-id]
  (cutil/add-join** node token-layer-id :token-layer/span-layers span-layer-id))
(defn add-span-layer [node token-layer-id span-layer-id]
  (gce/submit! node (add-span-layer** node token-layer-id span-layer-id)))

(defn remove-span-layer** [node token-layer-id span-layer-id]
  (cutil/remove-join** node token-layer-id :token-layer/span-layers span-layer-id))
(defn remove-span-layer [node token-layer-id span-layer-id]
  (gce/submit! node (remove-span-layer** node token-layer-id span-layer-id)))

(defn delete** [node eid]
  (let [span-layers (:token-layer/span-layers (gce/entity node eid))
        span-layer-deletions (reduce into (map #(sl/delete** node %) span-layers))
        token-ids (map first (crux/q (crux/db node) '{:find  [?tok]
                                                      :where [[?tok :token/layer ?tokl]]
                                                      :in    [?tokl]}
                                     eid))
        token-deletions (mapv gce/delete* token-ids)]
    (reduce into
            [span-layer-deletions
             token-deletions
             [(gce/match* eid (gce/entity node eid))
              (gce/delete* eid)]])))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
