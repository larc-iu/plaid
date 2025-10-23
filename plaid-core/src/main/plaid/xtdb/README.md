# XTDB Layer
These are some notes on how to write code in this namespace.

## Core Conventions

### Function Signatures: Read vs. Write

Functions which **read** (only access data) and **write** (both access and modify data) should have different signatures which are differentiated by their first argument.

- **Reads** take a `db-like` as their first argument.
- **Writes** take an `xt-map` as their first argument.

### Read Functions: `db-like` Parameter

Read functions accept a flexible `db-like` parameter that can be any of:

- An XTDB node (`XtdbNode`)
- An XTDB database (`QueryDatasource`) 
- An `xt-map` (a map containing `:node` and optionally `:db` keys)

The `->db` function in `common.clj` handles converting any of these to an XTDB database for querying. This flexibility allows reads to work in various contexts without forcing callers to manage database snapshots.

```clojure
;; All of these work:
(user/get node user-id)
(user/get (xt/db node) user-id)  
(user/get {:node node :db (xt/db node)} user-id)
```

### Write Functions: `xt-map` Parameter

Write functions require an `xt-map` as their first argument - a map containing:

- `:node` - The XTDB node (required)
- `:db` - An XTDB database snapshot (optional, will be created if missing)

The `ensure-db` function in `common.clj` ensures the `:db` key is populated if not provided. This pattern is crucial for data integrity (see "Database Consistency" below).

```clojure
;; Typical usage:
(user/create {:node node} user-id true "password")

;; With explicit db snapshot:
(user/create {:node node :db (xt/db node)} user-id true "password")
```

## Transaction Preparation vs Execution

### Functions Ending in `*`

Write functions ending in `*` (asterisk) **prepare** transaction vectors but do **not submit** them. These functions:

- Return a transaction vector suitable for `pxc/submit!` (which uses `xt/submit-tx` under the hood)
- Perform all validation and integrity checks
- Can be composed into larger transactions
- Enable reuse in other write operations

### Functions Without `*`

For every `*` function, there should typically (though this is not required) be a corresponding function without the `*` that:

- Calls the `*` function to prepare the transaction
- Submits the transaction using the `submit!` macro
- Returns a standardized result map with `:success` and optional `:error`/`:code` keys

```clojure
;; Transaction preparation:
(defn create* [xt-map id is-admin password]
  ;; ... validation and transaction building ...
  [match put])

;; Transaction execution:
(defn create [xt-map id is-admin password]
  (pxc/submit! (:node xt-map) (create* xt-map id is-admin password)))
```

## Maintaining Data Model Integrity

XTDB is schemaless, so we must be especially careful to never commit a write which invalidates assumptions we need to make about our data.
For instance, joins to other entities should never be broken: of an entity is deleted, for example, then steps must be taken to ensure that all references to that entity are removed.

### Reading a Single Point in Time

Many writes have to access database state they don't initially have in order to prepare their transactions.
Throughout a write operation's entire lifecycle, **exactly one** database snapshot must be used for all reads and validation checks. 
This ensures that any writes which occur on a different thread during the preparation of the transaction do not bleed in and produce what might effectively be an integrity-compromised view of the database.
The `xt-map` pattern with `:db` makes follow this rule easy. `ensure-db` creates the snapshot once, and all subsequent operations use that same snapshot.

### Optimistic Concurrency Control

We use optimistic concurrency control in order to handle concurrent writes: we assume that most writes will not conflict with each other, and in case they do, we are prepared to have the entire transaction fail.
Accordingly, every write **must** include `::xt/match` operations to guard against concurrent modifications that could compromise data model integrity.
Think very carefully about every record that is implicated in the data model integrity of the write both before and after the write is performed.

For example, suppose we have some `e1` that is `{:xt/id e1-id :e1/e2-list []}` and we want to add an `e2-id` to the `:e1/e2-list`.
We should match against both `e1` and `e2`.
We match with `e1` because, for example, another write might have modified `:e1/e2-list`.
We match with `e2` because, for example, `e2` might have been deleted in the meantime.
Note that the `e1` and `e2` **must** come from the single database snapshot which is serving the entire write.

See an example of what adding this join would look like.
The first `::xt/match` op makes the transaction fail, if when the transaction is evaluated, the value of the entity with ID `e1-id` does not match the full state of the entity `e1` we recorded during the preparation of our transaction.

```clojure
;; Example: joining two entities requires matching both
[[::xt/match e1-id e1]  ;; 
 [::xt/match e2-id e2]           ; Match entity being referenced  
 [::xt/put (update e1 :refs conj e2-id)]]
```
## Error Handling in Transactions

Every write function **must** check all necessary invariants as it is preparing the write transaction.
For instance, if a user is being created, we must check that no user with the same ID already exists. 

If an integrity error occurs, use an exception: `(throw (ex-info "message" {:code http-code}))`.
Messages should be user-friendly and safe for API responses (no secrets)
The code should be a valid HTTP status code that aligns with the nature of the issue.
Some examples:

```clojure
(cond
  (some? (pxc/entity db id))
  (throw (ex-info (str "User already exists with ID " id) {:code 409}))
  
  (nil? (pxc/entity db target-id))
  (throw (ex-info (str "Target record not found with ID " target-id) {:code 404})))
```

The `submit!` macro in `common.clj` provides standardized error handling for all writes:

- Catches `ExceptionInfo` thrown during transaction preparation
- Logs errors appropriately
- Returns consistent result maps
- Preserves error codes for HTTP responses
