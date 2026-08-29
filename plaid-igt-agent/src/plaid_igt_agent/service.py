"""The assistant as a Plaid service (task ``assist``, delegating).

One request = one chat turn (or one plan approval). The browser holds the
transcript and sends it back with each turn, so the service is stateless
across turns; every request is served with the REQUESTER's own client (the
server mints a short-lived token for them), so reads are limited to what they
may read and approved edits are attributed to them in the audit log.

Request data:
    project_id   the project (a service instance may serve many)
    messages     the transcript so far (OpenAI-shaped message dicts, no system)
    approve      instead of a turn: {ops, label} of a plan the user approved

Result data:
    {kind: 'turn', message, messages: [new transcript messages], plan: {id, summary, labels, ops} | null}
    {kind: 'applied', applied: n, counts: [{kind, count}], message}
"""

import argparse
import re

from plaid_client import BaseService, TASKS, service_source

from .agent import ModelConfig, run_turn
from .plan import execute_plan, summarize
from .project import load_project
from .prompt import build_system_prompt
from .tools import Workspace

SUMMARY = """\
**IGT Assistant** is a chat assistant over this project, powered by whatever
model the Plaid operator configured (any provider litellm supports).

Ask it analytic questions (how is X glossed, which words are unanalyzed, are
these glosses consistent), or ask it to make changes: fix a gloss across the
corpus, segment and gloss words, link words to lexicon entries, add entries,
respell words, fill in an orthography. It never writes on its own: a request
that changes data comes back as a **plan** you approve or discard. Approved
changes are applied under your own account, in one audit-log entry, stamped as
machine-made so they show as unverified in the editor until confirmed.

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
            label = approve.get('label') or f'Assistant: {summarize(ops)}'
            response_helper.progress(10, 'Applying changes…')
            counts = execute_plan(client, ops, source=service_source(self.service_id), label=label)
            response_helper.progress(100, 'Done')
            response_helper.complete({
                'kind': 'applied', 'applied': sum(counts.values()),
                'counts': [{'kind': k, 'count': n} for k, n in counts.items()],
                'message': f'Applied {summarize(ops)}.',
            })
            return

        transcript = request_data.get('messages') or []
        state = {'pct': 5}

        def on_progress(pct, msg):
            state['pct'] = max(state['pct'], pct)
            response_helper.progress(state['pct'], msg)

        ws = Workspace(client, project, on_progress=lambda msg: response_helper.progress(state['pct'], msg))
        text, new = run_turn(self.cfg, ws, build_system_prompt(project), transcript, on_progress)
        response_helper.progress(100, 'Done')
        response_helper.complete({'kind': 'turn', 'message': text, 'messages': new, 'plan': ws.plan_payload()})


def main():
    AssistantService().run()


if __name__ == '__main__':
    main()
