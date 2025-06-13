# Plaid Technical Overview

Plaid is a Clojure-based platform for building linguistic annotation applications. It provides a REST API for managing hierarchical linguistic data structures with built-in versioning, access control, and audit logging.

## Core Technologies

- **Language**: Clojure
- **Database**: XTDB (immutable, bitemporal database) with LMDB storage
- **Web Server**: HTTP-kit with Ring middleware
- **Routing**: Reitit
- **Authentication**: JWT tokens
- **State Management**: Mount
- **API Documentation**: OpenAPI 3.0

## XTDB Key Characteristics

XTDB is an immutable, bitemporal database that provides:
- **Immutability**: All data is versioned; nothing is ever deleted, only new versions are created
- **Time Travel**: Query any point in history using `as-of` parameter
- **Optimistic Concurrency Control**: Uses `::xt/match` operations to prevent conflicting writes
- **Schemaless**: No enforced schema, requiring careful data integrity management in application code

## Architecture

### Directory Structure
```
src/main/plaid/
├── server/          # HTTP server setup, middleware, XTDB configuration
├── rest_api/v1/     # REST API endpoint handlers
├── xtdb/            # Database layer (entity-specific namespaces)
├── algos/           # Text processing algorithms
└── config/          # Environment-specific configuration
```

### Namespace Patterns

1. **API Layer** (`plaid.rest-api.v1.*`): HTTP request handling, parameter validation, response formatting
2. **Database Layer** (`plaid.xtdb.*`): XTDB operations, data integrity, transaction preparation
3. **Server Layer** (`plaid.server.*`): Infrastructure, middleware, authentication

## Data Model

### Entity Hierarchy
```
User
Project
├── Document
└── TextLayer
    └── TokenLayer
        └── SpanLayer
            └── RelationLayer
```

### Core Entities

1. **User**: Authentication entity with bcrypt-hashed passwords
2. **Project**: Container with access control lists (readers, writers, maintainers)
3. **Document**: Content holder within projects, can have media attachments
4. **Text**: Primary text content (one per TextLayer per Document)
5. **Token**: Substring reference with begin/end indices into Text
6. **Span**: Annotation over one or more Tokens with arbitrary value
7. **Relation**: Directed edge between two Spans with arbitrary value

### Access Control

Three permission levels per project:
- **Reader**: Read-only access
- **Writer**: Read and write access
- **Maintainer**: Full control including user management

## Database Patterns

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

### Data Integrity Rules

1. **Single Database Snapshot**: All reads within a write operation must use the same DB snapshot
2. **Optimistic Concurrency**: Every write must include `::xt/match` operations for affected entities
3. **Referential Integrity**: Manually maintained; deletes must clean up all references
4. **Error Handling**: Throw `ex-info` with `:code` (HTTP status) for validation failures

## API Structure

Base path: `/api/v1/`

### Key Endpoints

- `POST /login` - Returns JWT token
- CRUD operations for: users, projects, documents, layers, texts, tokens, spans, relations
- `GET /projects/:project-id/audit` - Audit log for project operations
- `GET /documents/:document-id/audit` - Audit log for document operations
- `GET /users/:user-id/audit` - Audit log for user actions (admin only)

### as-of
- The query parameter `:as-of` is available on all routes and must contain a valid ISO 8601 string if present.
- It is only valid for GET requests--a 400 will be triggered with any other method.
- When provided, the resource will be shown as it existed at the given time, allowing users to see past states.

### Authentication

- JWT tokens in `Authorization: Bearer <token>` header
- Tokens do not expire by time; they are invalidated when the user's password changes
- User permissions checked at project level for all operations

## Audit System

All write operations are logged with:
- User ID
- Timestamp
- Operation type
- Entity type and ID
- Human-readable description

Accessible via audit endpoints for projects, documents, and users (see Key Endpoints above).

## Layer Configuration

Each layer has a `:config` field for storing arbitrary EDN data. This enables UI customization without code changes:
- Token layers can specify if they represent words, morphemes, etc.
- Span layers can specify cardinality constraints
- Relation layers can specify allowed relation types

## Common Operations Flow

1. **Creating a document with annotations**:
   - Create Document in Project
   - Create Text linked to Document and TextLayer
   - Create Tokens referencing Text substrings
   - Create Spans referencing Tokens
   - Create Relations between Spans

2. **Modifying with integrity**:
   - Read current state into single DB snapshot
   - Validate all constraints
   - Prepare transaction with `::xt/match` ops for all affected entities
   - Submit transaction (fails atomically if any match fails)

## Testing

Run tests with: `clojure -M:test`

Tests use a separate XTDB node configuration to avoid affecting development data.

## Client Code Generation

Plaid includes a JavaScript client generator that creates a fully-typed API client from the OpenAPI specification.

### Usage
```bash
clojure -M:gen openapi.json client.js
```

### Generated Client Features

1. **Automatic Key Transformation**: 
   - Converts between kebab-case (API) and camelCase (JavaScript)
   - Handles namespaced keys (e.g., `project/name` → `name`)

2. **Organized API Methods**:
   - Groups endpoints into logical bundles (e.g., `client.projects.create()`)
   - Infers method names from HTTP verbs and paths
   - Supports custom method names via OpenAPI extensions

3. **Built-in Authentication**:
   - Automatically includes JWT token in headers
   - Excludes auth header for login endpoint

4. **Error Handling**:
   - Provides detailed error objects with status, URL, and response body
   - Preserves HTTP error context for debugging

5. **Parameter Handling**:
   - Supports path, query, and body parameters
   - Optional parameters with default values
   - Automatic request/response transformation

### Example Generated Code
```javascript
const client = new PlaidClient('http://localhost:8085/api/v1', token);

// Create a project
const project = await client.projects.create('my-project', 'My Project');

// Add a document
const doc = await client.documents.create(project.id, 'doc1', 'Document 1');

// All keys are automatically converted between formats
console.log(doc.projectId); // API returns 'project-id'
```

## Important Constraints

1. **No Orphaned Data**: Deleting entities must cascade properly
2. **Token Boundaries**: Must be valid indices into parent Text
3. **Span Tokens**: Must reference at least one Token
4. **Relation Endpoints**: Both source and target must exist
5. **Layer Hierarchy**: Child layers cannot exist without parents

## Error Codes

Standard HTTP status codes are used:
- 404: Entity not found
- 409: Conflict (e.g., duplicate ID)
- 422: Validation error
- 403: Permission denied
- 401: Authentication required
