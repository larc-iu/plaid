# Plaid IGT JSON — the native export format

**Format id:** `plaid-igt` · **Current version:** 1 · **Produced by:** the Export wizard's
"Plaid IGT JSON (lossless .zip archive)" format · **Serializer:** `src/export/nativeJson.js`

Plaid IGT JSON is a lossless archive of an IGT project, expressed in IGT terms —
sentences > words > morphemes, annotation fields by scope, orthographies, lexicon
items and links, time alignment, and provenance — rather than as a dump of the
underlying substrate (layers/tokens/spans). It is designed for archival and for
re-import (Projects → New Project → "Import a Plaid IGT archive").

**What "lossless" covers.** The archive captures the IGT substrate: the baseline
text layer, the role-tagged sentence/word/morpheme/time-alignment token layers,
every span layer attached to them (scoped or not), the linked vocabularies, and
the project's IGT configuration. It deliberately does NOT capture layers owned by
other Plaid apps sharing the substrate (e.g. UD's syntactic-word layer or
relation layers), additional text layers, non-IGT project configuration, users
or permissions, or document history. Comments ride along as a faithful record
(author, body, both timestamps), but re-import cannot restore their authorship —
see Comments.

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
Media file extensions come from the served content type (the server's `mediaUrl`
is a bare endpoint path with no filename); extensions matter on re-import, where
the upload's media type is validated from its filename.

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
| `schema.fields` | `{sentence, word, morpheme}` → `[{name, tagset?}]` annotation fields by scope. `tagset` names the tagset governing the field, and is absent when none does |
| `schema.ignoredTokens` | the word layer's ignored-token config (`{type: 'unicodePunctuation', whitelist?}` or `{type: 'blacklist', blacklist}`), or `null` |
| `schema.documentMetadata` | `[{name, tagset?}]` enabled document metadata fields, or `[]` |
| `schema.autoAnalysis` | the project's stored auto-analysis config, `null` when unset |
| `schema.tagsets` | the project's tagsets, `{name: {delimiters, mode, values}}`, `null` when unset |
| `schema.languages` | the project's `{object, meta}` language identity, `null` when unset |
| `schema.speakers` | the project's known speaker labels, `null` when unset |
| `schema.serviceDefaults` | the project's stored service defaults, `null` when unset |
| `schema.compose` | the project's own backslash compose codes, `{codes: [{code, char, description?}]}`, `null` when unset. These layer over the built-in codes, so only the project's own are carried |
| `schema.exportPresets` | the project's saved export presets (stored under config key `export`), `null` when unset |
| `layers` | substrate layer ids (`baselineText`, `sentence`, `word`, `morpheme`, `timeAlignment`, `spanLayers: [{id, name, scope}]`) — **informative only**, for debugging and correlation |
| `documents` | manifest: `[{id, name, file, mediaFile}]` (`mediaFile` null when no media was embedded) |
| `vocabularies` | manifest: `[{id, name, file}]` |

## vocabularies/*.json

```jsonc
{ "id": "…", "name": "Lexicon",
  "fields": [{ "name": "morphType", "inline": false }, { "name": "gloss", "inline": true },
             { "name": "pos", "inline": true, "tagset": "POS" }, …],
  "tagsets": { "POS": { "delimiters": "", "mode": "closed", "values": [{ "value": "n" }, …] } },
  "items":  [{ "id": "…", "form": "perro", "metadata": { "gloss": "dog", … } }, …],
  "comments": [{ "id": "…", "anchor": { "type": "vocab-item", "id": "…" }, … }] }
```

- `fields` is the normalized, ordered field inventory (`form` is never a field — it
  is the item's own headword). A field's `tagset` names one of the vocabulary's own
  tagsets and is absent when none governs it; `lang` (a FLEx custom field's writing
  system) is likewise present only when set.
- `tagsets` is the vocabulary's own tagset map, the same shape as the project's
  `schema.tagsets`, `null` when it has none. A vocabulary carries its own because it
  is shared across projects.
- Item `metadata` is exported wholesale (custom fields, FLEx guids, examples, …).
- **Items keep the order the server returned them in, and that order is
  contractual.** It is creation order, which is what homonym subscripts
  (form₁, form₂, …) are numbered by, so a re-importer must recreate items **in
  array order** to preserve them.
- **Never re-sort items by id.** An earlier version of this spec claimed UUIDv7
  ids encode creation order. They do so only across MILLISECONDS, and a bulk
  write puts thousands of items inside a single millisecond where the remainder
  of the id is random. Sorting by id was measured shuffling a 4,591-item lexicon
  down to 9 items still in place, so every export/import cycle permuted the
  whole vocabulary (fixed 2026-08-31).
- `comments` — the comments on the vocabulary's entries, the same node shape as a
  document's (see Comments) with `anchor.type` always `vocab-item`; **omitted
  entirely when there are none**.

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
  re-importer creates it once, with all token ids. When an `extraSpans` record
  carries the same id as field entries, the `extraSpans` record is
  **authoritative** (it holds the span's complete token list — e.g. a span that
  also reaches a token outside the tree); the field entries are then display
  duplicates and must not produce a second span. Fields with no annotation are
  simply absent (no `null` placeholders).
- **Orthography lifting**: for each configured orthography `N`, the token-metadata
  key `orthog:<N>` is moved to `orthographies[N]`. An orthography with no stored
  key is absent (unset ≠ `""`). Unconfigured `orthog:*` keys stay in `metadata`.
  Re-import: token metadata = `metadata` ∪ the reconstituted `orthog:<N>` keys.
- **Vocab links**: a link is inlined as `vocab` iff it targets exactly that one
  token, carries an item, and is the LAST such link for the token — matching
  what the editor displays when data holds several links on one token. All other
  links (multi-token, item-less, displaced earlier links, and links whose token
  is not in the tree) are in `extraVocabLinks`. `metadata` is the full raw link
  metadata (see Provenance).

### alignment

```jsonc
[{ "id": "…", "begin": 0, "end": 14, "timeBegin": 1.25, "timeEnd": 3.5, "metadata": { … } }]
```

Time-alignment spans: character extent over the baseline plus times in seconds.
Alignment extents are independent of the sentence partition. Residual alignment
token metadata (anything besides `timeBegin`/`timeEnd`) rides in `metadata`.
`timeBegin`/`timeEnd` are `null` when the stored token lacks them.

### Completeness sections

Everything in the project that the sentence tree cannot express, so the archive is
lossless even for unusual data:

- `extraVocabLinks` — `[{id, vocabId, itemId, tokens, metadata?}]`: every link
  not inlined in the tree — multi-token links, displaced or item-less links,
  and links on tokens outside the tree (orphan, sentence, alignment).
- `extraSpans` — `[{id, layer: {id, name, scope}, tokens, value, metadata?}]`:
  duplicate spans (beyond the first per layer+token), spans on layers with
  no/unknown scope (including span layers on the time-alignment layer), and the
  authoritative full records of tree spans whose membership reaches a non-tree
  token. `layer.id` is the source layer id (correlation); re-importers resolve
  the layer by scope+name.
- `orphanTokens` — `[{layer, id, begin, end, precedence?, metadata}]`: tokens
  outside every sentence extent, or morphemes matching no word extent. Metadata is
  raw here (no orthography/form lifting).
- `comments` — `[{id, anchor: {type, id}, anchorLabel, author: {id, name}, body,
  createdAt, updatedAt}]`, **omitted entirely when the document has none**. See
  Comments below.

## Comments

Comments (discussion anchored to an entity, not annotation of it) are the one
part of the archive that records a PERSON rather than a piece of language, and
they behave unlike everything else here.

- `anchor.type` is one of `document`, `text`, `token`, `span` in a document file
  and `vocab-item` in a vocabulary file — the anchor types this archive can
  represent. `anchor.id` always names a node in the same file.
- **A comment whose anchor is not in the file is dropped at export**, counted in
  one warning per file. A comment outlives its anchor on the server, so a
  project holds comments on deleted words, annotations and entries; a project
  also holds entities this archive does not carry (a **relation** belongs to
  whichever app owns its layer, UD's dependency arcs say). A re-importer would
  have nothing to hang either on, and the server refuses a comment on a missing
  anchor, so the archive does not pretend to carry them. The importer still
  skips, with a warning, any comment whose anchor it cannot resolve (an archive
  edited by hand).
- `author.id` is the user's id, which **is their email address**. `author.name`
  is their display name at export time, or `null` — a label, since display names
  change and the id is the identity. An archive therefore contains personal data
  even when the linguistic content is public.
- `createdAt` / `updatedAt` are the server's own timestamps. A comment is
  "edited" iff they differ.
- `anchorLabel` is the caption the comment was posted with (what it is about,
  in words: "Gloss of ktab, sentence 4"), or `null`. It is what the comment
  shows once its anchor is gone, so it is carried and re-posted verbatim.
- **A historical (`asOf`) export omits comments entirely.** They are unaudited
  (`plaid.sql.comment`), so there is no state at `asOf` to read; today's comments
  in a time-travelled archive would carry today's dates and could anchor to
  entities that did not yet exist.

### Attribution does not survive re-import

`plaid.sql.comment/create!` stamps `author_id` from the authenticated caller and
both timestamps from the clock, with no override, so that nobody — maintainers
and admins included — can put words in another user's mouth. An importer is
therefore unable to restore either.

Every imported comment is consequently authored by whoever ran the import and
dated then. The original attribution survives only as a Markdown blockquote the
importer prepends to the body:

```
> Imported from an archive. Originally posted by Ada Lovelace <ada@example.com> on 2026-08-14.

<the original body, untouched>
```

The importer strips a note it wrote previously before adding its own, so
repeated export/import cycles do not stack them; the surviving note describes
what THIS archive recorded. A comment close enough to the server's
10,000-character ceiling that the note would breach it is imported unchanged
rather than truncated, and the import reports how many.

## Provenance

The cross-app provenance convention rides verbatim in span and link `metadata`:
`prov`, `provSource`, `provConfirmed` (plus `provProb`/`provDetail` where present).
Absent provenance keys mean human-entered. The exporter never rewrites these.

## Re-import contract

Implemented by `src/import/native/importEngine.js` (UI: Projects → New Project →
"Import a Plaid IGT archive"); mirrors the FLEx importer's operation inventory:

1. Project setup from `schema` (orthographies, fields by scope, ignored tokens,
   document metadata; one vocabulary per `vocabularies/*.json`), then the stored
   project config the wizard does not cover, written verbatim: `autoAnalysis`,
   `tagsets`, `languages`, `speakers`, `serviceDefaults`, `compose`, `export`, and
   `documentMetadata` again (the wizard creates it as bare `{name}` rows, so the
   archive's version is written over it to restore each field's `tagset`).
   Each governed field's `tagset` is then set on its own span layer.
2. Per vocabulary: write `fields` (with each `tagset`/`lang`) and `tagsets`, then create
   items **in array order**, mapping old item ids to new.
   The importer stamps each created item's metadata with `nativeImportId` (the
   archive item id) for resume dedupe and provenance. Then `comments.create`
   per archived entry comment, against the mapped item id (see Comments). Items
   are reused on resume rather than redone, so a comment already on the
   vocabulary with the same anchor and body is not posted again.
3. Per document: `documents.create(name, metadata)` → `texts.create(body)` →
   `tokens.bulkCreate` for sentences, words (metadata ∪ reconstituted `orthog:*`),
   morphemes (`form`/`morphType` folded back into metadata, `precedence` as
   given), orphan tokens, and alignment tokens (times folded back) →
   `spans.bulkCreate` (dedupe field entries by span id; `extraSpans` records are
   authoritative when their id collides with field entries) →
   `vocabLinks.create(itemId, tokens, metadata)` for inline and extra links →
   `comments.create` per archived comment (anchors resolved through the same
   old→new maps; see Comments) → upload media from `mediaFile`. A document is
   marked done
   (`metadata.nativeImported`) only after every write succeeded; resume skips
   done documents and deletes + redoes half-imported ones.
4. All offsets are code points; never re-derive them from UTF-16 indices.

## Non-goals

Deliberately not in the archive: export presets and other app UI preferences,
cross-project vocabulary usage counts, server users/permissions, document history.
