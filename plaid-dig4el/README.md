# plaid-dig4el

[dig4el](https://github.com/alterfero/dig4el) (Digital Inferential Grammars for
Endangered Languages, Sebastien Christian) rebuilt on Plaid. Language documenters
translate conversational questionnaires and link words to the meanings they express;
dig4el infers grammatical parameters from those translations together with what
WALS and Grambank already document, and a caretaker reviews and approves the result.

The linguistic record lives in Plaid: each language is a project, each questionnaire
translation a document with the shared `sentence` and `word` substrate, word–concept
connections as spans over words, and the prompt, alternate pivot, back-translation
and note as sentence fields. igt can open the same documents to gloss them. dig4el's
own database holds the language registry, inference runs, overrides and approvals.

This is a prototype covering the first slice of the workflow: create a language,
translate questionnaires (or import existing dig4el translations), run the inference,
review and approve. Sentence-pair corpora, reference documents and lesson generation
are not here yet.

## Running

Python 3.11+. From a checkout:

```sh
pip install -e ../plaid-client-py -e .
python scripts/fetch_reference_data.py      # ~100 MB of derived WALS/Grambank tables
plaid-dig4el --plaid-url http://localhost:8085 --data-dir ./data --port 8087
```

Log in with a Plaid account. `--data-dir` holds the SQLite database and a generated
cookie-signing secret; `PLAID_DIG4EL_REFERENCE_DIR` points at the reference data if it
is not next to the package.

## Layout

- `src/plaid_dig4el/reference/` typological tables and the questionnaire catalog
- `src/plaid_dig4el/legacy/` dig4el's observers, belief-propagation agent and frontier
  discovery, reused with their imports rewired (AGPL-3.0, see the file headers)
- `src/plaid_dig4el/inference/` the pipeline as dig4el's inference page runs it
- `src/plaid_dig4el/plaid_gateway.py` everything dig4el does to Plaid
- `src/plaid_dig4el/web/` the FastAPI + Jinja2 + htmx application
- `tests/` offline unit tests and the parity tests against dig4el's baselines
