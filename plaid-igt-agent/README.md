# plaid-igt-agent

A chat assistant for [Plaid IGT](../plaid-igt) projects, run as a Plaid
service by whoever operates the Plaid instance, with whatever model they
choose (anything [litellm](https://docs.litellm.ai/) can talk to: OpenAI,
Anthropic, Gemini, Ollama, vLLM, any OpenAI-compatible server).

Users reach it from the **Assistant** tab on a project page. They can ask
analytic questions about the corpus and lexicon, or ask for edits. The
assistant never writes on its own: an edit request comes back as a plan the
user approves or discards, and an approved plan is applied under the user's
own account, in one audit-log entry. Approval is the human check, so what a
plan writes is recorded as **verified** (made by the assistant, confirmed by
the approver); the approver can instead have it recorded as human-made.

Replies cite evidence with a tag, `<cite doc="Text 1" ref="s3"/>` (`ref` may
also be a word, `s3.w2`, or a morpheme, `s3.w2.m1`); the service resolves each
citation to the sentence's interlinear data (`citations.py`) and the Assistant
tab shows it as an example card linking to that sentence in the editor.

## Running

Python 3.11+.

```sh
pip install larc-plaid-igt-agent        # from PyPI (published with each Plaid release)
# or, from a checkout:  pip install -e ../plaid-client-py -e .
# a named API token for the service account goes in ./.token (or you are prompted)
plaid-igt-agent --url http://localhost:8080 --model openai/gpt-4o
plaid-igt-agent --url http://localhost:8080 --model ollama/llama3.1
plaid-igt-agent --url http://localhost:8080 --model openai/my-model --api-base http://gpu-box:8000/v1
```

Provider keys come from the provider's usual environment variable
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...) or `--api-key`. At startup the
service asks the model one question and stops if it gets no answer, so a typo
in `--model`, a missing key or an `--api-base` pointing at nothing is a
message to the operator rather than a chat that fails on every question. (A
provider that is merely down at that moment stops startup too, unlike a Plaid
server that is down, which is waited out.) With no project
id the service registers on every project its token can access (new ones are
picked up as they appear); pass one or more project ids to serve just those.

Each instance registers as `igt:assist:<model>` (override with `--service-id`
and `--service-name`), so several assistants with different models can be
online on the same project; the Assistant tab shows a picker. Two instances
with the same id on one project collide (409) and the newcomer retries until
the other stops.

The service account needs **writer** access to register on a project, but it
does not write with its own credentials: it declares *delegation*, so Plaid
mints a short-lived token for each requesting user and every read and write
runs as that user. Readers get a read-only assistant; writers can apply plans.

### Web lookup (off by default)

`--web-search` lets the assistant look things up outside the project: what a
gloss abbreviation conventionally means, how a construction is described in
the literature, a reference for a claim. The service runs one real search at
startup, so a bad key or an unreachable instance stops it there rather than
failing every question later.

| provider | needs | notes |
|---|---|---|
| `brave` | `--web-search-key` or `BRAVE_SEARCH_API_KEY` | independent index, not a reseller |
| `tavily` | `--web-search-key` or `TAVILY_API_KEY` | built for agents, clean prose snippets |
| `searxng` | `--web-search-url` | an instance you run, no key, no quota |

```sh
plaid-igt-agent --url http://localhost:8080 --model openai/gpt-4o --web-search brave
plaid-igt-agent --url http://localhost:8080 --model ollama/llama3.1 \
                --web-search searxng --web-search-url http://localhost:8888
```

SearXNG is the option with no third party in it: nothing to sign up for, no
quota, and no commercial account holding your query log, which matters for a
corpus under a community protocol. It serves JSON only when `json` is in
`search.formats` in its `settings.yml`, and the tool says so if it is not.
Its own URL is exempt from the fetch guard below, since the operator named
it, but `read_url` still refuses to open that host: the search endpoint being
on your network does not make the network readable.

Adding a provider is one entry in `BACKENDS` in `web.py`: a function taking
`(query, limit, cfg, client)` and returning `Result(title, url, snippet)`,
plus whether it wants a key (and from which environment variable) or a URL.
Nothing in the service knows the difference.

Without the flag the two tools are not offered to the model and the prompt
does not mention them, so an assistant that cannot look anything up is never
told that it can. **Leave it off for a corpus under a community protocol or
an embargoed deposit**: a search query carries whatever the assistant puts in
it, which can include forms, glosses and document metadata.

This is the one place where text by strangers enters a turn, so it is fenced:

- `read_url` opens only a link that `web_search` returned in this
  conversation or that the user pasted into the chat.
- A fetch is refused if the URL, or anything it redirects to, resolves onto
  the network the service runs on (loopback, private ranges, link-local, and
  the Plaid server itself). The service usually runs beside Plaid, so an
  unrestricted fetch would be a request-forgery primitive.
- HTML and plain text only. Most linguistics references are PDFs, and the
  tool says so rather than letting the model guess at a title.
- What comes back is labelled untrusted and fenced, and the prompt tells the
  model it is a claim to weigh, never an instruction, and never evidence
  about the language's own data.
- **A turn that reads the web cannot also plan changes.** The assistant
  reports what it found and the user asks for the change in the next message.
  So nothing a page says can become a proposed edit in the same breath as
  being read. It is not a complete answer to prompt injection (the page is
  still in the transcript on the next turn), but the user always sees what
  was found before anything is proposed, and no plan is applied unapproved.

## How it works

`SAMPLE_PROMPT.md` shows the system prompt and the tool list as the model
receives them, rendered over the test fixture project; regenerate it with
`python tests/sample_prompt.py` when it has gone stale.

- `web.py`: the optional web tools, the URL guard, and HTML to text.
- `project.py`: loads a project's IGT shape (layers by role, fields by scope,
  orthographies, lexicons) and documents, and renders documents as compact
  interlinear text. Everything is addressed positionally (`s3.w2.m1`); the
  model never sees ids.
- `tools.py`: the tools the model gets. Reads run immediately:
  `project_overview`, `list_documents`, `read_document`, `search`, `read_lexicon`,
  `lexicon_entry`, `concordance` (aligned context and pattern tally for a
  form or value), `analyses_of` (how a form has been analyzed so far),
  `check_consistency` (spelling variants, forms with several values, link
  gaps), `check_lexicon`, `check_integrity`, `corpus_stats`,
  `frequency_list`, `worklist` (unlinked / unglossed / unanalyzed /
  unverified, by frequency), `sequence_search`, `recent_changes` (the audit
  log), `plan_status`, and the escape hatch `query` + `query_help` (Plaid's
  query language, project-scoped, layers by name). Writes append resolved operations to the turn's plan:
  `set_field`, `set_analysis`, `set_orthography`, `respell`, `link_entry`,
  `unlink_entry`, `create_entry`, `set_entry_field`, `set_document_metadata`,
  `create_document`, and the corpus-wide `replace_in_field` (also on stored
  morpheme forms), `set_field_for_form`, `respell_all` (carrying morpheme forms
  and lexicon headwords along, as Bulk Edit does), `copy_to_orthography`,
  `set_analysis_for_form`, plus `merge_entries`, `delete_entry`, `rename_entry`,
  `rename_document`; `confirm` and `discard_analysis` for what other services
  produced; and the segmentation edits `split_word`, `merge_words`,
  `delete_word`, `split_sentence`, `merge_sentences` (`shape.py`), which mirror
  the editor's own mutations including their side effects (a word split or
  merge deletes the affected morpheme analyses; merges combine field values
  losslessly and keep one lexicon link); and the text edits `append_text`
  and `retype_sentence`, which go through the server's diffing text update
  (unchanged words keep their tokens and analyses) and then tokenize the
  edited region as the editor would.
- `corpus.py`: the query-engine side of every corpus-wide tool. Project-wide
  reads and target finding run as server-side queries (counts, grouped
  tallies, entity ids); documents are fetched only to render the hits a tool
  shows, so cost follows what is displayed, not the size of the corpus. With
  `document=` a tool scans that one document instead, and the scan
  implementations double as the reference the query path is tested against
  (`tests/test_live_corpus.py`, which seeds the fixture project into a running
  core and compares both paths; it skips without a server at
  `PLAID_TEST_URL`, default `http://localhost:8085`, dev account `a@b.com`).
  Two conventions the engine does not know are applied in Python on grouped
  results: ignored (punctuation) tokens are left out of word counts, and
  forms are compared case-insensitively. `check_integrity` still reads whole
  documents (it inspects raw text). Parsed documents are cached in the
  service process across turns and users, keyed by `(id, version)` (every
  write inside a document bumps its version), so rendering hits costs a
  fetch only the first time a document is touched.
- `plan.py`: validates and normalizes an approved plan (a later op on the same
  target wins; links to entries the plan deletes are dropped; overlapping
  respells are refused; ops on tokens a split, merge, or delete removes are
  refused), then applies it with the requester's client in atomic batches
  under one operation (`stamp_mode` verified or human), reporting how much
  was applied if a later batch fails. A plan carries the version of every
  document it touches; approval is refused if any of them changed since, as
  the plan's ids and character offsets were read from that state.
- `agent.py`: the litellm loop. `service.py`: the Plaid service; one request
  is one turn (the browser keeps the transcript) or one approval.

## Tests

```sh
pytest
```
