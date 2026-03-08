# XTDB v2 API Reference

Reference for XTDB v2 Clojure APIs as used by Plaid. Researched from official docs as of March 2026.

---

## 1. Core Clojure API (`xtdb.api`)

### `xt/q` — Query

```clojure
(xt/q node query)
(xt/q node query opts)
```

- Returns a vector of maps (kebab-case keyword keys by default).
- `query` is either a quoted XTQL form or a SQL string.
- `opts` map:
  - `:await-token` — lower-bound tx token; waits for this tx to be indexed before evaluating
  - `:snapshot-token` — upper-bound; query sees only txs up to this token (for repeatable reads)
  - `:snapshot-time` — timestamp upper-bound (alternative to snapshot-token)
  - `:current-time` — overrides wall-clock for temporal predicates
  - `:default-tz` — timezone for temporal functions
  - `:explain?` — returns query plan instead of results
  - `:key-fn` — output key formatter (default `:kebab-case-keyword`)
  - `:tx-timeout` — duration to wait for indexing

### `xt/plan-q` — Streaming Query

```clojure
(xt/plan-q node query+args)
(xt/plan-q node query+args opts)
```

Returns a reducible (`IReduceInit`) for streaming large result sets without materializing into memory. Same options as `xt/q`.

### `xt/execute-tx` — Synchronous Transaction

```clojure
(xt/execute-tx node tx-ops)
(xt/execute-tx node tx-ops tx-opts)
```

- **Blocks** until the receiving node indexes the transaction.
- **Throws** if the transaction fails (error or assertion failure).
- Returns a map including `:tx-id`, `:system-time`, and an `:await-token` that can be passed to subsequent queries.
- `tx-opts` map:
  - `:system-time` — override system time for backfills (must not be earlier than any previous system-time)
  - `:default-tz` — timezone
  - `:metadata` — arbitrary map attached to tx; available in `xt$txs.user_metadata`

**Replaces** v1 `xt/submit-tx` + `xt/await-tx` pattern.

### `xt/submit-tx` — Asynchronous Transaction

```clojure
(xt/submit-tx node tx-ops)
(xt/submit-tx node tx-ops tx-opts)
```

- Writes to log asynchronously; returns `{:tx-id ...}` immediately without waiting.
- Same `tx-opts` as `execute-tx`.
- Use when you don't need to wait for indexing confirmation.

### `xt/template` — Parameterized Query Macro

```clojure
(xt/template (-> (from :users [{:xt/id id} username])
                 (where (= username ~target-username))))
```

Quotes the XTQL form while allowing Clojure `~` (unquote) and `~@` (unquote-splicing) for embedding runtime values.

### `xt/status`

```clojure
(xt/status node)
```

Returns node status map.

### `xt/client` — Remote Connection

```clojure
(xt/client {:keys [host port user password dbname]
            :or   {host "127.0.0.1" port 5432 dbname "xtdb"}})
```

Opens a connection to a remote XTDB node via the PostgreSQL wire protocol.

---

## 2. XTQL Transaction Operations

All operations are vectors passed to `execute-tx` or `submit-tx` as a sequence.

### `put-docs` — Upsert

```clojure
[:put-docs :table-name {:xt/id id :attr val ...}]

;; With valid-time constraints:
[:put-docs {:into :table-name
            :valid-from #inst "2024-01-01"
            :valid-to   #inst "2025-01-01"}
 {:xt/id id :attr val}]
```

- Each document **must** have `:xt/id`.
- Without valid-time, inserts from now through end-of-time.
- Overwrites existing document for the specified period.
- **Replaces** v1 `[::xt/put doc]`.

### `patch-docs` — Merge-Upsert

```clojure
[:patch-docs :table-name {:xt/id id :attr new-val}]

;; With valid-time:
[:patch-docs {:into :table-name :valid-from ...} {:xt/id id :attr val}]
```

- Merges at key granularity: present keys override; absent/null keys preserve existing values.
- **Cannot remove keys** — for key removal, use a full `put-docs` with read-modify-write.
- New in v2; no v1 equivalent.

### `delete-docs` — Delete

```clojure
[:delete-docs :table-name id1 id2]

;; With valid-time constraints:
[:delete-docs {:from :table-name :valid-from #inst "..." :valid-to #inst "..."}
 id1 id2]
```

- Without valid-time, deletes from now through end-of-time.
- **Replaces** v1 `[::xt/delete id]`.

### `erase-docs` — Irrevocable GDPR Delete

```clojure
[:erase-docs :table-name id1 id2]
```

- Permanently removes records from all temporal dimensions, including historical system-time.
- **Replaces** v1 `[::xt/evict id]`.

### SQL Operations via `[:sql ...]`

```clojure
[:sql "INSERT INTO users (_id, username) VALUES (?, ?)" [user-id "alice"]]
[:sql "UPDATE users SET username = ? WHERE _id = ?" ["bob" user-id]]
[:sql "DELETE FROM users WHERE _id = ?" [user-id]]
[:sql "ASSERT EXISTS (SELECT 1 FROM users WHERE _id = ?), 'User must exist'"
      [user-id]]
[:sql "ASSERT NOT EXISTS (SELECT 1 FROM emails WHERE email = ?), 'Duplicate email'"
      ["alice@example.com"]]
```

- SQL operations can be mixed with XTQL operations in the same `execute-tx` call.
- Parameters are passed as a second element in the vector (seq of arg seqs for batch inserts).
- `ASSERT` rolls back the entire transaction if the predicate fails.

### **IMPORTANT: `assert-exists` / `assert-not-exists` are REMOVED**

The XTQL DML operators `:assert-exists` and `:assert-not-exists` were removed from v2 GA due to lack of uptake. Use SQL `ASSERT` via `[:sql "ASSERT ..."]` instead.

---

## 3. Replacing `::xt/match` (Optimistic Concurrency)

### The v2 approach: SERIALIZABLE log + SQL ASSERT

XTDB v2 serializes all DML via a totally-ordered log, giving SERIALIZABLE isolation automatically. For explicit optimistic locking (the v1 `::xt/match` pattern), use SQL `ASSERT` checking `_system_from`:

```clojure
;; During read phase, capture _system_from alongside entity data:
(let [{:keys [entity-data system-from]}
      (first (xt/q node
               '(from :tokens {:bind [{:xt/id id} attr1 attr2 _system_from]
                               :for-system-time :all-time})
               {:snapshot-token token}))]
  ;; In the transaction, assert _system_from hasn't changed:
  (xt/execute-tx node
    [[:sql "ASSERT (SELECT _system_from FROM tokens WHERE _id = ?) = ?"
           [entity-id captured-system-from]]
     [:put-docs :tokens updated-entity]]))
```

### Match helper

```clojure
(defn match* [table id system-from]
  [:sql (str "ASSERT (SELECT _system_from FROM " (name table) " WHERE _id = ?) = ?")
        [id system-from]])

;; Usage:
(xt/execute-tx node
  [(match* :tokens token-id captured-sys-from)
   [:put-docs :tokens updated-token]])
```

### Note on SERIALIZABLE isolation

Because all writes are serialized through the log, **write-write conflicts are impossible** — the log order determines the winner and the transaction either succeeds atomically or fails. The `ASSERT` on `_system_from` is an additional application-level check for cases where you want to guarantee the entity wasn't modified between read and write.

---

## 4. XTQL Query Language

### Basic query structure

```clojure
;; Simple from query (like xt/entity):
(xt/q node '(from :users [{:xt/id id} username email]))

;; With pipeline stages:
(xt/q node '(-> (from :users [{:xt/id id} username])
                (where (= username "alice"))
                (limit 1)))
```

### `from` — Source Operator

```clojure
;; Simple column binding (positional):
(from :users [username first-name last-name])

;; With ID binding:
(from :users [{:xt/id user-id} username email])

;; With renaming:
(from :users [{:xt/id id :username uname}])

;; All columns wildcard:
(from :users [*])

;; With temporal filter:
(from :users {:bind [{:xt/id id} username _system_from]
              :for-valid-time (at #inst "2023-01-01")})
(from :users {:bind [{:xt/id id} username]
              :for-system-time :all-time})
```

### Temporal Filter Options

Used in `from`'s `:for-valid-time` and `:for-system-time`:
- `(at <timestamp>)` — rows visible at this moment
- `(from <timestamp>)` — rows visible after timestamp
- `(to <timestamp>)` — rows visible before timestamp
- `(in <from-ts> <to-ts>)` — rows visible within period
- `:all-time` — all historical versions

### Binding `_system_from` and other temporal columns

To access temporal columns, include them in the binding spec **and** use `:for-system-time :all-time` (or similar):

```clojure
(xt/q node
  '(from :tokens {:bind [{:xt/id id} value _system_from _valid_from]
                  :for-system-time :all-time}))
```

Without `:for-system-time`, queries default to the current system time and `_system_from` is not exposed.

### `unify` — Join Multiple Sources

Replaces Datalog's shared logic variables for joins:

```clojure
(unify (from :projects [{:xt/id project-id} name])
       (from :documents [{:xt/id doc-id} project-id title]))
```

Shared variable names (`project-id` above) act as join conditions.

### `union-all` — OR Queries

Replaces v1 `(or ...)` in `:where`:

```clojure
(union-all
  (from :project-members [{:project/id proj-id :role :reader} user-id])
  (from :project-members [{:project/id proj-id :role :writer} user-id])
  (from :project-members [{:project/id proj-id :role :maintainer} user-id]))
```

### Pipeline Tail Operators

```clojure
;; where — filter rows
(where (> age 18))
(where (= status :active))

;; with — add computed columns
(with {:full-name (concat first-name " " last-name)})

;; without — remove columns from output
(without :internal-id)

;; return — project specific columns (like SELECT)
(return user-id {:display-name (concat first-name " " last-name)})

;; order-by — sort
(order-by {:val created-at :dir :desc :nulls :last})
(order-by username)  ; ascending default

;; limit / offset — pagination
(limit 10)
(offset 20)

;; aggregate — GROUP BY
(aggregate project-id
           {:doc-count (row-count)
            :total-size (sum file-size)})

;; unnest — flatten arrays
(unnest {:tag tags})
```

### `pull` and `pull*` — Nested Queries

```clojure
;; pull: must return single row, nests as map
(-> (from :projects [{:xt/id project-id} name])
    (with {:owner (pull (from :users [{:xt/id user-id} username])
                        {:args [owner-id]})}))

;; pull*: may return multiple rows, nests as vector of maps
(-> (from :projects [{:xt/id project-id} name])
    (with {:docs (pull* (from :documents [{:xt/id doc-id} title project-id])
                        {:args [project-id]})}))
```

### Parameterized Queries

```clojure
;; Using fn form:
(xt/q node ['(fn [username]
               (from :users [{:username username} first-name]))
            "alice"])

;; Using xt/template macro (preferred for readability):
(xt/q node (xt/template (-> (from :users [{:xt/id id} username])
                             (where (= username ~target-username)))))
```

### Replacing `xt/pull` (v1 standalone)

v1 `(xt/pull db id pull-pattern)` becomes a `from` query:

```clojure
;; v1:
(xt/pull db project-id [:project/name :project/description])

;; v2:
(first (xt/q node (xt/template (from :projects [{:xt/id ~project-id}
                                                 project/name
                                                 project/description]))))
```

### `(pull ?e [*])` wildcard becomes `[*]` binding

```clojure
;; v1 Datalog pull wildcard:
{:find [(pull ?tok [*])] :where [[?tok :token/text-id text-id]]}

;; v2 XTQL:
(-> (from :tokens [{:xt/id tok-id :token/text-id text-id} *])
    (where (= text-id ~target-text-id)))
```

---

## 5. Replacing `xt/db` Snapshots

### v1 pattern

```clojure
(let [db (xt/db node)]
  (xt/entity db id)
  (xt/q db query))
```

### v2 pattern

No `xt/db` equivalent. Instead:

```clojure
;; Simple: query directly against node (sees all committed txs)
(xt/q node query)

;; Consistent reads after a write (use await-token from execute-tx result):
(let [{:keys [await-token]} (xt/execute-tx node tx-ops)]
  (xt/q node query {:await-token await-token}))

;; Frozen snapshot for repeatable queries (snapshot-token is an upper-bound):
(let [{:keys [await-token]} (xt/execute-tx node tx-ops)]
  ;; Use snapshot-token from a prior execute-tx to ensure queries
  ;; see exactly that state (not newer txs):
  (xt/q node query {:snapshot-token await-token}))
```

### Replacing `xt/entity`

```clojure
;; v1:
(xt/entity db entity-id)

;; v2 (must know the table):
(first (xt/q node (xt/template (from :users [{:xt/id ~entity-id} *]))))
```

**This is the most impactful change**: every `xt/entity` call must become a typed query against a known table. This is why the table-name registry in the plan is necessary.

---

## 6. System Tables

### `xt/txs` (SQL: `xt$txs`)

Stores the complete transaction history. Columns:
- `_id` — transaction ID (integer)
- `system_time` — timestamp with timezone (UTC, microsecond precision) of when the tx was committed
- `user_metadata` — arbitrary map attached via `:metadata` in `execute-tx` tx-opts

**XTQL query:**
```clojure
(xt/q node '(from :xt/txs [*]))

;; Filter by time range:
(xt/q node '(-> (from :xt/txs [{:xt/id tx-id} system-time user-metadata])
                (where (> system-time ~cutoff-time))))
```

**SQL query:**
```sql
SELECT * FROM xt$txs ORDER BY system_time DESC LIMIT 100
```

This replaces `xt/open-tx-log` for reading transaction history. Note that `xt$txs` stores **metadata** about transactions (tx-id, system-time, user-metadata) but does **not** expose the full operation payloads (what was put/deleted). This has significant implications for the batch rollback system in `operation.clj` — see section 8 of the migration plan.

---

## 7. Temporal Columns

Every XTDB v2 table automatically maintains four temporal columns:

| Column | Description |
|--------|-------------|
| `_valid_from` | Start of valid time period (inclusive) |
| `_valid_to` | End of valid time period (exclusive) |
| `_system_from` | When this version entered the database (system time start, inclusive) |
| `_system_to` | When this version was superseded (system time end, exclusive) |

These columns are **not visible by default** in query results. To access them:

```clojure
;; In XTQL, include them in the binding spec + use for-system-time:
(from :tokens {:bind [{:xt/id id} value _system_from _valid_from]
               :for-system-time :all-time})

;; In SQL:
(xt/q node "SELECT _id, value, _system_from FROM tokens FOR SYSTEM_TIME ALL")
```

**SQL name mapping**: XTDB maps between Clojure/XTQL and SQL names:
- `:xt/id` ↔ `_id`
- `:xt/valid-from` ↔ `_valid_from`
- `:xt/valid-to` ↔ `_valid_to`
- `:user/username` ↔ `user$username` (namespace separator becomes `$`)
- Hyphens become underscores: `:token-layer/id` ↔ `token_layer$id`

---

## 8. Node Configuration

### Requirements
- **JDK 21+** required
- Add JVM args for Apache Arrow: `--add-opens java.base/java.nio=ALL-UNNAMED`

### In-Memory Node (Development/Testing)

```clojure
(require '[xtdb.node :as xtdb])

(def node (xtdb/start-node {}))
;; or simply:
(def node (xtdb/start-node))
```

### Local Disk Node

```clojure
(def node (xtdb/start-node
  {:log     [:local {:path "/tmp/xtdb/log"}]
   :storage [:local {:path "/tmp/xtdb/storage"}]}))
```

### Remote (Kafka + S3)

```clojure
(def node (xtdb/start-node
  {:log     [:kafka {:bootstrap-servers "kafka:9092"
                     :topic-name "xtdb-log"}]
   :storage [:remote
             {:object-store [:s3 {:bucket "my-bucket"}]
              :disk-cache   {:path "/tmp/xtdb-cache"}}]}))
```

### Remote Client Connection

```clojure
(require '[xtdb.api :as xt])

;; Connect to XTDB server (PostgreSQL wire protocol, port 5432):
(def node (xt/client {:host "localhost" :port 5432}))
```

### Closing the Node

```clojure
(.close node)
;; or use with-open:
(with-open [node (xtdb/start-node {})]
  ...)
```

---

## 9. Key API Differences Summary (v1 → v2)

| v1 | v2 |
|----|-----|
| `(xt/db node)` | No equivalent; query directly against node |
| `(xt/entity db id)` | `(first (xt/q node '(from :table [{:xt/id ~id} *])))` |
| `(xt/q db {:find ...})` | `(xt/q node '(from :table [...]))` |
| `(xt/submit-tx node [[::xt/put doc]])` | `(xt/execute-tx node [[:put-docs :table doc]])` |
| `(xt/await-tx node tx)` | Built into `execute-tx` (synchronous) |
| `[::xt/put entity]` | `[:put-docs :table entity]` |
| `[::xt/delete id]` | `[:delete-docs :table id]` |
| `[::xt/evict id]` | `[:erase-docs :table id]` |
| `[::xt/match id expected]` | `[:sql "ASSERT (SELECT _system_from FROM t WHERE _id = ?) = ?" [id sys-from]]` |
| `xt/open-tx-log` | `(from :xt/txs [...])` (metadata only, not operation payloads) |
| `(pull ?e [*])` in find | `[*]` in `from` binding |
| `(xt/pull db id pattern)` | `(first (xt/q node '(from :table [{:xt/id ~id} col1 col2])))` |
| `:in [?param]` | `(fn [param] ...)` form or `(xt/template ...)` with `~` |
| `(or ...)` in `:where` | `(union-all ...)` with multiple `from` clauses |
| Cross-entity joins via shared vars | `(unify ...)` with multiple `from` clauses |
| `:find [(pull ?e [*])] :where [...]` | `(from :table [{:xt/id id} *])` |
| `:order-by`, `:limit` in query map | `(order-by ...)`, `(limit ...)` pipeline stages |

---

## 10. Verified Implementation Findings (from Batch 1 + Batch 2)

### XTDB v2 Node implements `IPersistentMap` (CRITICAL)
`xtdb.node.impl.Node` implements `clojure.lang.IPersistentMap`, which means:
- `(map? node)` returns **`true`** for a raw node
- `(:node node)` returns **`nil`** for a raw node (not the node itself)
- **Never use `(map? o)` to distinguish a raw node from an xt-map**

Correct pattern:
```clojure
(defn ->node [o]
  (if (and (map? o) (contains? o :node))
    (:node o)
    o))
```

### XTQL returns temporal columns as namespaced keywords
When XTQL returns temporal columns, they are keywordized with the `:xt/` prefix:
- `_system_from` → **`:xt/system-from`** (NOT `:_system-from` or `:system-from`)
- `_system_to` → **`:xt/system-to`**
- `_valid_from` → **`:xt/valid-from`**
- `_valid_to` → **`:xt/valid-to`**

This affects the SQL ASSERT and all dissoc calls:
```clojure
;; Correct:
(match* :users (:xt/system-from entity))
(dissoc e :xt/system-from :xt/system-to :xt/valid-from :xt/valid-to)

;; Wrong (will be nil):
(match* :users (:_system-from entity))
```

### XTQL bare keyword in binding vector = FILTER, not binding (CRITICAL)

`(from :table [{:xt/id id} :some-attribute])` — the bare keyword `:some-attribute` in
the binding vector acts as a **filter** (entity must have this attribute) but does NOT
bind it to a result variable. `(:some-attribute row)` will always return `nil`.

Only the map form `{:some-attribute var}` actually binds the value:

```clojure
;; WRONG — :token-layer/span-layers is a filter; (:token-layer/span-layers row) = nil
(xt/q node '(from :text-layers [{:xt/id id} :text-layer/token-layers]))

;; CORRECT — binds the value to tls
(xt/q node '(from :text-layers [{:xt/id id} {:text-layer/token-layers tls}]))
```

Use `[*]` wildcard **only** in the context of SQL queries (via `find-entities`), not bare XTQL `from`. XTQL `[*]` in `from` returns empty maps `{}` in practice — the wildcard binding is unreliable for `xt/q` with quoted XTQL.

### SQL queries via `find-entities` return full entity attributes (USE THESE for array columns)

The `find-entities` helper (which generates `SELECT * FROM table WHERE col = ?`) correctly
returns all document attributes. This is the **only reliable way** to query entities when
you need collection-valued attributes.

**Critical caveat**: SQL equality on array columns does NOT perform containment checking:
```clojure
;; WRONG — generates WHERE vocab_link$tokens = ? which fails for array columns
(find-entities node :vocab-links {:vocab-link/tokens some-token-id})

;; CORRECT — fetch all and filter in Clojure, or use XTQL unnest (see below)
(->> (find-entities node :vocab-links {})
     (filter #(some #{some-token-id} (:vocab-link/tokens %))))
```

### XTQL `unnest` for array containment queries (IDIOMATIC v2)

The proper v2 way to query for array containment is `unnest`:

```clojure
;; Find the parent text-layer containing a given token-layer-id in its array:
(first (xt/q node (xt/template
  (-> (from :text-layers [{:xt/id pid :text-layer/token-layers tls}])
      (unnest {:tl tls})
      (where (= tl ~tokl-id))
      (return pid)))))
```

This pushes filtering to the database and avoids deserializing all entities.
Currently we use `find-entities + Clojure filter` instead; the `unnest` approach
is more efficient at scale.

### `entity-with-sys-from` required before calling `match*`

Entities passed to `match*` must come from `entity-with-sys-from` (returns `:xt/system-from`).
Passing a plain `entity` result will have nil `:xt/system-from`, causing XTDB to throw
"expected xt/id" when the ASSERT runs with a NULL comparison.

### EDN parsing of XTDB responses requires `*data-readers*`

XTDB stores `java.time.Instant` and related types as tagged literals (`#xt/zdt "..."` etc.).
When parsing EDN responses containing these values:

```clojure
;; WRONG — throws "No reader function for tag xt/zdt"
(edn/read-string body-str)

;; CORRECT — XTDB registers its readers in *data-readers*
(edn/read-string {:readers *data-readers*} body-str)
```

### Protobuf conflict with Fulcro
`com.fulcrologic/fulcro` → `org.clojure/clojurescript` → `closure-compiler-unshaded` bundles
old protobuf classes that conflict with xtdb-core 2.0.0's protobuf 4.31.1. Fix:
```clojure
com.fulcrologic/fulcro {:mvn/version "3.8.6"
                        :exclusions [com.cognitect/transit-cljs
                                     com.cognitect/transit-js
                                     org.clojure/clojurescript]}
```
Also remove any dep that transitively pulls clojurescript (e.g. `binaryage/devtools`) from `:nrepl`.

---

## 11. Open Questions Resolved

### Q1: `assert-exists`/`assert-not-exists` available?
**RESOLVED: NO.** These XTQL DML operators were removed from v2 GA "due to lack of uptake." Use SQL `ASSERT` via `[:sql "ASSERT EXISTS (SELECT ...)"]` instead.

### Q2: Can `_system_from` be bound in XTQL `from`?
**RESOLVED: YES.** Include `_system_from` in the bind vector and use `:for-system-time :all-time` to access historical versions. Without the temporal filter, `_system_from` is not included in default results.

### Q3: Does `xt$txs` expose full operation payloads?
**RESOLVED: NO.** `xt$txs` stores only metadata: `_id` (tx-id), `system_time`, and `user_metadata`. It does **not** expose what documents were put/deleted. The fix (detailed in plan section 8) is to stop stripping `:op/tx-ops` from stored operation records — rollback then reads its inverse-op data from the `:operations` table directly, rather than from the native tx log. No redesign needed.

### Q4: Is `xt/execute-tx` truly synchronous?
**RESOLVED: YES.** `execute-tx` blocks until the node indexes the transaction and throws on failure. `submit-tx` is the async alternative.

### Q5: JDK 21 requirement?
**RESOLVED: YES.** JDK 21+ is required. Also needs JVM flag `--add-opens java.base/java.nio=ALL-UNNAMED` for Apache Arrow support.

### Q6: Performance of entity lookup by ID?
The `from` operator with `{:xt/id ~id}` binding performs a primary key lookup and should be O(1), equivalent to v1's `xt/entity`.

---

## 12. Dependency / Maven Coordinates

As of v2.x:
- Core: `com.xtdb/xtdb-api`
- In-process node: `com.xtdb/xtdb-core`
- Kafka log: `com.xtdb/xtdb-kafka`
- AWS S3 storage: `com.xtdb/xtdb-aws`
- GCP storage: `com.xtdb/xtdb-google-cloud`
- Azure storage: `com.xtdb/xtdb-azure`

The HTTP server module was removed in v2.1.0.

---

## Sources

- [XTQL Transactions (Clojure)](https://docs.xtdb.com/reference/main/xtql/txs.html)
- [XTQL Queries](https://docs.xtdb.com/reference/main/xtql/queries.html)
- [SQL Transactions](https://docs.xtdb.com/reference/main/sql/txs.html)
- [SQL Queries](https://docs.xtdb.com/reference/main/sql/queries.html)
- [xtdb.api Codox](https://docs.xtdb.com/drivers/clojure/codox/xtdb.api.html)
- [Using XTDB from Clojure](https://docs.xtdb.com/drivers/clojure.html)
- [Clojure Config Cookbook](https://docs.xtdb.com/ops/config/clojure.html)
- [Transactions/Consistency in XTDB](https://docs.xtdb.com/about/txs-in-xtdb.html)
- [Key Concepts](https://docs.xtdb.com/concepts/key-concepts.html)
- [v2.0.0 Release](https://github.com/xtdb/xtdb/releases/tag/v2.0.0)
- [v2.1.0 Release](https://github.com/xtdb/xtdb/releases/tag/v2.1.0)
- [GitHub: xtdb/xtdb](https://github.com/xtdb/xtdb)
