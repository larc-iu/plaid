(ns plaid.sql.layer
  "What the four layer tables (text_layers, token_layers, span_layers,
  relation_layers) do identically: read one row, resolve its project, and
  swap its order_idx with a sibling's.

  Each `plaid.sql.<kind>-layer` namespace keeps what is its own (the row
  mapper, create, merge, the cascade walk) and delegates these three here,
  so a change lands once rather than four times."
  (:require [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]))

(defn reader
  "A `(fn [db id] ...)` returning one row of `table` through `row->layer`,
  or nil when there is no such row."
  [table row->layer]
  (fn [db id] (row->layer (psc/fetch-by-id db table id))))

(defn project-id
  "The project id owning layer `id` in `table` (denormalized on every layer
  row, so this is a single-row read), or nil when there is no such row."
  [db table id]
  (:project_id (psc/fetch-by-id db table id)))

(defn shift-layer!
  "Swap order_idx between `eid` and its adjacent sibling (up? means the
  previous one, else the next) inside `table`, where siblings share
  `parent-col` = parent. A no-op at either end. `noun` names the layer kind
  in the 404 (\"Span layer\"), never the SQL table.

  The swap goes through a temporary sentinel idx so it cannot collide on the
  (parent, order_idx) uniqueness the tables declare."
  [tx table noun eid parent-col up?]
  (let [row (psc/fetch-by-id tx table eid)]
    (when (nil? row)
      (throw (ex-info (psc/err-msg-not-found noun eid) {:code 404 :id eid})))
    (let [parent (get row parent-col)
          my-idx (:order_idx row)
          neighbor (psc/q1 tx {:select [:*]
                               :from [table]
                               :where [:and
                                       [:= parent-col parent]
                                       (if up?
                                         [:< :order_idx my-idx]
                                         [:> :order_idx my-idx])]
                               :order-by [[:order_idx (if up? :desc :asc)]]
                               :limit 1})]
      (when neighbor
        (let [tmp -1
              their-idx (:order_idx neighbor)
              their-id (:id neighbor)]
          (crud/update-by-id! tx table eid {:order_idx tmp})
          (crud/update-by-id! tx table their-id {:order_idx my-idx})
          (crud/update-by-id! tx table eid {:order_idx their-idx})))
      eid)))
