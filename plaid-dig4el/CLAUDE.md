# plaid-dig4el — local conventions

Python server-rendered app (FastAPI, Jinja2, htmx, Bootstrap 5 vendored as one CSS file) that puts dig4el
on Plaid. Environment: `~/.mambaforge/envs/plaid-dig4el/bin/python` (mamba env
`plaid-dig4el`); the package is installed editable there along with `plaid-client-py`.
Dev server: `plaid-dig4el --plaid-url http://localhost:8085 --data-dir <dir> --port 8087`
(core on :8085, igt :5174, ud :5173). Login is the Plaid login.

## Boundaries

- Plaid holds what a person asserted about the language: translations (baseline text,
  `sentence` partitioning slots, `word` tokens), concept links (`Concept` span layer on
  words, value = concept id), and the sentence fields (`Prompt`, `Alternate pivot`,
  `Back-translation`, `Note`, declared as igt Sentence-scope fields). All writes go
  through `plaid_gateway.py` with the user's own token, inside `client.operation(...)`.
- dig4el's SQLite (`db.py`) holds the language registry, questionnaire document refs,
  inference runs with overrides and approvals. Nothing linguistic.
- Reference data: catalog files under `src/plaid_dig4el/data/` are committed; the derived
  WALS/Grambank tables (~100 MB) live in `reference_data/` (gitignored), fetched by
  `scripts/fetch_reference_data.py`.

## Background jobs

Long work (an inference run, later every LLM stage) is a row in `jobs` executed by the
single worker thread in `jobs.py`. A handler is `@jobs.handler("kind")` taking
`(job, client)`, where the client carries the token of the person who started the job
(stored on the row until the job finishes). Create the job and the rows it refers to in
one session, commit, then `jobs.submit(id)`. A restart requeues interrupted jobs
(`attempts`, given up after `MAX_ATTEMPTS`). Do not start threads for work; add a kind.

## Plaid-side changes degrade, they never crash

Anything igt or another app does to the shared project is legitimate. The gateway
reports it: `DocumentUnavailable` when a document or its text/sentence/word layer is
gone (the language page shows why and a caretaker can remove the reference),
`doc.problems` and `doc.can_link` for a lost Concept layer or field, `doc.missing_segments`
for deleted sentence tokens (the editor offers Restore, an audited insert), `extra_slots`
for foreign sentence tokens. A run records the document versions it read; the language
page marks a run stale when a published document's version moved (Plaid bumps it on any
edit inside the document).

## Schema changes

`db.MIGRATIONS` is a numbered list of SQL statement lists applied by `engine()` via
`PRAGMA user_version`; a fresh database comes straight from `create_all`. Append a list
for every model change; never edit an applied one.

## The slot document

A questionnaire document is created with one `\n` per segment and one partitioning
sentence token per newline. Filling a segment is ONE `replace` edit over the slot's
whole range (content + `\n`), which Plaid keeps as the same token. Re-filling deletes
that slot's words and concept links (a translation edit is a re-elicitation).

## Fidelity

`legacy/` is Sebastien's code with imports rewired; keep behavior, fix only paths and
imports. `inference/pipeline.py` mirrors `pages/infer_from_knowledge_and_cqs.py`; the
two departures (de-duplicated agent parameters, seedable traversal) are documented at
the top. `tests/test_parity.py` compares against baselines produced by the untouched
dig4el code (`tests/fixtures/baseline_*_seed0.json`); regenerate them from the dig4el
clone if the fixtures or pipeline constants change.

The knowledge graph handed to observers uses words joined by spaces and
`plaid_gateway.KG_DELIMITERS`, so dig4el's `custom_split` reproduces Plaid's tokens
exactly; `tokenize_with_offsets` must keep agreeing with `custom_split` (unit test).

## Copy

On-screen text is for a fluent speaker who is not a linguist: plain words, one or two
short sentences, no internals. Concept labels come from `terminology_conversion.json`
via `legacy_labels.label`.
