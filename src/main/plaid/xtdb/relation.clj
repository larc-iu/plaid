(ns plaid.xtdb.relation
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:relation/id
                :relation/layer
                :relation/source
                :relation/target
                :relation/value])

;; Queries ------------------------------------------------------------------------
(defn get
  [db-like id]
  (pxc/find-entity (pxc/->db db-like) {:relation/id id}))

(defn project-id [db-like id]
  (-> (xt/q (pxc/->db db-like)
            '{:find  [?prj]
              :where [[?prj :project/text-layers ?txtl]
                      [?txtl :text-layer/token-layers ?tokl]
                      [?tokl :token-layer/span-layers ?sl]
                      [?sl :span-layer/relation-layers ?rl]
                      [?r :relation/layer ?rl]]
              :in    [?r]}
            id)
      first
      first))

(defn get-doc-id-of-span
  "Get document id of a span"
  [db-like span-id]
  (ffirst
    (xt/q (pxc/->db db-like)
          '{:find  [?doc]
            :where [[?s :span/tokens ?tok]
                    [?tok :token/text ?txt]
                    [?txt :text/document ?doc]]
            :in    [?s]}
          span-id)))

;; Mutations --------------------------------------------------------------------------------
(defn create* [xt-map attrs]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        {:relation/keys [id layer source target] :as r} (clojure.core/merge (pxc/new-record "relation")
                                                                            (select-keys attrs attr-keys))
        source-record (pxc/entity db source)
        target-record (pxc/entity db target)]

    (cond
      ;; ID is not already taken?
      (some? (pxc/entity db id))
      (throw (ex-info (pxc/err-msg-already-exists "Relation" id) {:id id :code 409}))

      ;; Relation layer exists?
      (not (:relation-layer/id (pxc/entity db layer)))
      (throw (ex-info (pxc/err-msg-not-found "Relation layer" layer) {:id layer :code 400}))

      ;; Source span exists?
      (not (:span/id source-record))
      (throw (ex-info (str "Source span " source " does not exist") {:id source :code 400}))

      ;; Target span exists?
      (not (:span/id target-record))
      (throw (ex-info (str "Source span " target " does not exist") {:id target :code 400}))

      ;; Source and target spans in same layer?
      (not= (:span/layer source-record) (:span/layer target-record))
      (throw (ex-info "Source and target relations must be contained in a single span layer."
                      {:source-layer (:span/layer source-record)
                       :target-layer (:span/layer target-record)
                       :code         400}))

      ;; Relation layer linked to span layer?
      (not ((set (:span-layer/relation-layers (pxc/entity db (:span/layer source-record)))) layer))
      (throw (ex-info (str "Relation layer " layer " is not connected to span layer " (:span/layer source-record))
                      {:relation-layer layer :span-layer (:span/layer source-record) :code 400}))

      ;; Source and target spans in same doc?
      (not= (get-doc-id-of-span db source) (get-doc-id-of-span db target))
      (throw (ex-info "Source and target relations must be in a single document."
                      {:source-document (get-doc-id-of-span db source)
                       :target-document (get-doc-id-of-span db target)
                       :code            400}))

      :else
      [[::xt/match id nil]
       [::xt/match source source-record]
       [::xt/match target target-record]
       [::xt/match layer (pxc/entity db layer)]
       [::xt/put r]])))

(defn create [{:keys [node] :as xt-map} attrs]
  (pxc/submit-with-extras! node (create* xt-map attrs) #(-> % last last :xt/id)))

(defn merge
  [{:keys [node db] :as xt-map} eid m]
  (pxc/submit! node (pxc/merge* xt-map eid (select-keys m [:relation/value]))))

(defn set-end*
  "Modify either :relation/source or :relation/target, controlled by key"
  [xt-map eid key span-id]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        {:relation/keys [id layer source target] :as r} (pxc/entity db eid)
        new-span (pxc/entity db span-id)
        other-span (if (= :relation/target key)
                     (pxc/entity db source)
                     (pxc/entity db target))]
    (cond
      ;; Relation exists?
      (nil? id)
      (throw (ex-info (pxc/err-msg-not-found "Relation" eid) {:id eid :code 404}))

      ;; Span exists?
      (not (:span/id new-span))
      (throw (ex-info (str "Span " span-id " does not exist") {:id span-id :code 400}))

      ;; Relation layer linked to span layer?
      (not ((set (:span-layer/relation-layers (pxc/entity db (:span/layer new-span)))) layer))
      (throw (ex-info (str "Relation layer " layer " is not connected to span layer " (:span/layer new-span))
                      {:relation-layer layer :span-layer (:span/layer new-span) :code 400}))

      ;; Key is valid?
      (not (#{:relation/source :relation/target} key))
      (throw (ex-info "Key must be either :relation/source or :relation/target"
                      {:code 500 :key key}))

      ;; Source and target spans in same doc?
      (not= (get-doc-id-of-span db (:span/id new-span)) (get-doc-id-of-span db (:span/id other-span)))
      (throw (ex-info "Source and target relations must be in a single document."
                      {:source-document (get-doc-id-of-span db (:span/id source))
                       :target-document (get-doc-id-of-span db (:span/id target))
                       :code            400}))


      ;; Spans in same layer?
      (not= (:span/layer other-span) (:span/layer new-span))
      (throw (ex-info "Source and target relations must be in the same layer."
                      {:current-layer (:span/layer other-span)
                       :new-layer     (:span/layer new-span)
                       :code          400}))

      :else
      [[::xt/match id r]
       [::xt/match source (pxc/entity db source)]
       [::xt/match target (pxc/entity db target)]
       [::xt/match layer (pxc/entity db layer)]
       [::xt/match span-id new-span]
       [::xt/put (assoc r key span-id)]])))

(defn set-end [xt-map eid key span-id]
  (pxc/submit! (:node xt-map) (set-end* xt-map eid key span-id)))

(defn delete* [xt-map eid]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        r (pxc/entity db eid)]

    (when-not (:relation/id (pxc/entity db eid))
      (throw (ex-info (pxc/err-msg-not-found "Relation" eid) {:code 404 :id eid})))

    [[::xt/match eid r]
     [::xt/delete eid]]))

(defn delete [xt-map eid]
  (pxc/submit! (:node xt-map) (delete* xt-map eid)))