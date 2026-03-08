(ns plaid.xtdb2.audit
  (:require [xtdb.api :as xt]
            [clojure.string :as str]
            [plaid.xtdb2.common :as pxc]))

(defn- batch-fetch-by-ids
  "Batch-fetch entities by ID from a table. Returns a map of id -> entity."
  [node table ids]
  (pxc/entities-with-sys-from-by-id node table (vec (distinct ids))))

(defn- batch-enrich-audits
  "Enrich multiple audit records by batch-fetching all referenced entities."
  [node audits]
  (if (empty? audits)
    []
    (let [;; Collect all referenced IDs across all audits
          all-user-ids (->> audits (keep :audit/user) distinct)
          all-proj-ids (->> audits (mapcat :audit/projects) (filter some?) distinct)
          all-doc-ids (->> audits (mapcat :audit/documents) (filter some?) distinct)
          all-op-ids (->> audits (mapcat :audit/ops) (filter some?) distinct)
          ;; Batch-fetch all referenced entities (1 query per table)
          users-cache (batch-fetch-by-ids node :users all-user-ids)
          ops-cache (batch-fetch-by-ids node :operations all-op-ids)
          ;; Also collect project/doc IDs referenced by ops for nested enrichment
          op-proj-ids (->> (vals ops-cache) (keep :op/project))
          op-doc-ids (->> (vals ops-cache) (keep :op/document))
          projects-cache (batch-fetch-by-ids node :projects (concat all-proj-ids op-proj-ids))
          docs-cache (batch-fetch-by-ids node :documents (concat all-doc-ids op-doc-ids))]
      (mapv (fn [audit]
              (-> audit
                  (update :audit/user
                          (fn [uid] (when uid (get users-cache uid))))
                  (update :audit/projects
                          (fn [pids] (->> pids (keep #(get projects-cache %)) set)))
                  (update :audit/documents
                          (fn [dids] (->> dids (keep #(get docs-cache %)) set)))
                  (update :audit/ops
                          (fn [op-ids]
                            (mapv (fn [op-id]
                                    (when-let [op (get ops-cache op-id)]
                                      (-> op
                                          (update :op/project
                                                  (fn [pid] (when pid (get projects-cache pid))))
                                          (update :op/document
                                                  (fn [did] (when did (get docs-cache did))))
                                          (dissoc :op/tx-ops))))
                                  op-ids)))))
            audits))))

(defn- filter-by-time [start-time end-time entries]
  (filter (fn [{ts :audit/time}]
            (let [ts-inst (when ts (.toInstant ts))]
              (and (or (nil? start-time) (nil? ts-inst) (not (.isBefore ts-inst (.toInstant start-time))))
                   (or (nil? end-time) (nil? ts-inst) (not (.isAfter ts-inst (.toInstant end-time)))))))
          entries))

(defn- fetch-audits-by-ids
  "Batch-fetch audit records by ID using a single SQL IN query."
  [node audit-ids]
  (if (empty? audit-ids)
    []
    (let [ids (vec (distinct audit-ids))
          ph (str/join ", " (repeat (count ids) "?"))]
      (vec (xt/q node (into [(str "SELECT * FROM audits WHERE _id IN (" ph ")")] ids))))))

(defn get-project-audit-log
  "Get all audit entries for a project with their operations, optionally filtered by time range."
  ([node-or-map project-id]
   (get-project-audit-log node-or-map project-id nil nil))
  ([node-or-map project-id start-time end-time]
   (let [node (pxc/->node node-or-map)
         audit-ids (->> (xt/q node (xt/template
                                    (-> (from :audits [{:xt/id aid :audit/projects projs}])
                                        (unnest {:p projs})
                                        (where (= p ~project-id))
                                        (return aid))))
                        (map :aid)
                        distinct)
         audits (fetch-audits-by-ids node audit-ids)]
     (->> (batch-enrich-audits node audits)
          (filter-by-time start-time end-time)
          (sort-by :audit/time)))))

(defn get-document-audit-log
  "Get all audit entries for a document with their operations."
  ([node-or-map document-id]
   (get-document-audit-log node-or-map document-id nil nil))
  ([node-or-map document-id start-time end-time]
   (let [node (pxc/->node node-or-map)
         audit-ids (->> (xt/q node (xt/template
                                    (-> (from :audits [{:xt/id aid :audit/documents docs}])
                                        (unnest {:d docs})
                                        (where (= d ~document-id))
                                        (return aid))))
                        (map :aid)
                        distinct)
         audits (fetch-audits-by-ids node audit-ids)]
     (->> (batch-enrich-audits node audits)
          (filter-by-time start-time end-time)
          (sort-by :audit/time)))))

(defn get-user-audit-log
  "Get all audit entries by a specific user with their operations."
  ([node-or-map user-id]
   (get-user-audit-log node-or-map user-id nil nil))
  ([node-or-map user-id start-time end-time]
   (let [node (pxc/->node node-or-map)
         audits (pxc/find-entities node-or-map :audits {:audit/user user-id})]
     (->> (batch-enrich-audits node audits)
          (filter-by-time start-time end-time)
          (sort-by :audit/time)))))
