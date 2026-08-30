"""The assistant as a Plaid service (task ``assist``, delegating).

One request = one chat turn (or one plan approval). The browser holds the
transcript and sends it back with each turn, so the service is stateless
across turns; every request is served with the REQUESTER's own client (the
server mints a short-lived token for them), so reads are limited to what they
may read and approved edits are attributed to them in the audit log.

Request data:
    project_id   the project (a service instance may serve many)
    messages     the transcript so far (OpenAI-shaped message dicts, no system)
    approve      instead of a turn: {id, ops, label, as_human, documents} of a plan the user approved
                 (as_human: record the writes as human-made instead of verified machine-made;
                 documents: [{id, name, version}] read at plan time, refused if any changed since)

Result data:
    {kind: 'turn', message, messages: [new transcript messages], plan: {id, summary, labels, ops, documents} | null,
     citations: [{key, document_id, document_name, sentence_id, sentence, focus, text, words, fields}],
     steps: [{id, name, kind, label}], steps_summary: '...'}
                 (a step's own output is not repeated here: it is the `tool` message with the same id)
    {kind: 'applied', applied: n, counts: [{kind, count}], message}
"""

import argparse
import re
import time

from plaid_client import BaseService, TASKS, service_source

from .agent import ModelConfig, ping_model, run_turn
from .citations import resolve_citations
from .plan import execute_plan, summarize, PlanError
from .project import load_project
from .prompt import build_system_prompt
from .tools import Workspace

SUMMARY = """\
**IGT Assistant** is a chat assistant over this project, powered by whatever
model the Plaid operator configured (any provider litellm supports).

Ask it analytic questions (how is X glossed, which words are unanalyzed, are
these glosses consistent), or ask it to make changes: fix a gloss across the
corpus, segment and gloss words, link words to lexicon entries, add entries,
respell words, fill in an orthography, confirm or discard what another service
produced. It never writes on its own: a request that changes data comes back
as a **plan** you approve or discard. Approved changes are applied under your
own account, in one audit-log entry, and recorded as **verified** (made by the
assistant, confirmed by you), or as human-made if you say so when approving.

Readers can use it for questions; planning and applying changes needs write
access.
"""


class AssistantService(BaseService):
    CONCURRENT = True  # turns wait on a remote model; do not serialize users

    def __init__(self):
        super().__init__(
            'igt:assist', 'IGT Assistant',  # both replaced per model in setup()
            'Chat about the project and plan edits, with the operator\'s model',
            tasks=[TASKS.ASSIST], summary=SUMMARY, delegation=True)
        self.cfg: ModelConfig | None = None
        # Plan ids already applied by this process, so a second approval of
        # the same plan (a retried request after a client timeout, a double
        # click) does not write it twice. Bounded, most recent last.
        self._applied_plans: list = []

    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        parser.add_argument('--model', required=True,
                            help='litellm model string, e.g. openai/gpt-4o, anthropic/claude-sonnet-4-5, '
                                 'ollama/llama3.1, or openai/<name> with --api-base for any OpenAI-compatible server')
        parser.add_argument('--api-base', default=None, help='Provider base URL (OpenAI-compatible servers, proxies)')
        parser.add_argument('--api-key', default=None, help='Provider API key (else the provider\'s env var)')
        parser.add_argument('--max-steps', type=int, default=50, help='Tool-call rounds per turn (default 50)')
        parser.add_argument('--temperature', type=float, default=None)
        parser.add_argument('--max-tokens', type=int, default=None)
        parser.add_argument('--service-id', default=None,
                            help='Service id (default igt:assist:<model>). Several assistants can be '
                                 'online on one project as long as their ids differ; the Assistant tab '
                                 'offers a picker.')
        parser.add_argument('--service-name', default=None,
                            help='Display name (default "IGT Assistant (<model>)")')

    def setup(self, args) -> None:
        self.cfg = ModelConfig(model=args.model, api_base=args.api_base, api_key=args.api_key,
                               max_steps=args.max_steps, temperature=args.temperature, max_tokens=args.max_tokens)
        # One registration per model by default, so an operator can run several
        # assistants side by side (different models, or the same model with a
        # different base) and users pick one in the tab. Two instances with the
        # SAME id on a project still collide (409): that is the dedupe guard.
        slug = re.sub(r'[^A-Za-z0-9._-]+', '-', self.cfg.model).strip('-')
        self.service_id = args.service_id or f'igt:assist:{slug}'
        self.service_name = args.service_name or f'IGT Assistant ({self.cfg.model})'
        # Advertised so the UI can say which model answers.
        self.extras['model'] = self.cfg.model
        print(f'Model: {self.cfg.model}' + (f' via {self.cfg.api_base}' if self.cfg.api_base else ''))
        # Ask the model one question before registering. A service that cannot
        # reach its model has nothing to offer, and the operator is here NOW.
        started = time.monotonic()
        try:
            ping_model(self.cfg)
        except Exception as e:  # noqa: BLE001 - whatever the provider says, the operator needs to read it
            print(f'  The model did not answer: {e}')
            print('  Check --model (a litellm model string), --api-base, and the provider key '
                  '(--api-key or the provider\'s environment variable).')
            raise SystemExit(1)
        print(f'  Answered in {time.monotonic() - started:.1f}s.')

    def process_request(self, request_data: dict, response_helper) -> None:
        client = request_data.get('requester_client')
        project_id = request_data.get('project_id')
        if client is None or not project_id:
            response_helper.error('Missing project_id or requester credentials')
            return
        try:
            project = load_project(client, project_id)
        except ValueError as e:
            response_helper.error(str(e))
            return

        approve = request_data.get('approve')
        if approve:
            ops = approve.get('ops') or []
            if not ops:
                response_helper.error('Nothing to apply')
                return
            plan_id = approve.get('id')
            if plan_id and plan_id in self._applied_plans:
                response_helper.complete({'kind': 'applied', 'applied': 0, 'counts': [], 'duplicate': True,
                                          'message': 'This plan was already applied; nothing was written again.'})
                return
            label = approve.get('label') or f'Assistant: {summarize(ops)}'
            stamp_mode = 'human' if approve.get('as_human') else 'verified'
            stale = stale_documents(client, approve.get('documents') or [])
            if stale:
                response_helper.error('Nothing was written: ' + '; '.join(stale)
                                      + '. The plan was made against an older state of the data (its character '
                                      'offsets and ids may no longer fit). Ask the assistant to plan again.')
                return
            response_helper.progress(10, 'Applying changes…')
            try:
                counts = execute_plan(client, ops, source=service_source(self.service_id), label=label, project=project,
                                      stamp_mode=stamp_mode)
            except PlanError as e:
                if plan_id and e.applied:
                    self._remember_applied(plan_id)
                response_helper.error(f'The plan failed after {e.applied} of {e.total} changes were applied: {e}. '
                                      + ('Those changes stand (see recent_changes); the rest were not applied.' if e.applied
                                         else 'Nothing was written.'))
                return
            except ValueError as e:
                response_helper.error(f'The plan was rejected before anything was written: {e}')
                return
            if plan_id:
                self._remember_applied(plan_id)
            notes = counts.pop('notes', [])
            response_helper.progress(100, 'Done')
            response_helper.complete({
                'kind': 'applied', 'applied': sum(counts.values()),
                'counts': [{'kind': k, 'count': n} for k, n in counts.items()],
                'message': f'Applied {summarize(ops)}.' + (' ' + '; '.join(notes) if notes else ''),
            })
            return

        transcript = request_data.get('messages') or []
        state = {'pct': 5}

        def on_progress(pct, msg):
            state['pct'] = max(state['pct'], pct)
            response_helper.progress(state['pct'], msg)

        ws = Workspace(client, project, on_progress=lambda msg: response_helper.progress(state['pct'], msg))
        turn = run_turn(self.cfg, ws, build_system_prompt(project), transcript, on_progress)
        response_helper.progress(100, 'Done')
        response_helper.complete({'kind': 'turn', 'message': turn.text, 'messages': turn.messages,
                                  'plan': ws.plan_payload(), 'citations': resolve_citations(ws, turn.text),
                                  'steps': turn.steps, 'steps_summary': turn.summary})


    def _remember_applied(self, plan_id: str) -> None:
        self._applied_plans.append(plan_id)
        del self._applied_plans[:-500]


def stale_documents(client, documents: list) -> list:
    """Which of the plan's documents changed since it was made: every write
    inside a document bumps its version, so a version mismatch means the
    plan's ids and offsets were read from data that is no longer there."""
    out = []
    for d in documents:
        if not isinstance(d, dict) or not d.get('id') or d.get('version') is None:
            continue
        try:
            now = client.documents.get(d['id'])
        except Exception as e:  # noqa: BLE001 - deleted or unreadable: the plan cannot apply
            out.append(f'document "{d.get("name") or d["id"]}" could not be read ({e})')
            continue
        if now.get('version') != d['version']:
            out.append(f'document "{now.get("name") or d.get("name") or d["id"]}" has changed since the plan was made')
    return out


def main():
    AssistantService().run()


if __name__ == '__main__':
    main()
