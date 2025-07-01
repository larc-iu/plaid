(ns plaid.xtdb.token-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.span-layer :as sl]
            [taoensso.timbre :as log]
            [plaid.algos.token :as toka])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:token-layer/id
                :token-layer/name
                :token-layer/span-layers
                :config])

;; Queries ------------------------------------------------------------------------
(defn get
  "Get a token layer by ID, formatted for external consumption (API responses)."
  [db-like id]
  (when-let [token-layer-entity (pxc/find-entity (pxc/->db db-like) {:token-layer/id id})]
    (select-keys token-layer-entity attr-keys)))

(defn- parent-id [db id]
  (-> (xt/q db
            '{:find  [?txtl]
              :where [[?txtl :text-layer/token-layers ?tokl]]
              :in    [?tokl]}
            id)
      first
      first))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]]
              :in    [?tokl]}
            id)
      first
      first))

(defn get-existing-tokens
  "Find all tokens with their two indices for a given token layer and document."
  [db-like eid document-id]
  (let [db (pxc/->db db-like)]
    (map first (xt/q db '{:find  [(pull ?tok [:token/begin :token/end])]
                          :where [[?prj :project/text-layers ?txtl]
                                  [?doc :document/project ?prj]
                                  [?txtl :text-layer/token-layers ?tokl]
                                  [?txt :text/document ?doc]
                                  [?tok :token/text ?txt]
                                  [?tok :token/layer ?tokl]]
                          :in    [[?tokl ?doc]]}
                     [eid document-id]))))

(defn- project-id-from-txtl [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]]
              :in    [?txtl]}
            id)
      first
      first))

;; Mutations ----------------------------------------------------------------------
(defn create* [xt-map {:token-layer/keys [id] :as attrs} text-layer-id]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:token-layer/keys [id name] :as record} (clojure.core/merge (pxc/new-record "token-layer" id)
                                                                     {:token-layer/span-layers []}
                                                                     (select-keys attrs attr-keys))
        text-layer (pxc/entity db text-layer-id)
        tx [[::xt/match id nil]
            [::xt/match text-layer-id text-layer]
            [::xt/put (update text-layer :text-layer/token-layers conj id)]
            [::xt/put record]]]
    (pxc/valid-name? name)
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Token layer" id) {:id id :code 409}))

      :else
      tx)))

(defn create-operation
  "Build an operation for creating a token layer"
  [xt-map attrs text-layer-id]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        {:token-layer/keys [name]} attrs
        project-id (project-id-from-txtl db text-layer-id)
        tx-ops (create* xt-map attrs text-layer-id)]
    (op/make-operation
     {:type        :token-layer/create
      :project     project-id
      :document    nil
      :description (str "Create token layer \"" name "\" in text layer " text-layer-id)
      :tx-ops      tx-ops})))

(defn create [xt-map attrs text-layer-id user-id]
  (submit-operations-with-extras! xt-map [(create-operation xt-map attrs text-layer-id)] user-id #(-> % last last :xt/id)))

(defn merge-operation
  "Build an operation for updating a token layer"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db eid)
        tx-ops (do (when-let [name (:token-layer/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map eid (select-keys m [:token-layer/name])))]
    (op/make-operation
     {:type        :token-layer/update
      :project     project-id
      :document    nil
      :description (str "Update token layer " eid (when (:token-layer/name m) (str " to name \"" (:token-layer/name m) "\"")))
      :tx-ops      tx-ops})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(def shift-token-layer* (pxc/make-shift-layer* :text-layer/id :token-layer/id :text-layer/token-layers))
(defn shift-token-layer-operation
  "Build an operation for shifting a token layer"
  [xt-map token-layer-id up?]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project-id (project-id db token-layer-id)
        tx-ops (shift-token-layer* xt-map token-layer-id up?)]
    (op/make-operation
     {:type        :token-layer/shift
      :project     project-id
      :document    nil
      :description (str "Shift token layer " token-layer-id " " (if up? "up" "down"))
      :tx-ops      tx-ops})))

(defn shift-token-layer [xt-map token-layer-id up? user-id]
  (submit-operations! xt-map [(shift-token-layer-operation xt-map token-layer-id up?)] user-id))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        {span-layers :token-layer/span-layers :as token-layer} (pxc/entity db eid)
        span-layer-deletions (reduce into [] (map #(sl/delete* xt-map %) span-layers))
        token-ids (map first (xt/q db '{:find  [?tok]
                                        :where [[?tok :token/layer ?tokl]]
                                        :in    [?tokl]}
                                   eid))
        ;; Delete all vmaps for these tokens
        vmap-ids (distinct (mapcat (fn [token-id]
                                     (map first (xt/q db
                                                      '{:find [?vm]
                                                        :where [[?vm :vmap/tokens ?tok]]
                                                        :in [?tok]}
                                                      token-id)))
                                   token-ids))
        vmap-deletions (reduce into (mapv (fn [vmap-id]
                                            [[::xt/match vmap-id (pxc/entity db vmap-id)]
                                             [::xt/delete vmap-id]])
                                          vmap-ids))
        token-deletions (reduce into (mapv (fn [id]
                                             [[::xt/match id (pxc/entity db id)]
                                              [::xt/delete id]])
                                           token-ids))]
    (cond
      (nil? (:token-layer/id token-layer))
      (throw (ex-info (pxc/err-msg-not-found "Token layer" eid) {:code 404}))

      :else
      (reduce into
              []
              [vmap-deletions
               span-layer-deletions
               token-deletions
               [[::xt/match eid (pxc/entity db eid)]
                [::xt/delete eid]]]))))


(defn delete-operation
  "Build an operation for deleting a token layer"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        token-layer (pxc/entity db eid)
        project-id (project-id db eid)
        span-layers (:token-layer/span-layers token-layer)
        base-tx (delete* xt-map eid)
        text-layer-id (parent-id db eid)
        text-layer (pxc/entity db text-layer-id)
        delete-layer-tx [[::xt/match text-layer-id text-layer]
                         [::xt/put (pxc/remove-id text-layer :text-layer/token-layers eid)]]
        all-tx-ops (into base-tx delete-layer-tx)]
    (op/make-operation
     {:type        :token-layer/delete
      :project     project-id
      :document    nil
      :description (str "Delete token layer " eid " with " (count span-layers) " span layers")
      :tx-ops      all-tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

;; Other --------------------------------------------------------------------------------
(defn sort-token-records [tokens]
  (->> tokens
       (sort-by #(or (:token/precedence %) 0) <)
       (sort-by :token/begin)))