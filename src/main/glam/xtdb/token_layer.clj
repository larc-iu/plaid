(ns glam.xtdb.token-layer
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.span-layer :as sl]
            [glam.xtdb.text :as txt]
            [taoensso.timbre :as log]
            [glam.xtdb.token :as tok])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/span-layers])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :token-layer/span-layers xutil/identize :span-layer/id))))

(defn create [node {:token-layer/keys [id] :as attrs}]
  (let [{:token-layer/keys [id] :as record} (clojure.core/merge (xutil/new-record "token-layer" id)
                                                                {:token-layer/span-layers []}
                                                                (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:token-layer/id id})))

(defn parent-id [node id]
  (-> (xt/q (xt/db node)
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
  (gxe/merge node eid (select-keys m [:token-layer/name])))


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

;; todo: this needs a deftx rewrite, probably
(defn whitespace-tokenize [node eid document-id text-id]
  (let [existing-token-ids (map first (xt/q (xt/db node) '{:find  [?tok]
                                                           :where [[?prj :project/text-layers ?txtl]
                                                                   [?doc :document/project ?prj]
                                                                   [?txtl :text-layer/token-layers ?tokl]
                                                                   [?txt :text/document ?doc]
                                                                   [?tok :token/text ?txt]
                                                                   [?tok :token/layer ?tokl]]
                                                           :in    [[?tokl ?doc]]}
                                            [eid document-id]))
        deletions (reduce into (mapv (partial tok/delete** node) existing-token-ids))
        text-body (-> (txt/get node text-id) :text/body)
        offsets (get-whitespace-token-offsets text-body)]
    (let [res (gxe/submit! node deletions)]
      (doseq [[b e] offsets]
        (tok/create node {:token/begin b
                          :token/end   e
                          :token/text  text-id
                          :token/layer eid}))
      res)))

(defn add-span-layer** [node token-layer-id span-layer-id]
  (xutil/add-join** node token-layer-id :token-layer/span-layers span-layer-id))
(defn add-span-layer [node token-layer-id span-layer-id]
  (gxe/submit! node (add-span-layer** node token-layer-id span-layer-id)))

(defn remove-span-layer** [node token-layer-id span-layer-id]
  (xutil/remove-join** node token-layer-id :token-layer/span-layers span-layer-id))
(defn remove-span-layer [node token-layer-id span-layer-id]
  (gxe/submit! node (remove-span-layer** node token-layer-id span-layer-id)))

(defn delete** [node eid]
  (let [span-layers (:token-layer/span-layers (gxe/entity node eid))
        span-layer-deletions (reduce into (map #(sl/delete** node %) span-layers))
        token-ids (map first (xt/q (xt/db node) '{:find  [?tok]
                                                  :where [[?tok :token/layer ?tokl]]
                                                  :in    [?tokl]}
                                   eid))
        token-deletions (mapv gxe/delete* token-ids)]
    (reduce into
            [span-layer-deletions
             token-deletions
             [(gxe/match* eid (gxe/entity node eid))
              (gxe/delete* eid)]])))
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))
