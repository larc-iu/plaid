(ns glam.crux.text
  (:require [crux.api :as crux]
            [glam.crux.util :as cutil]
            [glam.crux.easy :as gce]
            [glam.crux.token :as tok]
            [glam.algos.text :as ta]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:text/id
                :text/document
                :text/layer
                :text/body])

(defn crux->pathom [doc]
  (when doc
    (-> doc
        (update :text/layer cutil/identize :text-layer/id)
        (update :text/document cutil/identize :document/id))))

(defn create [node {:text/keys [id] :as attrs}]
  (let [{:text/keys [id] :as record} (clojure.core/merge (cutil/new-record "text" id)
                                                         (select-keys attrs attr-keys))
        tx-status (gce/submit! node [[:crux.tx/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (crux->pathom (gce/find-entity node {:text/id id})))


;; Mutations ----------------------------------------------------------------------
(defn- get-span-ids [node eid]
  (map first (crux/q (crux/db node)
                     '{:find  [?span]
                       :where [[?span :span/tokens ?tok]
                               [?tok :token/text ?txt]]
                       :in    [?txt]}
                     eid)))

(defn- get-token-ids [node eid]
  (map first (crux/q (crux/db node)
                     '{:find  [?tok]
                       :where [[?tok :token/text ?txt]]
                       :in    [?txt]}
                     eid)))

(defn update-body [node eid old-body ops]
  (let [text (gce/entity node eid)
        tokens (map #(gce/entity node %) (get-token-ids node eid))
        indexed-tokens (reduce #(assoc %1 (:token/id %2) %2) {} tokens)
        {new-text :text new-tokens :tokens deleted-token-ids :deleted} (ta/apply-text-edits ops text tokens)
        needs-update? (fn [{:token/keys [begin end id]}] (or (not= begin (:token/begin (clojure.core/get indexed-tokens id)))
                                                             (not= end (:token/end (clojure.core/get indexed-tokens id)))))
        deletion-tx (map #(tok/delete** node %) deleted-token-ids)
        update-tx (map #(gce/put* %) (filter needs-update? new-tokens))
        text-tx [(gce/match* eid (assoc text :text/body old-body))
                 (gce/put* (assoc text :text/body (:text/body new-text)))]
        tx (reduce into [text-tx deletion-tx update-tx])]
    (let [success (gce/submit! node tx)]
      success)))

;; We don't follow the usual pattern of relying on child nodes' delete** functions here because
;; this would lead to children being included multiple times. Instead, we write a bespoke fn.
(defn delete** [node eid]
  (let [span-deletes (mapv gce/delete* (get-span-ids node eid))
        token-deletes (mapv gce/delete* (get-token-ids node eid))
        text-delete [(gce/delete* eid)]]
    (reduce into
            [span-deletes
             token-deletes
             text-delete])))
(defn delete [node eid]
  (gce/submit-tx-sync node (delete** node eid)))
