(ns plaid.xtdb2.audit
  (:require [xtdb.api :as xt]
            [plaid.xtdb2.common :as pxc]))

(defn- enrich-audit
  "Enrich an audit record by joining related entities from their respective tables.
  :audit/time is already stored on the record; no extra lookup needed."
  [node audit-record]
  (-> audit-record
      (update :audit/user
              (fn [uid]
                (when uid (pxc/entity node :users uid))))
      (update :audit/projects
              (fn [proj-ids]
                (->> proj-ids
                     (map (fn [pid] (pxc/entity node :projects pid)))
                     (filter some?)
                     set)))
      (update :audit/documents
              (fn [doc-ids]
                (->> doc-ids
                     (map (fn [did] (pxc/entity node :documents did)))
                     (filter some?)
                     set)))
      (update :audit/ops
              (fn [op-ids]
                (mapv (fn [op-id]
                        (when-let [op (pxc/entity node :operations op-id)]
                          (-> op
                              (update :op/project
                                      (fn [pid] (when pid (pxc/entity node :projects pid))))
                              (update :op/document
                                      (fn [did] (when did (pxc/entity node :documents did))))
                              (dissoc :op/tx-ops))))
                      op-ids)))))

(defn- filter-by-time [entries start-time end-time]
  (filter (fn [{ts :audit/time}]
            (and (or (nil? start-time) (nil? ts) (not (.isBefore ts (.toInstant start-time))))
                 (or (nil? end-time) (nil? ts) (not (.isAfter ts (.toInstant end-time))))))
          entries))

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
         audits (mapv #(pxc/entity node :audits %) audit-ids)]
     (->> audits
          (map #(enrich-audit node %))
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
         audits (mapv #(pxc/entity node :audits %) audit-ids)]
     (->> audits
          (map #(enrich-audit node %))
          (filter-by-time start-time end-time)
          (sort-by :audit/time)))))

(defn get-user-audit-log
  "Get all audit entries by a specific user with their operations."
  ([node-or-map user-id]
   (get-user-audit-log node-or-map user-id nil nil))
  ([node-or-map user-id start-time end-time]
   (let [node (pxc/->node node-or-map)
         audits (pxc/find-entities node-or-map :audits {:audit/user user-id})]
     (->> audits
          (map #(enrich-audit node %))
          (filter-by-time start-time end-time)
          (sort-by :audit/time)))))
