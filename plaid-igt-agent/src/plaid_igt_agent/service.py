"""The assistant as a Plaid service (task ``assist``, delegating).

One request = one chat turn, or one plan approval, on a conversation that
lives in the requester's private key/value store on the Plaid server (see
:mod:`.conversation`). The browser appends the user's message to the record
and marks the conversation pending before submitting; the service loads the
record, does the work, and writes the outcome back BEFORE reporting the
request done. So the reply lands whether or not the browser is still
watching, and a browser that comes back reads it from the record (or
rejoins the request by id while it is still running). Every request is
served with the REQUESTER's own client (the server mints a short-lived token
for them), so reads are limited to what they may read, approved edits are
attributed to them in the audit log, and the record is theirs.

Request data:
    project_id       the project (a service instance may serve many)
    conversation_id  the conversation to continue
    approve          instead of a turn: {plan_id, as_human, contributed_by} for a plan
                     in the conversation the user approved (as_human: record the writes
                     as human-made instead of verified machine-made; contributed_by: the
                     approver's user id when they are a contributor, whose approval records
                     the writes as their own unreviewed work). The plan's ops and the
                     document versions it was made against come from the record; a plan
                     whose documents changed since is refused.

Result data:
    {kind: 'turn', message, plan: {id, summary, ...} | null, citations, steps, steps_summary}
    {kind: 'stopped'}                       the requester cancelled the turn
    {kind: 'applied', applied: n, counts: [{kind, count}], message}
The record is the full outcome: a browser re-reads it on any of these.
"""

import argparse
import os
import re
import time
import traceback
from urllib.parse import urlsplit

from plaid_client import BaseService, TASKS, service_source

from .agent import ModelConfig, TurnCancelled, ping_model, run_turn
from .citations import resolve_citations
from .conversation import (ConversationStore, MissingConversation, assistant_item, build_meta, error_item,
                           find_plan, prune, settle_plan)
from .plan import execute_plan, summarize, PlanError
from .project import load_project
from .prompt import build_system_prompt
from .tools import Workspace
from .web import BACKENDS, WebConfig, session_for, ping as ping_search

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
        self.web_cfg: WebConfig | None = None
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
        parser.add_argument('--no-stream', action='store_true',
                            help='Do not stream the reply as it is written (for a provider that misbehaves '
                                 'under streaming); the reply then arrives whole')
        parser.add_argument('--service-id', default=None,
                            help='Service id (default igt:assist:<model>). Several assistants can be '
                                 'online on one project as long as their ids differ; the Assistant tab '
                                 'offers a picker.')
        parser.add_argument('--service-name', default=None,
                            help='Display name (default "IGT Assistant (<model>)")')
        parser.add_argument('--web-search', default=None, choices=sorted(BACKENDS),
                            help='Let the assistant look things up on the web with this provider. '
                                 'Off unless given: without it the web tools are not offered to the '
                                 'model and the prompt does not mention them. '
                                 + ' · '.join(f'{b.name}: ' + (b.note or f'key in {b.env_key}')
                                              for b in BACKENDS.values()))
        parser.add_argument('--web-search-key', default=None,
                            help='Key for --web-search, for a provider that takes one (else its own '
                                 'environment variable)')
        parser.add_argument('--web-search-url', default=None,
                            help='Base URL of a self-hosted --web-search provider, e.g. '
                                 'http://localhost:8888 for SearXNG')

    def setup(self, args) -> None:
        self.cfg = ModelConfig(model=args.model, api_base=args.api_base, api_key=args.api_key,
                               max_steps=args.max_steps, temperature=args.temperature, max_tokens=args.max_tokens,
                               stream=not getattr(args, 'no_stream', False))
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
        self.web_cfg = build_web_config(args)
        if self.web_cfg is None:
            print('Web lookup: off (--web-search to turn it on)')
        else:
            # Same reasoning as the model ping: a bad key should be the
            # operator's problem now, not a user's mid-conversation.
            where = f' at {self.web_cfg.api_base}' if self.web_cfg.api_base else ''
            print(f'Web lookup: {self.web_cfg.backend}{where}')
            try:
                print(f'  {ping_search(self.web_cfg)} results for a test search.')
            except Exception as e:  # noqa: BLE001 - the provider's own complaint is what helps
                print(f'  The search provider did not answer: {e}')
                print(f'  {check_hint(BACKENDS[self.web_cfg.backend])}')
                raise SystemExit(1)

    def process_request(self, request_data: dict, response_helper) -> None:
        client = request_data.get('requester_client')
        project_id = request_data.get('project_id')
        user_id = request_data.get('requester_id')
        conv_id = request_data.get('conversation_id')
        if client is None or not project_id or not user_id:
            response_helper.error('Missing project_id or requester credentials')
            return
        if not conv_id:
            response_helper.error('Missing conversation_id')
            return
        store = ConversationStore(client, user_id, project_id)
        try:
            conv, meta = store.load(conv_id)
        except MissingConversation:
            response_helper.error('No such conversation')
            return
        try:
            project = load_project(client, project_id)
        except ValueError as e:
            response_helper.error(str(e))
            return
        request_id = getattr(response_helper, 'request_id', None)
        approve = request_data.get('approve')
        if approve:
            self._apply(client, project, store, conv_id, conv, meta, approve, request_id, response_helper)
        else:
            self._turn(client, project, store, conv_id, conv, meta, request_id, response_helper)

    def _write(self, store: ConversationStore, conv_id: str, conv: dict, meta: dict, request_id) -> bool:
        """Write the outcome, unless the conversation moved on meanwhile (its
        pending marker names another request, or it was deleted): then the
        outcome is dropped rather than written over what the user did."""
        if not store.owned_by(conv_id, request_id):
            print(f'Conversation {conv_id} moved on; the outcome of request {request_id} is not written.')
            return False
        store.save(conv_id, conv, meta)
        return True

    def _turn(self, client, project, store, conv_id, conv, meta, request_id, response_helper) -> None:
        transcript = conv['messages']
        if not transcript or transcript[-1].get('role') != 'user':
            response_helper.error('The conversation has no message to answer')
            return
        model = self.cfg.model
        # Every progress event carries the reply text written so far, so a
        # watcher (or one that rejoins) shows it as it grows.
        state = {'pct': 5, 'text': ''}

        def send(msg):
            response_helper.progress(state['pct'], msg, text=state['text'])

        def on_progress(pct, msg):
            state['pct'] = max(state['pct'], pct)
            send(msg)

        def on_text(text):
            state['text'] = text
            send('Writing…')

        def cancelled() -> bool:
            return bool(getattr(response_helper, 'cancelled', False))

        ws = Workspace(client, project, on_progress=send)
        if self.web_cfg is not None:
            ws.web = session_for(self.web_cfg, transcript)
        try:
            turn = run_turn(self.cfg, ws, build_system_prompt(project, web=ws.web is not None),
                            transcript, on_progress, cancelled=cancelled, on_text=on_text)
        except TurnCancelled:
            # The user's message leaves the model transcript (a retry must not
            # send it twice) and stays on screen with what happened.
            stopped = {'messages': transcript[:-1], 'display': conv['display'] + [error_item('Stopped.', stopped=True)]}
            self._write(store, conv_id, stopped, build_meta(meta, conv_id, stopped, self.service_id, model), request_id)
            response_helper.complete({'kind': 'stopped'})
            return
        except Exception as e:  # noqa: BLE001 - whatever failed, the record must say so
            traceback.print_exc()
            failed = {'messages': transcript[:-1],
                      'display': conv['display'] + [error_item(f'The assistant could not answer: {e}')]}
            self._write(store, conv_id, failed, build_meta(meta, conv_id, failed, self.service_id, model), request_id)
            response_helper.error(str(e))
            return
        item = assistant_item(turn.text, ws.plan_payload(), resolve_citations(ws, turn.text),
                              turn.steps, turn.summary, model)
        done = prune({'messages': transcript + turn.messages, 'display': conv['display'] + [item]})
        self._write(store, conv_id, done, build_meta(meta, conv_id, done, self.service_id, model), request_id)
        response_helper.progress(100, 'Done')
        response_helper.complete({'kind': 'turn', 'message': turn.text, 'plan': item['plan'],
                                  'citations': item['citations'], 'steps': turn.steps, 'steps_summary': turn.summary})

    def _apply(self, client, project, store, conv_id, conv, meta, approve: dict, request_id, response_helper) -> None:
        model = self.cfg.model
        plan_id = approve.get('plan_id')
        index, item = find_plan(conv, plan_id) if plan_id else (-1, None)
        if item is None:
            response_helper.error('No such plan in this conversation')
            return
        plan = item['plan']

        def settled(next_conv=None):
            """Clear the pending marker (with the conversation as it stands, or
            as given) so the card is decidable again."""
            c = next_conv or conv
            self._write(store, conv_id, c, build_meta(meta, conv_id, c, self.service_id, model), request_id)

        # A second approval of the same plan (a retried request, a double
        # click) does not write it twice.
        if item.get('status') == 'applied' or (plan_id in self._applied_plans):
            settled()
            response_helper.complete({'kind': 'applied', 'applied': 0, 'counts': [], 'duplicate': True,
                                      'message': 'This plan was already applied; nothing was written again.'})
            return
        if item.get('status') == 'discarded':
            settled()
            response_helper.error('The plan was discarded')
            return
        ops = plan.get('ops') or []
        if not ops:
            settled()
            response_helper.error('Nothing to apply')
            return
        contributor = approve.get('contributed_by') or None
        as_human = bool(approve.get('as_human'))
        stamp_mode = 'contributed' if contributor else 'human' if as_human else 'verified'
        stale = stale_documents(client, plan.get('documents') or [])
        if stale:
            settled()
            response_helper.error('Nothing was written: ' + '; '.join(stale)
                                  + '. The plan was made against an older state of the data (its character '
                                  'offsets and ids may no longer fit). Ask the assistant to plan again.')
            return
        response_helper.progress(10, 'Applying changes…')
        summary = plan.get('summary') or summarize(ops)
        try:
            counts = execute_plan(client, ops, source=service_source(self.service_id), label=f'Assistant: {summary}',
                                  project=project, stamp_mode=stamp_mode, contributor=contributor)
        except PlanError as e:
            if e.applied:
                self._remember_applied(plan_id)
            settled()
            response_helper.error(f'The plan failed after {e.applied} of {e.total} changes were applied: {e}. '
                                  + ('Those changes stand (see recent_changes); the rest were not applied.' if e.applied
                                     else 'Nothing was written.'))
            return
        except ValueError as e:
            settled()
            response_helper.error(f'The plan was rejected before anything was written: {e}')
            return
        self._remember_applied(plan_id)
        notes = counts.pop('notes', [])
        note = f'(note) The plan was approved and applied: {summary}.' + (' ' + '; '.join(notes) if notes else '')
        settled(settle_plan(conv, index, 'applied', note, as_human=as_human))
        response_helper.progress(100, 'Done')
        response_helper.complete({
            'kind': 'applied', 'applied': sum(counts.values()),
            'counts': [{'kind': k, 'count': n} for k, n in counts.items()],
            'message': f'Applied {summarize(ops)}.' + (' ' + '; '.join(notes) if notes else ''),
        })

    def _remember_applied(self, plan_id: str) -> None:
        self._applied_plans.append(plan_id)
        del self._applied_plans[:-500]


def check_hint(backend) -> str:
    """What to look at when a provider will not answer."""
    if backend.needs_base:
        return f'Check --web-search-url ({backend.note}).'
    return f'Check --web-search-key (or {backend.env_key}).'


def build_web_config(args) -> 'WebConfig | None':
    """The web configuration, or None when the operator did not ask for one.
    What a provider needs is the provider's own business (see web.BACKENDS):
    a hosted one wants a key, a self-hosted one wants a URL and no key.

    The Plaid server's own host is denied to any fetch: aimed there, this
    service would be reaching back into the network it is trusted inside."""
    if not args.web_search:
        return None
    backend = BACKENDS[args.web_search]
    key = args.web_search_key or (os.environ.get(backend.env_key) if backend.env_key else '') or ''
    if backend.env_key and not key:
        print(f'--web-search {backend.name} needs a key: --web-search-key or '
              f'{backend.env_key} in the environment.')
        raise SystemExit(1)
    base = (args.web_search_url or '').strip()
    if backend.needs_base and not base:
        print(f'--web-search {backend.name} needs --web-search-url ({backend.note}).')
        raise SystemExit(1)
    host = urlsplit(args.url).hostname
    return WebConfig(backend=backend.name, api_key=key, api_base=base,
                     deny_hosts=tuple(h for h in (host,) if h))


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
