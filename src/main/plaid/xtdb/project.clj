(ns plaid.xtdb.project
  (:require [plaid.xtdb.user :as user]
            [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]
            [plaid.xtdb.operation :as op :refer [submit-operations!]]
            [plaid.xtdb.text-layer :as txtl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:project/id
                :project/name
                :project/readers
                :project/writers
                :project/maintainers
                :project/text-layers
                :project/vocabs
                :config])

;; reads --------------------------------------------------------------------------------
(defn get-document-ids [db-like id]
  (map first (xt/q (pxc/->db db-like)
                   '{:find [?doc]
                     :where [[?doc :document/project ?prj]]
                     :in [?prj]}
                   id)))

(defn get-documents [db-like id]
  (map first (xt/q (pxc/->db db-like)
                   '{:find [(pull ?doc [:document/id :document/name])]
                     :where [[?doc :document/project ?prj]]
                     :in [?prj]}
                   id)))

(defn get
  ([db-like id]
   (get db-like id false))
  ([db-like id include-documents]
   (when-let [e (xt/pull (pxc/->db db-like)
                         [:project/id :project/name :project/readers :project/writers :project/maintainers
                          {:project/vocabs [:vocab/id :vocab/name :vocab/maintainers :config]}
                          :config
                          {:project/text-layers [:text-layer/id :text-layer/name :config
                                                 {:text-layer/token-layers
                                                  [:token-layer/id :token-layer/name :config
                                                   {:token-layer/span-layers
                                                    [:span-layer/id :span-layer/name :config
                                                     {:span-layer/relation-layers
                                                      [:relation-layer/id :relation-layer/name :config]}]}]}]}]
                         id)]
     (-> e
         (dissoc :xt/id)
         (cond-> include-documents (assoc :project/documents (get-documents db-like id)))))))

(defn reader-ids
  [db-like id]
  (:project/readers (pxc/entity (pxc/->db db-like) id)))

(defn writer-ids
  [db-like id]
  (:project/writers (pxc/entity (pxc/->db db-like) id)))

(defn maintainer-ids
  [db-like id]
  (:project/maintainers (pxc/entity (pxc/->db db-like) id)))

(defn get-all-ids
  [db-like]
  (map first (pxc/find-entity-ids (pxc/->db db-like) {:project/id '_})))

(defn get-accessible-ids [db-like user-id]
  (let [db (pxc/->db db-like)]
    (map first (xt/q db '{:find [?p]
                          :where [(or [?p :project/readers ?u]
                                      [?p :project/writers ?u]
                                      [?p :project/maintainers ?u])]
                          :in [?u]}
                     user-id))))

(defn get-accessible
  [db-like user-id]
  (if (user/admin? (user/get db-like user-id))
    (->> (get-all-ids db-like)
         (mapv #(get db-like %)))
    (->> (get-accessible-ids db-like user-id)
         (mapv #(get db-like %)))))

(defn get-by-name
  [db-like name]
  (pxc/find-entity (pxc/->db db-like) {:project/name name}))

(defn project-id [db-like id]
  "For projects, the project-id is the entity's own ID"
  id)

;; writes --------------------------------------------------------------------------------
(defn create* [xt-map attrs]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        {:project/keys [id name] :as record} (clojure.core/merge (pxc/new-record "project")
                                                                 {:project/readers []
                                                                  :project/writers []
                                                                  :project/maintainers []
                                                                  :project/text-layers []
                                                                  :project/vocabs []
                                                                  :config {}}
                                                                 (select-keys attrs attr-keys))]
    (pxc/valid-name? name)
    (cond
      (some? (pxc/entity db id))
      (throw (ex-info (str "Project already exists with ID " id) {:code 409}))

      :else
      [[::xt/match id nil]
       [::xt/put record]])))

(defn create-operation
  "Build an operation for creating a project"
  [xt-map attrs]
  (let [{:project/keys [name]} attrs
        tx-ops (create* xt-map attrs)]
    (op/make-operation
     {:type :project/create
      :project (-> tx-ops last last :xt/id)
      :document nil
      :description (str "Create project \"" name "\"")
      :tx-ops tx-ops})))

(defn create [xt-map attrs user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs)] user-id #(-> % last last :xt/id)))

(defn merge-operation
  "Build an operation for updating a project"
  [xt-map eid m]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project (pxc/entity db eid)
        tx-ops (do (when-let [name (:project/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map :project/id eid (select-keys m [:project/name])))]

    (op/make-operation
     {:type :project/update
      :project eid
      :document nil
      :description (str "Update project " eid (when (:project/name m) (str " to name \"" (:project/name m) "\"")))
      :tx-ops tx-ops})))

(defn merge
  [{:keys [node db] :as xt-map} eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete*
  [xt-map eid]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        text-layers (:project/text-layers (pxc/entity db eid))
        txtl-txs (reduce into [] (mapv #(txtl/delete* xt-map %) text-layers))
        documents (get-document-ids db eid)
        doc-txs (mapcat (fn [id]
                          [[::xt/match id (pxc/entity db id)]
                           [::xt/delete id]])
                        documents)
        project (pxc/entity db eid)
        project-txs [[::xt/match (:xt/id project) project]
                     [::xt/delete eid]]
        all-txs (vec (concat txtl-txs doc-txs project-txs))]
    (cond
      (nil? (:project/id project))
      (throw (ex-info (pxc/err-msg-not-found "Project" eid) {:code 404}))

      :else
      all-txs)))

(defn delete-operation
  "Build an operation for deleting a project"
  [xt-map eid]
  (let [{:keys [db]} (pxc/ensure-db xt-map)
        project (pxc/entity db eid)
        text-layers (:project/text-layers project)
        documents (get-document-ids db eid)
        tx-ops (delete* xt-map eid)]
    (op/make-operation
     {:type :project/delete
      :project eid
      :document nil
      :description (str "Delete project " eid " with " (count text-layers) " text layers and " (count documents) " documents")
      :tx-ops tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

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
(defn add-reader-operation
  "Build an operation for adding a reader to a project"
  [xt-map project-id user-id]
  (let [tx-ops (add-reader* xt-map project-id user-id)]
    (op/make-operation
     {:type :project/add-reader
      :project project-id
      :document nil
      :description (str "Add reader " user-id " to project " project-id)
      :tx-ops tx-ops})))

(defn add-reader [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(add-reader-operation xt-map project-id user-id)] actor-user-id))

(defn remove-reader* [{:keys [node] :as xt-map} project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/readers]))
(defn remove-reader-operation
  "Build an operation for removing a reader from a project"
  [xt-map project-id user-id]
  (let [tx-ops (remove-reader* xt-map project-id user-id)]
    (op/make-operation
     {:type :project/remove-reader
      :project project-id
      :document nil
      :description (str "Remove reader " user-id " from project " project-id)
      :tx-ops tx-ops})))

(defn remove-reader [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(remove-reader-operation xt-map project-id user-id)] actor-user-id))

(defn add-writer*
  [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [true :project/writers]))
(defn add-writer-operation
  "Build an operation for adding a writer to a project"
  [xt-map project-id user-id]
  (let [tx-ops (add-writer* xt-map project-id user-id)]
    (op/make-operation
     {:type :project/add-writer
      :project project-id
      :document nil
      :description (str "Add writer " user-id " to project " project-id)
      :tx-ops tx-ops})))

(defn add-writer [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(add-writer-operation xt-map project-id user-id)] actor-user-id))

(defn remove-writer* [{:keys [node] :as xt-map} project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/writers]))
(defn remove-writer-operation
  "Build an operation for removing a writer from a project"
  [xt-map project-id user-id]
  (let [tx-ops (remove-writer* xt-map project-id user-id)]
    (op/make-operation
     {:type :project/remove-writer
      :project project-id
      :document nil
      :description (str "Remove writer " user-id " from project " project-id)
      :tx-ops tx-ops})))

(defn remove-writer [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(remove-writer-operation xt-map project-id user-id)] actor-user-id))

(defn add-maintainer*
  [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [true :project/maintainers]))
(defn add-maintainer-operation
  "Build an operation for adding a maintainer to a project"
  [xt-map project-id user-id]
  (let [tx-ops (add-maintainer* xt-map project-id user-id)]
    (op/make-operation
     {:type :project/add-maintainer
      :project project-id
      :document nil
      :description (str "Add maintainer " user-id " to project " project-id)
      :tx-ops tx-ops})))

(defn add-maintainer [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(add-maintainer-operation xt-map project-id user-id)] actor-user-id))

(defn remove-maintainer* [{:keys [node] :as xt-map} project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/maintainers]))
(defn remove-maintainer-operation
  "Build an operation for removing a maintainer from a project"
  [xt-map project-id user-id]
  (let [tx-ops (remove-maintainer* xt-map project-id user-id)]
    (op/make-operation
     {:type :project/remove-maintainer
      :project project-id
      :document nil
      :description (str "Remove maintainer " user-id " from project " project-id)
      :tx-ops tx-ops})))

(defn remove-maintainer [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(remove-maintainer-operation xt-map project-id user-id)] actor-user-id))

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

 ;; Vocab management --------------------------------------------------------------------------------
(defn add-vocab*
  [xt-map project-id vocab-id]
  (let [{:keys [db]} xt-map
        project (pxc/entity db project-id)
        vocab (pxc/entity db vocab-id)]
    (cond
      (nil? project)
      (throw (ex-info (pxc/err-msg-not-found "Project" project-id)
                      {:code 404 :id project-id}))

      (nil? vocab)
      (throw (ex-info (pxc/err-msg-not-found "Vocab" vocab-id)
                      {:code 400 :id vocab-id}))

      :else
      [[::xt/match project-id project]
       [::xt/put (pxc/add-id project :project/vocabs vocab-id)]])))

(defn add-vocab-operation
  [xt-map project-id vocab-id]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        project (pxc/entity db project-id)
        vocab (pxc/entity db vocab-id)]
    (op/make-operation
     {:type :project/add-vocab
      :project project-id
      :document nil
      :description (format "Add vocab '%s' to project '%s'"
                           (:vocab/name vocab)
                           (:project/name project))
      :tx-ops (add-vocab* xt-map project-id vocab-id)})))

(defn add-vocab
  [xt-map project-id vocab-id actor-user-id]
  (submit-operations! xt-map [(add-vocab-operation xt-map project-id vocab-id)] actor-user-id))

(defn remove-vocab*
  [xt-map project-id vocab-id]
  (let [{:keys [db]} xt-map
        project (pxc/entity db project-id)]
    (cond
      (nil? project)
      (throw (ex-info (pxc/err-msg-not-found "Project" project-id)
                      {:code 404 :id project-id}))

      (nil? (pxc/entity db vocab-id))
      (throw (ex-info (pxc/err-msg-not-found "Vocab" vocab-id)
                      {:code 400 :id vocab-id}))

      :else
      ;; Find all vocab-links that belong to vocab items in this vocab layer 
      ;; and have tokens in documents belonging to this project
      (let [vocab-link-ids (map first (xt/q db
                                            '{:find [?vl]
                                              :where [[?doc :document/project ?prj]
                                                      [?txt :text/document ?doc]
                                                      [?tok :token/text ?txt]
                                                      [?vi :vocab-item/layer ?vocab-layer]
                                                      [?vl :vocab-link/vocab-item ?vi]
                                                      [?vl :vocab-link/tokens ?tok]]
                                              :in [?vocab-layer ?prj]}
                                            vocab-id project-id))
            vocab-link-deletions (if (seq vocab-link-ids)
                                   (vec (mapcat (fn [vocab-link-id]
                                                  (when-let [entity (pxc/entity db vocab-link-id)]
                                                    [[::xt/match vocab-link-id entity]
                                                     [::xt/delete vocab-link-id]]))
                                                vocab-link-ids))
                                   [])
            project-update-ops [[::xt/match project-id project]
                                [::xt/put (pxc/remove-id project :project/vocabs vocab-id)]]]
        (into vocab-link-deletions project-update-ops)))))

(defn remove-vocab-operation
  [xt-map project-id vocab-id]
  (let [{:keys [db] :as xt-map} (pxc/ensure-db xt-map)
        project (pxc/entity db project-id)
        vocab (pxc/entity db vocab-id)]
    (op/make-operation
     {:type :project/remove-vocab
      :project project-id
      :document nil
      :description (format "Remove vocab '%s' from project '%s'"
                           (:vocab/name vocab)
                           (:project/name project))
      :tx-ops (remove-vocab* xt-map project-id vocab-id)})))

(defn remove-vocab
  [xt-map project-id vocab-id actor-user-id]
  (submit-operations! xt-map [(remove-vocab-operation xt-map project-id vocab-id)] actor-user-id))
