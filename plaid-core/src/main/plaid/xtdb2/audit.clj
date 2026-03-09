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
          docs-cache (batch-fetch-by-ids node :documents (concat all-doc-ids op-doc-ids))
          select-user #(select-keys % [:user/id :user/username])
          select-proj #(select-keys % [:project/id :project/name])
          select-doc #(select-keys % [:document/id :document/name])]
      (mapv (fn [audit]
              (-> audit
                  (update :audit/user
                          (fn [uid] (when-let [u (get users-cache uid)] (select-user u))))
                  (update :audit/projects
                          (fn [pids] (->> pids (keep #(when-let [p (get projects-cache %)] (select-proj p))) vec)))
                  (update :audit/documents
                          (fn [dids] (->> dids (keep #(when-let [d (get docs-cache %)] (select-doc d))) vec)))
                  (update :audit/ops
                          (fn [op-ids]
                            (vec (keep (fn [op-id]
                                         (when-let [op (get ops-cache op-id)]
                                           (-> (select-keys op [:op/id :op/type :op/project :op/document :op/description])
                                               (update :op/project
                                                       (fn [pid] (when-let [p (get projects-cache pid)] (select-proj p))))
                                               (update :op/document
                                                       (fn [did] (when-let [d (get docs-cache did)] (select-doc d)))))))
                                       op-ids))))))
            audits))))

(defn- ->instant
  "Coerce to java.time.Instant if possible. Returns nil for unsupported types."
  [x]
  (cond
    (instance? java.time.Instant x) x
    (instance? java.util.Date x) (.toInstant x)
    (instance? java.time.ZonedDateTime x) (.toInstant x)
    :else nil))

(defn- filter-by-time [start-time end-time entries]
  (let [start-inst (->instant start-time)
        end-inst (->instant end-time)]
    (filter (fn [{ts :audit/time}]
              (let [ts-inst (->instant ts)]
                (and (or (nil? start-inst) (nil? ts-inst) (not (.isBefore ts-inst start-inst)))
                     (or (nil? end-inst) (nil? ts-inst) (not (.isAfter ts-inst end-inst))))))
            entries)))

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
