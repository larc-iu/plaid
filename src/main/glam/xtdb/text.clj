(ns glam.xtdb.text
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
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
        (update :text/layer xutil/identize :text-layer/id)
        (update :text/document xutil/identize :document/id))))

(defn create* [{:text/keys [id] :as attrs}]
  (gxe/put* (xutil/create-record "text" id attrs attr-keys)))

(defn create [node attrs]
  (let [[_ {:text/keys [id]} :as put] (create* attrs)
        tx-status (gxe/submit! node [put])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:text/id id})))


;; Mutations ----------------------------------------------------------------------
(defn- get-span-ids [node eid]
  (map first (xt/q (xt/db node)
                   '{:find  [?span]
                     :where [[?span :span/tokens ?tok]
                             [?tok :token/text ?txt]]
                     :in    [?txt]}
                   eid)))

(defn get-token-ids [node eid]
  (map first (xt/q (xt/db node)
                   '{:find  [?tok]
                     :where [[?tok :token/text ?txt]]
                     :in    [?txt]}
                   eid)))

(declare update-body**)
(gxe/deftx update-body [node eid old-body ops]
  (let [text (gxe/entity node eid)
        tokens (map #(gxe/entity node %) (get-token-ids node eid))
        indexed-tokens (reduce #(assoc %1 (:token/id %2) %2) {} tokens)
        {new-text :text new-tokens :tokens deleted-token-ids :deleted} (ta/apply-text-edits ops text tokens)
        needs-update? (fn [{:token/keys [begin end id]}] (or (not= begin (:token/begin (clojure.core/get indexed-tokens id)))
                                                             (not= end (:token/end (clojure.core/get indexed-tokens id)))))
        deletion-tx (reduce into (map #(tok/delete** node %) deleted-token-ids))
        update-tx (map #(gxe/put* %) (filter needs-update? new-tokens))
        text-tx [(gxe/match* eid (assoc text :text/body old-body))
                 (gxe/put* (assoc text :text/body (:text/body new-text)))]
        tx (reduce into [text-tx deletion-tx update-tx])]
    (log/info tx)
    tx))


;; We don't follow the usual pattern of relying on child nodes' delete** functions here because
;; this would lead to children being included multiple times. Instead, we write a bespoke fn.
(defn delete** [node eid]
  (let [span-deletes (mapv gxe/delete* (get-span-ids node eid))
        token-deletes (mapv gxe/delete* (get-token-ids node eid))
        text-delete [(gxe/delete* eid)]]
    (reduce into
            [span-deletes
             token-deletes
             text-delete])))
(defn delete [node eid]
  (gxe/submit-tx-sync node (delete** node eid)))
