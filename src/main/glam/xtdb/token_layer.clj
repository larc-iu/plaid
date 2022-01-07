(ns glam.xtdb.token-layer
  (:require [xtdb.api :as xt]
            [glam.xtdb.util :as xutil]
            [glam.xtdb.easy :as gxe]
            [glam.xtdb.span-layer :as sl]
            [glam.xtdb.text :as txt]
            [taoensso.timbre :as log]
            [glam.xtdb.token :as tok]
            [glam.algos.token :as toka])
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

(defn get-existing-tokens [node eid document-id]
  (map first (xt/q (xt/db node) '{:find  [(pull ?tok [:token/begin :token/end])]
                                  :where [[?prj :project/text-layers ?txtl]
                                          [?doc :document/project ?prj]
                                          [?txtl :text-layer/token-layers ?tokl]
                                          [?txt :text/document ?doc]
                                          [?tok :token/text ?txt]
                                          [?tok :token/layer ?tokl]]
                                  :in    [[?tokl ?doc]]}
                   [eid document-id])))

(gxe/deftx whitespace-tokenize [node eid document-id text-id]
  (let [existing-tokens (get-existing-tokens node eid document-id)
        text-body (-> (txt/get node text-id) :text/body)
        offsets (toka/filter-overlaps
                  (map (fn [{:token/keys [begin end]}] [begin end]) existing-tokens)
                  (toka/whitespace-tokenize text-body))]
    (reduce into (mapv (fn [[b e]]
                         (let [token {:token/begin b
                                      :token/end   e
                                      :token/text  text-id
                                      :token/layer eid}
                               token (xutil/create-record "token" nil token (filterv #(not= % :token/id) tok/attr-keys))]
                           (tok/safe-create-internal2** node existing-tokens token)))
                       offsets))))

(declare morpheme-tokenize**)
(gxe/deftx morpheme-tokenize [node eid document-id text-id]
  (let [existing-tokens (get-existing-tokens node eid document-id)
        {text-body :text/body :as text} (gxe/entity node text-id)
        {:keys [new-body offsets ops] :as output} (toka/morpheme-tokenize
                                                    text-body
                                                    (map (fn [{:token/keys [begin end]}] [begin end]) existing-tokens)
                                                    \-)]
    ;; At this point, the state of the text body has the raw input. Make the body changes, and then introduce the
    ;; tokens. The body update should produce a body equal to `new-body` (above), and the new offsets assume the
    ;; new-body, not the old body.
    (let [new-token-txs (reduce into (mapv (fn [[b e]]
                                             (let [token {:token/begin b
                                                          :token/end   e
                                                          :token/text  text-id
                                                          :token/layer eid}
                                                   token (xutil/create-record "token" nil token (filterv #(not= % :token/id) tok/attr-keys))]
                                               (tok/safe-create-internal2** node existing-tokens token)))
                                           offsets))
          body-update-txs (txt/update-body** node text-id ops)]
      (into body-update-txs new-token-txs))))

(gxe/deftx update-body-and-morpheme-tokenize [node tokl-id text-id ops]
  (let [{doc-id :text/document} (gxe/entity node text-id)]
    (into (txt/update-body** node text-id ops) (morpheme-tokenize** node tokl-id doc-id text-id))))

(gxe/deftx create-text-and-morpheme-tokenize-internal [node text tokl-id]
  (into [(gxe/put* text)]
        (morpheme-tokenize** node tokl-id (:text/document text) (:text/id text))))

(defn create-text-and-morpheme-tokenize [node text tokl-id]
  (let [{:text/keys [id] :as text} (xutil/create-record "text" nil text txt/attr-keys)]
    {:success (create-text-and-morpheme-tokenize-internal node text tokl-id)
     :id      id}))

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
