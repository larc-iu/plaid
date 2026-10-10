(ns plaid.sql.layer
  "What the four layer tables (text_layers, token_layers, span_layers,
  relation_layers) do identically: read one row, resolve its project, swap
  its order_idx with a sibling's, and the rename, shift and delete
  operations.

  Each `plaid.sql.<kind>-layer` namespace keeps what is its own (the row
  mapper, create, the cascade walk) and delegates the rest here through a
  spec map, so a change lands once rather than four times. A spec is
    :table       the SQL table, e.g. :span_layers
    :kind        the op type namespace, e.g. \"span-layer\" (also the
                 namespace of the name attribute, :span-layer/name)
    :noun        e.g. \"span layer\", in descriptions and the 404
    :parent-col  the column siblings share, e.g. :token_layer_id
    :cascade!    `(fn [tx id])` deleting the layer and everything under it"
  (:require [clojure.string :as str]
            [plaid.sql.common :as psc]
            [plaid.sql.crud :as crud]
            [plaid.sql.operation :refer [submit-operation!]]))

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

(defn- assert-exists! [tx {:keys [table noun]} eid]
  (when (nil? (psc/fetch-by-id tx table eid))
    (throw (ex-info (psc/err-msg-not-found (str/capitalize noun) eid) {:code 404 :id eid}))))

(defn rename
  "Rename layer `eid` to `(:<kind>/name m)`, in one operation. A map with no
  name changes nothing."
  [{:keys [table kind noun] :as spec} db eid m user-id]
  (submit-operation! [tx db {:type (keyword kind "update")
                             :project (project-id db table eid)
                             :document nil
                             :description (str "Update " noun " " eid)
                             :user user-id}]
                     (let [n (clojure.core/get m (keyword kind "name"))]
                       (when n (psc/assert-valid-name! n))
                       (assert-exists! tx spec eid)
                       (when (some? n)
                         (crud/update-by-id! tx table eid {:name n}))
                       eid)))

(defn shift
  "Move layer `eid` one place up or down among its siblings, in one operation."
  [{:keys [table kind noun parent-col]} db eid up? user-id]
  (submit-operation! [tx db {:type (keyword kind "shift")
                             :project (project-id db table eid)
                             :document nil
                             :description (str "Shift " noun " " eid " " (if up? "up" "down"))
                             :user user-id}]
                     (shift-layer! tx table (str/capitalize noun) eid parent-col up?)))

(defn delete
  "Delete layer `eid` and everything under it through the spec's `:cascade!`,
  in one operation."
  [{:keys [table kind noun cascade!] :as spec} db eid user-id]
  (submit-operation! [tx db {:type (keyword kind "delete")
                             :project (project-id db table eid)
                             :document nil
                             :description (str "Delete " noun " " eid)
                             :user user-id}]
                     (assert-exists! tx spec eid)
                     (cascade! tx eid)
                     eid))
