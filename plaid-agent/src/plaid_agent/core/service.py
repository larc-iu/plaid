"""The assistant as a Plaid service (task ``assist``, delegating).

One request = one chat turn, or one plan approval, on a conversation that
lives in the requester's private key/value store on the Plaid server (see
:mod:`.conversation`). The browser appends the user's message to the record
and marks the conversation pending before submitting. The service loads the
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
    where            optional: {kind, id} for what the user is looking at, sent fresh
                     with EVERY turn because the panel outlives the screen it was
                     opened from and the user walks between documents while it stays
                     open. It is a DEFAULT, not a fence: the model is told what is
                     open so an unqualified question is about that, and every tool
                     that reads the rest of the project stays available.
                     A `kind` of "document" is the case every app has. An app with
                     other kinds of screen answers for them in `place`, and says how
                     to treat one in `focus_note_for`.
    approve          instead of a turn: {plan_id, as_human, contributed_by} for a plan
                     in the conversation the user approved (as_human: record the writes
                     as human-made instead of verified machine-made. Contributed_by: the
                     approver's user id when they are a contributor, whose approval records
                     the writes as their own unreviewed work). The plan's ops and the
                     document versions it was made against come from the record. A plan
                     whose documents changed since is refused.

Result data:
    {kind: 'turn', message, plan: {id, summary, ...} | null, citations, steps, steps_summary}
    {kind: 'stopped'}                       the requester cancelled the turn
    {kind: 'applied', applied: n, counts: [{kind, count}], message}
The record is the full outcome: a browser re-reads it on any of these.

ALL OF THAT IS THE SAME IN EVERY APP. What an app fills in is what its
assistant knows about: the project it loads, the workspace and tools a turn
runs against, the prompt, how a citation resolves, and how a plan is applied.
Those are the methods marked below, and a subclass that answers them is a
working assistant service.
"""

import argparse
import os
import re
import time
import traceback
from typing import Any, Dict, List, Optional
from urllib.parse import urlsplit

from plaid_client import BaseService, TASKS, service_source

from .agent import ModelConfig, Toolkit, TurnCancelled, context_window, ping_model, run_turn
from .conversation import (ConversationStore, MissingConversation, assistant_item, build_meta, error_item,
                           find_plan, prune, settle_plan)
from .plan import PlanError
from .web import BACKENDS, WebConfig, session_for, ping as ping_search


class BaseAssistantService(BaseService):
    """One app's assistant. Fill in the class attributes and the hooks."""

    CONCURRENT = True  # turns wait on a remote model; do not serialize users

    # --- what the app is ---------------------------------------------------------
    APP = None          # the app's short tag: the service-id prefix and the record key prefix
    APP_LABEL = None    # the display name, replaced per model in setup()
    DESCRIPTION = None  # the one line the service list shows
    SUMMARY = None      # the Markdown the tab shows when a user asks what this is
    # A real search at startup, so a bad key is the operator's problem now.
    # Something the app's users would plausibly look up.
    PING_QUERY = 'linguistic annotation'

    def __init__(self):
        for attr in ('APP', 'APP_LABEL', 'DESCRIPTION', 'SUMMARY'):
            if not getattr(self, attr):
                raise NotImplementedError(f'{type(self).__name__} must set {attr}')
        super().__init__(
            f'{self.APP}:assist', self.APP_LABEL,  # both replaced per model in setup()
            self.DESCRIPTION,
            tasks=[TASKS.ASSIST], summary=self.SUMMARY, delegation=True)
        self.cfg: Optional[ModelConfig] = None
        self.web_cfg: Optional[WebConfig] = None
        self.kit: Optional[Toolkit] = None
        # Plan ids already applied by this process, so a second approval of
        # the same plan (a retried request after a client timeout, a double
        # click) does not write it twice. Bounded, most recent last.
        self._applied_plans: list = []

    # --- what the app knows ------------------------------------------------------

    def toolkit(self) -> Toolkit:
        """The app's tools and its words for them. Built once, at setup."""
        raise NotImplementedError

    def load_project(self, client, project_id):
        """The app's model of the project. Raises ValueError with a message
        for the user when the project is not one this assistant can serve."""
        raise NotImplementedError

    def make_workspace(self, client, project, on_progress):
        """What a turn runs against: the app's own workspace, which holds the
        plan as the model builds it (``ops``, ``plan_payload()``) and takes a
        web session on ``web`` when the operator configured one."""
        raise NotImplementedError

    def system_prompt(self, project, web: bool) -> str:
        """What the model is told before the conversation."""
        raise NotImplementedError

    #: How this app writes a reference to a place in a document, for the focus
    #: note. The app's own grammar, so the app states it.
    reference_shape = 'a bare reference'

    def place(self, ws, where: Optional[dict]) -> Optional[tuple]:
        """``(noun, name)`` for what the user has open, or None.

        The noun is the app's own word for the kind of thing, and it is written
        into the model's transcript, so the app answers for every kind but a
        document. Every app has documents, so that one is answered here.
        """
        where = where or {}
        if where.get('kind') != 'document':
            return None
        name = self.document_name(ws, where.get('id'))
        return ('document', name) if name else None

    def focus_note_for(self, ws, request_data: dict) -> Optional[str]:
        """The line that tells the model what the user is looking at, or None.

        A document is the case every app has, so it lives here. An app that also
        docks the assistant beside something else overrides this, reads the
        ``where`` kind it owns, and calls back here for documents. That is what
        keeps this file naming no app of its own.
        """
        found = self.place(ws, request_data.get('where'))
        if not found or found[0] != 'document':
            return None
        return focus_note(found[1], self.reference_shape)

    def document_name(self, ws, document_id: str) -> Optional[str]:
        """What to call the document the user has open, in the language the
        tools use. An app whose assistant has no document view keeps the
        default and the focus note is left off."""
        return None

    def citations(self, ws, text: str) -> List[Dict[str, Any]]:
        """The references in a reply, resolved to whatever the tab shows as a
        card. An app with nothing to cite keeps the default."""
        return []

    def execute_plan(self, client, ops: List[Dict[str, Any]], *, source: str, label: str, project,
                     stamp_mode: str, contributor: Optional[str]) -> Dict[str, int]:
        """Apply an approved plan. Per-kind counts of what was applied, plus
        ``notes`` for anything dropped. Raises
        :class:`plaid_agent.core.plan.PlanError` if a batch fails part-way."""
        raise NotImplementedError

    def summarize(self, ops: List[Dict[str, Any]]) -> str:
        """A plan in one phrase, for the audit label and the applied message."""
        raise NotImplementedError

    # --- the model and the web ---------------------------------------------------

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
                            help=f'Service id (default {self.APP}:assist:<model>). Several assistants can be '
                                 'online on one project as long as their ids differ; the Assistant tab '
                                 'offers a picker.')
        parser.add_argument('--service-name', default=None,
                            help=f'Display name (default "{self.APP_LABEL} (<model>)")')
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
        self.kit = self.toolkit()
        # One registration per model by default, so an operator can run several
        # assistants side by side (different models, or the same model with a
        # different base) and users pick one in the tab. Two instances with the
        # SAME id on a project still collide (409): that is the dedupe guard.
        slug = re.sub(r'[^A-Za-z0-9._-]+', '-', self.cfg.model).strip('-')
        self.service_id = args.service_id or f'{self.APP}:assist:{slug}'
        self.service_name = args.service_name or f'{self.APP_LABEL} ({self.cfg.model})'
        # Advertised so the UI can say which model answers, and so it can tell
        # its OWN assistant from another app's: a conversation's record is
        # namespaced by app, so an app that offered a foreign assistant sent
        # every turn to a service that could not find the conversation.
        self.extras['model'] = self.cfg.model
        self.extras['app'] = self.APP
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
                print(f'  {ping_search(self.web_cfg, self.PING_QUERY)} results for a test search.')
            except Exception as e:  # noqa: BLE001 - the provider's own complaint is what helps
                print(f'  The search provider did not answer: {e}')
                print(f'  {check_hint(BACKENDS[self.web_cfg.backend])}')
                raise SystemExit(1)

    # --- the request -------------------------------------------------------------

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
        store = ConversationStore(client, user_id, project_id, self.APP)
        try:
            conv, meta = store.load(conv_id)
        except MissingConversation:
            # A conversation lives under its app's own key prefix, so this is
            # also what a turn from ANOTHER app's screen looks like.
            response_helper.error(
                f'No such conversation in {self.APP}. A conversation belongs to the app it was '
                f'started in, and this is the {self.APP} assistant.')
            return
        try:
            project = self.load_project(client, project_id)
        except ValueError as e:
            response_helper.error(str(e))
            return
        request_id = getattr(response_helper, 'request_id', None)
        approve = request_data.get('approve')
        if approve:
            self._apply(client, project, store, conv_id, conv, meta, approve, request_id, response_helper)
        else:
            self._turn(client, project, store, conv_id, conv, meta, request_id, response_helper,
                       request_data)

    def _write(self, store: ConversationStore, conv_id: str, conv: dict, meta: dict, request_id) -> bool:
        """Write the outcome, unless the conversation moved on meanwhile (its
        pending marker names another request, or it was deleted): then the
        outcome is dropped rather than written over what the user did."""
        if not store.owned_by(conv_id, request_id):
            print(f'Conversation {conv_id} moved on; the outcome of request {request_id} is not written.')
            return False
        store.save(conv_id, conv, meta)
        return True

    def _turn(self, client, project, store, conv_id, conv, meta, request_id, response_helper,
              request_data: Optional[dict] = None) -> None:
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

        ws = self.make_workspace(client, project, send)
        # Where this question was asked from, stamped onto the question itself.
        # The panel outlives the screen it was opened from, so one thread can
        # hold questions asked from several places, and the system note below
        # only ever describes the LAST of them. Without the stamp the model
        # reads turn 1's "this sentence" as being about turn 5's document.
        transcript = stamped(transcript, self.place(ws, (request_data or {}).get('where')))
        if self.web_cfg is not None:
            ws.web = session_for(self.web_cfg, transcript)
        system = self.system_prompt(project, web=ws.web is not None)
        # Asked from inside a screen that is about one thing: say which, so an
        # unqualified question is about it. Nothing is taken away.
        focus = self.focus_note_for(ws, request_data or {})
        if focus:
            system = f'{system}\n\n{focus}'
        try:
            turn = run_turn(self.cfg, self.kit, ws, system,
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
        # The window goes on the item beside the counts: the reader is told how
        # full the thread is, and what it is full OF changes when the operator
        # points the service at a different model.
        usage = dict(turn.usage) if turn.usage else None
        if usage:
            window = context_window(model)
            if window:
                usage['window'] = window
        item = assistant_item(turn.text, ws.plan_payload(), self.citations(ws, turn.text),
                              turn.steps, turn.summary, model, usage)
        done = prune({'messages': transcript + turn.messages, 'display': conv['display'] + [item]})
        try:
            self._write(store, conv_id, done, build_meta(meta, conv_id, done, self.service_id, model), request_id)
        except Exception as e:  # noqa: BLE001 - the answer is in hand; say so rather than lose it
            # This write is the LAST thing a turn does, and it sat outside the
            # try that catches everything else, so a refused save (too large,
            # a network blip) threw here: the finished reply never reached the
            # record and the pending marker was never cleared, which leaves
            # the card undecidable. The answer is already computed, so hand it
            # over and say the record did not take it.
            traceback.print_exc()
            response_helper.error(
                f'The answer is ready but the conversation could not be saved: {e}. '
                f'It is below, and this turn is not in the record.')
            response_helper.complete({'kind': 'turn', 'message': turn.text, 'plan': None,
                                      'citations': item['citations'], 'steps': turn.steps,
                                      'steps_summary': turn.summary})
            return
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
            as given) so the card is decidable again. False when the record
            refused the write, which `_write` reports rather than raising."""
            c = next_conv or conv
            return self._write(store, conv_id, c,
                               build_meta(meta, conv_id, c, self.service_id, model), request_id)

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
        summary = plan.get('summary') or self.summarize(ops)
        try:
            counts = self.execute_plan(client, ops, source=service_source(self.service_id),
                                       label=f'Assistant: {summary}', project=project,
                                       stamp_mode=stamp_mode, contributor=contributor)
        except PlanError as e:
            if e.applied:
                self._remember_applied(plan_id)
            settled()
            # No fraction: `applied` counts batch calls and `total` counts plan
            # ops, and one op can be several calls, so the two together read as
            # "failed after 10 of 3 changes were applied".
            response_helper.error(
                f'The plan failed part-way: {e}. '
                + ('Some of its changes were written before it failed and they stand '
                   '(see recent_changes); the rest were not applied.' if e.applied
                   else 'Nothing was written.'))
            return
        except ValueError as e:
            settled()
            response_helper.error(f'The plan was rejected before anything was written: {e}')
            return
        self._remember_applied(plan_id)
        notes = counts.pop('notes', [])
        note = f'(note) The plan was approved and applied: {summary}.' + (' ' + '; '.join(notes) if notes else '')
        # `_write` returns False without raising when the conversation has moved
        # on, so the 'applied' status can fail to reach the record while the
        # writes have already happened. The only other guard against a second
        # apply is `_applied_plans`, which lives in this process, so a restart
        # in between left a card still offering Approve over work already done.
        # Say so rather than leave it looking undecided.
        if not settled(settle_plan(conv, index, 'applied', note, as_human=as_human)):
            response_helper.error(
                'The changes were applied, but the conversation could not be marked as such: '
                'someone else wrote to it first. Do not approve this plan again, and check '
                'recent_changes for what landed.')
            return
        response_helper.progress(100, 'Done')
        response_helper.complete({
            'kind': 'applied', 'applied': sum(counts.values()),
            'counts': [{'kind': k, 'count': n} for k, n in counts.items()],
            'message': f'Applied {self.summarize(ops)}.' + (' ' + '; '.join(notes) if notes else ''),
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

# The stamp that records which place a question was asked from, written onto
# the question and kept in the transcript for good.
#
# Read back as well as written: a thread that has not moved must not repeat the
# same line on every turn, which is noise the model has to re-read and which
# says nothing. Stamping only the CHANGES also gives the model the one fact
# that matters in a thread that wandered, which is that it wandered.
_STAMP = '[Asked from the {noun} "{name}"]'
_STAMP_RE = re.compile(r'^\[Asked from the ([^"\]]+) "(.*)"\]')


def _stamp_on(content) -> Optional[tuple]:
    """The (noun, name) a message was stamped with, or None."""
    if not isinstance(content, str):
        return None
    found = _STAMP_RE.match(content)
    return (found.group(1).strip(), found.group(2)) if found else None


def stamped(transcript: List[Dict[str, Any]], place: Optional[tuple]) -> List[Dict[str, Any]]:
    """The transcript with its last message stamped, if the place has changed.

    The scan looks back over the earlier messages for the last stamp, so the
    decision needs nothing carried between requests: the transcript is the
    record of where the user has been.
    """
    if not place or not transcript or transcript[-1].get('role') != 'user':
        return transcript
    for m in reversed(transcript[:-1]):
        was = _stamp_on(m.get('content')) if m.get('role') == 'user' else None
        if was:
            if was == place:
                return transcript
            break
    last = transcript[-1]
    note = _STAMP.format(noun=place[0], name=place[1])
    return transcript[:-1] + [{**last, 'content': f'{note}\n\n{last.get("content") or ""}'}]


# What the model is told when the user asks from inside a document.
#
# The default has to be stated much more firmly than the escape from it. An
# earlier version ended by inviting the model to read anything else in the
# project, and that is what it did: asked which sentence "here" had the most
# words, it listed the project, searched the whole corpus, and read a document
# the user was not looking at. So the escape is now conditional and last, and
# reading the open document is an instruction rather than an inference.
def focus_note(name: str, refs: str = 'a bare reference') -> str:
    """What to add to the prompt when the user has one document open.

    ``refs`` is how the app writes a reference to a place in a document. That
    is the app's own grammar and not this file's, and the apps do not agree on
    it, so the app states it. One app's shape was hardcoded here, in a file
    whose whole point is to name no app.
    """
    return (f'The user has "{name}" open and is asking about what is in front of them. Unless they '
            f'name another document, this question is about "{name}": read it first, and take '
            f'{refs} as a place in it. Look at other documents only when the question is '
            f'explicitly about the corpus as a whole or asks you to compare.')
