(ns plaid.xtdb2.vocab-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.user :as user]
            [plaid.xtdb2.vocab-item :as vi])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab/id
                :vocab/name
                :vocab/maintainers
                :config])

;; Reads -------------------------------------------------------------------------

(defn get
  ([node-or-map id]
   (get node-or-map id false))
  ([node-or-map id include-items?]
   (when-let [record (pxc/entity node-or-map :vocab-layers id)]
     (when (:vocab/id record)
       (-> (dissoc record :xt/id)
           (pxc/deserialize-config)
           (cond-> include-items?
                   (assoc :vocab/items (vi/get-all-in-layer node-or-map id))))))))

(defn get-all-ids [node-or-map]
  (->> (pxc/find-entities node-or-map :vocab-layers {})
       (map :xt/id)))

(defn get-accessible-ids
  "Get vocab IDs accessible to a user."
  [node-or-map user-id]
  (let [node (pxc/->node node-or-map)
        user-rec (user/get node-or-map user-id)]
    (if (user/admin? user-rec)
      (get-all-ids node-or-map)
      (let [all-vocabs (pxc/find-entities node :vocab-layers {})
            maintainer-ids (->> all-vocabs
                                (filter #(some #{user-id} (:vocab/maintainers %)))
                                (map :xt/id))
            all-projects (pxc/find-entities node :projects {})
            user-projects (->> all-projects
                               (filter (fn [p]
                                         (or (some #{user-id} (:project/readers p))
                                             (some #{user-id} (:project/writers p))
                                             (some #{user-id} (:project/maintainers p)))))
                               (mapcat :project/vocabs))
            project-granted-ids (distinct user-projects)]
        (distinct (concat maintainer-ids project-granted-ids))))))

(defn get-accessible
  "Get all vocab records accessible to a user."
  [node-or-map user-id]
  (let [ids (get-accessible-ids node-or-map user-id)]
    (keep #(get node-or-map %) ids)))

(defn maintainer-ids [node-or-map id]
  (:vocab/maintainers (pxc/entity node-or-map :vocab-layers id)))

(defn maintainer? [node-or-map vocab-id user-id]
  (contains? (set (maintainer-ids node-or-map vocab-id)) user-id))

(defn accessible-through-project?
  "Check if a user has access to a vocab through a project."
  [node-or-map vocab-id user-id]
  (let [node (pxc/->node node-or-map)
        all-projects (pxc/find-entities node :projects {})]
    (some (fn [p]
            (and (some #{vocab-id} (:project/vocabs p))
                 (or (some #{user-id} (:project/readers p))
                     (some #{user-id} (:project/writers p))
                     (some #{user-id} (:project/maintainers p)))))
          all-projects)))

(defn write-accessible-through-project?
  "Check if a user has write access to vocab items through a project."
  [node-or-map vocab-id user-id]
  (let [node (pxc/->node node-or-map)
        all-projects (pxc/find-entities node :projects {})]
    (some (fn [p]
            (and (some #{vocab-id} (:project/vocabs p))
                 (or (some #{user-id} (:project/writers p))
                     (some #{user-id} (:project/maintainers p)))))
          all-projects)))

;; Mutations ---------------------------------------------------------------------

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        {:vocab/keys [id name] :as record} (clojure.core/merge
                                             (pxc/new-record "vocab")
                                             (select-keys attrs attr-keys))]
    (pxc/valid-name? name)
    [[:put-docs :vocab-layers record]]))

(defn create-operation [xt-map attrs]
  (op/make-operation
   {:type        :vocab/create
    :description (clojure.core/format "Create vocab '%s'" (:vocab/name attrs))
    :tx-ops      (create* xt-map attrs)
    :project     nil
    :document    nil}))

(defn create [xt-map attrs user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs)] user-id
                      #(-> % last last :xt/id)))

(defn merge-operation [xt-map eid m]
  (let [node (pxc/->node xt-map)
        current (pxc/entity node :vocab-layers eid)]
    (when-not current
      (throw (ex-info (pxc/err-msg-not-found "Vocab" eid) {:code 404 :id eid})))
    (when (and (contains? m :vocab/name)
               (not (pxc/valid-name? (:vocab/name m))))
      (throw (ex-info "Invalid vocab name" {:code 400 :name (:vocab/name m)})))
    (op/make-operation
     {:type        :vocab/update
      :description (clojure.core/format "Update vocab '%s'" (:vocab/name current))
      :tx-ops      (pxc/merge* xt-map :vocab-layers :vocab/id eid m)
      :project     nil
      :document    nil})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        record (pxc/entity-with-sys-from node :vocab-layers eid)]
    (when-not (:vocab/id record)
      (throw (ex-info (pxc/err-msg-not-found "Vocab" eid) {:code 404 :id eid})))
    (let [vocab-items (pxc/find-entities node :vocab-items {:vocab-item/layer eid})
          vocab-item-ids (map :xt/id vocab-items)
          ;; Get all vocab-links for these items
          vocab-link-ops (mapcat (fn [vi-id]
                                   (mapcat (fn [vl]
                                             (let [vl-e (pxc/entity-with-sys-from node :vocab-links (:xt/id vl))]
                                               [(pxc/match* :vocab-links vl-e)
                                                [:delete-docs :vocab-links (:xt/id vl)]]))
                                           (pxc/find-entities node :vocab-links {:vocab-link/vocab-item vi-id})))
                                 vocab-item-ids)
          item-ops (mapcat (fn [vi-id]
                             (let [vi-e (pxc/entity-with-sys-from node :vocab-items vi-id)]
                               [(pxc/match* :vocab-items vi-e)
                                [:delete-docs :vocab-items vi-id]]))
                           vocab-item-ids)]
      (vec (concat vocab-link-ops
                   item-ops
                   [(pxc/match* :vocab-layers record)
                    [:delete-docs :vocab-layers eid]])))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        current (pxc/entity node :vocab-layers eid)]
    (op/make-operation
     {:type        :vocab/delete
      :description (clojure.core/format "Delete vocab '%s'" (:vocab/name current))
      :tx-ops      (delete* xt-map eid)
      :project     nil
      :document    nil})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

;; Maintainer management --------------------------------------------------------

(defn- modify-maintainers* [xt-map vocab-id f]
  (let [node (pxc/->node xt-map)
        current (pxc/entity-with-sys-from node :vocab-layers vocab-id)]
    (when-not current
      (throw (ex-info (pxc/err-msg-not-found "Vocab" vocab-id) {:code 404 :id vocab-id})))
    [(pxc/match* :vocab-layers current)
     [:put-docs :vocab-layers (-> (dissoc current :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to) f)]]))

(defn add-maintainer* [xt-map vocab-id user-id]
  (modify-maintainers* xt-map vocab-id #(pxc/add-id % :vocab/maintainers user-id)))

(defn add-maintainer-operation [xt-map vocab-id user-id]
  (let [node (pxc/->node xt-map)
        vocab (pxc/entity node :vocab-layers vocab-id)]
    (op/make-operation
     {:type        :vocab/add-maintainer
      :description (clojure.core/format "Add maintainer '%s' to vocab '%s'" user-id (:vocab/name vocab))
      :tx-ops      (add-maintainer* xt-map vocab-id user-id)
      :project     nil
      :document    nil})))

(defn add-maintainer [xt-map vocab-id user-id actor-user-id]
  (submit-operations! xt-map [(add-maintainer-operation xt-map vocab-id user-id)] actor-user-id))

(defn remove-maintainer* [xt-map vocab-id user-id]
  (modify-maintainers* xt-map vocab-id #(pxc/remove-id % :vocab/maintainers user-id)))

(defn remove-maintainer-operation [xt-map vocab-id user-id]
  (let [node (pxc/->node xt-map)
        vocab (pxc/entity node :vocab-layers vocab-id)]
    (op/make-operation
     {:type        :vocab/remove-maintainer
      :description (clojure.core/format "Remove maintainer '%s' from vocab '%s'" user-id (:vocab/name vocab))
      :tx-ops      (remove-maintainer* xt-map vocab-id user-id)
      :project     nil
      :document    nil})))

(defn remove-maintainer [xt-map vocab-id user-id actor-user-id]
  (submit-operations! xt-map [(remove-maintainer-operation xt-map vocab-id user-id)] actor-user-id))
