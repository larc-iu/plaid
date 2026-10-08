# Plaid assistant study dataset

This dataset was extracted from one Plaid database by `plaid_agent.research.extract`. It records what the assistants proposed, what people decided about it, what became of every machine write afterwards, and how the assistants used their tools. `manifest.json` says which database, when, with which options, and holds the aggregate counts.

## What is and is not in it

- People are pseudonyms (`u-` and ten hex digits), a keyed hash of the user id. The key (the salt file) is kept outside the dataset. The same salt gives the same pseudonyms in a later extraction.
- Projects are their id (a random UUID) and a pseudonym (`p-...`). Names are written only with `--keep-project-names`, into `projects.jsonl`.
- No text of a user's message, a model's reply, a tool's answer or an operation's label is written. With `--include-text` they go to `PRIVATE_text.jsonl` only, for the researcher's own review. That file must never travel with the dataset.
- Values (a gloss, a form, a dependency label) are clipped to 24 code points with an ellipsis, as the assistant's plan record clips them.
- Entity ids (documents, tokens, spans, relations, vocabulary entries) are kept. They are random UUIDs and name nobody, and they are what joins the files.
- A `provSource` that names a person (`user:<id>`) is pseudonymized. A service or rule name is kept.

## Time

All times are ISO 8601 in UTC. Audit times have nanoseconds. Durations are seconds.

The **horizon** (`manifest.horizon`) is the latest time the database holds: its last audit write, conversation record write or client event. The time the copy was taken is not in the database, so a later copy time is not used. Everything that happened to a write is followed until the horizon. A write's `observed_s` is how long it was observable, so a write made an hour before the horizon had an hour to be corrected. `manifest.audit_pruned_below` is set when the log was pruned, and nothing before it can be seen.

## What the records cannot say

- A plan's proposal time is read off its id, a UUIDv7 minted when the turn staged it. Plans made before 2026-09-30, when the ids became UUIDv7, have no proposal time.
- Every question, reply and error carries the time it was written since 2026-10-06 (`turns.created_at`, `turns.asked_at`). Before that a turn without a plan has only its duration (`elapsed_ms`, recorded since 2026-10-05).
- A failed or stopped turn keeps the tool calls it made before it ended since 2026-10-06. Before that its tool use is lost.
- Retry keeps the attempt that did not finish since 2026-10-06: the question and its error stay, and the question sent again is a new turn marked `retry`. Before that Retry took the failed attempt out of the record, so a failure the user retried left no trace.
- The question of a failed or stopped turn stays in the model transcript since 2026-10-08, so `transcript_messages` counts it. Before that it was taken out. Turns are counted from the questions on screen either way.
- `settled_at` is recorded since 2026-09-29. For an applied plan without it, the start of the plan's operation in the audit log stands in (`settled_at_source: audit_group_start`). A discarded, stale or replaced plan without it has no settle time.
- `proposed` (what each change targeted and its value) is recorded since 2026-09-29. Before that it is derived from the plan's `ops` when the record still holds them (`proposed_source: derived_from_ops`). A plan compacted before `proposed` existed has neither (`none`), only its row count.
- Approval is of the whole plan. A change's own outcome is the plan's status, and what happened to it afterwards is read from the audit log (`plan_changes.fate`).
- A conversation the user deleted is gone with its plans, by design. An applied plan's operation stays in the log with its kind and reference, marked `plan_record: deleted` in `units.jsonl`.
- Comments are not in the audit log, by design. A plan's comments are found by their ids (`comments.jsonl`): since 2026-09-30 a plan draws the id of every row it creates from its own. An applied plan from before then that left no operation is `comment_link: unrecoverable`, and what it commented cannot be found.
- Which credential made a write (`credential`: a password login, a named API token or a token delegated to a service) is recorded since 2026-10-06. Before that only `via_token` says a named token was used. From 2026-10-06 to 2026-10-08 a named token that held a service connection when it wrote was recorded as `service`, whoever opened the connection. Since 2026-10-08 the kind comes from the token alone and such writes are `named-token`, so a service's own writes are told from a script's by the unit's kind (`service-run`), not by its credential.
- The parts of a record pruned to fit its size cap are gone: old tool results (`tool_results_dropped`), the steps and citations of old replies, the `ops` of settled plans. A failed tool call whose answer was pruned has `error_class: unknown`.
- User data is not in the audit log. Only the latest version of each record exists.
- Operation kinds and references are recorded since 2026-09-29. Older operations are classed by what they wrote (see `units.jsonl`).
- Telemetry (`telemetry.jsonl`) is recorded only in projects that switched it on.

## Files

### projects.jsonl

One row per project in scope.

| field | meaning |
|---|---|
| project_id | the project's id |
| project | its pseudonym |
| name | its name, only with `--keep-project-names` |
| exists | false when the project was deleted (its rows remain in the log) |
| conversations, plans | how many of each the records hold |
| units | machine units by kind (see units.jsonl) |

### conversations.jsonl

One row per assistant conversation.

| field | meaning |
|---|---|
| conversation_id | the conversation's id, as in an assistant operation's `ref` |
| app | `igt`, `ud` or `umr` |
| project_id, project | the project |
| user | the conversation's owner |
| created_at, updated_at | from the sidebar entry (or the record's store time) |
| has_meta | false when the record has no sidebar entry (a write cut off between the two) |
| turns | user messages |
| items | everything shown: messages, replies, errors |
| plans | replies that carried a plan |
| models, services | every model and assistant service that answered |
| version | the assistant's prompt version at the last turn |
| pending | a turn or approval was under way when the database was copied |
| record_bytes | the stored record's size |
| transcript_messages | messages in the model transcript |
| tool_results_kept, tool_results_dropped | tool results still in the transcript, and those pruned to fit the size cap |
| about_document | the document a docked conversation is about |

### turns.jsonl

One row per reply or error (one per turn).

| field | meaning |
|---|---|
| conversation_id, app, project_id, project, user | as above |
| item_index | the item's place in the conversation |
| turn | which user message it answers (1 is the first) |
| end | `answered`, `stopped` (the user stopped it), `failed` (no answer), `lost` (no answer came back and the user retried it, since 2026-10-06), `stopped_repeat` (the same tool call failed or repeated three times), `step_limit`, `empty_reply`, `cut_at_length` |
| model, version, service | what answered |
| asked_at | when the question it answers was written (since 2026-10-06) |
| retry | the question is one the turn before it did not finish, sent again with Retry (since 2026-10-06) |
| created_at | when the reply or error was written, at the end of the turn (since 2026-10-06) |
| elapsed_ms | how long the turn took |
| sent_tokens, received_tokens | the turn's last model call |
| window_tokens | the model's context window, when known |
| total_sent_tokens, total_received_tokens, model_calls | every model call of the turn added up |
| n_steps, n_failed_steps | tool calls, and those the tool refused. A failed or stopped turn counts the calls it made before it ended (since 2026-10-06) |
| n_citations | citations in the reply |
| plan_id | the plan the reply carried |
| where_kind, where_id | where the user was when asking (a document) |
| files_attached, files_stored | files the user attached to the question, and that the turn stored |
| unavailable_projects | other projects asked for that the turn could not read |
| other_project_ids, other_projects | the other projects the question was sent with that the turn could read, by id and pseudonym (empty for a turn that read only its own project) |

### tool_calls.jsonl

One row per tool call.

| field | meaning |
|---|---|
| conversation_id, app, project_id, project, user, item_index, turn | the turn |
| turn_end | how the turn ended (as turns.end), so the calls of failed and stopped turns can be told apart |
| step | the call's place in the turn |
| tool | the tool's name |
| step_kind | `document`, `read`, `plan`, `web` or `meta` |
| failed | the tool refused the call (its answer began `Error`) |
| error_class | for a refusal: `query_rejected` (the server refused a query), `bad_arguments`, `wrong_level` (a reference to the wrong kind of thing: a word where a morpheme was wanted, a sentence where a word was, a multi-word token where one of its words was), `ambiguous` (a name matched several things), `not_found`, `plan_limit`, `plan_conflict`, `unavailable` (a service or capability not there), `server_refused`, `code_exception` (run_code raised), `tool_fault` (a bug in the tool), `other`, or `unknown` when the answer was pruned |
| recovered_in_turn | for a refusal: a later call to the same tool in the same turn went through |
| result_kept | the tool's answer is still in the record |
| planned | how much the call changed the plan's size |
| document_read | the call read a document |
| arg_names | the names of the arguments it was given, never their values (null when the record no longer holds them) |
| legacy_shape | the step was recorded in the older shape (its arguments and result inline) |

### tool_inventory.json

`inventory` is every tool each app's assistant offers in the code that made this extraction (an operator's configuration can withhold the web, code and file tools). `tools` has per tool: calls, failed, recovered_in_turn, result_kept, turns, conversations, error_classes, and `in_inventory`. `never_used` lists the offered tools no turn called, `not_in_inventory` the tools called that the current code no longer offers.

### plans.jsonl

One row per plan.

| field | meaning |
|---|---|
| plan_id | the plan's id |
| conversation_id, app, project_id, project, user, item_index, turn | where it was proposed and whose conversation it is |
| status | `applied`, `partial` (applying stopped partway), `discarded` (by the user), `stale` (refused on approval: the documents changed, or made by an older assistant), `replaced` (a newer plan in the same conversation replaced it before a decision), `undecided` |
| interrupted | an approval was cut off and its outcome is not known |
| dismissed, dismissed_at | for a `stale` plan: the reader discarded the card after the refusal, and when. The status stays `stale` |
| model, version, service | the turn that proposed it |
| proposed_at | when it was staged, from its UUIDv7 id |
| settled_at, settled_at_source | when it was decided, from the record (`record`) or the start of its operation (`audit_group_start`) |
| seconds_to_settle | settled_at less proposed_at |
| proposed_count | how many changes it proposed (a bulk row counts each change) |
| proposed_kept | how many of them `plan_changes.jsonl` has (at most 500) |
| proposed_source | `record`, `derived_from_ops` or `none` |
| op_count | the plan's operations as the card stored them (a bulk row is one) |
| rows | rows on the plan card |
| as_human | the approver had the changes recorded as their own work, not the assistant's |
| contributed | the approver's work is reviewed in the project, so the changes were stamped as their contribution |
| partly_applied, rows_written | for a partial plan: the card rows written in full |
| outcome_unknown | the server did not answer for part of it |
| apply_notes | notes applying made (a change a later one superseded) |
| unwritten_rows | rows that wrote nothing under this approval |
| kinds | the kinds of change it proposed |
| group_id | its operation in the audit log (units.jsonl) |
| group_link | how it was found: `ref` (the operation names the plan) or `label` (an older operation, matched by its label, owner, project and time) |
| writes | the audit rows of that operation |
| comments_written | comments the plan wrote, found by their ids (comments.jsonl) |
| comment_link | `minted_id` (its comments were found by their ids), `unrecoverable` (applied before plans drew their ids, with no operation found, so what it wrote outside the log cannot be found), or null |

### plan_changes.jsonl

One row per proposed change.

| field | meaning |
|---|---|
| plan_id, conversation_id, app, project_id, project, user | the plan |
| change | the change's place in the plan |
| plan_status | the plan's status, which is the change's: approval is whole-plan |
| kind | the change's kind (`set_span`, `set_head`, ...) |
| target | the id it targets (a word, a morpheme, a span, an entry) |
| value | its proposed value, clipped |
| other | the second thing a change joins (a head, a link's entry), when it has one |
| source | as plans.proposed_source |
| target_written | for an applied plan: its operation wrote this target or something on it (a gloss over the word, a dependency on it), or for a comment, a comment of the plan is on it |
| matched_writes | how many of the operation's writes are about the target |
| fate | the fate of the first matching write (writes.jsonl): the target itself first, then a write the plan left in place before one it deleted. For a comment, `comment_kept` or `comment_edited` |
| fates | the fates of every matching write, counted |

### units.jsonl

One row per machine unit followed. A unit is an operation group, else a batch, else a single operation, as the audit log folds them. Units of these kinds are followed by default (`--track` changes it):

- `assistant-plan`: an approved assistant plan being applied. `legacy: true` when the operation has no kind and was recognized by its `Assistant: ` label.
- `service-run`: a service's run, or an app's in-browser rule (`ref` is `builtin:<name>`).
- `guess-adoption`: a person taking a suggested value (an igt guess) as their own.
- `untagged-machine`: a unit with no kind (older than kinds) that wrote machine provenance (`prov` set, not confirmed, not contributed). An untagged unit whose machine stamps are all an importer's (`flex-import`) is an `import` instead.

| field | meaning |
|---|---|
| unit_id | the group, batch or operation id |
| kind, legacy | as above |
| ref | the operation's reference: `conv:<id>/plan:<id>/service:<id>` for a plan, `service:<id>` or `builtin:<name>` for a run |
| conversation_id, plan_id, service | read from ref |
| plan_found | for a plan's unit: its plan is in a conversation record |
| plan_record | for a plan's unit: `found`, `deleted` (no record holds its plan: its conversation was deleted, which deletes its plans, or an older operation without a reference matched no plan), or `missing` (its conversation is there but the plan is not) |
| requester | who started it (for a plan, the approver) |
| project_id, project | the project |
| started_at, ended_at | its first and last audit row |
| via_token | some of its writes were made with an API token |
| credentials | its audit rows by the kind of credential that made them: `login` (a session from signing in with a password), `named-token` (a named API token, such as a script or a service run on its owner's token), `service` (only from 2026-10-06 to 2026-10-08: a named token holding a service connection), `delegated` (a token a service was handed to act for its requester). Empty before 2026-10-06 |
| documents | documents it wrote |
| counts | its audit rows by `table.change` |
| sources | the provSource of its machine or verified writes, counted |
| writes | its audit rows |

### writes.jsonl

One row per entity a followed unit wrote (its last write to it), and what happened to the entity afterwards, until the horizon. Only annotation tables are followed: tokens, spans, relations, vocab_links and vocab_items.

| field | meaning |
|---|---|
| unit_id, unit_kind, legacy | the unit |
| project_id, document_id, vocab_layer_id | where |
| table, target_id | the entity |
| written_change | `insert`, `update` or `delete` (the unit deleted it) |
| written_at | the unit's last write to it |
| observed_s | horizon less written_at |
| prov_written | its provenance as written: `human`, `machine`, `contributed` or `verified` |
| source_written, model_written | its provSource and provDetail.model |
| value_written | its value as written (a span's or relation's value, an entry's form, a morpheme token's form, a link's entry id), clipped |
| fate | the headline, in this order of precedence: `deleted_by_run` (the unit itself deleted it), `deleted_by_<actor>`, `edited_by_<actor>` (its value or non-provenance metadata changed), `reshaped` (only where it sits changed: offsets, its tokens), `reviewed_by_<actor>` (only its provenance changed, as when someone confirms it), `unchanged` |
| later_writes | changes to it after the unit, by later units |
| later_by | those changes counted by `<actor>.<category>` |
| first_event | the first later change of any kind |
| first_edit | the first change of its value or metadata |
| first_review | the first change of its provenance only |
| deletion | its deletion |
| final_exists | it still exists at the horizon |
| final_value_same | its value at the horizon is the value written |

An event (`first_event`, `first_edit`, `first_review`, `deletion`) has:

| field | meaning |
|---|---|
| at, after_s | when, and how long after the unit's write |
| actor_class | `person`, `assistant` (an approved plan), `machine` (a service run or untagged machine unit), `import`, `repair` (an app's own repair when a document opens) |
| actor_kind | the kind of the unit that made the change (`person-untagged` for a person's ordinary edit) |
| actor | who made it (pseudonym) |
| by_requester | the same person who started the followed unit |
| via_token | made with an API token (a script or a service, not the browser) |
| credential | the kind of credential that made it, as units.credentials (null before 2026-10-06) |
| unit_id | the unit that made the change |
| category | `value`, `metadata`, `extent`, `structure`, `provenance` |
| fields | the fields that changed (`metadata.<key>` for metadata) |
| prov_after, source_after, value_after | the entity's provenance, provSource and value after the change |
| cascade | for a deletion: the same unit deleted a token or span the entity sat on, so it went with the structure under it (a word deleted or re-split), not as a judgment of its value |

Who counts as a person or a machine is read from the unit that made the change: its kind, else (before kinds) whether it wrote machine provenance. A person's change made through a script with their API token counts as a person's, and `via_token` and `credential` (`named-token`) say so. A change made in the browser is `login`.

### comments.jsonl

One row per comment an approved plan wrote, found by its id (the plan draws the id of every row it creates from its own, since 2026-09-30). Comments are not in the audit log, so this is the comment as it stands at the copy: a comment deleted since is not here. No comment text.

| field | meaning |
|---|---|
| plan_id, conversation_id, app, project_id, project | the plan |
| comment_id | the comment's id |
| entity_type, entity_id | what it is on (a token, a span, a vocabulary entry, ...) |
| document_id, vocab_layer_id | where |
| created_at | when it was written |
| edited_after_s | how long after it was last edited, null when never (only its author can edit it) |
| author_is_requester | written under the approver's name, as every plan's comment is |

### telemetry.jsonl

One row per client event (`client_events`), only in projects that switched telemetry on.

| field | meaning |
|---|---|
| event_id | the row id |
| project_id, project, document_id | where |
| user | who |
| type | `suggestion.shown`, `suggestion.adopted`, `suggestion.dismissed`, `plan.opened` |
| target_id | the entity it was about |
| data | the event's own keys: `value` and `written` clipped, `source` with any person pseudonymized, `field`, `conversation` |
| client_ts, ts | the browser's time and the server's |

### manifest.json

The extractor version, the database file name, the horizon, the options, how plans were linked to their operations (`linking`: by reference, by label, by their comments, applied plans with no operation found, those whose writes outside the log cannot be recovered, plan operations with no plan in any record and those whose conversation was deleted), and `summary`, the aggregate counts. In it `units_by_credential` counts the units that hold a write made with each kind of credential (a unit with two kinds counts under both), and `writes_by_credential` counts their audit rows.

### PRIVATE_text.jsonl (only with `--include-text`)

User messages, replies, error lines, tool refusals (first 500 characters) and operation labels, keyed like the rows above. For the researcher's own review. Never share it.
