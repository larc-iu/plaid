(ns plaid.sql.cascade-statistics
  "Planner statistics a delete's FK cascades can trust.

  A cascade (`ON DELETE CASCADE`) runs, for every parent row deleted, a
  `DELETE FROM child WHERE fk = ?` that SQLite plans like any statement, and
  nothing in SQL can name an index for it. When the statistics this
  connection loaded say the child table holds one row or none (it was
  analysed nearly empty, as a young install or a test is), SQLite plans that
  statement as a scan of the whole table, once per parent row. Deleting the
  50,000 spans of a document then scans every relation 100,000 times, which
  holds the write lock for minutes. With statistics of two rows or more, or
  none at all, it seeks the child's index.

  `prepare!` runs at the start of every delete that cascades. It asks
  SQLite's own staleness test (`PRAGMA optimize`, the test the scheduled
  refresh in `plaid.server.sql` uses, which compares the row counts this
  connection planned with against the tables as they are) which tables are
  stale. For each one that is the child of a cascade and holds rows, it drops
  the table's rows from `sqlite_stat1`, and reloads this connection's
  statistics, so the cascades are planned on SQLite's defaults, which seek.
  It costs one PRAGMA when nothing is stale. The next scheduled refresh
  analyses the tables it dropped, since a table with no statistics is stale
  to the same test."
  (:require [clojure.string :as str]
            [plaid.sql.common :as psc]))

(defn- stale-tables
  "The tables SQLite's staleness test would analyse, read from the
  statements `PRAGMA optimize` returns with its debug bit (`ANALYZE
  \"main\".\"t\"`) instead of running them."
  [tx]
  (keep (fn [row]
          (some->> (first (vals row)) str (re-find #"^ANALYZE \"main\"\.\"([^\"]+)\"") second))
        (psc/q tx ["PRAGMA optimize=0x10003"])))

(defn- cascade-child?
  "Is `table` the child of an `ON DELETE CASCADE` foreign key?"
  [tx table]
  (some? (psc/q1 tx ["SELECT 1 FROM pragma_foreign_key_list(?) WHERE on_delete = 'CASCADE' LIMIT 1" table])))

(defn- holds-rows? [tx table]
  (some? (psc/q1 tx [(str "SELECT 1 FROM \"" (str/replace table "\"" "\"\"") "\" LIMIT 1")])))

(defn- statistics-table? [tx]
  (some? (psc/q1 tx ["SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'"])))

(defn prepare!
  "Make the cascades of the delete about to run on `tx` seek their child
  tables' indexes, whatever statistics this connection loaded (see the
  namespace). Returns the tables whose statistics it dropped or reloaded."
  [tx]
  (if-not (statistics-table? tx)
    ;; Never analysed: every table plans on the defaults already.
    []
    (let [tables (->> (stale-tables tx)
                      (filter #(cascade-child? tx %))
                      (filter #(holds-rows? tx %))
                      vec)]
      (when (seq tables)
        (psc/execute! tx (into [(str "DELETE FROM sqlite_stat1 WHERE tbl IN ("
                                     (str/join ", " (repeat (count tables) "?")) ")")]
                               tables))
        ;; Reload this connection's statistics from `sqlite_stat1`. Another
        ;; connection may have dropped the rows already, so this runs even
        ;; when the DELETE above found none.
        (psc/execute! tx ["ANALYZE sqlite_schema"]))
      tables)))
