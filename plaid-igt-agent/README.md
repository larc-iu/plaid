# plaid-igt-agent

A chat assistant for [Plaid IGT](../plaid-igt) projects, run as a Plaid
service by whoever operates the Plaid instance, with whatever model they
choose (anything [litellm](https://docs.litellm.ai/) can talk to: OpenAI,
Anthropic, Gemini, Ollama, vLLM, any OpenAI-compatible server).

Users reach it from the **Assistant** tab on a project page. They can ask
analytic questions about the corpus and lexicon, or ask for edits. The
assistant never writes on its own: an edit request comes back as a plan the
user approves or discards, and an approved plan is applied under the user's
own account, in one audit-log entry, stamped machine-made so it shows as
unverified in the editor until confirmed.

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
id the service registers on every project its token can access.

The service account needs **writer** access to register on a project, but it
does not write with its own credentials: it declares *delegation*, so Plaid
mints a short-lived token for each requesting user and every read and write
runs as that user. Readers get a read-only assistant; writers can apply plans.

## How it works

- `project.py`: loads a project's IGT shape (layers by role, fields by scope,
  orthographies, lexicons) and documents, and renders documents as compact
  interlinear text. Everything is addressed positionally (`s3.w2.m1`); the
  model never sees ids.
- `tools.py`: the tools the model gets. Reads (`project_overview`,
  `read_document`, `search`, `field_values`, `read_lexicon`) run immediately;
  writes (`set_field`, `set_analysis`, `set_orthography`, `respell`,
  `link_entry`, `unlink_entry`, `create_entry`, `set_entry_field`) append
  resolved operations to the turn's plan.
- `plan.py`: applies an approved plan with the requester's client, in atomic
  batches under one operation.
- `agent.py`: the litellm loop. `service.py`: the Plaid service; one request
  is one turn (the browser keeps the transcript) or one approval.

## Tests

```sh
pytest
```
