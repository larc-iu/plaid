(ns plaid.xtdb.vocab-layer
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations! submit-operations-with-extras!]]
            [plaid.xtdb.user :as user]
            [plaid.xtdb.vocab-item :as vi]
            [taoensso.timbre :as log])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:vocab/id
                :vocab/name
                :vocab/maintainers
                :config])

;; reads --------------------------------------------------------------------------------
(defn get
  "Get vocab layer with all vocab items."
  ([db-like id]
   (get db-like id false))
  ([db-like id include-items?]
   (when-let [record (pxc/entity (pxc/->db db-like) id)]
     (-> record
         (dissoc :xt/id)
         (cond-> include-items?
                 (assoc :vocab/items (vi/get-all-in-layer db-like id)))))))

(defn get-all-ids
  "Get all vocab IDs in the system"
  [db-like]
  (map first (xt/q (pxc/->db db-like)
                   '{:find  [?id]
                     :where [[?e :vocab/id ?id]]})))

(defn get-accessible-ids
  "Get vocab IDs accessible to a user - either as maintainer or admin"
  [db-like user-id]
  (let [db (pxc/->db db-like)
        user-rec (user/get db user-id)]
    (if (user/admin? user-rec)
      ;; Admins can see all vocabs
      (get-all-ids db)
      ;; Otherwise only vocabs where user is maintainer
      (map first (xt/q db
                       '{:find  [?v]
                         :where [[?v :vocab/maintainers ?u]]
                         :in    [?u]}
                       user-id)))))

(defn get-accessible
  "Get all vocab records accessible to a user"
  [db-like user-id]
  (let [db (pxc/->db db-like)
        ids (get-accessible-ids db user-id)]
    (map #(get db %) ids)))

(defn maintainer-ids
  [db-like id]
  (:vocab/maintainers (pxc/entity (pxc/->db db-like) id)))

(defn maintainer?
  "Check if a user is a maintainer of a vocab"
  [db-like vocab-id user-id]
  (contains? (set (maintainer-ids db-like vocab-id)) user-id))

(defn accessible-through-project?
  "Check if a user has access to a vocab through a project"
  [db-like vocab-id user-id]
  (let [db (pxc/->db db-like)]
    ;; Find projects that include this vocab and where user has some access
    (not-empty
      (xt/q db
            '{:find  [?prj]
              :where [[?prj :project/vocabs ?v]
                      (or [?prj :project/readers ?u]
                          [?prj :project/writers ?u]
                          [?prj :project/maintainers ?u])]
              :in    [[?v ?u]]}
            [vocab-id user-id]))))

(defn write-accessible-through-project?
  "Check if a user has write access to vocab items through a project"
  [db-like vocab-id user-id]
  (let [db (pxc/->db db-like)]
    ;; Find projects that include this vocab and where user has some access
    (not-empty
      (xt/q db
            '{:find  [?prj]
              :where [[?prj :project/vocabs ?v]
                      (or [?prj :project/writers ?u]
                          [?prj :project/maintainers ?u])]
              :in    [[?v ?u]]}
            [vocab-id user-id]))))

;; writes --------------------------------------------------------------------------------
(defn create*
  [xt-map attrs]
  (let [{:keys [node db]} (pxc/ensure-db xt-map)
        {:vocab/keys [id name] :as record} (clojure.core/merge (pxc/new-record "vocab")
                                                               (select-keys attrs attr-keys))]
    (when (pxc/find-entity db {:vocab/id id})
      (throw (ex-info (pxc/err-msg-already-exists "Vocab" id)
                      {:code 409 :id id})))
    (when-not (pxc/valid-name? name)
      (throw (ex-info "Invalid vocab name"
                      {:code 400 :name name})))
    [[::xt/match id nil]
     [::xt/put record]]))

(defn create-operation
  [xt-map attrs]
  (op/make-operation
    {:type :vocab/create
     :description (format "Create vocab '%s'" (:vocab/name attrs))
     :tx-ops (create* xt-map attrs)
     :project nil
     :document nil}))

(defn create
  [xt-map attrs user-id]
  (submit-operations-with-extras! xt-map [(create-operation xt-map attrs)] user-id #(-> % last last :xt/id)))

(defn merge-operation
  [xt-map eid m]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        current (pxc/entity db eid)]
    (when-not current
      (throw (ex-info (pxc/err-msg-not-found "Vocab" eid)
                      {:code 404 :id eid})))
    (when (and (contains? m :vocab/name)
               (not (pxc/valid-name? (:vocab/name m))))
      (throw (ex-info "Invalid vocab name"
                      {:code 400 :name (:vocab/name m)})))
    (op/make-operation
      {:type :vocab/update
       :description (format "Update vocab '%s'" (:vocab/name current))
       :tx-ops (pxc/merge* xt-map eid m)
       :project nil
       :document nil})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete*
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        record (pxc/entity db eid)]
    (when-not record
      (throw (ex-info (pxc/err-msg-not-found "Vocab" eid)
                      {:code 404 :id eid})))
    ;; Delete all vocab items in this layer and their dependent vmaps
    (let [vocab-item-ids (map first (xt/q db
                                          '{:find [?vi]
                                            :where [[?vi :vocab-item/layer ?layer]]
                                            :in [?layer]}
                                          eid))
          ;; Get all vmaps that reference these vocab items
          vmap-ids (mapcat (fn [vocab-item-id]
                             (map first (xt/q db
                                               '{:find [?vm]
                                                 :where [[?vm :vmap/vocab-item ?vi]]
                                                 :in [?vi]}
                                               vocab-item-id)))
                           vocab-item-ids)
          vmap-deletions (mapcat (fn [vmap-id]
                                   [[::xt/match vmap-id (pxc/entity db vmap-id)]
                                    [::xt/delete vmap-id]])
                                 vmap-ids)
          vocab-item-deletions (mapcat (fn [item-id]
                                         [[::xt/match item-id (pxc/entity db item-id)]
                                          [::xt/delete item-id]])
                                       vocab-item-ids)]
      (vec
        (concat
          vmap-deletions
          vocab-item-deletions
          [[::xt/match eid record]
           [::xt/delete eid]])))))

(defn delete-operation
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        current (pxc/entity db eid)]
    (op/make-operation
      {:type :vocab/delete
       :description (format "Delete vocab '%s'" (:vocab/name current))
       :tx-ops (delete* xt-map eid)
       :project nil
       :document nil})))

(defn delete
  [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

;; Maintainer management --------------------------------------------------------------------------------
(defn- modify-maintainers*
  [xt-map vocab-id f]
  (let [{:keys [db]} xt-map
        current (pxc/entity db vocab-id)]
    (when-not current
      (throw (ex-info (pxc/err-msg-not-found "Vocab" vocab-id)
                      {:code 404 :id vocab-id})))
    [[::xt/match vocab-id current]
     [::xt/put (f current)]]))

(defn add-maintainer*
  [xt-map vocab-id user-id]
  (modify-maintainers* xt-map vocab-id #(pxc/add-id % :vocab/maintainers user-id)))

(defn add-maintainer-operation
  [xt-map vocab-id user-id]
  (let [{:keys [db]} xt-map
        vocab (pxc/entity db vocab-id)]
    (op/make-operation
      {:type :vocab/add-maintainer
       :description (format "Add maintainer '%s' to vocab '%s'" user-id (:vocab/name vocab))
       :tx-ops (add-maintainer* xt-map vocab-id user-id)
       :project nil
       :document nil})))

(defn add-maintainer
  [xt-map vocab-id user-id actor-user-id]
  (submit-operations! xt-map [(add-maintainer-operation xt-map vocab-id user-id)] actor-user-id))

(defn remove-maintainer*
  [xt-map vocab-id user-id]
  (modify-maintainers* xt-map vocab-id #(pxc/remove-id % :vocab/maintainers user-id)))

(defn remove-maintainer-operation
  [xt-map vocab-id user-id]
  (let [{:keys [db]} xt-map
        vocab (pxc/entity db vocab-id)]
    (op/make-operation
      {:type :vocab/remove-maintainer
       :description (format "Remove maintainer '%s' from vocab '%s'"
                            user-id
                            (:vocab/name vocab))
       :tx-ops (remove-maintainer* xt-map vocab-id user-id)
       :project nil
       :document nil})))

(defn remove-maintainer
  [xt-map vocab-id user-id actor-user-id]
  (submit-operations! xt-map [(remove-maintainer-operation xt-map vocab-id user-id)] actor-user-id))