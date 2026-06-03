# Plaid Query Language

A way to search Plaid annotation data expressively, across every project you can
read, in one request. You describe a **pattern** — entities (spans, tokens,
relations, vocab items) and the relationships between them — and the engine
returns every match.

It's exposed as `POST /api/v1/query` and as a `query()` method on the official
clients. This document uses the **Python client** for its examples, with a
JavaScript snippet where the syntax differs.

---

## 1. Mental model

A query is a **conjunctive graph pattern**, in the spirit of Datalog:

- You declare **variables** (`?s`, `?t`, …) for the entities you're looking for.
- You write a list of **clauses**. Each clause is either an **entity pattern**
  (`a span on the "pos" layer with value "NOUN", call it ?s`) or a
  **relationship** between two variables (`?s covers ?t`).
- All clauses must hold simultaneously (implicit AND). Re-using a variable in two
  clauses **joins** them.
- You ask for some of those variables back, as ids, full entities, or a count.

There's also a CQP-style **`:seq`** shorthand for the common case of *"this token,
immediately followed by that token"* — it desugars into the same primitives.

> Clauses are **conjunctive by default** — every clause must hold. Use the
> explicit `:or` clause (§5.5) for disjunction and `:not` (§5.6) for negation.

```python
from plaid_client import PlaidClient

client = PlaidClient.login("http://localhost:8085", "you@example.com", "password")

# "Find every NOUN immediately followed by a VERB" (across all readable projects)
result = client.query({
    "find": ["?s1", "?s2"],
    "where": [
        ["span", "?s1", {"layer": "pos", "value": "NOUN"}],
        ["span", "?s2", {"layer": "pos", "value": "VERB"}],
        ["covers", "?s1", "?t1"], ["covers", "?s2", "?t2"],
        ["precedes", "?t1", "?t2"],
    ],
})
# -> {"return": "ids", "columns": ["s1", "s2"],
#     "results": [["<noun-id>", "<verb-id>"], ...], "count": N, "truncated": false}
```

---

## 2. Request shape

A query is a JSON object (a Python `dict` / a JS object):

| Key | Required | Meaning |
|---|---|---|
| `find` | yes | Non-empty list of variables to return, in column order. |
| `where` | yes | Non-empty list of clauses (the pattern). |
| `scope` | no | Restrict to specific projects. Default: every project you can read. |
| `limit` | no | Max rows. Default 100, hard cap 1000 (see §10). |
| `order-by` | no | Sort the results (see §2.5). Without it, row order is unspecified. |
| `return` | no | `"ids"` (default), `"entities"`, or `"count"` (see §9). |
| `strict-layers` | no | If `true`, scalar layer references must be ids (reject names/paths/aliases — §6). |

### 2.5 Ordering — `order-by`

Without `order-by` the rows come back in whatever order the database finds them —
fine for a `count`, useless for a concordance. `order-by` is a list of
`[variable, attribute]` (or `[variable, attribute, "desc"]`) entries, applied
left to right:

```python
# NOUNs, sorted by document then by position in the text
client.query({
    "find": ["?t"],
    "where": [["token", "?t", {"layer": "Words"}],
              ["span",  "?s", {"layer": "POS", "value": "NOUN"}],
              ["covers", "?s", "?t"]],
    "order-by": [["?t", "doc"], ["?t", "begin"]],
})
```

- The variable **must be one you `find`** — you can only sort by something you
  return.
- The attribute depends on the variable's kind: tokens take
  `begin` / `end` / `precedence` / `doc` / `id`; spans and relations take
  `value` / `doc` / `id`; vocab items take `form` / `id`.
- Direction is `"asc"` (default) or `"desc"`. Missing values (e.g. a null
  `precedence`) always sort last, either direction.
- Ordering is applied across the whole result, including queries that use `:or`
  or `:seq` (which run as a union internally).

### Variables

A variable is a **string beginning with `?`**: `"?s1"`, `"?token"`, `"?head"`.
The name is arbitrary; what matters is that the same name in two clauses refers
to the same entity (that's the join). Every variable in `find` must be bound by
some clause in `where`.

---

## 3. Entity clauses

An entity clause has the form `[kind, "?var", {constraints}]`. The **kind** picks
the entity type (and the table + access-control scope); the **constraint map**
filters it.

| Kind | Constraints | Notes |
|---|---|---|
| `"span"` | `layer`, `value`, `doc` | `value` matches the stored annotation value. |
| `"token"` | `layer`, `doc`, `begin`, `end` | `begin`/`end` are character offsets. |
| `"relation"` | `layer`, `value`, `doc`, `source`, `target` | `source`/`target` may be inline variables (see §4). |
| `"vocab"` | `layer`, `form` | Vocab items are global; scoped via project grants (§8). `form` is plain text. |

All constraints are optional, but a layer-less entity is still scoped to your
readable projects (§8). A few examples:

```python
["span", "?s", {"layer": "UPOS", "value": "NOUN"}]      # a NOUN annotation
["token", "?t", {"layer": "Words"}]                      # any word token
["token", "?t", {"layer": "Words", "begin": 0}]          # a word starting at offset 0
["relation", "?r", {"layer": "deprel", "value": "nsubj"}]  # an nsubj edge
["vocab", "?v", {"form": "Kemal"}]                        # the lexeme "Kemal"
```

> **Value matching.** `value` (on spans and relations) is compared against the
> stored value exactly. `form` (on vocab) is plain text. The clients and the
> engine handle encoding for you — just pass the literal you want.

> **One-of (alternation).** The literal-match keys — `value`, `form`, `doc`,
> `begin`, `end` — also accept a **list**, meaning "any of these":
> `{"value": ["NOUN", "PROPN"]}` → `value IN (…)`. (Not `layer`, which must
> resolve to a single layer — §6.)

> **Regex.** `value` and `form` also accept a regex spec
> `{"regex": "<pattern>", "flags": "i"?}`:
> ```python
> ["span",  "?s", {"layer": "Lemma", "value": {"regex": "^walk"}}]   # walk, walks, walking…
> ["vocab", "?v", {"form": {"regex": "ция$", "flags": "i"}}]          # case-insensitive suffix
> ```
> The only supported flag is `"i"` (case-insensitive). For `value`, the pattern
> is matched against the *decoded* string, so anchors (`^` / `$`) behave as you'd
> expect. Patterns are POSIX-compatible; stick to common syntax (`. * + ? [] ^ $
> |`) for portability. A malformed pattern is a `400`.

---

## 4. Relationship clauses

A relationship clause is `[op, "?a", "?b"]` — a named edge between two variables.
This is where the graph structure comes from.

| Clause | Meaning |
|---|---|
| `["covers", "?span", "?token"]` | the span includes that token (a span↔token edge) |
| `["precedes", "?t1", "?t2"]` | `?t2` is the **immediate** successor of `?t1` in token order |
| `["precedes*", "?t1", "?t2"]` | `?t1` comes **somewhere before** `?t2` (transitive) |
| `["within", "?child", "?parent"]` | `?child`'s extent sits inside `?parent`'s (token hierarchy by offsets) |
| `["first-in", "?token", "?container"]` | `?token` is within `?container` and is the **first** token of its layer there |
| `["source", "?relation", "?span"]` | the relation's source endpoint |
| `["target", "?relation", "?span"]` | the relation's target endpoint |
| `["vocab-link", "?token", "?vocab"]` | the token is linked to that vocab item |

**Token order** for `precedes`/`precedes*` is the canonical Plaid order:
`(begin, precedence, end, id)` — the same order tokens appear in when you read a
document. `precedes` is the *immediate* next token in that order; `precedes*` is
"anywhere after."

**`within`/`first-in`** are pure offset containment — a child is within a parent
when the parent's `[begin, end]` covers the child's. Pin the child and parent to
different token layers (e.g. morpheme within word within sentence) to express a
hierarchy. A token is never "within" itself, but containment is non-strict, so an
equal-extent child (a full-width morpheme equal to its word) *is* within its
parent.

> **Token relationships are scoped to one text, and `precedes`/`precedes*` to one
> token layer.** `precedes` never chains across documents or across token layers —
> a word token does not "precede" a morpheme token. `within`/`first-in` compare
> any two token vars by offset but still require the same text.

Relations can be written two equivalent ways — inline on the entity clause, or as
separate edges:

```python
# inline source/target variables:
["relation", "?r", {"layer": "deprel", "value": "nsubj", "source": "?h", "target": "?d"}]

# is the same as:
["relation", "?r", {"layer": "deprel", "value": "nsubj"}]
["source", "?r", "?h"]
["target", "?r", "?d"]
```

---

## 5. `:seq` — token sequences

Linear token patterns ("a determiner, then optionally an adjective, then a noun")
are awkward to write with `covers` + `precedes` by hand, so there's a CQP-style
shorthand. A `seq` clause walks **one token layer**; each element matches a token
at the next position, and elements are adjacent by `precedes`.

```python
# Determiner immediately followed by a noun (over the Words layer)
["seq", {"layer": "Words"},
 ["span", {"layer": "UPOS", "value": "DET"}, "as", "?d"],
 ["span", {"layer": "UPOS", "value": "NOUN"}, "as", "?n"]]
```

Each element is `[kind, {constraints}]`, optionally followed by `"as", "?var"` to
capture it. A `"span"` element matches a token that the span covers; a `"token"`
element matches the sequence token directly.

### Quantifiers (bounded)

Wrap an element to repeat it:

| Form | Meaning |
|---|---|
| `["?", element]` | 0 or 1 |
| `["rep", n, m, element]` | between `n` and `m` (inclusive, `m ≤ 16`) |

```python
# DET, optional ADJ, NOUN
["seq", {"layer": "Words"},
 ["span", {"layer": "UPOS", "value": "DET"}, "as", "?d"],
 ["?", ["span", {"layer": "UPOS", "value": "ADJ"}]],
 ["span", {"layer": "UPOS", "value": "NOUN"}, "as", "?n"]]
```

Rules:
- Only **fixed** (non-quantified) elements may be named with `"as"` — a quantified
  element is anonymous filler.
- Unbounded quantifiers (`*`, `+`) are **not** supported; use a bounded `rep`.
- The `seq` config may also carry `"doc"` to pin the whole sequence to one
  document.

Under the hood, bounded quantifiers expand to a `UNION` of the possible lengths,
so the query above matches both *DET NOUN* and *DET ADJ NOUN*.

## 5.5 Disjunction — `:or`

The pattern is conjunctive by default. For "this OR that", use an `:or` clause:
`["or", group, group, …]` where each **group is a list of clauses** (its own
conjunction). The query matches if *any* group matches.

```jsonc
// a token tagged NOUN or VERB
["or", [["span", "?s", {"layer": "UPOS", "value": "NOUN"}]],
       [["span", "?s", {"layer": "UPOS", "value": "VERB"}]]]
```

A group can hold several clauses, and the surrounding conjunctive clauses apply
to every branch — so this finds tokens that are *either* a sentence-initial DET
*or* covered by a PROPN span:

```jsonc
["token", "?t", {"layer": "Words"}],
["or",
 [["first-in", "?t", "?s"], ["token", "?s", {"layer": "Sentences"}],
  ["span", "?d", {"layer": "UPOS", "value": "DET"}], ["covers", "?d", "?t"]],
 [["span", "?p", {"layer": "UPOS", "value": "PROPN"}], ["covers", "?p", "?t"]]]
```

Rules:
- **At least 2 groups**, each a non-empty list of clauses.
- Every `find` variable must be **bound in every group**, with the **same kind**
  in each (so result columns are well-typed) — otherwise 400.
- `:or` may nest, and a group may contain a `:seq`.
- Each group is compiled as its own conjunctive query and the results are
  `UNION`ed (set semantics — a row matching two groups appears once).

> For simple "one field is one of several values" alternation, prefer a **value
> list** (§3) — `{"value": ["NOUN", "PROPN"]}` compiles to a single `IN` rather
> than a UNION of branches.

## 5.6 Negation — `:not`

`["not", clause, clause, …]` matches when the negated sub-pattern (the
conjunction of its clauses) has **no** match — a `NOT EXISTS` anti-join.

```jsonc
// words with no NOUN annotation on them
["token", "?t", {"layer": "Words"}],
["not", ["covers", "?s", "?t"], ["span", "?s", {"layer": "UPOS", "value": "NOUN"}]]
```

How variables behave (this is the important part):

- A variable that is **also bound in the positive (non-`:not`) part** of the
  query is **correlated** — the negation is checked *for that binding*. Above,
  `?t` is bound positively, so `:not` means "this particular `?t` has no covering
  NOUN span."
- A variable that appears **only inside the `:not`** is **existential** to the
  negation ("there is no `?s` such that…"). It is *not* bound by the outer query,
  so it **may not be a `find` variable** (that's a 400).

Rules:
- At least one clause to negate.
- Negation is over your readable scope, same as everything else.

`:not` composes with everything. It distributes into `:or` branches, and its body
may itself contain `:or`/`:seq`/`:not`:

```jsonc
// words covered by NEITHER a NOUN nor a VERB span (De Morgan: NOT(A OR B))
["token", "?t", {"layer": "Words"}],
["not", ["or", [["covers","?s","?t"], ["span","?s",{"layer":"UPOS","value":"NOUN"}]],
               [["covers","?s","?t"], ["span","?s",{"layer":"UPOS","value":"VERB"}]]]]
```

`NOT(A OR B)` becomes `NOT(A) AND NOT(B)`; a nested `:not` is a double negation
(`NOT(NOT(A))` ⇔ `A` exists). (For the simple NOUN-or-VERB case above, a value
list — `{"value": ["NOUN","VERB"]}` — is lighter.)

---

## 6. Layer addressing

Wherever a clause takes a `layer`, you can name it three ways. They're tried in
this order:

1. **Alias** — a stable label set in the layer's config under the reserved
   `plaid` / `alias` editor-config pair (set it with
   `PUT …/config/plaid/alias` → `"pos"`). Best for cross-project queries that
   share a convention (e.g. every project's POS layer aliased `"pos"`).
2. **Path** — `"ProjectName/LayerName"`. Convenient for one project at the REPL.
3. **ID** — the raw layer UUID. Always unambiguous.

```python
["span", "?s", {"layer": "pos"}]                 # alias
["span", "?s", {"layer": "My UD Project/UPOS"}]  # path
["span", "?s", {"layer": "98ef7a32-...-1327101afee3"}]  # id
```

A scalar `layer` reference must identify **exactly one** layer. Because names,
paths, and aliases are all non-unique (two projects can share a name; an alias is
a shared convention), a reference that matches several layers in your scope is an
**ambiguous 400**, not a silent match-them-all:

```json
// 400: "pos layer reference \"pos\" is ambiguous — it matches 3 layers in your scope."
["span", "?s", {"layer": "pos"}]
```

To pick one, use its id (or narrow `scope` to a single project). Matching several
layers on purpose isn't a scalar reference — it'll be expressed with a layer
*variable* (planned).

> **Prefer IDs in application code.** A UI or script already holds the layer ids
> of whatever it loaded; feed those in — they're unambiguous by construction.
> Names/aliases are best for human exploration.

> **Strict mode.** Set `"strict-layers": true` on the query to *reject* scalar
> name/path/alias references outright (400) — only layer ids or layer variables
> (§6.5) are allowed. A query-building UI can turn this on to guarantee its
> queries are unambiguous by construction.

### 6.5 Layer variables

Instead of a layer *reference*, the `layer` slot can hold a **variable**
(`"?sl"`). A layer variable binds the entity's layer as a first-class node, which
lets you do two things references can't:

**Same-layer join** — two entities sharing a layer variable are forced onto the
*same* (otherwise unspecified) layer:

```jsonc
// a NOUN and a VERB span that live on the SAME layer (whichever it is)
["span", "?a", {"layer": "?sl", "value": "NOUN"}],
["span", "?b", {"layer": "?sl", "value": "VERB"}]
```

**Project the layer** — put a layer variable in `find` to get the layer id back.

**Intentional multi-layer match** — a layer variable can be constrained by a
`*-layer` clause, and because layer *names* aren't unique, this is the sanctioned
way to match the same layer across many projects (the thing a scalar reference
refuses with an "ambiguous" 400):

```jsonc
// every NOUN span on a layer named "pos", in ALL readable projects
["span", "?s", {"layer": "?sl", "value": "NOUN"}],
["span-layer", "?sl", {"name": "pos"}]
```

The layer-constraint clause matches the entity's kind: `span-layer`,
`token-layer`, `relation-layer`, `vocab-layer`. It constrains by `name` or
`alias`; an unconstrained layer variable ranges over every layer of its kind in
scope. (A layer variable used for two different kinds — e.g. a span's layer and a
token's layer — is a 400 kind conflict.)

---

## 7. Putting it together — worked examples

These run against a Universal Dependencies project with a token hierarchy
`Sentences › Words › Morphemes`, a `UPOS` span layer (on morphemes), and a
`Dependency Relations` relation layer. Layers are addressed by path here; swap in
ids for real code.

```python
P = "My UD Project"

# How many NOUNs?  -> {"return": "count", "count": 38, "truncated": false}
client.query({
    "find": ["?s"],
    "where": [["span", "?s", {"layer": f"{P}/UPOS", "value": "NOUN"}]],
    "return": "count",
})

# Determiner immediately followed by a noun, as full entities
client.query({
    "find": ["?d", "?n"],
    "where": [["seq", {"layer": f"{P}/Morphemes"},
               ["span", {"layer": f"{P}/UPOS", "value": "DET"}, "as", "?d"],
               ["span", {"layer": f"{P}/UPOS", "value": "NOUN"}, "as", "?n"]]],
    "return": "entities",
    "limit": 20,
})

# Every nsubj dependency whose dependent is sentence-initial
client.query({
    "find": ["?r"],
    "where": [
        ["relation", "?r", {"layer": f"{P}/Dependency Relations",
                            "value": "nsubj", "target": "?dep"}],
        ["covers", "?dep", "?td"],
        ["within", "?td", "?s"], ["token", "?s", {"layer": f"{P}/Sentences"}],
        ["first-in", "?td", "?s"],
    ],
})

# Tokens linked to a vocab item
client.query({
    "find": ["?t"],
    "where": [["vocab", "?v", {"form": "Kemal"}], ["vocab-link", "?t", "?v"]],
})

# Restrict to one project by id (defensive; works even with duplicate names)
client.query({
    "find": ["?s"],
    "where": [["span", "?s", {"layer": "UPOS", "value": "NOUN"}]],
    "scope": {"project_ids": ["5b7ce985-...-6d1186cbd822"]},
})
```

---

## 8. Scope & access control

A query only ever sees data in projects **you can read** — access control is
applied server-side from your authenticated identity and **cannot be widened** by
the request. By default the scope is *all* your readable projects.

Narrow it with `scope`:

```python
"scope": {"projects": ["Project A", "Project B"]}   # by name (non-unique!)
"scope": {"project_ids": ["<uuid>", "<uuid>"]}       # by id (unambiguous)
```

The requested scope is **intersected** with what you can read, so you can only
ever narrow, never widen. Vocab layers are global; a vocab item is visible if a
project in your scope has been granted its layer.

---

## 9. Return shapes

Set `return` to choose the result shape:

### `"ids"` (default)

```json
{"return": "ids",
 "columns": ["s1", "s2"],
 "results": [["<id>", "<id>"], ...],
 "count": 12,
 "truncated": false}
```

`results` is a list of rows; each row has one id per `find` variable, in order.
`columns` echoes the variable names (without `?`).

### `"entities"`

Same envelope, but each cell is the **full entity object** — exactly the shape
the corresponding `GET` endpoint returns (id, layer, value, and nested data like
a span's ordered token list or a relation's source/target). Hydrated in one pass,
no N+1 per duplicate.

```python
r = client.query({..., "return": "entities"})
r["results"][0][0]
# -> {"id": "...", "layer": "...", "value": "NOUN", "tokens": ["..."], ...}
```

### `"count"`

```json
{"return": "count", "count": 38, "truncated": false}
```

A scalar count of distinct matches. It ignores `limit`. For safety it is computed
up to 100,000; a result past that reports `count: 100000, truncated: true`.

---

## 10. Result-size guardrails

`ids`/`entities` queries are paginated by `limit`:

- No `limit` → **100** rows.
- An explicit `limit` is honored up to a hard cap of **1000** (a larger value is
  clamped).
- `truncated: true` means you hit the (effective) limit and there may be more.

There is no cursor yet; to page through a large result, add more selective
clauses or query per-project. `count` is bounded separately (§9).

Every query's execution is also bounded by a **30-second time limit** — a query
that exceeds it is aborted and returns HTTP **408**. If you hit it, the pattern
is too broad: add a more selective clause or tighten `scope`.

---

## 11. Errors

Author errors return HTTP **400** with a message:

```json
{"error": "No span layer matching \"poss\" is visible in the queried project scope"}
```

The clients raise this as an exception (`PlaidAPIError` in Python). Common causes:
an unbound `find` variable, a duplicate `find` variable, an unknown clause or
constraint key, a layer reference that doesn't resolve or is **ambiguous** (§6),
an unbounded `seq` quantifier, or an unsupported `return` value.

A query that runs too long returns **408** (§10). Internal failures return **500**
with a generic message (the details are logged server-side, not exposed).

---

## 12. The clients and casing

The official clients pass your query body through their normal request/response
pipeline, which converts naming conventions automatically — so you write queries
in your language's idiom and read results in it too:

- **Request keys** are recased to the wire format. In Python you can write
  `scope={"project_ids": [...]}`; in JavaScript `scope: { projectIds: [...] }`.
  Both become `project-ids` on the wire.
- **Clause heads, variables, and values are plain string *values*** — they are
  passed through untouched. Write them literally: `"span"`, `"?s1"`,
  `"vocab-link"`, `"NOUN"`.
- **Response entity objects** are recased and namespace-stripped for you, so a
  span comes back as `{"value": "NOUN", "tokens": [...]}` in Python
  (`snake_case`) / JavaScript (`camelCase`), not `{"span/value": ...}`.

### The same query in JavaScript

The structure is identical; only the surrounding language idiom differs
(`camelCase` config keys, object literals):

```javascript
const result = await client.query({
  find: ['?d', '?n'],
  where: [
    ['seq', { layer: 'Words' },
      ['span', { layer: 'UPOS', value: 'DET' }, 'as', '?d'],
      ['?', ['span', { layer: 'UPOS', value: 'ADJ' }]],
      ['span', { layer: 'UPOS', value: 'NOUN' }, 'as', '?n']],
  ],
  scope: { projectIds: ['<uuid>'] },   // camelCase -> project-ids on the wire
  return: 'entities',
  limit: 20,
});
// result.results[0][0] -> { id: '...', value: 'DET', tokens: ['...'] }
```

Note the only differences from Python: `projectIds` vs `project_ids` (your
client's convention; both convert), object-literal syntax, and `await`. The
clause heads (`'span'`, `'seq'`, `'?'`), variables (`'?d'`), and values
(`'NOUN'`) are written exactly the same in both languages.

---

## 13. Clause reference

**Entities** — `[kind, "?var", {constraints}]`:

| Kind | Constraint keys |
|---|---|
| `span` | `layer` `value` `doc` |
| `token` | `layer` `doc` `begin` `end` |
| `relation` | `layer` `value` `doc` `source` `target` |
| `vocab` | `layer` `form` |

**Relationships** — `[op, "?a", "?b"]`:

`covers` · `precedes` · `precedes*` · `within` · `first-in` · `source` ·
`target` · `vocab-link`

**Sequence** — `["seq", {layer, doc?}, element, …]` where each element is
`[kind, {constraints}]` (optionally `…, "as", "?var"`) or a quantifier wrapper
`["?", element]` / `["rep", n, m, element]`.

**Disjunction** — `["or", group, group, …]` (≥2 groups; each group a list of
clauses). Matches if any group matches; results are UNIONed.

**Negation** — `["not", clause, …]`. Matches when the conjunction of the clauses
has no match (`NOT EXISTS`). Vars bound outside correlate; inner-only vars are
existential (and can't be in `find`).

**Layer variable** — a var in the `layer` slot (`{"layer": "?sl"}`); bind/share a
layer (same-layer join, projection). Constrain it with `["span-layer", "?sl",
{"name"|"alias": …}]` (or `token-layer`/`relation-layer`/`vocab-layer`).

**Top level** — `{find, where, scope?, limit?, return?, strict-layers?}`.

---

## 14. Not yet supported (roadmap)

- Unbounded sequence quantifiers (`*`, `+`).
- Cursor/streaming for very large result sets.
- Historical / `as-of` querying (the QL runs against current state only).
- Bulk edits driven by query matches.

These are tracked separately; the language above is the stable v0 surface.
