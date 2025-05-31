(ns plaid.xtdb.project
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.access :as pxa]
            [plaid.xtdb.text-layer :as txtl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:project/id
                :project/name
                :project/readers
                :project/writers
                :project/maintainers
                :project/text-layers])

;; reads --------------------------------------------------------------------------------
(defn get-document-ids [db-like id]
  (map first (xt/q (pxc/->db db-like)
                   '{:find  [?doc]
                     :where [[?doc :document/project ?prj]]
                     :in    [?prj]}
                   id)))

(defn get
  [db-like id]
  (dissoc (pxc/find-entity (pxc/->db db-like) {:project/id id})
          :xt/id))

(defn reader-ids
  [db-like id]
  (:project/readers (pxc/entity (pxc/->db db-like) id)))

(defn writer-ids
  [db-like id]
  (:project/writers (pxc/entity (pxc/->db db-like) id)))

(defn maintainer-ids
  [db-like id]
  (:project/maintainers (pxc/entity (pxc/->db db-like) id)))

(defn get-all
  [db-like]
  (->> (pxc/find-entities (pxc/->db db-like) {:project/id '_})
       (mapv #(dissoc % :xt/id))))

(defn get-by-name
  [db-like name]
  (pxc/find-entity (pxc/->db db-like) {:project/name name}))

(defn get-accessible-ids [db-like user-id]
  (pxa/get-accessible-ids (pxc/->db db-like) user-id :project/id))

(defn get-accessible-projects
  "Return a seq of full projects accessible for a user"
  [db-like user-id]
  (let [db (pxc/->db db-like)]
    (->> (get-accessible-ids db user-id)
         (map vector)
         (pxc/entities db))))

;; writes --------------------------------------------------------------------------------
(defn create* [xt-map attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:project/keys [id] :as record} (clojure.core/merge (pxc/new-record "project")
                                               {:project/readers     []
                                                :project/writers     []
                                                :project/maintainers []
                                                :project/text-layers []}
                                               (select-keys attrs attr-keys))]
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (str "Project already exists with ID " id) {:code 409}))

      :else
      [[::xt/match id nil]
       [::xt/put record]])))

(defn create [{:keys [node] :as xt-map} attrs]
  (pxc/submit-with-extras! node (create* xt-map attrs) #(-> % last last :xt/id)))

(defn merge
  [{:keys [node db] :as xt-map} eid m]
  (pxc/submit! node (pxc/merge* xt-map eid (select-keys m [:project/name]))))

(defn delete*
  [xt-map eid]
  ;; A project needs to delete three kinds of things
  ;; - Its dependent text layers
  ;; - Its dependent documents
  ;; - Itself
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        text-layers (:project/text-layers (pxc/entity db eid))
        txtl-txs (reduce into (mapv #(txtl/delete* xt-map %) text-layers))
        documents (get-document-ids db eid)
        doc-txs (mapcat (fn [id]
                          [[::xt/match id (pxc/entity db id)]
                           [::xt/delete id]])
                        documents)
        project (pxc/entity db eid)
        project-txs [[::xt/match (:xt/id project) project]
                     [::xt/delete eid]]
        all-txs (reduce into [txtl-txs doc-txs project-txs])]
    (cond
      (nil? (:project/id project))
      (throw (ex-info (pxc/err-msg-not-found "Project" eid) {:code 404}))

      :else
      all-txs)))

(defn delete [{:keys [node] :as xt-map} eid]
  (pxc/submit! node (delete* xt-map eid)))

;; access privileges --------------------------------------------------------------------------------
(defn- modify-privileges* [xt-map project-id user-id [add? key]]
  (let [{:keys [node db] :as xt-map} (pxc/ensure-db xt-map)
        user (pxc/entity db user-id)
        project (pxc/entity db project-id)
        new-project (-> project
                        (pxc/remove-id :project/readers user-id)
                        (pxc/remove-id :project/writers user-id)
                        (pxc/remove-id :project/maintainers user-id)
                        (cond-> (and add? (= key :project/readers))
                                (pxc/add-id :project/readers user-id)

                                (and add? (= key :project/writers))
                                (pxc/add-id :project/writers user-id)

                                (and add? (= key :project/maintainers))
                                (pxc/add-id :project/maintainers user-id)))]
    (cond
      (nil? (:user/id user))
      (throw (ex-info (str "Not a valid user ID: " user-id) {:id user-id :code 400}))

      (nil? (:project/id project))
      (throw (ex-info (str "Not a valid project ID: " project-id) {:id project-id :code 400}))

      :else
      (reduce into
              [[[::xt/match user-id user]
                [::xt/match project-id project]
                [::xt/put new-project]]]))))


(defn add-reader*
  [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [true :project/readers]))
(defn add-reader [xt-map project-id user-id]
  (pxc/submit! (:node xt-map) (add-reader* xt-map project-id user-id)))

(defn remove-reader* [{:keys [node] :as xt-map} project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/readers]))
(defn remove-reader [xt-map project-id user-id]
  (pxc/submit! (:node xt-map) (remove-reader* xt-map project-id user-id)))

(defn add-writer*
  [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [true :project/writers]))
(defn add-writer [xt-map project-id user-id]
  (pxc/submit! (:node xt-map) (add-writer* xt-map project-id user-id)))

(defn remove-writer* [{:keys [node] :as xt-map} project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/writers]))
(defn remove-writer [xt-map project-id user-id]
  (pxc/submit! (:node xt-map) (remove-writer* xt-map project-id user-id)))

(defn add-maintainer*
  [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [true :project/maintainers]))
(defn add-maintainer [xt-map project-id user-id]
  (pxc/submit! (:node xt-map) (add-maintainer* xt-map project-id user-id)))

(defn remove-maintainer* [{:keys [node] :as xt-map} project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/maintainers]))
(defn remove-maintainer [xt-map project-id user-id]
  (pxc/submit! (:node xt-map) (remove-maintainer* xt-map project-id user-id)))

;; This is not actually a project operation, but this is the most sensible place to put it
(defn assoc-editor-config-pair [xt-map layer-id editor-name config-key config-value]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        layer (pxc/entity db layer-id)
        new-layer (assoc-in layer [:config editor-name config-key] config-value)
        tx [[::xt/match (:xt/id layer) layer]
            [::xt/put new-layer]]]
    (cond
      (not (pxc/layer? layer))
      (throw (ex-info (str "Not a valid layer ID: " layer-id) {:id layer-id :code 400}))

      :else
      (pxc/submit! node tx))))

(defn dissoc-editor-config-pair [xt-map layer-id editor-name config-key]
  (let [{:keys [db node] :as xt-map} (pxc/ensure-db xt-map)
        layer (pxc/entity db layer-id)
        new-layer (update-in layer [:config editor-name] dissoc config-key)
        tx [[::xt/match (:xt/id layer) layer]
            [::xt/put new-layer]]]
    (cond
      (not (pxc/layer? layer))
      (throw (ex-info (str "Not a valid layer ID: " layer-id) {:id layer-id :code 400}))

      :else
      (pxc/submit! node tx))))
