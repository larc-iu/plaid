# plaid-ud — local conventions

React/Vite app for Universal Dependencies annotation, backed by `plaid-core` (REST). Uses `plaid-client` symlinked from `../plaid-client-js`. Dev server proxies `/api` → `:8085`.

## Layer model (the thing to internalize)

A UD project has one text layer and **three token layers**, set at project creation and immutable thereafter:

| Layer       | overlap-mode      | parent     | config flag (in `ud` namespace) | role                                     |
|-------------|-------------------|------------|---------------------------------|------------------------------------------|
| Sentences   | `partitioning`    | (root)     | `sentenceTokenLayer`            | tile `[0, len)` of the document          |
| Words       | `non-overlapping` | Sentences  | `wordTokenLayer`                | UD *surface tokens* (orthographic words) |
| Morphemes   | `any`             | Words      | `morphemeTokenLayer`            | UD *syntactic words* — annotations live here |

All annotation span layers (`Form`, `Lemma`, `UPOS`, `XPOS`, `Features`) hang off the **morpheme** token layer; the dependency relation layer hangs off `Lemma`.

**Full-width morpheme rule:** a morpheme token always spans the *full extent* of its parent word — never a sub-range. A 1:1 word has one morpheme equal to the word. An MWT (`del` → `de`+`el`) has multiple morphemes that all share `[word.begin, word.end]`, ordered by `precedence` and distinguished by their **Form** span. Tokens have no form attribute; `Form` span carries it when the surface form differs from the substring.

Parentage is by character containment (no per-token parent ref). `getUdLayerInfo` exposes `tokenLayer` as an alias of `morphemeTokenLayer` so span/relation readers compose naturally.

## File map

- `src/utils/udLayerUtils.js` — config flags + `getUdLayerInfo`.
- `src/utils/conlluParser.js` — `parseCoNLLU` + `buildConlluHierarchy`.
- `src/components/projects/{ProjectForm,ProjectConfiguration}.jsx` — both bootstrap paths build the 3-layer tree atomically.
- `src/components/editor/TextEditor.jsx` — all token-side handlers; renders error + misconfigured-layers banners.
- `src/components/editor/TokenVisualizer.jsx` — raw-text overlay editor.
- `src/components/editor/hooks/useSentenceData.js` — read model (derive sentences→words→morphemes by containment).
- `src/components/editor/hooks/useAnnotationHandlers.js` — span/relation handlers (lemma/upos/xpos/features/form + relations).
- `src/components/documents/ImportModal.jsx`, `src/components/editor/ExportEditor.jsx` — CoNLL-U import/export.
- `parser_service.py` — Stanza-based NLP service.

## Patterns to follow

- **Atomic-batch hierarchy creation.** Multi-op token creation goes in `client.beginBatch()` … `await client.submitBatch()`. Batch ops run sequentially server-side, so nested ops see their parents. `submitBatch` returns `[{status,headers,body}, …]` in order — `results[i].body.ids` is reliable. Only constraint: an op cannot reference an ID produced earlier in the same batch (split spans/relations into a follow-up call).
- **Optimistic local-state, post-server.** Handlers `await` the server op and then mutate `document` state in place (no `refreshData()` on success); `await fetchData()` only in the catch. Match this in new handlers — refetching on every op gates UX on a full document round-trip and breaks keyboard responsiveness. `handleSetWordMorphemes` is the lone exception (deliberate, complex post-cascade local replay).
- **Form-else-substring** for morpheme display. Always prefer the Form span value; fall back to text substring. Don't substring-as-form anywhere new — for overlapping MWT morphemes the substring is wrong.
- **Top-down creation.** Sentences → Words → Morphemes. A child without its parent is a 400.
- **CoNLL-U round-trip metadata** lives on tokens: arbitrary sentence-level `# k = v` lines on the sentence token's `.metadata`; MWT MISC on the word token's `.metadata.misc`; MWT surface form (FORM column of the `N-M` row) on the word token's `.metadata.form` (only set when the word is a multiword token — for 1:1 words the body substring is correct and metadata stays clean). Don't add a new "metadata sidecar" layer.

## Gotchas

- **Vite dep pre-bundle cache.** Symlinked local deps (`../plaid-client-js`) don't invalidate `node_modules/.vite/deps` when they change. Symptom: stale `plaid-client` missing newer methods (e.g. `client.tokens.split is not a function`). Fix: `rm -rf node_modules/.vite && npm run dev` (or `npm run dev -- --force`).
- **Popovers bubble.** Tooltip / Edit Range modal / morpheme editor in `TokenVisualizer` are DOM children of the word `<span>` whose `onClick` toggles sentence boundary. All popovers carry `onClick={e => e.stopPropagation()}` to prevent double-fires. Maintain this on new popovers.
- **Stale-bundle legacy projects.** Projects created with an older `plaid-client` bundle have `overlapMode=any` / `parentTokenLayer=null` on all three layers (the older `tokenLayers.create` signature dropped those args). Immutable, so unrecoverable; `TextEditor` detects this (`layersMisconfigured`) and shows an amber banner. New projects from the current bundle have the right shape.
- **Errors must be rendered.** Set state alone is invisible — `TextEditor` has an explicit red banner above the editor grid.
- **`documents.get` in Python is keyword-only** for `include_body`: `client.documents.get(id, include_body=True)`, not positional.

## Dev workflow

- Server: dev REPL on `:8085`, admin `a@b.com` / `password`. nREPL port in `../plaid-core/.nrepl-port`.
- Build: `npx vite build`. Dev server: `npm run dev`.
- Python client: importable from `../plaid-client-py/src` (used by `parser_service.py` and ad-hoc verification scripts).

## State as of last session (uncommitted on `master`)

Migration complete and verified live; CoNLL-U round-trip restored; editor parity with the original on selection-create / hover tooltip / Edit Range / keyboard nudge / dirty-text preview; optimistic local-state restored for word update/delete/create and sentence toggle. Parked items in [[plaid-ud-token-hierarchy]] memory (`Pending design questions`).
