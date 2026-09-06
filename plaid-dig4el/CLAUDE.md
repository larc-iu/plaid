# plaid-dig4el — local conventions

Python server-rendered app (FastAPI, Jinja2, htmx, Bootstrap 5 vendored as one CSS file) that puts dig4el
on Plaid. Environment: `~/.mambaforge/envs/plaid-dig4el/bin/python` (mamba env
`plaid-dig4el`); the package is installed editable there along with `plaid-client-py`.
Dev server: `plaid-dig4el --plaid-url http://localhost:8085 --data-dir <dir> --port 8087
--llm-url <endpoint> --llm-key-file <file> --llm-model <m> --llm-embedding-model <e>`
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

## Sentence pairs and the language model

The sentence pool (`sentences.read_pool`) is every slot with both sides: the target
text and its source-language prompt field, from questionnaire and corpus documents
alike (dig4el's `cq_to_sentence_pairs`). A corpus is a Plaid document of the same
shape (`plaid_gateway.create_corpus_document`), registered in `corpus_documents`.
Augmentation (`augment.py`, job kind `augment`) is Sebastien's Grammatical Descriptor
verbatim as one schema-constrained completion per source sentence; the result and its
three embeddings live in `sentence_augmentations` (dig4el's side: derived, not
asserted), while word-meaning links for a corpus sentence are Concept spans in Plaid
with the key translation concept as value. Retrieval (`sentences.py`) offers dig4el's
three routes: keyword substring, embedding cosine, and the Sentence Selector, which is
the one dig4el's generation actually uses.

`llm.py` talks to any OpenAI-compatible endpoint (a litellm proxy, typically). NOTHING
about the endpoint is hardcoded: `--llm-url`, `--llm-key-file` (or `LLM_API_KEY`),
`--llm-model`, `--llm-embedding-model`, optional `--llm-model-strong` come from the launch
(env: `LLM_BASE_URL`, `LLM_KEY_FILE`, `LLM_MODEL`, `LLM_EMBEDDING_MODEL`,
`LLM_MODEL_STRONG`). Without them the app runs and the model-backed features say they
are off (`llm.configured()`). Reasoning models return thinking in a separate field that
is dropped. `chat_json` constrains output with `response_format: json_schema` and
validates with pydantic; the structured model must honour json_schema (measured on one
endpoint: gpt-oss-120b does, gemma-4-31B-it emits whitespace under guided decoding).

## Grammar descriptions and reference documents

`generation.py` is dig4el's generate_grammar page as the `generate` job: the five agents'
schemas and instructions verbatim (parameter selector, alterlingua informant, lesson
creator, lesson reviewer, sketcher), the page's data strings, the seeded query from
`data/grammar_seeds.json`, and the aggregation order. Inputs: the approved run's retained
parameters (`grammar_priors`), the pseudo-gloss of every questionnaire sentence
(`build_alterlingua`, dig4el's `build_alterlingua_kg` at ancestor level 0), the Sentence
Selector's pick of augmented pairs with their word connections from Plaid, and the
documents contribution. Outputs live in `grammar_outputs` with a trace; feedback in
`output_feedback`; DOCX from `docx_export.py` (dig4el's localized headings verbatim).
Rendering: the models mark target words with `**...**`; the `emph` filter renders that.

`documents.py` replaces the OpenAI vector store: the file is kept under
`data/documents/<language>/`, its text extracted (pypdf, python-docx, plain), chunked and
embedded by the `index_documents` job into `document_chunks`; `contribute` answers
dig4el's file-search prompt over the nearest chunks and reports the file names as sources.

## Catalog editors, explorers, field-work documents

The catalog is editable (dig4el's expert features): `catalog_store.py` seeds
`catalog_entries` from the bundled files and installs a database source into
`reference/catalog.py`; every edit calls `catalog.invalidate()`. Editing is admin-only.
`legacy/graphs_utils.py` is dig4el's requirement-graph code verbatim; `value_options` in
web/app.py reproduces the CQ editor's walk of the concept tree. Renaming a prompt does
not touch existing translations, and the inference observers match some prompts by
their exact text.

`explore.py` serves the WALS/Grambank/probability pages from the reference tables and
the per-language statistics with `legacy/stats.py` and `legacy/kg_explore.py` (verbatim).
`/compare` is dig4el's compare page (one pivot sentence across languages, with glosses).
`transcription_io.py` is dig4el's Excel/Word field-work template, the workbook parser
(its template leaves row 2 empty; data starts at row 3) and the glossed-corpus Word
export; a filled workbook fills slots through `plaid_gateway.fill_from_recording`.

## Guest access

One shared read-only Plaid account (`auth.guest_user`, token in `data/guest_account.json`,
minted from `/admin/guests`). `viewer(request)` resolves the session user or the guest;
read routes take it, write routes keep `current_user`. A caretaker's "Open to guests"
adds the account as a reader of the project (`POST /languages/{id}/guests`), which is
the only access control; `Access` marks `as_guest` (also for a logged-in non-member
reading an opened language) and then `can_edit`/`can_manage` are false. Guests never
start jobs, edit, give feedback, or use model-selection search.

## Plaid-side changes degrade, they never crash

Anything igt or another app does to the shared project is legitimate. The gateway
reports it: `DocumentUnavailable` when a document or its text/sentence/word layer is
gone (the language page shows why and a caretaker can remove the reference),
`doc.problems` and `doc.can_link` for a lost Concept layer or field, `doc.missing_segments`
for deleted sentence tokens (the editor offers Restore, an audited insert), `extra_slots`
for foreign sentence tokens. A deleted LAYER is detected by `check_layers` on the
language page and repaired by `repair_layers` (caretaker's Repair button): the layer
comes back with the new-language schema, ids are updated in the project config and the
language row, slots are rebuilt from the text's lines, words retokenized, prompts
restored from the catalog; what sat on the deleted layer is lost and the report says so.
Never repair silently and never recreate data that was not there. A run records the document versions it read; the language
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
