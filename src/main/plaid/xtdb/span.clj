(ns plaid.xtdb.span
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.relation :as r])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:span/id
                :span/tokens
                :span/value
                :span/layer])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (pxc/find-entity (pxc/->db db-like) {:span/id id}))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tokl :token-layer/span-layers ?sl]
                      [?s :span/layer ?sl]]
              :in    [?s]}
            id)
      first
      first))

(defn get-relation-ids [db-like eid]
  (map first (xt/q (pxc/->db db-like)
                   '{:find  [?relation]
                     :where [(or [?relation :relation/source ?id] [?relation :relation/target ?id])]
                     :in    [?id]}
                   eid)))

(defn get-doc-id-of-token
  [db-like token-id]
  (ffirst
    (xt/q (pxc/->db db-like)
          '{:find  [?doc]
            :where [[?tok :token/text ?txt]
                    [?txt :text/document ?doc]]
            :in    [?tok]}
          token-id)))

;; Mutations --------------------------------------------------------------------------------
(defn create*
  [xt-map attrs]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        {:span/keys [id tokens layer value] :as span} (clojure.core/merge (pxc/new-record "span")
                                                                          (select-keys attrs attr-keys))
        token-records (map #(pxc/entity db %) tokens)
        {token-layer-id :token/layer} (first token-records)
        {span-layers :token-layer/span-layers} (pxc/entity db token-layer-id)]

    (cond
      ;; ID is not already taken?
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Span" id) {:id id :code 409}))

      ;; Span layer exists?
      (nil? (:span-layer/id (pxc/entity db layer)))
      (throw (ex-info (pxc/err-msg-not-found "Span layer" layer) {:id layer :code 400}))

      ;; All tokens exist?
      (not (every? :token/id token-records))
      (throw (ex-info "Not all token IDs are valid." {:ids tokens :code 400}))

      ;; All tokens belong to the same layer?
      (not (and (some? token-layer-id)
                (every? #(= token-layer-id %) (map :token/layer token-records))))
      (throw (ex-info "Not all token IDs belong to the same layer."
                      {:layer-ids (map :token/layer token-records) :code 400}))

      ;; Tokens belong to a layer that is linked to the span layer?
      (not ((set span-layers) layer))
      (throw (ex-info (str "Token layer " token-layer-id " is not linked to span layer " layer)
                      {:token-layer-id token-layer-id :span-layer-id layer :code 400}))

      ;; All tokens belong to the same document?
      (not (= 1 (count (set (map (partial get-doc-id-of-token db) tokens)))))
      (throw (ex-info "Not all token IDs belong to the same document."
                      {:document-ids (map (partial get-doc-id-of-token db) tokens) :code 400}))

      :else
      (let [token-matches (mapv (fn [[id record]]
                                  [::xt/match id record])
                                (map vector tokens token-records))
            matches (into [[::xt/match id nil]
                           [::xt/match layer (pxc/entity db layer)]]
                          token-matches)]
        (conj matches [::xt/put span])))))

(defn create [{:keys [node] :as xt-map} attrs]
  (pxc/submit-with-extras! node (create* xt-map attrs) #(-> % last last :xt/id)))

(defn merge
  [{:keys [node db] :as xt-map} eid m]
  (pxc/submit! node (pxc/merge* xt-map eid (select-keys m [:span/value]))))

(defn delete* [xt-map eid]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        relations (get-relation-ids db eid)
        relation-deletes (reduce into (mapv #(r/delete* xt-map %) relations))
        span-delete [[::xt/match eid (pxc/entity db eid)]
                     [::xt/delete eid]]]

    (when-not (:span/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Span" eid) {:code 404 :id eid})))

    (reduce into
            [relation-deletes
             span-delete])))

(defn delete [xt-map eid]
  (pxc/submit! (:node xt-map) (delete* xt-map eid)))

(defn add-token* [xt-map span-id token-id]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        {:span/keys [id tokens layer]} (pxc/entity db span-id)
        new-token (pxc/entity db token-id)
        new-layer (:token/layer new-token)
        existing-layer (:token/layer (:first (pxc/entity db (first tokens))))]

    (cond
      ;; All tokens exist?
      (nil? (:token/id new-token))
      (throw (ex-info "Token ID is not valid." {:id token-id :code 400}))

      ;; All tokens belong to the same layer?
      (not= new-layer existing-layer)
      (throw (ex-info (str "Span already contains tokens for layer " existing-layer " but new token is on layer " new-layer)
                      {:existing-layer existing-layer :new-layer new-layer :code 400}))

      :else
      (pxc/add-join* xt-map :span/id span-id :span/tokens :token/id token-id))))

(defn add-token [xt-map span-id token-id]
  (pxc/submit! (:node xt-map) (add-token* xt-map span-id token-id)))

(defn remove-token*
  [xt-map span-id token-id]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        span (pxc/entity db span-id)
        base-txs (pxc/remove-join* xt-map :span/id span-id :span/tokens :token/id token-id)]
    (if (and (= 1 (-> span :span/tokens count))
             (= token-id (first (:span/tokens span))))
      (into base-txs (delete* xt-map span-id))
      base-txs)))

(defn remove-token [xt-map span-id token-id]
  (pxc/submit! (:node xt-map) (remove-token* xt-map span-id token-id)))
