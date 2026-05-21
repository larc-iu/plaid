# Plaid Technical Overview
Plaid is a Clojure-based platform for building linguistic annotation applications.
It provides a REST API for managing hierarchical linguistic data structures.
It features a data model that is configurable on a per-project basis using "layers", which are composable.
Thanks to its immutable database, XTDB (v2), it is also able to offer a full history of all data and audit logging.

## Core Technologies
* **Language**: Clojure
* **Database**: XTDB v2 (immutable & bitemporal; storage persisted under `data/`)
* **Web Server**: HTTP-kit with Ring middleware
* **Routing**: Reitit
* **Authentication**: JWT tokens
* **API Documentation**: OpenAPI 3.0

## Code Organization
```
src/
├── main/plaid/
│   ├── server/          # HTTP server setup, middleware, XTDB configuration
│   ├── rest_api/v1/     # REST API endpoint handlers
│   ├── xtdb2/           # Database layer (entity-specific namespaces)
│   ├── algos/           # Text processing algorithms
│   └── config/          # Environment-specific configuration
└── dev/                 # Development utilities and user namespace
```

## Data Model

### Entity Hierarchy
```
User
Project
├── Document
├── TextLayer
│   └── TokenLayer
│       └── SpanLayer
│           └── RelationLayer
└── VocabLayer
```

Each Layer type also holds corresponding annotations.
While a given layer type always must have the same kind of parent (e.g. a TokenLayer must always depend on a TextLayer), a Project may be configured to have multiple layers of any given type.
For instance, you might use one SpanLayer for marking sentence boundaries and another for holding part-of-speech tags.

### Layer Configuration
Each layer has a `:config` field for storing arbitrary data. This enables UI customization without code changes:
- Token layers can specify if they represent words, morphemes, etc.
- Span layers can specify cardinality constraints
- Relation layers can specify allowed relation types

### Core Entities

1. **User**: Authentication entity with bcrypt-hashed passwords
2. **Project**: Container with access control lists (readers, writers, maintainers)
3. **Document**: Content holder within projects, can have media attachments
4. **Text**: Primary text content (one per TextLayer per Document)
5. **Token**: Substring reference with begin/end indices into Text
6. **Span**: Annotation over one or more Tokens with arbitrary value
7. **Relation**: Directed edge between two Spans with arbitrary value
8. **VocabLayer**: Vocabulary management layer across projects
9. **VocabItem**: Individual vocabulary entries with metadata
10. **VocabLink**: Links VocabItems with Tokens

### Access Control

Three permission levels per project:
- **Reader**: Read-only access
- **Writer**: Read and write access
- **Maintainer**: Full control including user management

## Database Patterns
XTDB v2 is an immutable, bitemporal database. See `docs/xtdb2_reference.md` for detailed API reference.

Entities are stored in **tables** (e.g. `:projects`, `:tokens`, `:span-layers`). Each entity has an `:xt/id` uniquely identifying it within its table. The mapping from entity type to table name is defined in `plaid.xtdb2.common/entity-table`.

Queries use **XTQL** (Clojure-native) or **SQL**:
```clojure
;; XTQL
(xt/q node '(from :projects [{:xt/id id} :project/name]))
;; SQL
(xt/q node "SELECT _id, project$name FROM projects")
```

Past states can be viewed using `:snapshot-time` in query opts.

### Transaction Operations
Writes are submitted via `xt/execute-tx`:

* `[:put-docs :table doc]` — upsert a document into a table
* `[:delete-docs :table id]` — delete a document (retained in history)
* `[:sql "ASSERT ..." [params]]` — assertion that aborts the tx on failure (used for optimistic concurrency)
* Custom `match*` in `plaid.xtdb2.common` — compares `:xt/system-from` to detect concurrent modifications

### Maintaining Integrity
Database writes (in `plaid.xtdb2`) are prepared with `match*` assertions to ensure invariants hold. For example, when updating a token's extent, we verify the text hasn't changed concurrently by matching on `:xt/system-from`.

### Read vs Write Functions

**Read functions** accept a node or xt-map:
```clojure
(defn get [node-or-map id] ...)  ; Can be node or {:node node}
```

**Write functions** require `xt-map` parameter:
```clojure
(defn create [xt-map ...] ...)  ; Must be {:node node} (may also contain :snapshot-time)
```

### Transaction Patterns
Functions ending with `*` prepare transactions without submitting:
```clojure
(defn create* [...] ...)   ; Returns transaction ops vector
(defn create [...] ...)    ; Calls create* and submits via operation coordinator
```

### Operation Coordinator
Write operations go through `plaid.xtdb2.operation-coordinator`, which serializes writes and handles the `submit → await → verify` cycle. The `submit-operations!` macro in `plaid.xtdb2.operation` is the standard entry point for all writes.

### Batch Operations
Batch requests bind `op/*current-batch-id*` to group multiple operations atomically. When set, individual operations skip the coordinator and are submitted together. Failed batches can be rolled back using stored `:op/tx-ops`.

### Audit Log
We maintain an audit log which records each op, which we use to refer to a conceptually atomic operation from the perspective of our data model, e.g. "change a text record's `:text/body`" or "delete a token".
For each op, we record (cf. `plaid.xtdb2.audit`):

* `:op/type`: the kind of write
* `:op/project`: the affected project (`nil` if not applicable)
* `:op/document`: the affected document (`nil` if not applicable)
* `:op/description`: a human-readable summary of the change

While most REST API endpoints result in exactly one op, some may result in multiple ops.
The audit log therefore consists of records with `:audit/id` which includes the following:

* `:audit/ops`: a vector of `:op/id`, i.e. references to the constituent ops of this audit log entry
* `:audit/user`: the user who is responsible for the ops
* `:audit/projects`: the union of all `:op/project`s
* `:audit/documents`: the union of all `:op/document`s

There is exactly one such audit record for all audited non-GET endpoints.

### Constraint System

Constraints enforce invariants on token operations (e.g. overlap modes: `:any`, `:non-overlapping`, `:partitioning`). The architecture follows these principles:

1. **Constraints must be part of the atomic transaction.** The DB must never be in an invalid state. Pre-flight checks are a UX optimization (fail fast with a good error message), not the safety mechanism.

2. **`match*` on read entities provides TOCTOU safety for complex invariants.** Read all relevant entities, validate in Clojure, include `match*` ops for everything read → either the tx succeeds or a `match*` fails (concurrent modification, tx rolls back). SQL ASSERTs are an optimization for simple cases (overlap checks).

3. **`*` functions are constraint-unaware.** They build tx-ops for what was asked, period. No constraint checks, no ASSERT ops, no compensation, no skip flags.

4. **`-operation` functions call `tc/enforce` once.** They build base tx-ops via the `*` fn, then call `(tc/enforce op-kw node ctx base-ops)` which runs pre-flight checks (throwing on violation) and returns base-ops augmented with ASSERTs/neighbor-adjustments. No overlap-mode interpretation lives in `token.clj`.

5. **Cascade paths call `*` functions directly** then do their own compensation. No flags needed.

The three-layer pattern:
```
*            → pure tx-op builders (token.clj)
-operation   → call * for base ops, then tc/enforce once (token.clj)
public API   → submit-operations! wrapper (token.clj)
```

Cascade pattern (e.g. text body edits deleting tokens):
```
tok/multi-delete*           → called directly, no constraint checks
tc/compensate-after-cascade → separate compensation step
```

`tc/enforce` composes three independent concerns (each a no-op when not applicable), so it is the single place all token-layer constraints are interpreted:
- **`enforce-overlap`** — within-layer overlap mode (`:any`/`:non-overlapping`/`:partitioning`), incl. merge adjacency and shift neighbor-adjustment.
- **`enforce-nesting`** — containment for a *nested* layer (one with `:token-layer/parent-token-layer`): every new/changed child token must sit inside some parent-layer token (the containing parent is `match*`ed). See "Token-layer hierarchy" below.
- **`enforce-parent-guard`** — the reverse: structural ops on a token that has nested children must not orphan them.

**Partitioning invariant:** a `:partitioning` layer is, for any document, always **empty or a complete cover** of the text — never partial. Single create/delete/extent-update are rejected; bulk-create establishes (validated), bulk-delete removes the whole partition at once, split/merge/shift are partition-preserving. `enforce-shift` bounds-checks the moved boundary against the neighbor (it must land strictly inside the neighbor's extent) so a shift can't zero-width, invert, or overshoot a token; the layer is otherwise not re-validated after a shift.

Public surface of `tc`:
- `enforce` — single entry point keyed on op (`:create :update :delete :bulk-create :bulk-delete :merge :shift :split`); takes `[op node ctx base-ops]`, runs pre-flight checks + appends safety ops, returns augmented tx-ops.
- `compensate-after-cascade` / `text-edit-partition-asserts` — the text-body-edit cascade's partitioning guards (root partitioning layers only; nested layers resize with the text). compensate runs after EVERY edit (insert/append/prepend/delete), extending tokens to close gaps then fail-closed `validate-partition!`; the asserts handle concurrency (see Concurrency note).
- `straddling-descendant-token-ids-at` / `-in` — used by the resize and split cascades respectively (see below).
- `find-overlapping-tokens` / `validate-partition!` remain public utilities; `check-*`, `validate-partition-range!`, `guard-dlids`, the ASSERT builders, and the per-axis `enforce-*` fns are private.

**Concurrency note:** the operation coordinator serializes *batches* against regular ops but does NOT serialize regular ops against each other. Per-row `match*`/overlap-`ASSERT`s make `:non-overlapping` and the partition-preserving ops (split/merge/shift each `match*` both sides of every boundary they touch) safe. Partitioning *establishment* (`bulk-create`) has no row to `match*`, so `enforce` adds `partition-establish-assert-sql` — an `ASSERT NOT EXISTS` for any token in the layer+doc other than the ones being inserted — to block a concurrent establishment.

Text-body edits (`text/update-body*`) are the one extent-changing path outside `enforce`, so they carry their own two TOCTOU `ASSERT`s for concurrency (a concurrently-created token has no row for the edit to `match*`): (1) **`oob-assert`** — no token of the text may end past the new length, so a token created concurrently with a *shrink* can't survive out-of-bounds; (2) **`text-edit-partition-asserts`** — each root partitioning layer that is empty at the edit's read must stay empty, so a concurrent establishment can't leave a partition covering only the old extent after a *grow*. A concurrent token write on a text being edited therefore conflicts and one side rolls back (retry).

### Token-layer hierarchy (nesting)

A token layer may declare an immutable `:token-layer/parent-token-layer` (must share the same text layer). This models e.g. sentence > word > morpheme. Parentage is **derived by offset containment** — there is no per-token parent ref — so spans/vocab-links/merge keep working unchanged and migration is a no-op (existing flat layers have no parent).

- **Containment** (`enforce-nesting`): every token in a nested layer must be contained in some parent-layer token (same doc), enforced on create/update/bulk-create/merge/shift; the containing parent is `match*`ed for TOCTOU. Cross-parent merges/shifts are impossible (the escaping extent has no containing parent).
- **Partitioning is root-only**: `:partitioning` is rejected on a nested layer (one with a parent) — `create*` in token_layer.clj throws. On a nested layer it could only mean "tile each parent token," a leaky invariant (a freshly created parent has no children yet, and merging non-adjacent parents gaps the tiling), so it was dropped. Nested layers are `:any` or `:non-overlapping`. Natural IGT mapping now: sentence = `:partitioning` (root), word = `:non-overlapping` + parent=sentence, morpheme = `:any` + parent=word (`:any`, not `:non-overlapping`, so fused/non-concatenative morphemes can share a span — see manual.adoc; containment is still enforced regardless of overlap-mode).
- **Delete cascades** (`-operation` expands the delete set with descendants): deleting a parent token deletes every token nested in it — and, via `multi-delete*`, those tokens' spans/relations/vocab-links. This is the same "delete dependents that can no longer validly exist" pattern as token→span deletion. `enforce-parent-guard` adds a TOCTOU assert that no descendant remains. Applies to both single delete and bulk-delete.
- **Split cascades**: splitting a token at `p` also splits every straddling descendant at `p` (via `straddling-descendant-token-ids-in` + `split-straddlers*`), so a split never orphans a child; descendants re-home into the two halves by offset.
- **Resize cascades** (shift/update extent, via `resize-child-cascade*` in token.clj): mode-dependent, and symmetric for shrink/grow. A **`:partitioning` parent** grows/shrinks its neighbor, so straddling descendants are *split* at the moved boundary and the outside half re-homes to the neighbor by offset — works whether the boundary moved into this token (the straddler is its own child) or into the neighbor (the straddler is the neighbor's child), because the partitioning scan is doc-wide and a disjoint partition puts the moved boundary inside exactly one parent. A **non-overlapping/`:any` parent** has no neighbor, so descendants straddling the new extent are *trimmed* to it and descendants left fully outside are *deleted* (with dependents). `enforce-parent-guard` adds the matching TOCTOU assert (no-straddler for partitioning, no-out-of-bounds for the rest).

- **Read API**: `GET /documents/:id?include-body=true` surfaces each token layer's `overlap-mode` (defaulted to `:any`) and `parent-token-layer` (omitted for roots) in the projection (`document.clj` `get-doc-info`), so a client can render the hierarchy without a per-layer `GET /token-layers/:id`.

**Deferred**: a general cross-entity constraint protocol (the only thing left — every parent op now cascades correctly).

**CORS**: `:access-control-allow-methods` includes `:patch` (config/defaults.edn + middleware.clj fallback) — PATCH endpoints (token/text/layer/project/document updates) were otherwise blocked for cross-origin browser clients.

**Adding a new token constraint:** add its logic to the relevant `enforce-*` axis (and helpers) in `constraints/token.clj`. No changes to `*` functions or `-operation` call sites beyond passing any new ctx keys.

## API Structure
Base path: `/api/v1/`.
Default port for development: `8085`.

### Endpoints
- `POST /login` - Returns JWT token
- `GET /openapi.json` - return an OpenAPI JSON describing the entire API.
- CRUD operations for: users, projects, documents, layers, texts, tokens, spans, relations, vocab-layers, vocab-items, vocab-links

### as-of
- The query parameter `:as-of` is available on all routes and must contain a valid ISO 8601 string if present.
- It is only valid for GET requests--a 400 will be triggered with any other method.
- When provided, the resource will be shown as it existed at the given time, allowing users to see past states.

### Authentication
- JWT tokens in `Authorization: Bearer <token>` header
- Tokens do not expire by time; they are invalidated when the user's password changes
- User permissions checked at project level for all operations

## Testing
Run tests with: `clojure -M:test`.
To run a specific set of tests, you can use the `--namespace my.clojure.namespace` and `--var my.clojure.namespace/specific-test` arguments.
Do not combine `--namespace` and `--var`, just use one or the other.

Tests use a separate XTDB node configuration to avoid affecting development data.

## Client Libraries
Client libraries are maintained separately:

* **JavaScript**: `plaid-client-js/` — ESM package, uses `fetch` for HTTP and SSE
* **Python**: `plaid-client-py/` — pip-installable package, uses `requests`

Both clients automatically convert between API conventions (kebab-case) and language-specific conventions (camelCase for JavaScript, snake_case for Python).

## API Route Reference

To quickly see available API routes from the OpenAPI specification:

```bash
# List all routes with their HTTP methods
jq -r '.paths | keys[]' target/openapi.json

# Show routes with their HTTP methods and summaries
jq -r '.paths | to_entries[] | "\(.key):" + (.value | to_entries[] | " \(.key | ascii_upcase) - \(.value.summary // "No summary")")' target/openapi.json

# List only specific entity routes (e.g., projects)
jq -r '.paths | keys[] | select(contains("projects"))' target/openapi.json

# Show authentication requirements
jq -r '.paths | to_entries[] | select(.value | to_entries[] | .value.security) | .key' target/openapi.json
```

## REPL access & Clojure editing (clojure-mcp-light)
* A running nREPL is the most powerful way to develop here. The dev REPL writes its port to `plaid-core/.nrepl-port`. Use `user/start` / `user/stop` to control the web server (see @src/dev/user.clj).
* Evaluate Clojure against the running nREPL with the `clojure-eval` skill, or directly from a shell:
  `clj-nrepl-eval -p "$(cat plaid-core/.nrepl-port)" "(your-expr)"`. Use it to call application fns (e.g. `plaid.xtdb2.project/get`), run XTQL/SQL against the node, and verify behavior before writing code.
* Just use the normal `Edit`/`Write` tools for Clojure files — a `clj-paren-repair` PostToolUse hook automatically fixes delimiter/balance errors after each edit.
* Try not to run all the tests at once. Prefer testing individual namespaces like `clojure -M:test --namespace plaid.rest-api.v1.project-test`. Pipe the output to a /tmp file so you can easily inspect it later.
* When running tests, use `tee` to capture output: `clojure -M:test 2>&1 | tee /tmp/test-run.txt | tail -10` then grep the file for failures.

## Development Access
* **HTTP API**: Available at `http://localhost:8085/api/v1/` when the server is running. OpenAPI spec at `http://localhost:8085/api/v1/openapi.json`.
* **Default credentials**: During development, use `a@b.com` / `password` as valid admin credentials. Login field is `user-id` (not `email`): `curl -X POST .../login -d '{"user-id":"a@b.com","password":"password"}'`.
* **XTDB pgwire**: Connect via `psql -h localhost -p 5433 -d xtdb` (must specify `-h localhost` for TCP and `-d xtdb` for the database name).

### When to use each interface
* **REPL** (`clojure-eval` skill / `clj-nrepl-eval`): Best for most development tasks. Call application-level functions directly (e.g. `plaid.xtdb2.project/get`), run XTQL or SQL queries against the node, test code changes interactively. This is the most powerful option — you have full access to application internals and can require/call any namespace.
* **HTTP API** (`curl`): Use when testing the REST API itself — verifying request/response formats, coercion, auth, middleware behavior, error handling. Also useful for end-to-end validation of a feature. Requires a JWT token from the login endpoint.
* **pgwire** (`psql`): Use for quick ad-hoc SQL exploration of the database — checking what tables exist, viewing raw column names (note: nested keys use `$` separator, e.g. `project$name`), and querying history with `FOR ALL SYSTEM_TIME`. Handy for inspecting data without needing to write Clojure, but read-only and no access to application logic.

## Avoiding N+1 Queries
When you have a collection of IDs and need data for each one, **never** map a single-entity fetch over the list. Use batch operations instead:

```clojure
;; BAD — N+1: one query per ID
(mapv #(get node %) ids)
(keep #(vocab-item/get node %) ids)
(mapv #(pxc/entity node :tokens %) tokens)

;; GOOD — single query for all IDs
(pxc/entities-with-sys-from node :projects (vec ids))
(pxc/entities-with-sys-from-by-id node :tokens token-ids)  ; returns {id -> entity} map
```

Common anti-patterns to watch for:
- **`(mapv #(ns/get node %) ids)`**: Replace with batch fetch + in-memory formatting
- **Fetching same entities multiple times** (validation, then records, then sys-from for match): Fetch once with `entities-with-sys-from-by-id` and reuse
- **Unbounded table scans filtered in Clojure**: Push filters into SQL with `IN` clauses or XTQL `where`
- **Sequential parent traversals in loops**: If you need a parent field (e.g. project-id) for N entities, batch-fetch the entities and extract the field in-memory

For SQL `IN` queries with dynamic ID lists:
```clojure
(let [ph (str/join ", " (repeat (count ids) "?"))]
  (xt/q node (into [(str "SELECT * FROM table WHERE _id IN (" ph ")")] ids)))
```

## Namespace Shadowing in `plaid.xtdb2.*`
Most namespaces in `src/main/plaid/xtdb2/` use `(:refer-clojure :exclude [get merge])` (some also exclude `format`) and define their own `get`, `merge`, etc. for entity operations. When writing code **inside** these namespaces, use `clojure.core/get`, `clojure.core/merge`, etc. whenever you need the standard library versions, or you will get errors or silently call the wrong function.

## XTDB Reference
See
