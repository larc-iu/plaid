# Plaid IGT JSON — the native export format

**Format id:** `plaid-igt` · **Current version:** 1 · **Produced by:** the Export wizard's
"Plaid IGT JSON (lossless .zip archive)" format · **Serializer:** `src/export/nativeJson.js`

Plaid IGT JSON is a lossless archive of an IGT project, expressed in IGT terms —
sentences > words > morphemes, annotation fields by scope, orthographies, lexicon
items and links, time alignment, and provenance — rather than as a dump of the
underlying substrate (layers/tokens/spans). It is designed for archival and for a
future re-importer; the importer is not implemented yet, but every contract it
needs is specified here and honored by the exporter.

## Versioning policy

- `formatVersion` (integer, in `project.json`) governs the whole archive.
- **Breaking** changes — key renames, semantic changes, removed guarantees — bump it.
- **Additive** optional keys do NOT bump it. Consumers must ignore unknown keys.
- Version 1 is frozen by this document.

## Archive layout

```
project.json                 manifest + project identity + IGT schema + layer-id map
vocabularies/<name>.json     one per project vocabulary
documents/<name>.json        one per exported document
media/<name>.<ext>           embedded document media (optional, default on)
```

The export is **always a zip**, even when a single document is exported: document
files reference vocabulary items by id, the schema in `project.json` is needed to
interpret field and orthography names, and media needs a container. Filenames are
sanitized display labels, deduplicated with ` (2)` suffixes — **ids are identity,
names are labels**; the manifest in `project.json` maps ids to archive paths.

## Global conventions

- Keys are camelCase; user-defined field/orthography names appear verbatim as object keys.
- A `metadata` key is **omitted when empty** (absent = `{}`).
- All character offsets are **Unicode code points** into the owning document's `baseline.body`.
- All times are **seconds** (floats).
- Every id in the archive is a **correlation key**, not a value to write back: a
  re-importer creates fresh entities and maps old ids to new ones.

## project.json

| key | meaning |
|---|---|
| `format`, `formatVersion` | `"plaid-igt"`, integer version |
| `exportedAt` | ISO timestamp of the export |
| `asOf` | ISO timestamp when this is a historical (time-travel) export, else `null` |
| `project` | `{id, name}` of the source project |
| `schema.orthographies` | `[{name}]` — non-baseline orthographies on the word layer |
| `schema.fields` | `{sentence, word, morpheme}` → `[{name}]` annotation fields by scope |
| `schema.ignoredTokens` | the word layer's ignored-token config (`{type: 'unicodePunctuation', whitelist?}` or `{type: 'blacklist', blacklist}`), or `null` |
| `schema.documentMetadata` | `[{name}]` enabled document metadata fields, or `[]` |
| `schema.autoAnalysis` | the project's stored auto-analysis config, `null` when unset (defaults are the app's business, not the archive's) |
| `layers` | substrate layer ids (`baselineText`, `sentence`, `word`, `morpheme`, `timeAlignment`, `spanLayers: [{id, name, scope}]`) — **informative only**, for debugging and correlation |
| `documents` | manifest: `[{id, name, file, mediaFile}]` (`mediaFile` null when no media was embedded) |
| `vocabularies` | manifest: `[{id, name, file}]` |

## vocabularies/*.json

```jsonc
{ "id": "…", "name": "Lexicon",
  "fields": [{ "name": "morphType", "inline": false }, { "name": "gloss", "inline": true }, …],
  "items":  [{ "id": "…", "form": "perro", "metadata": { "gloss": "dog", … } }, …] }
```

- `fields` is the normalized, ordered field inventory (`form` is never a field — it
  is the item's own headword).
- Item `metadata` is exported wholesale (custom fields, FLEx guids, examples, …).
- **Items are sorted by id ascending, and the order is contractual.** Item ids are
  UUIDv7, so id order is creation order — which is what homonym subscripts
  (form₁, form₂, …) are numbered by. A re-importer must recreate items **in array
  order** to preserve homonym numbering.

## documents/*.json

Top level: `id`, `name`, `version` (debugging only), `mediaFile` (archive path or
null), `metadata` (**the raw document metadata, wholesale** — including keys not in
`schema.documentMetadata`, e.g. `flexImported`), `baseline` (`{textId, body, metadata?}`),
`sentences`, `alignment`, and three completeness sections (below).

### Sentences, words, morphemes

```jsonc
{ "id": "…", "begin": 0, "end": 14, "metadata": { … },
  "fields": { "Translation": { "id": "<spanId>", "value": "…", "metadata": { "prov": "…" } } },
  "words": [{
    "id": "…", "begin": 0, "end": 6, "text": "perros",
    "orthographies": { "Translit": "…" },
    "metadata": { … },
    "fields": { "POS": { "id": "…", "value": "NOUN" } },
    "vocab": { "linkId": "…", "vocabId": "…", "itemId": "…", "metadata": { … } },
    "morphemes": [{
      "id": "…", "begin": 0, "end": 6, "precedence": 1, "text": "perros",
      "form": "perro", "morphType": "stem",
      "metadata": { … }, "fields": { … }, "vocab": { … } }] }] }
```

- `text` is the surface slice — informative; `baseline.body` + offsets are authoritative.
- **Morphemes are full-width**: they share their word's extent and are ordered by
  1-based `precedence`; the segment text lives in `form`.
- **`form` present-vs-absent matters**: the key is omitted when the morpheme has no
  stored form (display falls back to the surface text); `"form": ""` means a stored,
  deliberately empty form. `morphType` is likewise omitted when absent.
- **Field entries** are `{id, value, metadata?}`. The span id makes provenance
  round-trippable, and identifies multi-token spans: entries sharing one span id
  across several tokens denote a **single** span over the union of those tokens — a
  re-importer creates it once, with all token ids. Fields with no annotation are
  simply absent (no `null` placeholders).
- **Orthography lifting**: for each configured orthography `N`, the token-metadata
  key `orthog:<N>` is moved to `orthographies[N]`. An orthography with no stored
  key is absent (unset ≠ `""`). Unconfigured `orthog:*` keys stay in `metadata`.
  Re-import: token metadata = `metadata` ∪ the reconstituted `orthog:<N>` keys.
- **Vocab links**: a link is inlined as `vocab` iff it targets exactly that one
  token and is the first such link for the token. `metadata` is the full raw link
  metadata (see Provenance).

### alignment

```jsonc
[{ "id": "…", "begin": 0, "end": 14, "timeBegin": 1.25, "timeEnd": 3.5, "metadata": { … } }]
```

Time-alignment spans: character extent over the baseline plus times in seconds.
Alignment extents are independent of the sentence partition. Residual alignment
token metadata (anything besides `timeBegin`/`timeEnd`) rides in `metadata`.

### Completeness sections

Everything in the project that the sentence tree cannot express, so the archive is
lossless even for unusual data:

- `extraVocabLinks` — `[{id, vocabId, itemId, tokens, metadata?}]`: multi-token
  links, and any second link on an already-linked token.
- `extraSpans` — `[{id, layer: {name, scope}, tokens, value, metadata?}]`: duplicate
  spans (beyond the first per layer+token) and spans on layers with no/unknown
  scope.
- `orphanTokens` — `[{layer, id, begin, end, precedence?, metadata}]`: tokens
  outside every sentence extent, or morphemes matching no word extent. Metadata is
  raw here (no orthography/form lifting).

## Provenance

The cross-app provenance convention rides verbatim in span and link `metadata`:
`prov`, `provSource`, `provConfirmed` (plus `provProb`/`provDetail` where present).
Absent provenance keys mean human-entered. The exporter never rewrites these.

## Re-import contract (informative — importer not yet implemented)

Mirrors the FLEx importer's operation inventory (`src/import/flex/importEngine.js`):

1. Project setup from `schema` (orthographies, fields by scope, ignored tokens,
   document metadata; one vocabulary per `vocabularies/*.json`).
2. Per vocabulary: create items **in array order**, mapping old item ids to new.
3. Per document: `documents.create(name, metadata)` → `texts.create(body)` →
   `tokens.bulkCreate` for sentences, words (metadata ∪ reconstituted `orthog:*`),
   and morphemes (`form`/`morphType` folded back into metadata, `precedence` as
   given) → `spans.bulkCreate` (dedupe field entries by span id; create multi-token
   spans once) → `vocabLinks.create(itemId, tokens, metadata)` for inline and extra
   links → recreate `extraSpans`/`orphanTokens` → upload media from `mediaFile`.
4. All offsets are code points; never re-derive them from UTF-16 indices.

## Non-goals

Deliberately not in the archive: export presets and other app UI preferences,
cross-project vocabulary usage counts, server users/permissions, document history.
