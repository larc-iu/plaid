(ns plaid.xtdb2.project
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]
            [plaid.xtdb2.operation :as op :refer [submit-operations!]]
            [plaid.xtdb2.user :as user]
            [plaid.xtdb2.text-layer :as txtl])
  (:refer-clojure :exclude [get merge]))

(def attr-keys [:project/id
                :project/name
                :project/readers
                :project/writers
                :project/maintainers
                :project/text-layers
                :project/vocabs
                :config])

;; Layer enrichment --------------------------------------------------------------

(def ^:private table-sql-names
  {:text-layers "text_layers"
   :token-layers "token_layers"
   :span-layers "span_layers"
   :relation-layers "relation_layers"
   :vocab-layers "vocab_layers"})

(defn- sql-in-query
  "Build and execute a SQL IN query for a table with given IDs."
  [node table ids]
  (if (empty? ids)
    []
    (let [ph (str/join ", " (repeat (count ids) "?"))
          table-name (clojure.core/get table-sql-names table (name table))]
      (xt/q node (into [(str "SELECT * FROM " table-name " WHERE _id IN (" ph ")")] ids)))))

(defn- format-layer
  "Select relevant keys from a layer entity and deserialize config."
  [entity keys-to-keep]
  (-> (select-keys entity keys-to-keep)
      pxc/deserialize-config))

(defn- enrich-layers
  "Build nested layer hierarchy for a project. Uses 4 queries (one per layer level)
  plus 1 for vocab-layers."
  [node project]
  (let [text-layer-ids (:project/text-layers project)
        vocab-ids (:project/vocabs project)
        ;; 1. Fetch all text-layers
        text-layers (sql-in-query node :text-layers (vec text-layer-ids))
        ;; 2. Collect and fetch all token-layers
        all-tokl-ids (vec (mapcat :text-layer/token-layers text-layers))
        token-layers (sql-in-query node :token-layers all-tokl-ids)
        tokl-by-id (into {} (map (juxt :xt/id identity) token-layers))
        ;; 3. Collect and fetch all span-layers
        all-sl-ids (vec (mapcat :token-layer/span-layers token-layers))
        span-layers (sql-in-query node :span-layers all-sl-ids)
        sl-by-id (into {} (map (juxt :xt/id identity) span-layers))
        ;; 4. Collect and fetch all relation-layers
        all-rl-ids (vec (mapcat :span-layer/relation-layers span-layers))
        relation-layers (sql-in-query node :relation-layers all-rl-ids)
        rl-by-id (into {} (map (juxt :xt/id identity) relation-layers))
        ;; 5. Fetch vocab-layers
        vocabs (sql-in-query node :vocab-layers (vec vocab-ids))
        ;; Assemble bottom-up
        format-rl (fn [rl] (format-layer rl [:relation-layer/id :relation-layer/name :config]))
        format-sl (fn [sl]
                    (-> (format-layer sl [:span-layer/id :span-layer/name :config :span-layer/relation-layers])
                        (update :span-layer/relation-layers
                                (fn [rl-ids] (mapv #(format-rl (clojure.core/get rl-by-id %)) rl-ids)))))
        format-tokl (fn [tokl]
                      (-> (format-layer tokl [:token-layer/id :token-layer/name :config :token-layer/span-layers])
                          (update :token-layer/span-layers
                                  (fn [sl-ids] (mapv #(format-sl (clojure.core/get sl-by-id %)) sl-ids)))))
        format-txtl (fn [txtl]
                      (-> (format-layer txtl [:text-layer/id :text-layer/name :config :text-layer/token-layers])
                          (update :text-layer/token-layers
                                  (fn [tokl-ids] (mapv #(format-tokl (clojure.core/get tokl-by-id %)) tokl-ids)))))
        txtl-by-id (into {} (map (juxt :xt/id identity) text-layers))
        enriched-text-layers (mapv #(format-txtl (clojure.core/get txtl-by-id %)) text-layer-ids)
        enriched-vocabs (mapv #(format-layer % [:vocab/id :vocab/name :vocab/maintainers :config]) vocabs)]
    (assoc project
           :project/text-layers enriched-text-layers
           :project/vocabs enriched-vocabs)))

;; Reads -------------------------------------------------------------------------

(defn get-document-ids [node-or-map id]
  (->> (pxc/find-entities node-or-map :documents {:document/project id})
       (map :xt/id)))

(defn get-documents [node-or-map id]
  (->> (pxc/find-entities node-or-map :documents {:document/project id})
       (map #(select-keys % [:document/id :document/name]))))

(defn get
  ([node-or-map id]
   (get node-or-map id false))
  ([node-or-map id include-documents?]
   (when-let [record (pxc/entity node-or-map :projects id)]
     (when (:project/id record)
       (let [node (pxc/->node node-or-map)]
         (-> (dissoc record :xt/id)
             (pxc/deserialize-config)
             (->> (enrich-layers node))
             (cond-> include-documents?
               (assoc :project/documents (get-documents node-or-map id)))))))))

(defn reader-ids [node-or-map id]
  (:project/readers (pxc/entity node-or-map :projects id)))

(defn writer-ids [node-or-map id]
  (:project/writers (pxc/entity node-or-map :projects id)))

(defn maintainer-ids [node-or-map id]
  (:project/maintainers (pxc/entity node-or-map :projects id)))

(defn get-all-ids [node-or-map]
  (->> (pxc/find-entities node-or-map :projects {})
       (map :xt/id)))

(defn get-accessible-ids [node-or-map user-id]
  (let [node (pxc/->node node-or-map)
        opts (pxc/snapshot-opts node-or-map)
        q #(xt/q node % (or opts {}))]
    (->> (concat
          (q (xt/template (-> (from :projects [{:xt/id pid :project/readers rs}])
                              (unnest {:r rs}) (where (= r ~user-id)) (return pid))))
          (q (xt/template (-> (from :projects [{:xt/id pid :project/writers ws}])
                              (unnest {:w ws}) (where (= w ~user-id)) (return pid))))
          (q (xt/template (-> (from :projects [{:xt/id pid :project/maintainers ms}])
                              (unnest {:m ms}) (where (= m ~user-id)) (return pid)))))
         (map :pid)
         distinct)))

(defn get-accessible [node-or-map user-id]
  (let [node (pxc/->node node-or-map)
        admin? (user/admin? (user/get node-or-map user-id))
        entities (if admin?
                   (pxc/find-entities node-or-map :projects {})
                   (pxc/entities-with-sys-from node-or-map :projects
                                               (vec (get-accessible-ids node-or-map user-id))))]
    (->> entities
         (mapv #(-> (dissoc % :xt/id :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
                    pxc/deserialize-config
                    (->> (enrich-layers node)))))))

(defn get-by-name [node-or-map name]
  (pxc/find-entity node-or-map :projects {:project/name name}))

(defn project-id
  "For projects, the project-id is the entity's own ID."
  [_node-or-map id]
  id)

;; Mutations ---------------------------------------------------------------------

(defn create* [xt-map attrs]
  (let [node (pxc/->node xt-map)
        {:project/keys [id name] :as record} (clojure.core/merge
                                              (pxc/new-record "project")
                                              {:project/readers []
                                               :project/writers []
                                               :project/maintainers []
                                               :project/text-layers []
                                               :project/vocabs []
                                               :config {}}
                                              (select-keys attrs attr-keys))
        record (update record :config pxc/serialize-config)]
    (pxc/valid-name? name)
    [[:put-docs :projects record]]))

(defn create-operation [xt-map attrs]
  (let [{:project/keys [name]} attrs
        tx-ops (create* xt-map attrs)]
    (op/make-operation
     {:type :project/create
      :project (-> tx-ops last last :xt/id)
      :document nil
      :description (str "Create project \"" name "\"")
      :tx-ops tx-ops})))

(defn create [xt-map attrs user-id]
  (submit-operations! xt-map [(create-operation xt-map attrs)] user-id
                      #(-> % last last :xt/id)))

(defn merge-operation [xt-map eid m]
  (let [tx-ops (do (when-let [name (:project/name m)]
                     (pxc/valid-name? name))
                   (pxc/merge* xt-map :projects :project/id eid (select-keys m [:project/name])))]
    (op/make-operation
     {:type :project/update
      :project eid
      :document nil
      :description (str "Update project " eid (when (:project/name m) (str " to name \"" (:project/name m) "\"")))
      :tx-ops tx-ops})))

(defn merge [xt-map eid m user-id]
  (submit-operations! xt-map [(merge-operation xt-map eid m)] user-id))

(defn delete* [xt-map eid]
  (let [node (pxc/->node xt-map)
        prj-e (pxc/entity-with-sys-from node :projects eid)]
    (when-not (:project/id prj-e)
      (throw (ex-info (pxc/err-msg-not-found "Project" eid) {:code 404})))
    (let [text-layers (:project/text-layers prj-e)
          txtl-txs (reduce into [] (mapv #(txtl/delete* xt-map %) text-layers))
          document-ids (get-document-ids xt-map eid)
          docs (pxc/entities-with-sys-from node :documents document-ids)
          project-txs [(pxc/match* :projects prj-e)
                       [:delete-docs :projects eid]]]
      (vec (concat txtl-txs (pxc/batch-delete-ops :documents docs) project-txs)))))

(defn delete-operation [xt-map eid]
  (let [node (pxc/->node xt-map)
        prj (pxc/entity node :projects eid)
        text-layers (:project/text-layers prj)
        documents (get-document-ids xt-map eid)
        tx-ops (delete* xt-map eid)]
    (op/make-operation
     {:type :project/delete
      :project eid
      :document nil
      :description (str "Delete project " eid " with " (count text-layers) " text layers and " (count documents) " documents")
      :tx-ops tx-ops})))

(defn delete [xt-map eid user-id]
  (submit-operations! xt-map [(delete-operation xt-map eid)] user-id))

;; Access privileges ------------------------------------------------------------

(defn- modify-privileges* [xt-map project-id user-id [add? key]]
  (let [node (pxc/->node xt-map)
        user-e (pxc/entity-with-sys-from node :users user-id)
        prj-e (pxc/entity-with-sys-from node :projects project-id)
        prj (dissoc prj-e :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
        new-project (-> prj
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
      (nil? (:user/id user-e))
      (throw (ex-info (str "Not a valid user ID: " user-id) {:id user-id :code 400}))

      (nil? (:project/id prj-e))
      (throw (ex-info (str "Not a valid project ID: " project-id) {:id project-id :code 400}))

      :else
      [(pxc/match* :users user-e)
       (pxc/match* :projects prj-e)
       [:put-docs :projects new-project]])))

(defn add-reader* [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [true :project/readers]))
(defn add-reader-operation [xt-map project-id user-id]
  (op/make-operation
   {:type :project/add-reader
    :project project-id
    :document nil
    :description (str "Add reader " user-id " to project " project-id)
    :tx-ops (add-reader* xt-map project-id user-id)}))
(defn add-reader [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(add-reader-operation xt-map project-id user-id)] actor-user-id))

(defn remove-reader* [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/readers]))
(defn remove-reader-operation [xt-map project-id user-id]
  (op/make-operation
   {:type :project/remove-reader
    :project project-id
    :document nil
    :description (str "Remove reader " user-id " from project " project-id)
    :tx-ops (remove-reader* xt-map project-id user-id)}))
(defn remove-reader [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(remove-reader-operation xt-map project-id user-id)] actor-user-id))

(defn add-writer* [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [true :project/writers]))
(defn add-writer-operation [xt-map project-id user-id]
  (op/make-operation
   {:type :project/add-writer
    :project project-id
    :document nil
    :description (str "Add writer " user-id " to project " project-id)
    :tx-ops (add-writer* xt-map project-id user-id)}))
(defn add-writer [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(add-writer-operation xt-map project-id user-id)] actor-user-id))

(defn remove-writer* [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/writers]))
(defn remove-writer-operation [xt-map project-id user-id]
  (op/make-operation
   {:type :project/remove-writer
    :project project-id
    :document nil
    :description (str "Remove writer " user-id " from project " project-id)
    :tx-ops (remove-writer* xt-map project-id user-id)}))
(defn remove-writer [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(remove-writer-operation xt-map project-id user-id)] actor-user-id))

(defn add-maintainer* [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [true :project/maintainers]))
(defn add-maintainer-operation [xt-map project-id user-id]
  (op/make-operation
   {:type :project/add-maintainer
    :project project-id
    :document nil
    :description (str "Add maintainer " user-id " to project " project-id)
    :tx-ops (add-maintainer* xt-map project-id user-id)}))
(defn add-maintainer [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(add-maintainer-operation xt-map project-id user-id)] actor-user-id))

(defn remove-maintainer* [xt-map project-id user-id]
  (modify-privileges* xt-map project-id user-id [false :project/maintainers]))
(defn remove-maintainer-operation [xt-map project-id user-id]
  (op/make-operation
   {:type :project/remove-maintainer
    :project project-id
    :document nil
    :description (str "Remove maintainer " user-id " from project " project-id)
    :tx-ops (remove-maintainer* xt-map project-id user-id)}))
(defn remove-maintainer [xt-map project-id user-id actor-user-id]
  (submit-operations! xt-map [(remove-maintainer-operation xt-map project-id user-id)] actor-user-id))

;; Editor config (not a project operation per se, but housed here) ---------------

(def ^:private layer-tables
  "Layer id-key → table pairs for editor config lookups."
  [[:project/id :projects]
   [:text-layer/id :text-layers]
   [:token-layer/id :token-layers]
   [:span-layer/id :span-layers]
   [:relation-layer/id :relation-layers]
   [:vocab/id :vocab-layers]])

(defn- find-layer-table
  "Find the table for a layer entity by checking known layer tables."
  [node layer-id]
  (some (fn [[id-key table]]
          (when-let [e (pxc/entity node table layer-id)]
            (when (id-key e) table)))
        layer-tables))

(defn assoc-editor-config-pair [xt-map layer-id editor-name config-key config-value]
  (let [node (pxc/->node xt-map)
        table (find-layer-table node layer-id)]
    (when-not table
      (throw (ex-info (str "Not a valid layer ID: " layer-id) {:id layer-id :code 400})))
    (let [layer-e (pxc/entity-with-sys-from node table layer-id)
          layer (dissoc layer-e :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
          current-config (pxc/parse-config (:config layer))
          new-config (assoc-in current-config [editor-name config-key] config-value)
          new-layer (assoc layer :config (pxc/serialize-config new-config))]
      (pxc/submit! node
                   [(pxc/match* table layer-e)
                    [:put-docs table new-layer]]))))

(defn dissoc-editor-config-pair [xt-map layer-id editor-name config-key]
  (let [node (pxc/->node xt-map)
        table (find-layer-table node layer-id)]
    (when-not table
      (throw (ex-info (str "Not a valid layer ID: " layer-id) {:id layer-id :code 400})))
    (let [layer-e (pxc/entity-with-sys-from node table layer-id)
          layer (dissoc layer-e :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
          current-config (pxc/parse-config (:config layer))
          new-config (update current-config editor-name dissoc config-key)
          new-layer (assoc layer :config (pxc/serialize-config new-config))]
      (pxc/submit! node
                   [(pxc/match* table layer-e)
                    [:put-docs table new-layer]]))))

;; Vocab management -------------------------------------------------------------

(defn add-vocab* [xt-map project-id vocab-id]
  (let [node (pxc/->node xt-map)
        prj-e (pxc/entity-with-sys-from node :projects project-id)
        vocab-e (pxc/entity node :vocab-layers vocab-id)]
    (cond
      (nil? (:project/id prj-e))
      (throw (ex-info (pxc/err-msg-not-found "Project" project-id) {:code 404 :id project-id}))

      (nil? (:vocab/id vocab-e))
      (throw (ex-info (pxc/err-msg-not-found "Vocab" vocab-id) {:code 400 :id vocab-id}))

      :else
      (let [prj (dissoc prj-e :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)]
        [(pxc/match* :projects prj-e)
         [:put-docs :projects (pxc/add-id prj :project/vocabs vocab-id)]]))))

(defn add-vocab-operation [xt-map project-id vocab-id]
  (let [node (pxc/->node xt-map)
        prj (pxc/entity node :projects project-id)
        vocab (pxc/entity node :vocab-layers vocab-id)]
    (op/make-operation
     {:type :project/add-vocab
      :project project-id
      :document nil
      :description (clojure.core/format "Add vocab '%s' to project '%s'"
                                        (:vocab/name vocab) (:project/name prj))
      :tx-ops (add-vocab* xt-map project-id vocab-id)})))

(defn add-vocab [xt-map project-id vocab-id actor-user-id]
  (submit-operations! xt-map [(add-vocab-operation xt-map project-id vocab-id)] actor-user-id))

(defn remove-vocab* [xt-map project-id vocab-id]
  (let [node (pxc/->node xt-map)
        prj-e (pxc/entity-with-sys-from node :projects project-id)]
    (cond
      (nil? (:project/id prj-e))
      (throw (ex-info (pxc/err-msg-not-found "Project" project-id) {:code 404 :id project-id}))

      (nil? (:vocab/id (pxc/entity node :vocab-layers vocab-id)))
      (throw (ex-info (pxc/err-msg-not-found "Vocab" vocab-id) {:code 400 :id vocab-id}))

      :else
      ;; Find vocab-links for this vocab's items that belong to tokens in this project's documents
      (let [project-doc-ids (set (get-document-ids xt-map project-id))
            vocab-item-ids (mapv :xt/id (pxc/find-entities node :vocab-items {:vocab-item/layer vocab-id}))
            ;; Batch-fetch all vocab-links for these items (single SQL query)
            all-vl-entities (if (empty? vocab-item-ids)
                              []
                              (let [ph (str/join ", " (repeat (count vocab-item-ids) "?"))]
                                (xt/q node (into [(str "SELECT *, _system_from FROM vocab_links"
                                                       " WHERE vocab_link$vocab_item IN (" ph ")")]
                                                 vocab-item-ids))))
            ;; Collect first token ID from each vocab-link to batch-fetch tokens
            first-token-ids (->> all-vl-entities (keep #(first (:vocab-link/tokens %))) distinct vec)
            token-cache (pxc/entities-with-sys-from-by-id node :tokens first-token-ids)
            ;; Filter vocab-links to those belonging to this project's documents
            project-vl-entities (filter (fn [vl-e]
                                          (let [first-tid (first (:vocab-link/tokens vl-e))
                                                doc-id (when first-tid
                                                         (:token/document (clojure.core/get token-cache first-tid)))]
                                            (project-doc-ids doc-id)))
                                        all-vl-entities)
            vocab-link-ops (pxc/batch-delete-ops :vocab-links project-vl-entities)
            prj (dissoc prj-e :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)
            project-ops [(pxc/match* :projects prj-e)
                         [:put-docs :projects (pxc/remove-id prj :project/vocabs vocab-id)]]]
        (into (vec vocab-link-ops) project-ops)))))

(defn remove-vocab-operation [xt-map project-id vocab-id]
  (let [node (pxc/->node xt-map)
        prj (pxc/entity node :projects project-id)
        vocab (pxc/entity node :vocab-layers vocab-id)]
    (op/make-operation
     {:type :project/remove-vocab
      :project project-id
      :document nil
      :description (clojure.core/format "Remove vocab '%s' from project '%s'"
                                        (:vocab/name vocab) (:project/name prj))
      :tx-ops (remove-vocab* xt-map project-id vocab-id)})))

(defn remove-vocab [xt-map project-id vocab-id actor-user-id]
  (submit-operations! xt-map [(remove-vocab-operation xt-map project-id vocab-id)] actor-user-id))
