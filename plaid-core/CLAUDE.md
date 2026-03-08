# Plaid Technical Overview
Plaid is a Clojure-based platform for building linguistic annotation applications.
It provides a REST API for managing hierarchical linguistic data structures.
It features a data model that is configurable on a per-project basis using "layers", which are composable.
Thanks to its immutable database, XTDB (v2), it is also able to offer a full history of all data and audit logging.

## Core Technologies
* **Language**: Clojure
* **Database**: XTDB v2 (currently in-memory; disk persistence not yet configured)
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
├── gen/plaid/           # Client code generation utilities
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

## Client Code Generation
Plaid includes client generators that create fully-typed API clients from the OpenAPI specification. Both JavaScript and Python clients are supported.

### Usage
```bash
# JavaScript client
clojure -M:gen target/openapi.json target/clients/client.js js

# Python client
clojure -M:gen target/openapi.json target/clients/client.py py
```

Both clients feature improved parameter casing handling that automatically converts between API conventions (kebab-case) and language-specific conventions (camelCase for JavaScript, snake_case for Python).

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

## clojure-mcp
* When `clojure-mcp` is active, you can use it to start an nREPL server and launch the web server if necessary. Use `user/start` and `user/stop` to control the web server. See @src/dev/user.clj.
* If `clojure-mcp` is active, you should **prefer to use its tools** to edit Clojure files, as this will help you keep parentheses balanced more easily.
  * Use `mcp__clojure-mcp__clojure_edit` for editing top-level Clojure forms (`defn`, `def`, `ns`, `defmethod`, etc.). Always try the regular `Edit` tool first; fall back to `clojure_edit` if it returns "String to replace not found".
  * Use `mcp__clojure-mcp__clojure_eval` to evaluate expressions in the running REPL (nREPL on port 7888 when server is running). Useful for verifying DB queries, checking entity state, etc. before writing code.
* Try not to run all the tests at once. Prefer testing individual namespaces like `clojure -M:test --namespace plaid.rest-api.v1.project-test`. Pipe the output to a /tmp file so you can easily inspect it later.
* When running tests, use `tee` to capture output: `clojure -M:test 2>&1 | tee /tmp/test-run.txt | tail -10` then grep the file for failures.

## Development Access
* **HTTP API**: Available at `http://localhost:8085/api/v1/` when the server is running. OpenAPI spec at `http://localhost:8085/api/v1/openapi.json`.
* **Default credentials**: During development, use `a@b.com` / `password` as valid admin credentials. Login field is `user-id` (not `email`): `curl -X POST .../login -d '{"user-id":"a@b.com","password":"password"}'`.
* **XTDB pgwire**: Connect via `psql -h localhost -p 5433 -d xtdb` (must specify `-h localhost` for TCP and `-d xtdb` for the database name).

### When to use each interface
* **REPL** (`clojure_eval`): Best for most development tasks. Call application-level functions directly (e.g. `plaid.xtdb2.project/get`), run XTQL or SQL queries against the node, test code changes interactively. This is the most powerful option — you have full access to application internals and can require/call any namespace.
* **HTTP API** (`curl`): Use when testing the REST API itself — verifying request/response formats, coercion, auth, middleware behavior, error handling. Also useful for end-to-end validation of a feature. Requires a JWT token from the login endpoint.
* **pgwire** (`psql`): Use for quick ad-hoc SQL exploration of the database — checking what tables exist, viewing raw column names (note: nested keys use `$` separator, e.g. `project$name`), and querying history with `FOR ALL SYSTEM_TIME`. Handy for inspecting data without needing to write Clojure, but read-only and no access to application logic.

## XTDB Reference
See 
