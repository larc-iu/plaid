(ns glam.xtdb.vocab-layer
  "A vocabulary layer contains vocabulary items (just 'vocab' for short in keyword ns, etc.).
  Unlike other layers, a vocabulary layer is global, i.e. not bound to any particular project.
  A vocabulary layer is tied to projects by having a token, span, or relation layer refer to it.

  A vocabulary layer has:
  - name: display name
  - open?: whether non-admin writers are able to introduce new items into the vocabulary
  - properties: a list of keys that hold properties, which define the keys available for
                key-value pairs inside vocabulary items. (Currently only string values are
                supported.)"
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab-layer/id
                :vocab-layer/name
                :vocab-layer/open?
                :vocab-layer/properties])

(defn xt->pathom [doc]
  (when doc
    (-> doc)))

(defn create [node {:vocab-layer/keys [id] :as attrs}]
  (let [{:vocab-layer/keys [id] :as record} (clojure.core/merge (xutil/new-record "vocab-layer" id)
                                                                (select-keys attrs attr-keys))
        tx-status (gxe/submit! node [[:xtdb.api/put record]])]
    {:success tx-status
     :id      id}))

;; Queries ------------------------------------------------------------------------
(defn get
  [node id]
  (xt->pathom (gxe/find-entity node {:vocab-layer/id id})))

(defn parent-id [node id]
  (-> (xt/q (xt/db node)
            '{:find  [?sl]
              :where [[?tokl :token-layer/span-layers ?sl]]
              :in    [?sl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn merge
  [node eid m]
  (gxe/merge node eid (select-keys m [:span-layer/name])))

(gxe/deftx delete [node eid]
  ;; TODO
  #_(let [span-ids (map first (xt/q (xt/db node) '{:find  [?s]
                                                   :where [[?s :span/layer ?sl]]
                                                   :in    [?sl]}
                                    eid))
          span-deletions (mapv gxe/delete* span-ids)
          span-layer-deletion [(gxe/delete* eid)]]
      (reduce into [remove-from-project-tx
                    span-deletions
                    span-layer-deletion])))
