# Plaid Technical Overview
Plaid is a Clojure-based platform for building linguistic annotation applications.
It provides a REST API for managing hierarchical linguistic data structures. 
It features a data model that is configurable on a per-project basis using "layers", which are composable.
Thanks to its immutable database, XTDB (v1), it is also able to offer a full history of all data and audit logging.

## Core Technologies
* **Language**: Clojure
* **Database**: XTDB
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
│   ├── xtdb/            # Database layer (entity-specific namespaces)
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
XTDB (https://v1-docs.xtdb.com/main/) is an immutable database similar to Datomic.
XTDB is schemaless and graph-based: it contains _documents_, which are Clojure maps with an `:xt/id` uniquely identifying it within the database.
Because it is immutable, past states of the entire database can easily be viewed using `(xt/db node iso-8601-string)`.
Writes are submitted to XTDB as _transactions_.
A transaction is a vector of _operations_, which are in turn vectors headed by an operation type:

* `[:xtdb.api/put doc]`: write an entire document, replacing the previous record if it exists
* `[:xtdb.api/delete doc-id]`: delete a document (though it will be retained in history)
* `[:xtdb.api/match doc-id doc]`: cause the transaction to fail if the current state of `doc-id` does not match `doc` (useful when using optimistic concurrency to maintain data model integrity)

### Maintaining Integrity with Matches
Because XTDB is schemaless, database writes (in `plaid.xtdb`) must be carefully prepared with all the `::xt/match` statements necessary so that the write will commit if and only if no invariants will be violated by the resulting state.
One important invariant, for example, is that a token's `:token/end` attribute, which holds a substring index, must never be greater than the length of the `:text/body` attribute (a string) within the text object which is referred to by the `:token/text` attribute.
During a write to `:token/end`, therefore, we must first ensure that the new value is valid for the current state of the text (cf. `plaid.xtdb.token/set-extent`), and then prepare the transaction.
But since another write may have occurred in the meantime, we must also include an `::xt/match` op in order to ensure that there have been no changes to the text in between the time we read it and the exact time at which our write will be committed.

### Read vs Write Functions

**Read functions** accept flexible `db-like` parameter:
```clojure
(defn get [db-like id] ...)  ; Can be node, db, or xt-map
```

**Write functions** require `xt-map` parameter:
```clojure
(defn create [xt-map ...] ...)  ; Must be {:node node :db db}
```

### Transaction Patterns
Functions ending with `*` prepare transactions without submitting:
```clojure
(defn create* [...] ...)   ; Returns transaction vector
(defn create [...] ...)    ; Calls create* and submits
```

### Audit Log
We maintain an audit log which records each op, which we use to refer to a conceptually atomic operation from the perspective of our data model, e.g. "change a text record's `:text/body`" or "delete a token".
For each op, we record (cf. `plaid.xtdb.audit`):

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
Run tests with: `clojure -M:test`

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
When `clojure-mcp` is active, note that you can `user/start` and `user/stop` the web server. See @src/dev/user.clj.
If `clojure-mcp` is active, you should **prefer to use its tools** to edit Clojure files, as this will help you keep parentheses balanced more easily.
