# Plaid Token Debugger

A throwaway, single-file dev UI for poking at the Plaid server's **token-layer
constraints** (overlap modes: `any` / `non-overlapping` / `partitioning`) and
**token-layer hierarchy** (nesting). It lets you fire token ops and watch the
server accept or reject them, with a char-aligned ribbon visualization.

Pure vanilla HTML/CSS/JS — no build step, no npm, no CDN. Works offline.

## Run the server

From `plaid-core/`:

```
clojure -M:dev
```

It listens on `http://localhost:8085` (API base `http://localhost:8085/api/v1`).
CORS allows all origins.

## Open the UI

Either way works (server allows all origins):

- Open `dev/token-debugger/index.html` directly in a browser (`file://`), **or**
- Serve it: from `dev/token-debugger/`, run `python3 -m http.server` and visit
  `http://localhost:8000/index.html`.

## Default dev credentials

- user-id: `a@b.com`
- password: `password`

The JWT is persisted in `localStorage`, so a reload keeps your session.

## Quick start

1. Login (creds are prefilled).
2. Click **New IGT sandbox** — creates a project, text layer, document, and text,
   plus a 3-layer IGT hierarchy (Sentences = `partitioning` root > Words >
   Morphemes, both `non-overlapping`) like `docs/manual.adoc`. With the default
   body it also seeds a plausible tokenization (2 sentences, 13 words, 17
   morphemes, including contraction/derivation/participle morpheme splits). Edit
   the body first and you get the 3 layers empty instead.
3. Or create your own token layers (try `partitioning` for sentences, then a
   `non-overlapping` layer with the sentences layer as parent for words).
4. Use single/bulk create and the selected-token actions; every successful op
   re-fetches the document and redraws the ribbon. Errors show verbatim in the
   banner and the request log.

> Note: the per-layer overlap-mode/parent in the ribbon comes from `include-body`
> if the server has the projection fix, else from a one-time per-layer fetch — so
> it's correct either way, but reload the dev server to pick up the fix.

## Note

Server JSON uses **kebab-case** keys (e.g. `text-layer-id`, `overlap-mode`,
`parent-token-layer-id`, `other-token-id`), not snake_case.
