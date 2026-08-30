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
(`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, ...) or `--api-key`. With no project
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

## How it works

- `project.py`: loads a project's IGT shape (layers by role, fields by scope,
  orthographies, lexicons) and documents, and renders documents as compact
  interlinear text. Everything is addressed positionally (`s3.w2.m1`); the
  model never sees ids.
- `tools.py`: the tools the model gets. Reads run immediately:
  `project_overview`, `read_document`, `search`, `read_lexicon`,
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
  losslessly and keep one lexicon link).
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
