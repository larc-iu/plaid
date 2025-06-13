(ns plaid.xtdb.audit
  (:require [xtdb.api :as xt]
            [plaid.xtdb.common :as pxc]))

(def audit-pull
  '(pull ?audit [:audit/id
                 :xt/id
                 {:audit/user [:user/id :user/username]}
                 {:audit/projects [:project/name :project/id]}
                 {:audit/documents [:document/name :document/id]}
                 {:audit/ops [:op/id
                              :op/type
                              {:op/project [:project/id :project/name]}
                              {:op/document [:document/id :document/name]}
                              :op/description]}]))

(defn get-project-audit-log
  "Get all audit entries for a project with their operations, optionally filtered by time range"
  ([db project-id]
   (get-project-audit-log db project-id nil nil))
  ([db project-id start-time end-time]
   (let [query {:find  [audit-pull]
                :where '[[?audit :audit/projects ?project]]
                :in    '[?project]}
         results (xt/q db query project-id)]
     (->> results
          (map first)
          (filter (fn [entry]
                    (when-let [tx-time (xt/entity-tx db (:xt/id entry))]
                      (let [ts (:xtdb.api/tx-time tx-time)]
                        (and (or (nil? start-time) (>= (.getTime ts) (.getTime start-time)))
                             (or (nil? end-time) (<= (.getTime ts) (.getTime end-time))))))))
          (sort-by (fn [entry] 
                     (:xtdb.api/tx-time (xt/entity-tx db (:xt/id entry)))))))))

(defn get-document-audit-log
  "Get all audit entries for a document with their operations"
  ([db document-id]
   (get-document-audit-log db document-id nil nil))
  ([db document-id start-time end-time]
   (let [query {:find  [audit-pull]
                :where '[[?audit :audit/documents ?document]]
                :in    '[?document]}
         results (xt/q db query document-id)]
     (->> results
          (map first)
          (filter (fn [entry]
                    (when-let [tx-time (xt/entity-tx db (:xt/id entry))]
                      (let [ts (:xtdb.api/tx-time tx-time)]
                        (and (or (nil? start-time) (>= (.getTime ts) (.getTime start-time)))
                             (or (nil? end-time) (<= (.getTime ts) (.getTime end-time))))))))
          (sort-by (fn [entry] 
                     (:xtdb.api/tx-time (xt/entity-tx db (:xt/id entry)))))))))

(defn get-user-audit-log
  "Get all audit entries by a specific user with their operations"
  ([db user-id]
   (get-user-audit-log db user-id nil nil))
  ([db user-id start-time end-time]
   (let [query {:find  [audit-pull]
                :where '[[?audit :audit/user ?user]]
                :in    '[?user]}
         results (xt/q db query user-id)]
     (->> results
          (map first)
          (filter (fn [entry]
                    (when-let [tx-time (xt/entity-tx db (:xt/id entry))]
                      (let [ts (:xtdb.api/tx-time tx-time)]
                        (and (or (nil? start-time) (>= (.getTime ts) (.getTime start-time)))
                             (or (nil? end-time) (<= (.getTime ts) (.getTime end-time))))))))
          (sort-by (fn [entry] 
                     (:xtdb.api/tx-time (xt/entity-tx db (:xt/id entry)))))))))