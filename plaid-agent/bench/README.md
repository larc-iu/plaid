# Assistant benchmark

A fixed, rerunnable set of linguist tasks for the igt, ud and umr assistants. Each run starts from the same database, asks the assistant the way the Assistant panel does, approves its plan when the task says to, and scores the result with a checker. See `DATA.md` for the data.

Everything runs on private cores on random free ports. Nothing touches a running core or the working tree of the checkout (the JS importers are only read, from the build).

## Layout

The harness is this folder, in git. What it makes and reads that is not code lives in the data directory, `$PLAID_BENCH_DATA` (default `~/.local/share/plaid-bench`), never in the repository: code snapshots, fixture sources, the database snapshot, runs and the gate's slot files. Paths marked DATA below are in it.

| path | what |
|---|---|
| `code.sh` | snapshot plaid-core, plaid-agent and plaid-client-py at a commit into DATA `code/<sha>/` (git archive) and build the core jar there. DATA `code/CURRENT` names the one in use |
| `fixtures/build.sh` | build DATA `fixtures/snapshot/` (database, JWT secret, `manifest.json`, `baseline/<doc>.json`) from DATA `fixtures/src/` |
| DATA `fixtures/src/` | the public sources, as fetched (DATA.md) |
| `tasks/<app>/<id>.yaml` | a task. Optional `<id>.setup.py` and `<id>.validate.py` beside it |
| `checks/` | checkers (`exact_changes.py`, `answer.py`), the readers they share (`common.py`), hand-written results for validation (`handwrite.py`) |
| `run`, `run.py` | run tasks |
| `validate`, `validate.py` | prove a checker on hand-made right and wrong results, no model |
| `report`, `report.py` | tables from a run stamp, or the diff of two |
| `rescore`, `rescore.py` | score kept runs (`--keep-db`) again with a task's current checker, no model. The old verdict stays in score.json as `pass_as_run` |
| `lib/gate.py` | the model gate: holds the key, caps requests in flight and per minute, retries 429s |
| `lib/panel.py` | the Assistant panel, headless |
| DATA `runs/<stamp>/` | results |
| `test_gate.py`, `test_report.py` | the gate and the report against fakes, no model, no core. They run with the plaid-agent suite, as does `tests/test_bench.py`, which imports the harness and loads every task |

## First time, or after a code change

The environment:

| variable | what |
|---|---|
| `PLAID_AGENT_PYTHON` | the python of the plaid-agent env. Required: every launcher runs it |
| `PLAID_BENCH_UPSTREAM` | the model endpoint, an OpenAI-compatible base URL ending in `/v1`. Required by `run`, no default |
| `PLAID_BENCH_KEY_FILE` | a file holding the endpoint's API key. Required by `run`, no default |
| `PLAID_BENCH_DATA` | the data directory (default `~/.local/share/plaid-bench`) |
| `PLAID_BENCH_CLDF_PYTHON` | a python with pycldf for `fixtures/build.sh` (default `PLAID_AGENT_PYTHON`) |
| `PLAID_NODE` | Node 24 or later for `fixtures/build.sh` and the igt tagset write (default the `node` on PATH) |
| `PLAID_REPO` | the checkout `code.sh` and `fixtures/build.sh` read (default the one this folder is in) |
| `BENCH_RPM` | requests a minute the gate allows (default 8) |

```sh
B=plaid-agent/bench       # from the repository root
export PLAID_AGENT_PYTHON=/path/to/envs/plaid-agent/bin/python
export PLAID_BENCH_DATA=~/.local/share/plaid-bench   # or wherever the runs should live
$B/code.sh                # HEAD of the checkout, or code.sh <rev>, about a minute
$B/fixtures/build.sh      # about 30 seconds
```

A new code snapshot does not need a new database unless core's schema moved. `fixtures/build.sh` replaces `fixtures/snapshot/`, which every run copies, so never rebuild it while anyone else is running or validating tasks, and rebuild only when the data or the importers changed (ids change with every build, the task files name projects and documents by key and name, not by id). `run.json` in each stamp records the code and the snapshot it used.

## Running

```sh
$B/run                                   # every task, glm-5.2, 1 repeat
$B/run igt-smoke-gloss                   # one task, by id
$B/run ud umr --reps 3 --jobs 2          # all ud and umr tasks, 3 repeats, 2 runs at once
$B/run igt --stamp baseline-1            # name the stamp (default: the time)
$B/run some/path/task.yaml --keep-db     # a task file anywhere, keep each run's database
$B/report baseline-1                     # Markdown tables to stdout (--out FILE)
$B/report baseline-1 baseline-2          # what changed between two stamps
$B/run --rerun-infra baseline-1          # run again the runs the endpoint failed
```

The report flags a run as "would time out in production" when one of its model calls went silent for over 120 s: production's `--timeout` is a read timeout that every streamed chunk resets (plaid-client-py `workflows/llm.py` `_streamed`), so a long call that keeps streaming does not time out there. The silence of a call is the longer of its wait for the first chunk and its longest gap after it (`first_chunk_s`, `max_gap_s` in `gate.jsonl`). It counts them per app and model and per task. A gate log from before those fields has only each call's total: a call of at most 120 s, or one that streamed nothing, is judged, and a longer call that streamed is counted as "not measured" and listed apart, never as a timeout. `test_report.py` tests it on a synthetic stamp.

The report's Storage table (rule-shaped plans) gives per task the conversation record's bytes and the tool results prune dropped (from the extractor's `conversations.jsonl`), the largest undecided plan a turn left (`plan_bytes` in `turns.json`, which `run.py` writes after each turn, blank for older runs) and every plan of the final record, each with its bytes per proposed change, and the approval time. Bytes are counted as core counts them. The diff of two stamps adds record KB and plan bytes per change.

`--models` takes a comma-separated list of the endpoint's model names (default `glm-5.2`).

Each run gets its own copy of the snapshot, its own core (about 5 s to start) and its own assistant process, registered on the task's project only. A simple task takes 20 to 45 s. Whatever `--jobs` says, at most 1 model request is in flight and at most 8 are sent a minute across every bench process on the machine (the key may serve other clients too), so more than 2 jobs only makes runs wait on the gate.

What a run leaves in DATA `runs/<stamp>/<task>/<model>/<rep>/`:

- `score.json`: pass, the checker's measures, wall time, turn ends, tool calls, failed calls by tool and error class, recovered in turn, model calls, tokens, time waiting for a gate slot. The service's startup ping is left out of the model numbers.
- `check.json`: the checker's whole answer, with what changed where.
- `record.json`: the conversation record as the service wrote it (transcript, tool calls and results, the plan card).
- `turns.json`: each request the panel made, with its wall time and any error.
- `gate.jsonl`: every model request.
- `extract/`: `plaid_agent.research.extract` on the run's database (`tool_calls.jsonl`, `turns.jsonl`, `plans.jsonl` and the rest, see its README). `PRIVATE_text.jsonl` holds the texts, which here are public data and our own prompts.
- `core.log`, `service.log`, `harness_error.txt` when the harness itself failed.

The run's database is deleted after extraction unless `--keep-db`.

## Adding a task

1. Write `tasks/<app>/<id>.yaml`:

```yaml
id: igt-gloss-copula            # the file name without .yaml, by convention
app: igt                        # igt | ud | umr: which assistant answers
project: igt-lezgi              # a key of manifest.json "projects"
as: B                           # A (admin), B or C. B is a plain writer, the usual user
where: {document: Lezgi text 1} # or {lexicon: Lexicon}, or leave out for the project at large
turns:
  - say: >-
      In sentence 2 of this text, the word я is glossed "was", but it is
      the copula. Change its gloss to COP.
    approve: true               # approve the plan this turn ends with, if any
  # more turns: each may have its own where, approve, as_human
  # approve: open approves the plan this turn ends with, or, when the turn
  # made none, the conversation's newest plan that is still undecided (a later
  # turn that finds an earlier one already did what it asks). Used by
  # ud-ru-aux-multiturn-hard. approve: true approves only a plan
  # made in that turn.
check: exact_changes            # checks/<name>.py
args:                           # handed to the checker as ctx.args
  reader: igt
  document: Lezgi text 1
  expect:
    "s2.w3.m1:Gloss": COP
  prov: verified
max_wall_s: 1800                # per request (optional)
```

   `where` is what the panel sends: a document or a vocabulary, never a sentence (the panel has no sentence in its `where`). Say the sentence in the prompt.

2. If the task needs a different starting state (a planted error to fix, links to merge), write `tasks/<app>/<id>.setup.py` with `setup(ctx)`. It runs on the run's copy before the assistant starts, as admin `ctx.client` or the task's user `ctx.user`, and the checker then compares against the state after setup. `checks/handwrite.py` has helpers. A planted value should be written unstamped (`verified=False`) unless the task is about machine values.

3. Pick or write a checker. A checker is `check(ctx) -> {'pass': bool, 'measures': {...}}` and gets `ctx.client` (admin), `ctx.user`, `ctx.project` (the manifest entry), `ctx.args`, `ctx.conversation` (the record: `display` and `messages`), `ctx.turns` and `ctx.baseline_dir`.
   - `exact_changes`: the expected addresses have their values, nothing else in the project changed (provenance included), and the expected spans carry the verified stamp. `plan: none` turns it into "nothing may change".
   - `umr_graph` (umr): expected values on named nodes, document-level triples (alternatives allowed, such as either direction of :same-entity), and a drafted sentence graph matched on its key parts whatever its variable names and order, over a reader that also covers alignments, constants, the document graph and the igt layers. `umr_answer`: `answer` with that reader, plus `no_plan` for a request that must be met with a question. `checks/umr_hand.py` has the matching hand writes.
   - `answer`: the last reply matches `match` (a regex or a list), matches none of `reject`, and nothing was written. For questions with a checkable answer, and for requests that must be refused or answered with a question.
   - Every checker also counts a guideline added, changed or removed as collateral (`common.guideline_changes`), unless the task's args say `allow_guidelines: true`.
   - Your own: read the project with the readers in `checks/common.py` (`igt_values`, `ud_values`, `umr_values`, flat maps of address to value), diff with `project_changes(ctx, reader)`, report collateral and provenance.

   Addresses: igt `s3.w2` (word text), `s3.w2.m1:form`, `s3.w2.m1:Gloss`, `s3:Translation`, `s3.w2.m1:link` (the linked entry's form). ud `s3.w2:form|lemma|upos|xpos|feats|head|deprel` (head is the head's word number, 0 for the root, words numbered as CoNLL-U numbers them). umr `s3.<var>:concept`, `s3.<var>::<attribute>`, `s3.<var>::<role>` (the target variable), `s3.<var>:anchor` (covered words), `s3:root`. Any stamped span adds `<address>#prov`.

4. Write `tasks/<app>/<id>.validate.py` with `right(ctx)` and one or more `wrong_<name>(ctx)`, each making a result by hand through the API (see the smoke tasks), and run `./validate <id>`. Every line must say `ok`: right passes, every wrong fails. A function returns the conversation the checker should see, `handwrite.applied_plan()` by default, `handwrite.no_plan()` for "the assistant wrote nothing", or a dict with a `display` list for an answer.

5. Run it on the model once (`./run <id>`), read `record.json` and `check.json`, and make sure a failure is the assistant's and not the task's (an ambiguous prompt, a checker too strict about a reasonable alternative).

## The model gate

`lib/gate.py` is an OpenAI-compatible proxy in `run.py`'s own process. `run.py` reads the key from the file `$PLAID_BENCH_KEY_FILE` names into the gate's memory once, and the gate sends requests on to `$PLAID_BENCH_UPSTREAM`. The key is sent upstream in a header and appears nowhere else: not in a file, a log, argv or a child's environment. The assistants get a dummy key and `--api-base http://127.0.0.1:<gate>/<run tag>/v1`.

Three limits hold across every bench process on the machine, through files in DATA `.llm-slots/`:

- **1 request in flight** (`SLOTS` in gate.py). A request holds an exclusive `flock` on `slot0.lock` from before it is sent until its answer has been read.
- **8 requests a minute** (`BENCH_RPM` to change it), so the bench leaves the rest of a shared key's per-minute limit to its other clients. `rpm.log` holds the send times of the last minute under an `flock` on `rpm.lock`. Every attempt counts, retries too.
- **A 429, 502, 503 or 504, a timeout or an unreachable endpoint is tried again inside the gate**, still holding its slot, after the answer's Retry-After or 5, 10, 20, 40, 60, 60 ... s, for up to 10 minutes from the first attempt. Only then does the error reach the assistant.

The service's model timeout is raised to 1500 s (the default is 120) because a call may first wait for a slot, the per-minute cap and the retries. `gate.jsonl` has, per request, `wait_s` (slot), `rate_wait_s`, `backoff_s`, `attempts`, the earlier attempts under `retried`, `upstream_s` (the last attempt only), `first_chunk_s` (from the request sent to the first chunk of the body, null when none came) and `max_gap_s` (the longest silence after the first chunk, up to the stream's end or failure, or the whole wait when no chunk came), both of the answer the assistant got, and `infra` when the final answer was the endpoint's error.

**Infra runs.** A run that did not pass while one of its turns ended on an error (or the harness failed) and the gate returned an endpoint error (`rate_limited`, `upstream_5xx`, `timeout`, `unreachable`, `stream_broken`) is marked `"infra": "<reason>"` in `score.json`. A failed run whose turns all ended normally stays the assistant's failure. `report` leaves infra runs out of every pass rate and measure, counts them in their own column and lists them in "Infra runs (not counted)". A score.json from before the field is judged from its gate log. `./run --rerun-infra STAMP [--jobs N]` runs the infra runs of a stamp again in place and moves each old one to `STAMP/_infra/<task>/<model>/<rep>.<n>/`, where the report does not read it.

`test_gate.py` tests the gate against a fake upstream (no key, no network, its own slot directory): pass-through, the key, streaming, the first chunk and the longest silence of a dripping stream, retries, the budget, timeouts, the per-minute cap in one gate and across three processes, and `infra_of`.

## Smoke tasks

`igt-smoke-gloss`, `ud-smoke-upos`, `umr-smoke-attr`: one value changed on request in the open document, plan approved, verified stamp checked, nothing else changed. They prove the harness end to end, not the assistants.
