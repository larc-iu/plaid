# Plaid Technical Overview

Plaid is a Clojure platform for building linguistic annotation applications. It
serves a REST API over a hierarchical, layer-based data model that is
configurable per project. Persistent state lives in a single SQLite database;
every row-level mutation is captured in an append-only audit log, which is the
intended change-data-capture source for a downstream OLAP replica (see
`docs/sql-port-review-2026-05-27.md` §8).

## Core Technologies

* **Language**: Clojure
* **Database**: SQLite (file-backed; WAL + `BEGIN IMMEDIATE`) via HikariCP
* **Migrations**: Migratus (`resources/migrations/`, applied on startup)
* **Query builder**: HoneySQL — composed into SQL strings via
  `plaid.sql.common/format-sql`
* **Web server**: HTTP-kit with Ring middleware
* **Routing**: Reitit
* **Authentication**: JWT tokens (TTL configurable; see OPERATIONS.md §3)
* **API Documentation**: OpenAPI 3.0

## Code Organization

```
src/main/plaid/
├── server/          # HTTP server, datasource startup, locks, events
├── rest_api/v1/     # REST handlers, middleware, batch
├── sql/             # Database layer — entity-specific namespaces
│   └── constraints/ # Token-layer overlap + hierarchy invariants
├── algos/           # Text processing algorithms
└── config/          # Environment-specific configuration
```

## Data Model

### Entity Hierarchy

```
User
Project
├── Document
├── TextLayer
│   └── TokenLayer (may declare :parent-token-layer)
│       └── SpanLayer
│           └── RelationLayer
└── VocabLayer
```

Layers are immutable in their parent: once created, a layer's project (and a
token layer's text-layer / parent-token-layer) cannot be changed. Project IDs
are denormalized onto every layer row (`text_layers.project_id`, etc.) so a
single-row read suffices to resolve a layer's project — no joins.

### Access Control

Three project-level roles: **Reader** (GET), **Writer** (CRUD on annotations),
**Maintainer** (project config + user management). Plus a global **admin**.

### Core Entities

User, Project, Document, Text, Token, Span, Relation, VocabLayer, VocabItem,
VocabLink. See `docs/manual.adoc` for the conceptual data model.

## Database Layer

### Read vs Write

**Reads** go directly through `plaid.sql.common` primitives (`q`, `q1`,
`fetch-by-id`, `fetch-where`, `fetch-ids-as-map`). The first arg is a `db`
value — either a Hikari `DataSource` or an open `Connection` (inside a
transaction). Returned rows are plain column-keyed maps; each `plaid.sql.<entity>`
namespace defines a `row->entity` mapper that converts column names
(`begin`, `end_`, `text_layer_id`, ...) to the public `:token/begin` shape.

**Writes** go through `plaid.sql.operation/submit-operation!`:

```clojure
(submit-operation! [tx db {:type :token/create
                           :description "Create token"
                           :project project-id
                           :document doc-id
                           :user user-id}]
  (psc/insert! tx :tokens row))
```

The macro opens a `BEGIN IMMEDIATE` transaction (serializes writers — see
`common.clj` `build-datasource`), inserts the `operations` row, binds
`psc/*op*` for the body, runs body-fn, and bumps the parent
`documents.version` post-body. Failures project to
`{:success false :code <int> :error <msg>}`; ExceptionInfo with a `:code` key
is preserved, busy/locked is mapped to 503, everything else becomes 500. See
`operation.clj` for the full catch contract.

### Audit machinery

Every row touched inside `submit-operation!` produces an `audit_writes` row via
`psc/insert!` / `psc/update-by-id!` / `psc/delete-by-id!` / `psc/merge*` /
`psc/insert-many!` / `psc/bulk-update-by-id!` / `psc/delete-where!`. These
helpers capture pre/post images automatically. The raw entry point
`record-audit-write!` exists for writes whose meaningful change doesn't live in
a single parent-row write — see "synthetic-parent-row pattern" below.

Each audit row carries `(op_id, seq)` where `seq` is the per-op ordinal — load-
bearing for ETL replay, since all rows in one op share a single `ts`.

### Synthetic-parent-row audit pattern

For mutations that conceptually belong to a parent entity but live in a
junction table (`span_tokens`, `vocab_link_tokens`, `project_users`,
`project_vocabs`, `vocab_maintainers`) or a wide-narrow KV table
(`entity_metadata`), the writer emits **one synthetic audit_writes row against
the parent table**. The pre/post images carry the parent row plus the junction
state folded under a well-known key (`:tokens`, `:metadata`, `:readers`,
`:writers`, `:maintainers`, ...).

**Asymmetry**: `:insert` and `:update` audit rows fold junction state into
pre/post. `:delete` audit rows carry only the bare parent-row columns — the
junction state at delete time is implied by the parent's deletion and is NOT
re-folded (parent-owned-delete contract). Replayers track running junction
state from `:update` rows. See the comment block above `record-audit-write!`
in `common.clj`.

### Optimistic concurrency control (OCC)

Clients pass `?document-version=<int>` on mutating requests. The middleware
`wrap-document-version` (`rest_api/v1/middleware.clj`) reads the current
version, binds `psc/*expected-document-version*`, and submit-operation*
re-checks it INSIDE the write tx against `documents.version` (under
`BEGIN IMMEDIATE`, so the read and write share isolation). Mismatch throws
`{:code 409}` and rolls back. Skipped when no version supplied, no
`:document` on the op, or the row doesn't exist yet (covers
`:document/create`).

The post-body bump increments `documents.version` and `modified_at` so future
clients see the change. Callers whose body manages the version column itself
must pass `:skip-doc-version-bump? true`.

## Key Namespaces

* **`plaid.sql.common`** (`psc`) — datasource, write helpers, audit
  machinery, `with-tx` / `BEGIN IMMEDIATE`, slow-query logging, JSON
  serialization for `config`.
* **`plaid.sql.operation`** — `submit-operation*` (fn), `submit-operation!`
  (macro), `bump-document-version!`, `*current-batch-id*`,
  `*expected-document-version*` (re-exported from `psc`).
* **`plaid.sql.metadata`** — `insert-metadata!` / `replace-metadata!` /
  `delete-metadata!`. Folds `:metadata` into a synthetic parent-row audit row.
* **`plaid.sql.constraints.token`** — token-layer overlap modes
  (`:any` / `:non-overlapping` / `:partitioning`), nesting via
  `:token-layer/parent-token-layer` (containment derived purely from offsets,
  no per-token parent FK), cascade splitters for shift/split/text-edit.

## Token-layer Hierarchy + Overlap Modes

A token layer may declare an immutable `:token-layer/parent-token-layer`
sharing the same text layer (e.g. sentence → word → morpheme).

* **Overlap modes**: `:any` (default), `:non-overlapping`, `:partitioning`.
  `:partitioning` is root-only (rejected on nested layers).
* **Containment** for nested layers: every child token must sit inside some
  parent-layer token; enforced on create/update/bulk-create/merge/shift.
  Cross-parent merges/shifts are rejected geometrically (the escaping extent
  has no containing parent).
* **Delete cascades**: deleting a parent deletes every nested descendant
  (and their spans/relations/vocab-links).
* **Split / shift cascades**: descendants straddling the moved boundary are
  split (partitioning parent) or trimmed/deleted (non-overlapping / `:any`
  parent).
* **Single enforcement entry point**: `constraints/token/enforce` runs the
  pre-flight checks for the right op kind (`:create :update :delete
  :bulk-create :bulk-delete :merge :shift :split`). Constraint logic does NOT
  live in `token.clj`'s `*` builders.

Under `BEGIN IMMEDIATE` there's only one writer at a time, so the v2
`match*` / `ASSERT NOT EXISTS` machinery is gone — pre-flight + commit in
one tx is sufficient.

## Read Paths

Token reads ORDER BY `begin ASC, end_ ASC, precedence ASC NULLS LAST, id ASC`
(`document.clj:213-219`). `:token/precedence` is load-bearing for
same-extent tokens (e.g. fused morphemes in non-concatenative morphology).
The post-group sort in `sort-token-records` preserves this since its keys are
a prefix of the SQL key.

`get-with-layer-data` (document.clj) batches the layer tree + tokens + spans
(with `json_group_array(token_id ORDER BY order_idx)`) + relations + vocab
links into a handful of queries — never N+1.

## Test Infrastructure

`src/test/plaid/fixtures.clj`:

* **Shared datasource via `defonce`**: one in-memory SQLite DB
  (`file::memory:?cache=shared&mode=memory`) reused across all deftests. URI
  form survives Hikari idle eviction; bare `:memory:` would not.
* **`with-clean-db` as `:each` fixture**: TRUNCATE-equivalent
  (`DELETE FROM <table>` in FK-safe order) between deftests, preserving
  the standing test users so JWT tokens stay valid. Also resets in-process
  state atoms (locks, rate-limit buckets, event registries).
* **Concurrent-writer tests** exercise `BEGIN IMMEDIATE` serialization (see
  `occ_race_test.clj`, `set_tokens_audit_smoke_test.clj`).

Run: `clojure -M:test` (full suite). Single ns:
`clojure -M:test --namespace plaid.sql.token-test`. Single var:
`clojure -M:test --var plaid.sql.token-test/test-foo`. Pipe to a `/tmp` file
and grep for failures rather than scrolling the full output.

## Common Gotchas

* **`coerce-id-cols` only catches `:id` and `*_id` keys**. Aliases like
  `[:pv.project_id :pid]` come back as raw strings — comparing to a UUID via
  `=` silently never matches. See `common.clj:48-79`.
* **Validation OUTSIDE `submit-operation!` doesn't get projected** to a
  structured `:code` response. Move pre-flight `valid-name?` /
  `validate-atomic-value!` / shape checks INSIDE the macro body so they
  return `{:success false :code 400}` rather than bubble a raw 500.
* **`add-join-if-absent!`** uses `INSERT ... ON CONFLICT DO NOTHING` — don't
  add a SELECT-then-INSERT race back.
* **`reparent-junction!`** in `token.clj` is SQLite-specific (qualified
  column refs in EXISTS without an explicit table alias). Rewrite with
  `UPDATE t AS t1` if porting to Postgres.
* **`row->span` and `row->vocab-link` take a `tokens` arg** — they break
  the otherwise-uniform 1-arg row-mapper contract because the token list
  comes from a separate query.
* **`text.clj` has its own private `row->token`** to dodge the
  `plaid.sql.token` cycle — keep in sync with the real one.
* **No longer applies (v2 holdovers worth knowing)**: nested map JSON keys
  are NOT lowercased (SQLite has no PostgreSQL identifier rules — `:config`
  round-trips fine). `:xt/system-from` is gone (BEGIN IMMEDIATE replaces
  TOCTOU). `ASSERT NOT EXISTS` is gone. No operation-coordinator,
  no `:snapshot-time`, no pgwire, no `?as-of=` query parameter.

## Avoiding N+1 Queries

When you have a collection of IDs and need data for each, **never** map a
single-entity fetch over the list. Batch helpers in `common.clj`:

* `psc/fetch-ids` — single SELECT for many IDs.
* `psc/fetch-ids-as-map` — same, returns `{id -> row}`.
* `psc/bulk-update-by-id!` — single CASE UPDATE for many rows.
* `psc/delete-where!` — batched pre-image SELECT + WHERE DELETE + per-row
  audit.
* For dynamic IN-lists: `(let [ph (str/join ", " (repeat (count ids) "?"))]
   (psc/q db (into [(str "... IN (" ph ")")] ids)))`.

Watch for: `(mapv #(ns/get db %) ids)`, fetching the same entity multiple
times across validation + record + sys-from passes, sequential parent
traversals in loops.

## Namespace Shadowing in `plaid.sql.*`

Most `plaid.sql.*` namespaces use `(:refer-clojure :exclude [get merge])` (some
also exclude `format`). Inside those namespaces, use `clojure.core/get` /
`clojure.core/merge` when you mean the standard-library version.

## REPL access & Clojure editing

* nREPL port lives in `plaid-core/.nrepl-port`. `user/start` / `user/stop`
  control the web server (`src/dev/user.clj`).
* Evaluate via the `clojure-eval` skill, or shell:
  `clj-nrepl-eval -p "$(cat plaid-core/.nrepl-port)" "(your-expr)"`.
* A `clj-paren-repair` PostToolUse hook fixes delimiter/balance errors
  after each `Edit`/`Write`.

## API Structure

Base path: `/api/v1/`. Default port 8085 (see OPERATIONS.md §4).

### Endpoints

* `POST /login` — returns JWT.
* `POST /logout` — invalidates ALL of the user's live tokens (not just the
  current device's — bumps `users.password_changes`).
* `GET /openapi.json` — full OpenAPI spec (can be disabled in production via
  `:plaid.api :expose-openapi?`).
* CRUD for users, projects, documents, layers, texts, tokens, spans,
  relations, vocab-layers, vocab-items, vocab-links.
* `?document-version=<int>` on mutating requests for OCC (see above).

### Batches

`submit-operations!` (REST batch handler) runs N sub-ops inside one outer
SQLite tx. `with-tx*` detects an already-in-tx Connection and runs body
inline rather than opening an inner tx, so a sub-op's throw rolls back the
entire outer tx. Each sub-op binds its own `psc/*op*`, so per-row audits land
under separate `operations` rows but share the outer tx's atomic commit.

### Authentication

JWT tokens in `Authorization: Bearer <token>` header. Tokens carry the user's
`password_changes` counter; bumping that counter invalidates every outstanding
token (used by both password change AND `/logout`). TTL is configurable via
`:plaid.auth :jwt-ttl-seconds` (default 30 days).

## Client Libraries

* **JavaScript**: `plaid-client-js/` — ESM, `fetch`, SSE.
* **Python**: `plaid-client-py/` — `requests`-based.

Both auto-convert between kebab-case wire format and language conventions
(camelCase / snake_case).

## Development Access

* **HTTP API**: `http://localhost:8085/api/v1/`. OpenAPI at
  `http://localhost:8085/api/v1/openapi.json`.
* **Default creds**: `a@b.com` / `password`. Login field is `user-id`:
  `curl -X POST .../login -d '{"user-id":"a@b.com","password":"password"}'`.
* **SQLite CLI**: `sqlite3 data/plaid.db` for ad-hoc reads. Don't write —
  bypasses the audit log.

### When to use each interface

* **REPL** (`clojure-eval` skill): most powerful — call application fns
  (`plaid.sql.project/get` etc.), run HoneySQL or raw SQL, iterate fast.
* **HTTP API** (`curl`): for testing REST surface — coercion, auth,
  middleware, error handling, end-to-end behavior.
* **`sqlite3`**: ad-hoc SQL exploration. Schema-tables view: `.tables`.
  Per-row history lives in `audit_writes`.

## Tests

Run: `clojure -M:test`. Pipe to `/tmp` and grep:

```
clojure -M:test 2>&1 | tee /tmp/test-run.txt | tail -10
```

Prefer single-namespace runs while iterating.

## OLAP Replica (Time Travel)

Optional read-only XTDB v2 replica fed from `audit_writes` via an
in-process tailer. Lives under `plaid.olap.*`:

* `plaid.olap.core` — mount/defstate for the XTDB node, cursor accessors
* `plaid.olap.replayer` — translates audit rows → XTDB tx-ops
* `plaid.olap.tailer` — poll loop. A malformed/structural audit row stalls
  the tailer (operator recovers via `resume!`); a transient `SQLITE_BUSY` on
  the read does NOT stall — it retries next poll, so it self-heals under
  write contention.
* `plaid.olap.document` — `get-at`, `get-with-layer-data-at`, `list-versions`

Exists to support one read shape: "doc X at time T," exposed via
`?as-of=<ISO-8601>` on document GET endpoints. Anti-features: no
arbitrary queries, no analytics, no historical-ACL, no writes.

Disabled by default (shipped + prod); **on in dev** (`config/dev.edn`).
Operators opt in elsewhere via `:plaid.olap/config :enabled? true` in env
config. See `OPERATIONS.md` §12 for the full ops guide and
`docs/olap-design.md` for the design rationale + open questions.

## See Also

* `docs/manual.adoc` — user-facing conceptual model + layer semantics.
* `docs/sql-port-review-2026-05-27.md` — 21-agent review consolidated;
  includes audit-retention policy (§8).
* `docs/olap-design.md` — OLAP replica design + decision rationale.
* `OPERATIONS.md` — deployment, config keys, backup, CORS, JWT secret,
  OLAP enable/disable + recovery (§12).
