(ns glam.xtdb.text
  (:require [xtdb.api :as xt]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.common :as gxc]
            [glam.xtdb.token :as tok]
            [glam.algos.text :as ta]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text/id
                :text/document
                :text/layer
                :text/body])

(defn xt->pathom [doc]
  (when doc
    (-> doc
        (update :text/layer gxc/identize :text-layer/id)
        (update :text/document gxc/identize :document/id))))

(defn create* [{:text/keys [id] :as attrs}]
  (gxe/put* (gxc/create-record "text" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:text/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:text/id id})))

(defn get-text-for-doc [node txtl doc]
  (ffirst
    (xt/q (xt/db node)
          '{:find  [?txt]
            :where [[?txt :text/layer ?txtl]
                    [?txt :text/document ?doc]]
            :in    [[?txtl ?doc]]}
          [txtl doc])))

;; Mutations ----------------------------------------------------------------------
(defn get-token-ids [node eid]
  (map first (xt/q (xt/db node)
                   '{:find  [?tok]
                     :where [[?tok :token/text ?txt]]
                     :in    [?txt]}
                   eid)))

(declare update-body**)
(gxe/deftx update-body [node eid ops]
  (let [text (gxe/entity node eid)
        tokens (map #(gxe/entity node %) (get-token-ids node eid))
        indexed-tokens (reduce #(assoc %1 (:token/id %2) %2) {} tokens)
        {new-text :text new-tokens :tokens deleted-token-ids :deleted} (ta/apply-text-edits ops text tokens)
        needs-update? (fn [{:token/keys [begin end id]}] (or (not= begin (:token/begin (clojure.core/get indexed-tokens id)))
                                                             (not= end (:token/end (clojure.core/get indexed-tokens id)))))
        deletion-tx (reduce into (map #(tok/delete** node %) deleted-token-ids))
        update-tx (map #(gxe/put* %) (filter needs-update? new-tokens))
        text-tx [(gxe/put* (assoc text :text/body (:text/body new-text)))]
        tx (reduce into [text-tx deletion-tx update-tx])]
    tx))

(gxe/deftx delete [node eid]
  (let [token-deletes (reduce into (mapv #(tok/delete** node %) (get-token-ids node eid)))
        text-delete [(gxe/delete* eid)]]
    (reduce into
            [token-deletes
             text-delete])))
