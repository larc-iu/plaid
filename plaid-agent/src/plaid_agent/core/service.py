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
    (projects)       not a request field: the other projects the user added to the
                     conversation ride on their message's display item as
                     ``projects: [{id, name}]``, and the turn may READ those as well
                     (see core/reach.py). Plans stay in project_id.
    where            optional: {kind, id} for what the user is looking at, sent fresh
                     with EVERY turn because the panel outlives the screen it was
                     opened from and the user walks between documents while it stays
                     open. It is a DEFAULT, not a fence: the model is told what is
                     open so an unqualified question is about that, and every tool
                     that reads the rest of the project stays available.
                     An app answers `place` for the kinds of screen it docks the
                     assistant beside, with what to call one and what the model
                     should be told about it.
    approve          instead of a turn: {plan_id, as_human} for a plan in the
                     conversation the user approved (as_human: record the writes as
                     human-made instead of verified machine-made). When the project
                     reviews the approver's work (its plaid.review lists, read at
                     approval), the writes are recorded as their own unreviewed work.
                     A contributed_by the page sends is not read. The plan's ops and the
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
import contextlib
import hashlib
import importlib.metadata
import json
import os
import re
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple
from urllib.parse import urlsplit

from plaid_client import BaseService, DocumentLockLost, ServiceCancelled, TASKS, service_source
from plaid_client.http import PlaidAPIError
from plaid_client.provenance import is_reviewed
from plaid_client.service import requester_message
from plaid_client.workflows.llm import add_timeout_argument, provider_secrets

from . import filetools
from . import prompt as shared_prompt
from .guidelines import in_reading_order
from .limits import MAX_PROJECTS, TRANSCRIPT_WINDOW_SHARE
from .reach import Reach
from .agent import (ModelConfig, ModelTooSlow, PING_TIMEOUT_S, Toolkit, TurnCancelled, TurnFailed, turn_trace,
                    context_window, model_failure_line, ping_model, run_turn, token_counter)
from .files import Attachments, FileKeeper
from .garble import seed
from .guidelines import in_context as guidelines_in_context
from .conversation import (ConversationStore, MissingConversation, assistant_item, build_meta, error_item,
                           find_plan, partial_note, partial_tally, pending_kept, plan_settling,
                           proposed_changes, prune, record_budget, turn_ending)
from . import rules
from .opkind import ROW
from .plan import (EXPANSION, HELD_FROM, WRITING, DocumentsBusy, Expansion, ExpansionUnreadable, PlanError,
                   PlanMovedOn, PlanOutOfDate, RecordFull, ScopeMoved, documents_to_lock, drawable, expanding,
                   forget_held, holding, outcome_unknown, writing)
from .conversation import WROTE
from .web import BACKENDS, WebConfig, session_for, ping as ping_search


def _agent_release() -> str:
    try:
        return importlib.metadata.version('larc-plaid-agent')
    except importlib.metadata.PackageNotFoundError:
        return '0.0.0'  # a checkout on the path, not an installed release


#: The plaid-agent release this process runs (``0.0.0`` in a checkout).
AGENT_VERSION = _agent_release()


def agent_sources(cls) -> List[List[str]]:
    """``[path, sha256]`` of every Python file of the harness
    (``plaid_agent/core``) and of the app package the class ``cls`` is written
    in (``plaid_agent/<app>``), path relative to ``plaid_agent`` with ``/``.
    The package is found from the class's file, not its module name, which is
    ``__main__`` when the service runs with ``python -m``. What a model is
    told is not only the prompt template: the guidelines paragraph, a
    project's shape lines, the note on the other projects a turn may read, the
    notes a turn adds and every tool's answer are written by this code too.
    Line endings are read as the repository stores them, so a CRLF checkout
    hashes like every other."""
    root = Path(__file__).resolve().parent.parent
    dirs = ['core']
    # Through the class's own functions, as plaid_client's BaseService finds
    # a service's file: the module a script runs as may not be in sys.modules.
    code = next((v.__code__ for v in vars(cls).values() if hasattr(v, '__code__')), None)
    own = Path(code.co_filename).resolve() if code is not None else None
    if own is not None and own.parent.parent == root and own.parent.name != 'core':
        dirs.append(own.parent.name)
    out = []
    for d in dirs:
        for f in sorted((root / d).rglob('*.py')):
            digest = hashlib.sha256(f.read_bytes().replace(b'\r\n', b'\n')).hexdigest()
            out.append([f.relative_to(root).as_posix(), digest])
    return out


def agent_version(texts: List[str], tools: List[Dict[str, Any]],
                  sources: Sequence[Sequence[str]] = ()) -> str:
    """An assistant's version, as each turn records it and an applied plan
    stamps it: the release and the first 8 hex digits of the SHA-256 of the
    system prompt template (before a project fills it), every tool schema and
    the code that writes everything else the model reads (``sources``, see
    :func:`agent_sources`), ``'0.0.0+3fa9c2d1'``. It changes whenever what
    the model can be told does. See the README, "Model and prompt version"."""
    text = json.dumps([list(texts), list(tools), [list(s) for s in sources]],
                      sort_keys=True, ensure_ascii=False)
    return f'{AGENT_VERSION}+{hashlib.sha256(text.encode("utf-8")).hexdigest()[:8]}'


def _held(response_helper):
    """The client's hold on cancellation (``ResponseHelper.critical``), or
    nothing for a helper that has none: a progress line sent inside it does
    not raise, and the stop is seen at the next checkpoint after it."""
    hold = getattr(response_helper, 'critical', None)
    return hold() if callable(hold) else contextlib.nullcontext()


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
        # What each turn records beside the model, and an applied plan stamps.
        self.version = agent_version(*self.prompt_template(), agent_sources(type(self)))
        self.cfg: Optional[ModelConfig] = None
        self.web_cfg: Optional[WebConfig] = None
        self.kit: Optional[Toolkit] = None
        # Plan ids already applied by this process, so a second approval of
        # the same plan (a retried request after a client timeout, a double
        # click) does not write it twice. Bounded, most recent last.
        #: plan id -> how this process settled it ({'status', 'note', 'fields'},
        #: status None while it is not known yet), newest last.
        self._applied_plans: Dict[str, Dict[str, Any]] = {}

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

    def prompt_template(self) -> Tuple[List[str], List[Dict[str, Any]]]:
        """The system prompt's texts before a project fills them in (every
        section, whether or not a turn includes it), and every tool schema the
        model can be offered. The assistant's version is a hash of them."""
        raise NotImplementedError

    def project_brief(self, project) -> str:
        """Another project's shape, in the lines the app's own prompt states
        its project's shape in, for a turn that may read it. The harness adds
        its name and its guideline titles, and cuts it to a budget."""
        raise NotImplementedError

    #: How this app writes a reference to a place in a document, for the focus
    #: note. The app's own grammar, so the app states it.
    reference_shape = 'a bare reference'

    #: ``(target keys, value keys, other keys)``: the keys of this app's plan
    #: ops that name what a change lands on, most specific first, those that
    #: carry the value it proposes, and, for each kind that joins two things,
    #: the key naming the second one (a relation's other end). What a plan
    #: proposed is kept by them (``core.conversation.proposed_changes``), since
    #: a plan that is discarded or refused writes nothing the audit log could show.
    proposed_keys: Tuple[Tuple[str, ...], Tuple[str, ...], Dict[str, str]] = ((), (), {})

    def place(self, ws, where: Optional[dict]) -> Optional[tuple]:
        """``(noun, name, note)`` for what the user has open, or None.

        One hook, not three. It used to be `place` for the noun and the name,
        `focus_note_for` for the line in the prompt, and `document_name` for
        what to call a document, each calling the next, and only one app
        overrode the first two. Answering all three questions at once is what
        an app actually knows: it is looking at one `where` and it knows what
        that is, what to call it, and what the model should be told about it.

        The noun is the app's own word for the kind of thing, and it is written
        into the model's transcript in front of the user's question, so it has
        to be the word the app puts on screen. The note is added to the system
        prompt. An app with no docked screens keeps the default and neither
        the stamp nor the note appears.

        The default answers for the case every app has, a document, and names
        it the way the tools take it back: two documents may share a name and
        ``resolve_document_id`` refuses an ambiguous one, so those are named by
        id instead. An app that docks its assistant beside anything else
        answers for that too and falls back here.
        """
        where = where or {}
        if where.get('kind') != 'document':
            return None
        document_id = where.get('id')
        names = [d.get('name') or '' for d in ws.documents() if d['id'] == document_id]
        if not names:
            return None
        name = names[0]
        clashes = sum(1 for d in ws.documents() if (d.get('name') or '').lower() == name.lower())
        return self.document_place(name if clashes == 1 else document_id)

    def document_place(self, name: Optional[str]) -> Optional[tuple]:
        """The triple for a document, given what the app calls it. The name is
        the app's, because it has to be a name a tool will accept back."""
        return ('document', name, focus_note(name, self.reference_shape)) if name else None

    def citations(self, ws, text: str) -> List[Dict[str, Any]]:
        """The references in a reply, resolved to whatever the tab shows as a
        card. An app with nothing to cite keeps the default."""
        return []

    def execute_plan(self, client, ops: List[Dict[str, Any]], *, source: str, label: str, project,
                     stamp_mode: str, contributor: Optional[str],
                     requester: Optional[str] = None,
                     detail: Optional[Dict[str, Any]] = None,
                     seed: Optional[str] = None) -> Dict[str, int]:
        """Apply an approved plan. Per-kind counts of what was applied, plus
        ``notes`` for anything dropped. ``requester`` is the user the plan
        acts for, for a change the plan works out again at approval.
        ``detail`` is the provDetail of what the plan writes (the model and
        version of the turn that proposed it, see ``core.plan.Stamps``).
        ``seed`` is the plan's id, which the ids of the rows it creates are
        drawn from (``core.plan.Minter``). Raises
        :class:`plaid_agent.core.plan.PlanError` if a batch fails part-way."""
        raise NotImplementedError

    def summarize(self, ops: List[Dict[str, Any]]) -> str:
        """A plan in one phrase, for the audit label and the applied message."""
        raise NotImplementedError

    def partial_label(self, ops: List[Dict[str, Any]], written: List[int], summary: str) -> str:
        """The History label of a plan that stopped partway: the changes
        written in full (card rows ``written``), or, when none was, the plan
        it was part of."""
        done = [ops[i] for i in written if 0 <= i < len(ops)]
        if done:
            return f'Assistant, partly applied: {self.summarize(done)}'
        return f'Assistant, partly applied: part of {summary}'

    def documents_to_lock(self, ops: List[Dict[str, Any]], documents: List[Dict[str, Any]]) -> List[str]:
        """The documents an approval holds locked from its staleness check to
        its last write: every one the plan writes. An app whose plan hands a
        document to another service, which locks it itself, leaves that one
        out."""
        return documents_to_lock(ops, documents)

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
        add_timeout_argument(parser)
        parser.add_argument('--context-window', type=_positive_int, default=None, metavar='TOKENS',
                            help='How many tokens the model can be sent. The conversation gauge shows '
                                 'how full a conversation is against it and warns near the limit. '
                                 'Without it the model library\'s figure is used, and a model it does '
                                 'not know shows a count with no percentage.')
        parser.add_argument('--no-stream', action='store_true',
                            help='Do not stream the reply as it is written (for a provider that misbehaves '
                                 'under streaming); the reply then arrives whole')
        parser.add_argument('--service-id', default=None,
                            help=f'Service id (default {self.APP}:assist:<model>). Several assistants can be '
                                 'online on one project as long as their ids differ; the Assistant tab '
                                 'offers a picker.')
        parser.add_argument('--service-name', default=None,
                            help=f'Display name (default "{self.APP_LABEL} (<model>)")')
        parser.add_argument('--disclosure', default=None, metavar='TEXT',
                            help='What users should know before using this assistant, such as where the '
                                 'model runs and where what they send it goes. Shown in the Assistant '
                                 'panel as given, as coming from whoever runs the assistant')
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
                               stream=not getattr(args, 'no_stream', False), timeout=args.timeout,
                               context_window=getattr(args, 'context_window', None))
        self.kit = self.toolkit()
        # A provider quotes the key it refused back in its own error text.
        self.REQUEST_SECRETS = provider_secrets(args.api_key)
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
        # And which version of it, for the conversation's sidebar entry, which
        # the browser rewrites too.
        self.extras['version'] = self.version
        self.extras['app'] = self.APP
        # How many projects one conversation may read, its own included. The
        # browser offers to add projects only when this is here, and stops at
        # it: the one number, so the control and the service cannot disagree.
        self.extras['max_projects'] = MAX_PROJECTS
        # The operator's own statement for users (`--disclosure`): Plaid cannot
        # know where a given site's model runs or where what is sent to it
        # goes, so whoever runs the assistant says, and the panel shows it.
        disclosure = (getattr(args, 'disclosure', None) or '').strip()
        if disclosure:
            self.extras['disclosure'] = disclosure
        print(f'Model: {self.cfg.model}' + (f' via {self.cfg.api_base}' if self.cfg.api_base else ''))
        window = context_window(self.cfg.model, self.cfg.context_window)
        if self.cfg.context_window:
            print(f'  Context window: {window} tokens (--context-window).')
        elif window:
            print(f'  Context window: {window} tokens (the model library\'s figure).')
        else:
            print('  Context window: unknown, so the conversation gauge shows a count with no '
                  'percentage. State it with --context-window.')
        # Ask the model one question before registering. A service that cannot
        # reach its model has nothing to offer, and the operator is here NOW.
        started = time.monotonic()
        try:
            ping_model(self.cfg)
        except ModelTooSlow:
            # A timeout is not evidence of a mistake. Refusing to start on one
            # takes an assistant off the air for a provider that is merely
            # loading a model, and the operator cannot tell that from a typo
            # because the message named the same three things either way.
            print(f'  No answer within {PING_TIMEOUT_S}s. Serving anyway: a slow provider is '
                  f'not a misconfigured one, and the first question will wait for it.')
        except Exception as e:  # noqa: BLE001 - whatever the provider says, the operator needs to read it
            print(f'  The model did not answer: {e}')
            print('  Check --model (a litellm model string), --api-base, and the provider key '
                  '(--api-key or the provider\'s environment variable).')
            raise SystemExit(1)
        else:
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

    def open_project(self, client, project_id: str):
        """A project other than the conversation's own, loaded for a turn to
        read, or raises. Read with the requester's own client, so the server
        checks the user's own role in it, and opened only where this same
        assistant is online: an operator who kept a model off a project keeps
        that project's text away from the model."""
        served = client.messages.discover_services(project_id) or []
        if not any(s.get('service_id') == self.service_id and s.get('online') is not False
                   for s in served if isinstance(s, dict)):
            raise LookupError(f'{self.service_id} is not online in project {project_id}')
        return self.load_project(client, project_id)

    def open_reach(self, client, ws, joined, token_reaches) -> Optional[Reach]:
        """The other projects this turn may read, or None when the user added
        none. ``joined`` is what their message carries, ``token_reaches`` the
        projects the requester's token is scoped to (``delegated_projects``)."""
        if not joined:
            return None
        reach = Reach(ws, joined, token_reaches, lambda pid: self.open_project(client, pid),
                      lambda project: self.make_workspace(client, project, ws.on_progress))
        # A list naming only this project, or nothing usable, adds no project
        # and refuses none: the turn is a one-project turn, as if it were empty.
        if not reach.others and not reach.unavailable:
            ws.reach = None
            return None
        return reach

    def other_projects_note(self, reach: Reach) -> str:
        """The paragraph of the system prompt about the other projects."""
        labels = reach.labels()
        briefs = [shared_prompt.project_brief(
                      label, self.project_brief(p),
                      [g.title for g in in_reading_order(getattr(p, 'guidelines', None) or [])])
                  for label, p in zip(labels[1:], reach.others)]
        return shared_prompt.other_projects(labels[0], briefs, [u['name'] for u in reach.unavailable])

    def _write(self, store: ConversationStore, conv_id: str, change, request_id, model: Optional[str] = None,
               pending: Optional[dict] = None) -> bool:
        """Write the outcome, ``change`` made on the record as it is stored
        (`ConversationStore.write`), and the sidebar entry with ``pending``
        (none: the request is over), unless the conversation moved on
        meanwhile (its pending marker names another request, a newer question
        follows, or it was deleted): then the outcome is dropped rather than
        written over what the user did."""
        model = model or self.cfg.model

        def meta_of(conv, prev):
            return build_meta(prev, conv_id, conv, self.service_id, model,
                              pending=pending_kept(prev, request_id, pending), version=self.version)
        if not store.write(conv_id, change, meta_of, request_id):
            print(f'Conversation {conv_id} moved on; the outcome of request {request_id} is not written.')
            return False
        return True

    def _turn(self, client, project, store, conv_id, conv, meta, request_id, response_helper,
              request_data: Optional[dict] = None) -> None:
        # How long the reply took, kept on it: the reader watches a clock while
        # it is written and wants the figure after (comparing it with doing the
        # same by hand).
        started = time.monotonic()
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

        # A stop asked for while the turn is being set up (the progress
        # lines sent while a document or another project loads are the
        # client's cancellation checkpoints) takes effect at the turn's first
        # check, where it is recorded with everything else a stop records.
        with _held(response_helper):
            ws = self.make_workspace(client, project, send)
            ws.requester_id = store.user_id
            # What the user attached to this conversation, and the note in front of
            # the message it came on. The note is written BEFORE the place stamp,
            # because that one has to stay at the very start of the message: it is
            # found again by matching there (see `stamped`).
            ws.files = Attachments.of(store, conv_id, conv['display'])
            # What read_url fetches is stored beside the conversation as a file.
            ws.keeper = FileKeeper(store, conv_id)
            last_user = next((d for d in reversed(conv['display'] or []) if d.get('kind') == 'user'), None)
            transcript = filetools.stamp(transcript, ws.files.named((last_user or {}).get('files') or []))
            # The other projects the user added to the conversation, read from their
            # own message and nowhere else, and only those the requester's token
            # reaches (the server scoped it to them). Stamped onto the question when the set
            # changed, after the files note and before the place stamp, which has to
            # stay first on the line.
            reach = self.open_reach(client, ws, (last_user or {}).get('projects'),
                                    (request_data or {}).get('delegated_projects') or ())
            transcript = projects_stamped(transcript, reach.labels() if reach else [project.name])
            # Where this question was asked from, stamped onto the question itself.
            # The panel outlives the screen it was opened from, so one thread can
            # hold questions asked from several places, and the system note below
            # only ever describes the LAST of them. Without the stamp the model
            # reads turn 1's "this sentence" as being about turn 5's document.
            where = self.place(ws, (request_data or {}).get('where'))
            transcript = stamped(transcript, where[:2] if where else None)
            if self.web_cfg is not None:
                ws.web = session_for(self.web_cfg, transcript)
            system = self.system_prompt(project, web=ws.web is not None)
            if reach is not None:
                system = f'{system}\n\n{self.other_projects_note(reach)}'
            # Asked from inside a screen that is about one thing: say which, so an
            # unqualified question is about it. Nothing is taken away.
            if where and where[2]:
                system = f'{system}\n\n{where[2]}'
            # What every call of the next turn sends besides the transcript, taken
            # off the window before the transcript is held to its share of it.
            overhead = (system, self.kit.tools_for(ws))
            # What the turn was given is text a value can be copied from (see
            # core.garble).
            seed(ws.seen, system, transcript, lambda tool, args: filetools.vouches(ws, tool, args))

        def fit(record):
            """The record held to its budget (`prune`)."""
            return prune(record, record_budget(client), self.transcript_budget(model, overhead))
        try:
            turn = run_turn(self.cfg, self.kit, ws, system,
                            transcript, on_progress, cancelled=cancelled, on_text=on_text)
        except (TurnCancelled, ServiceCancelled) as e:
            # Seen by the turn between its steps (TurnCancelled), or by the
            # client when a tool reported progress (ServiceCancelled, which
            # the client would otherwise end the request on, with nothing in
            # the record and the question left unanswered in the transcript).
            self._release(ws)
            ws.keeper.discard()
            # The user's message stays in the model transcript, as the turn
            # stamped it, so the next message ("go on", "I meant the second
            # one") is read with what it follows. Retry takes it off before
            # sending it again (`rewindForRetry`). What the turn did before it
            # stopped stays on the item, for the record.
            steps, calls = turn_trace(e)
            self._write(store, conv_id,
                        turn_ending(conv, transcript,
                                    error_item('Stopped.', stopped=True, model=model, version=self.version,
                                               service=self.service_id, steps=steps, calls=calls),
                                    fit=fit),
                        request_id, model)
            response_helper.complete({'kind': 'stopped'})
            return
        except Exception as e:  # noqa: BLE001 - whatever failed, the record must say so
            self._release(ws)
            ws.keeper.discard()
            traceback.print_exc()
            line = self.turn_failure_line(e)
            steps, calls = turn_trace(e)
            # The user's message stays in the model transcript whatever the
            # model call did, as on a stop.
            self._write(store, conv_id,
                        turn_ending(conv, transcript,
                                    error_item(line, model=model, version=self.version,
                                               service=self.service_id, steps=steps, calls=calls),
                                    fit=fit),
                        request_id, model)
            response_helper.error(line)
            return
        self._release(ws)
        # The window goes on the item beside the counts: the reader is told how
        # full the thread is, and what it is full OF changes when the operator
        # points the service at a different model.
        usage = dict(turn.usage) if turn.usage else None
        if usage:
            window = context_window(model, self.cfg.context_window)
            if window:
                usage['window'] = window
        plan = ws.plan_payload()
        if plan and reach is not None:
            # The project the plan writes in, which the card names wherever
            # the conversation reads other projects too (A4-CROSS-1).
            plan['project'] = reach.plan_project()
        if plan:
            plan['proposed'], plan['proposed_count'] = proposed_changes(plan.get('ops') or [],
                                                                        *self.proposed_keys)
        item = assistant_item(turn.text, plan, self.citations(ws, turn.text),
                              turn.steps, turn.summary, model, usage,
                              guidelines_in_context(getattr(project, 'guidelines', None) or []),
                              version=self.version, service=self.service_id)
        item['elapsed_ms'] = int((time.monotonic() - started) * 1000)
        if ws.keeper.refs:
            # The files this turn stored, which later turns read as the
            # conversation's own.
            item['files'] = [dict(r) for r in ws.keeper.refs]
        if reach is not None and reach.unavailable:
            item['unavailable_projects'] = [dict(u) for u in reach.unavailable]
        # A new plan replaces any still waiting: the model restates what still
        # applies in the plan it stages, so the older card is not left
        # approvable beside it.
        try:
            written = self._write(store, conv_id,
                                  turn_ending(conv, transcript, item, turn.messages,
                                              replaces=bool(item.get('plan')), fit=fit),
                                  request_id, model)
        except Exception as e:  # noqa: BLE001 - the answer is in hand; say so rather than lose it
            # This write is the LAST thing a turn does, and a refused save (too
            # large, a server error, a network blip) must not lose the answer
            # that is already computed. The request ends ONCE: the server
            # finishes a request on its first terminal event, so an error sent
            # before the answer took the answer down with it. The answer goes
            # out as the result, whole (`item`, as the record would have held
            # it), with a line saying the record did not take it, and the page
            # that asked writes it into the record itself. What this turn
            # stored beside the conversation is kept, since that item names it.
            traceback.print_exc()
            if outcome_unknown(e):
                said = 'Saving the conversation got no answer, so this answer may not be in the record.'
            else:
                said = (f'The conversation could not be saved: '
                        f'{requester_message(e, secrets=self.REQUEST_SECRETS).rstrip(".")}. '
                        f'This answer is not in the record.')
            response_helper.complete({'kind': 'turn', 'message': turn.text, 'warning': said, 'item': item})
            return
        if not written:
            # The conversation moved on (stopped, resent or deleted), so the
            # reply was dropped, and with it the only reference to what this
            # turn stored.
            ws.keeper.discard()
        try:
            response_helper.progress(100, 'Done')
        except ServiceCancelled:
            # Stopped after the answer was written: it is the outcome all the same.
            pass
        response_helper.complete({'kind': 'turn', 'message': turn.text, 'plan': item['plan'],
                                  'citations': item['citations'], 'steps': turn.steps, 'steps_summary': turn.summary})

    def transcript_budget(self, model: str, overhead) -> Optional[tuple]:
        """``(tokens, measure)`` the stored transcript may cost the model:
        its share of the window (`TRANSCRIPT_WINDOW_SHARE`) less what the
        system prompt and tool schemas take. None when the window is not
        known, and then prune holds the transcript to a byte figure instead."""
        window = context_window(model, self.cfg.context_window)
        if not window:
            return None
        measure = token_counter(model)
        return int(window * TRANSCRIPT_WINDOW_SHARE) - measure(overhead), measure

    def turn_failure_line(self, e: BaseException) -> str:
        """What the reader is told when a turn fails: one plain line. The
        exception itself went to the operator's log. A provider's error is
        never quoted (it names the library and can carry the endpoint, the
        request and the key), and anything else passes through
        ``requester_message``, which strips URLs and secrets."""
        if isinstance(e, TurnFailed):
            return str(e)
        return (model_failure_line(e, self.cfg.timeout)
                or f'The assistant could not answer: {requester_message(e, secrets=self.REQUEST_SECRETS)}')

    @staticmethod
    def _reviewed(client, project_id: str, user_id: str) -> bool:
        """Whether the approver's work is reviewed in the project (its
        ``plaid.review`` lists, by name or by role), read from the server. An
        administrator with no role of their own counts as a maintainer, as
        everywhere else. A token that may not read the user says nothing about
        that, so they then count by their listed role alone."""
        project = client.projects.get(project_id)
        try:
            is_admin = bool((client.users.get(user_id) or {}).get('is_admin'))
        except Exception:  # noqa: BLE001 - a delegated token may not read users
            is_admin = False
        return is_reviewed(project, user_id, is_admin=is_admin)

    def _apply(self, client, project, store, conv_id, conv, meta, approve: dict, request_id, response_helper) -> None:
        model = self.cfg.model
        plan_id = approve.get('plan_id')
        index, item = find_plan(conv, plan_id) if plan_id else (-1, None)
        if item is None:
            response_helper.error('No such plan in this conversation')
            return
        plan = item['plan']

        def settled(status=None, note=None, **fields):
            """Clear the pending marker so the card is decidable again, and
            settle the plan as ``status`` when given (`plan_settling`). False
            when the conversation moved on, which `_write` reports rather than
            raising.

            An outcome that wrote (applied, partly applied) is written on the
            plan even when the conversation moved on (another request's
            marker stands): the record never says undecided over changes
            that landed, and the model is told. The other request's marker
            is kept. False only when the conversation is gone."""
            change = plan_settling(plan_id, status, note, documents=plan.get('documents'),
                                   expansion=plan.get(EXPANSION), writing=plan.get(WRITING), **fields)
            if self._write(store, conv_id, change, request_id, model):
                return True
            return status in WROTE and self._write(store, conv_id, change, None, model)

        # This process applied the plan and its outcome never reached the
        # record (the conversation was deleted and its write refused, say):
        # written now, so the approval reports the plan as it is.
        done = self._applied_plans.get(plan_id)
        if item.get('status') is None and done and done.get('status'):
            settled(done['status'], done['note'], **done['fields'])
            item = {**item, 'status': done['status']}
        # A plan that stopped partway is settled: finishing it is a new plan.
        if item.get('status') == 'partial':
            settled()
            response_helper.error('This plan was partly applied. Ask the assistant to finish it.')
            return
        # A second approval of the same plan (a retried request, a double
        # click) does not write it twice.
        if item.get('status') == 'applied' or (plan_id in self._applied_plans):
            settled()
            response_helper.complete({'kind': 'applied', 'applied': 0, 'counts': [], 'duplicate': True,
                                      'message': 'This plan was already applied. Nothing was written again.'})
            return
        if item.get('status') == 'replaced':
            settled()
            response_helper.error('A newer plan replaced this one. Approve the newer plan.')
            return
        if item.get('status') == 'discarded':
            settled()
            response_helper.error('The plan was discarded')
            return
        if item.get('status') == 'stale':
            settled()
            response_helper.error('The plan is out of date. Ask the assistant to plan again.')
            return
        # A plan's writes name the service that proposed it, which its turn
        # records. A plan staged before turns recorded it cannot say, so it is
        # settled as out of date, not written under the wrong name. Asked here,
        # before the locks, or the lookup failed inside them as a KeyError and
        # the card kept offering an Approve that failed the same way.
        # Nor can a plan whose id is not a UUIDv7, which the ids of what it
        # creates are drawn from (`core.plan.Minter`).
        if not item.get('service') or not drawable(plan_id):
            said = 'This plan was made by an earlier version of the assistant.'
            settled('stale', f'(note) The plan was not applied: {said} Nothing was written.')
            response_helper.error(f'Nothing was written. {said} Ask the assistant to plan again.')
            return
        ops = plan.get('ops') or []
        if not ops:
            settled()
            response_helper.error('Nothing to apply')
            return
        # The limits a plan is held to when it is staged, asked again: a plan
        # staged under other limits must not lock or write more than these.
        big = rules.too_big(ops, self.documents_to_lock(ops, plan.get('documents') or []))
        if big:
            settled('stale', f'(note) The plan was not applied: {big} Nothing was written.', reason=big)
            response_helper.error(f'Nothing was written. {big}')
            return
        # Whose work is reviewed is the project's setting as it is NOW, read
        # here rather than taken from the page: a page loaded before a
        # maintainer changed it would stamp the plan by the old setting.
        try:
            contributor = store.user_id if self._reviewed(client, store.project_id, store.user_id) else None
        except Exception as e:  # noqa: BLE001 - the reason goes to the requester as one line
            settled()
            response_helper.error(f'Nothing was written. The project\'s review settings could not be '
                                  f'read: {" ".join(str(e).split())[:200]}')
            return
        as_human = bool(approve.get('as_human'))
        stamp_mode = 'contributed' if contributor else 'human' if as_human else 'verified'
        documents = plan.get('documents') or []
        summary = plan.get('summary') or self.summarize(ops)
        # The plan is written in several requests, and a document opened in
        # between is half written: its editor's repair on open can delete what
        # the first batch made, and the next batch fails. So every document the
        # plan writes is held (see core/plan.py `holding`) from the staleness
        # check, which then reads the state the writes go onto, to the last
        # write. The conversation record is written only once they are
        # released: a lock that lapsed refuses every later write this client
        # makes while the block runs, the record's too, which would leave the
        # card pending over a plan that stopped partway.
        def remember(undecided=False):
            """Write the plan's documents as the run holds them, what its
            scopes resolved to and whether it may have written, the approval
            still pending. ``undecided``: only on a plan the record still has
            undecided under this approval (`plan.writing`)."""
            return self._write(store, conv_id, plan_settling(plan_id, documents=plan.get('documents'),
                                                             expansion=plan.get(EXPANSION),
                                                             writing=plan.get(WRITING), undecided=undecided),
                               request_id, model, pending=(meta or {}).get('pending'))
        expansion = Expansion(plan, remember)

        try:
            with holding(client, self.documents_to_lock(ops, documents)):
                counts = self._check_and_execute(client, project, ops, documents, plan_id, summary,
                                                 index, conv, settled, remember, stamp_mode, contributor, store,
                                                 response_helper, conv_id, proposed_by(item),
                                                 item['service'], expansion, plan=plan, run=request_id)
        except DocumentsBusy as e:
            settled()
            name = next((d.get('name') for d in documents
                         if isinstance(d, dict) and d.get('id') == e.document_id), None)
            which = f'"{name}"' if name else 'A document'
            if e.cause is None:
                said = self._busy_sentence(client, e.document_id, which, plan, store.user_id, request_id)
            else:
                said = (f'{which} could not be locked for the change '
                        f'({requester_message(e.cause, secrets=self.REQUEST_SECRETS)}). Approve again.')
            response_helper.error(f'Nothing was written. {said}')
            return
        if callable(counts):
            counts()
            return
        notes = counts.pop('notes', [])
        # Card rows that wrote nothing under this approval (a contributor's
        # confirmation of only other contributors' work), which the card does
        # not show as applied.
        unwritten = counts.pop('unwritten', [])
        note = f'(note) The plan was approved and applied: {summary}.' + (' ' + '; '.join(notes) if notes else '')
        # Settled even when the conversation moved on (`settled`), so the card
        # never offers Approve over work already done. `_applied_plans` keeps
        # the outcome too, for a record that could not take it.
        # What the record keeps of the outcome: how the approval was recorded,
        # and what applying dropped (a change a later one superseded, say),
        # since each change's outcome is otherwise the plan's.
        outcome = {'as_human': as_human, **({'contributed': True} if contributor else {}),
                   **({'apply_notes': notes} if notes else {}),
                   **({'unwritten': unwritten} if unwritten else {})}
        self._remember_applied(plan_id, 'applied', note, outcome)
        if not settled('applied', note, **outcome):
            response_helper.error('The changes were applied, but this conversation was deleted.')
            return
        response_helper.progress(100, 'Done')
        response_helper.complete({
            'kind': 'applied', 'applied': sum(counts.values()),
            'counts': [{'kind': k, 'count': n} for k, n in counts.items()],
            'message': f'Applied {self.summarize(ops)}.' + ''.join(' ' + _sentence(n) for n in notes),
        })

    def _busy_sentence(self, client, document_id: str, which: str, plan: Dict[str, Any], user_id: str,
                       run: Any) -> str:
        """Why a plan could not take a document it writes. A run of this plan
        that stopped partway (the service killed) still holds the lock until
        it lapses, a minute after its last renewal: the user is told so, and
        when to apply again, rather than to wait for a run that will never
        finish (H12-RULES-4)."""
        earlier = plan.get(WRITING)
        if isinstance(earlier, dict) and earlier.get('run') != run:
            left = _lock_left(client, document_id, user_id)
            if left is not None:
                return (f'A previous run of this plan stopped and still holds {which}. Apply again in '
                        f'{left} second{"" if left == 1 else "s"}.')
        return f'{which} is locked by another run on it. Approve again once it has finished.'

    def _check_and_execute(self, client, project, ops, documents, plan_id, summary, index, conv,
                           settled, remember, stamp_mode, contributor, store,
                           response_helper, conv_id, detail, proposer, expansion=None, plan=None, run=True):
        """The staleness check and the writes, under the documents' locks.
        ``detail`` and ``proposer`` are the model and version, and the service
        id, of the turn that proposed the plan: the writes name that assistant
        (`provSource`, `provDetail`) and so does the operation's ref, whichever
        is running now.
        The counts of what was applied, or, when the plan was refused or
        failed, the answer to give once the locks are released: it writes the
        conversation record, which must not be written under a lock that may
        have lapsed."""
        def out_of_date(reasons):
            # Settled as out of date, so the card stops offering an Approve
            # that can only fail again, and the model is told on the next turn.
            said = ' '.join(_sentence(s) for s in reasons)

            def refuse():
                # The card says why, in the same words (`reason`).
                settled('stale', f'(note) The plan was not applied: {said} Nothing was written.', reason=said)
                response_helper.error(f'Nothing was written. {said} Ask the assistant to plan again.')
            return refuse

        stale = self._stale(client, project, documents)
        if stale:
            return out_of_date(stale)
        plan = {} if plan is None else plan

        # A run again of a plan whose earlier run may have written keeps the
        # mark, the versions that run held and what its scopes found, whatever
        # stops this one before it writes: some of the plan may be in the
        # project already.
        was = plan.get(WRITING)

        def nothing_written():
            if was:
                plan[WRITING] = was
                return
            # The next approval holds the versions the documents have then,
            # finds what they hold then, and may be discarded meanwhile.
            forget_held(documents)
            if expansion is not None:
                expansion.forget()
            plan.pop(WRITING, None)
        try:
            writing(client, plan, documents, lambda: remember(undecided=True), run=run, ops=ops)
        except (RecordFull, PlanMovedOn) as e:
            def stopped(e=e):
                nothing_written()
                settled()
                response_helper.error(str(e) if isinstance(e, RecordFull) else _moved_on(store, conv_id, plan_id))
            return stopped
        response_helper.progress(10, 'Applying changes…')
        # One operation of kind assistant-plan, naming the conversation, the
        # plan and the assistant that proposed it, so the audit log says which
        # writes a plan made. The app's own operation inside flattens into it.
        label = audit_label(summary)
        source = service_source(proposer)
        ref = f'conv:{conv_id}/plan:{plan_id}/{source}'
        try:
            # Keyed by the plan's id, and every row it creates is named by an
            # id drawn from it (`core.plan.Minter`). Applied again, from the
            # versions its first run held (`held_from`), it sends the same
            # requests: one that landed is answered from its first send, and a
            # create whose key is gone is refused as a taken id, which the
            # executor takes as made. Nothing is made twice.
            keys = {'seed': plan_id, 'stamps': {}}
            with client.operation(label, kind='assistant-plan', ref=ref, keys=keys) as operation:
                # Each op names its row on the card, so a plan that stops
                # partway can say which changes were written.
                try:
                    # A scope reads what an earlier run of this plan found
                    # (`core.plan.Expansion`), or records what it finds.
                    with expanding(client, expansion):
                        counts = self.execute_plan(client, [{**op, ROW: i} for i, op in enumerate(ops)],
                                                   source=source,
                                                   label=label, project=project,
                                                   stamp_mode=stamp_mode, contributor=contributor,
                                                   requester=store.user_id, detail=detail,
                                                   seed=plan_id)
                except PlanError as e:
                    # History names what was written, not the whole plan.
                    if e.wrote:
                        partly_label = self.partial_label(ops, e.written or [], summary)
                        operation.set_message(partly_label)
                        if e.partly and not e.applied and not e.unknown:
                            # Only another service wrote under the operation
                            # (a parse), which the client does not count as a
                            # write of its own, so it would skip the relabel.
                            _relabel(client, operation.id, partly_label)
                    raise
        except ScopeMoved as e:
            # A corpus-wide change found again reaches documents the plan was
            # not made over: never checked, never locked, not on the card.
            return out_of_date(_reach_moved(client, documents, e))
        except PlanOutOfDate as e:
            # Something the plan names outside its documents is gone, which no
            # document version says. Asked before the first write.
            return out_of_date(e.reasons)
        except PlanError as e:
            # A write whose answer was lost may have landed, so it counts as
            # written: "Nothing was written" was false, and approving again
            # wrote the plan a second time over the first attempt's leftovers.
            written = e.wrote
            if written:
                self._remember_applied(plan_id)

            def failed(e=e):
                why = 'the server did not answer' if e.unknown else _failure(client, documents, e)
                if not written:
                    # Nothing landed on this run.
                    nothing_written()
                    settled()
                    response_helper.error(f'Failed to apply the plan: {why}. Nothing was written.')
                    return
                # Settled as partly applied (Luke's ruling Q4): no Approve that
                # cannot work, the card marks the changes written in full, and
                # the model is told which, so the user asks it to finish. The
                # count is of the card's rows: `applied` counts batch calls,
                # and one change can be several.
                done = list(e.written or [])
                labels = [op.get('label') or '' for op in ops]
                # A row that folds many changes ("dep on 600 words") counts
                # each of them, written or not, so a row cut short by the
                # failure says "400 of 600", not "0 of 1".
                sizes = [int(op.get('count') or 1) if op.get('compact') or rules.is_rule(op) else 1 for op in ops]
                parts = {i: n for i, n in (e.members or {}).items() if 0 <= i < len(ops) and i not in done}
                written_n = sum(sizes[i] for i in done if 0 <= i < len(ops)) + sum(parts.values())
                # A row another service wrote in part (a parse that stopped
                # partway) has no count here: its own message says how much.
                partly = sorted({i for i in e.partly if 0 <= i < len(ops) and i not in done and i not in parts})
                note = partial_note(labels, done, e.unknown, why,
                                    parts={i: (n, sizes[i]) for i, n in parts.items()},
                                    sizes=sizes, partly=partly)
                # The count as the card says it, kept on the record for
                # whatever shows the plan later (an exported conversation).
                outcome = f'{partial_tally(written_n, sum(sizes), len(partly))}.'
                fields = {'written': done, 'outcome': outcome, **({'unknown': True} if e.unknown else {})}
                said = (f'Partly applied: {outcome} '
                        + ('The server did not answer for the rest.' if e.unknown else _sentence(why)))
                self._remember_applied(plan_id, 'partial', note, fields)
                if not settled('partial', note, **fields):
                    said += ' This conversation was deleted.'
                response_helper.complete({'kind': 'applied', 'partial': True, 'applied': written_n,
                                          'counts': [], 'message': said})
            return failed
        except ExpansionUnreadable as e:
            # The record is there because an earlier run began writing, so
            # some of the plan may stand. Nothing more is sent, and the plan
            # settles as partly applied: approved again it would send other
            # requests than that run did under the same keys.
            def unreadable(e=e):
                outcome = 'An earlier run may have written some of these changes. History shows them.'
                note = (f'(note) The plan was not applied again: {e}. An earlier run may have written some of '
                        'its changes. Nothing more was written.')
                fields = {'written': [], 'outcome': outcome}
                self._remember_applied(plan_id, 'partial', note, fields)
                settled('partial', note, **fields)
                response_helper.error(f'Not applied again: {e}. An earlier run may have written some of its '
                                      'changes, which History shows. Ask the assistant to plan the rest again.')
            return unreadable
        except ValueError as e:
            def rejected(e=e):
                nothing_written()
                settled()
                response_helper.error(str(e) if isinstance(e, RecordFull)
                                      else f'The plan was rejected before anything was written: {e}')
            return rejected
        return counts

    def _stale(self, client, project, documents: list) -> list:
        """What stands in the way of applying a plan made against
        ``documents``. A document whose version moved is read again, once, and
        only the sentences the plan recorded are compared."""
        ws = None

        def reread(doc_id: str):
            nonlocal ws
            if ws is None:
                ws = self.make_workspace(client, project, lambda *a, **k: None)
            return ws.current_prints(doc_id)

        try:
            return stale_documents(client, documents, reread=reread)
        finally:
            if ws is not None:
                self._release(ws)

    @staticmethod
    def _release(ws) -> None:
        """Let the workspace give back what it held for the turn (a code
        worker, and the workspaces of any other projects it read): the turn is
        over whichever way it ended."""
        for thing in (getattr(ws, 'reach', None), ws):
            close = getattr(thing, 'close', None)
            if close:
                try:
                    close()
                except Exception:  # noqa: BLE001 - releasing must never turn a finished turn into a failed one
                    traceback.print_exc()

    def _remember_applied(self, plan_id: str, status: Optional[str] = None, note: Optional[str] = None,
                          fields: Optional[Dict[str, Any]] = None) -> None:
        """A plan this process wrote, and how it settled it once that is
        known, so a second approval neither writes it again nor leaves the
        record undecided."""
        self._applied_plans.pop(plan_id, None)
        self._applied_plans[plan_id] = {'status': status, 'note': note, 'fields': dict(fields or {})}
        while len(self._applied_plans) > 500:
            del self._applied_plans[next(iter(self._applied_plans))]


def _moved_on(store: ConversationStore, conv_id: str, plan_id: str) -> str:
    """Why an approval found the record moved on before it sent anything
    (`plan.PlanMovedOn`), as the page says it."""
    try:
        conv, _ = store.load(conv_id)
    except Exception:  # noqa: BLE001 - only the wording depends on it
        conv = None
    if not conv:
        return 'This conversation was deleted. Nothing was written.'
    _, item = find_plan(conv, plan_id)
    if item is not None and item.get('status') == 'discarded':
        return 'The plan was discarded. Nothing was written.'
    if item is not None and item.get('status') is not None:
        return 'The plan was decided in another tab. Nothing was written.'
    return 'This conversation was changed in another tab. Nothing was written.'


def _positive_int(text: str) -> int:
    """An argparse type for a count that has to be above zero."""
    try:
        n = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f'{text!r} is not a whole number') from None
    if n <= 0:
        raise argparse.ArgumentTypeError(f'{n} is not above zero')
    return n


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


def proposed_by(item: Dict[str, Any]) -> Dict[str, Any]:
    """The provDetail an applied plan's writes carry: the model and the
    version of the turn that proposed the plan, which may not be the ones
    running when it is approved."""
    return {k: item[k] for k in ('model', 'version') if item.get(k)}


def _lock_left(client, document_id: str, user_id: str) -> Optional[int]:
    """Seconds until the lock on a document lapses, when ``user_id`` holds it
    (a run of theirs that stopped holds it until then), else None."""
    import math
    import time
    try:
        info = client.documents.check_lock(document_id)
    except Exception:  # noqa: BLE001 - only a better sentence depends on it
        return None
    if not isinstance(info, dict) or info.get('user_id') != user_id:
        return None
    try:
        left = (float(info.get('expires_at')) - time.time() * 1000) / 1000
    except (TypeError, ValueError):
        return None
    return max(1, math.ceil(left))


#: The longest audit label a plan's operation carries, in code points. It
#: goes in the request's URL (``?group-message=``), percent-encoded, and the
#: core keeps 1,000 UTF-16 units of it, so a plan naming many rules stays
#: well inside both.
AUDIT_LABEL_MAX = 400


def audit_label(summary: str) -> str:
    """The label of a plan's operation, which History and the audit feed
    show: ``Assistant: <the plan's summary>``, cut short with an ellipsis
    past :data:`AUDIT_LABEL_MAX`, and every isolate the cut leaves open
    closed."""
    from .bidi import PDI
    from .plan import clip_caption
    label = f'Assistant: {summary}'
    if len(label) <= AUDIT_LABEL_MAX:
        return label
    cut = clip_caption(label, AUDIT_LABEL_MAX - 1)
    opened = sum(cut.count(c) for c in '\u2066\u2067\u2068') - cut.count(PDI)
    return cut + PDI * max(0, opened) + '…'


def _sentence(text: str) -> str:
    """A note as a sentence of its own on screen, where a semicolon run of
    them read as one long clause."""
    text = str(text).strip()
    return text[:1].upper() + text[1:] + ('' if text.endswith('.') else '.')


def _document_name(client, documents: list, document_id: str) -> Optional[str]:
    """A document's name, from the plan's record or else read, or None."""
    for d in documents or ():
        if isinstance(d, dict) and d.get('id') == document_id and d.get('name'):
            return d['name']
    try:
        return (client.documents.get(document_id) or {}).get('name') or None
    except Exception:  # noqa: BLE001 - a name is only for the message
        return None


# Names a message lists before it counts the rest.
_NAMES_SHOWN = 3


def _documents_named(client, documents: list, ids: List[str]) -> str:
    """Documents as a reader says them: document "A", documents "A" and "B",
    documents "A", "B", "C" and 4 more."""
    if len(ids) == 1:
        return _named(_document_name(client, documents, ids[0]))
    shown = []
    for i in ids:
        if len(shown) == _NAMES_SHOWN:
            break
        name = _document_name(client, documents, i)
        if name:
            shown.append(f'"{name}"')
    rest = len(ids) - len(shown)
    if not shown:
        return f'{rest} documents'
    if rest:
        shown.append(f'{rest} more')
    return 'documents ' + (shown[0] if len(shown) == 1 else ', '.join(shown[:-1]) + ' and ' + shown[-1])


def _relabel(client, group_id: str, label: str) -> None:
    """Relabel an operation the client itself wrote nothing under. A group
    nothing was written under does not exist (404), and has nothing to say."""
    try:
        client.operation_groups.update(group_id, label)
    except PlaidAPIError as e:
        if e.status != 404:
            raise


def _failure(client, documents: list, e: PlanError) -> str:
    """Why a plan stopped, as the clause after "Failed to apply the plan:".
    A lock that lapsed names its document as the reader knows it. Anything
    else is the failure's own text, without the period it may end in, since
    the answer goes on after it."""
    cause = e
    while cause is not None and not isinstance(cause, DocumentLockLost):
        cause = cause.__cause__
    if cause is not None:
        return f'the lock on {_named(_document_name(client, documents, cause.document_id))} lapsed'
    said = str(e).rstrip()
    return said[:-1] if said.endswith('.') and not said.endswith('..') else said


def _reach_moved(client, documents: list, e) -> List[str]:
    """What a corpus-wide change found again at approval reaches that it did
    not, and what it no longer reaches, in the reader's words."""
    out = []
    if e.gained:
        many = len(e.gained) > 1
        out.append(f'{_documents_named(client, documents, e.gained)} now also '
                   f'{"match" if many else "matches"} a change in the plan')
    if e.lost:
        many = len(e.lost) > 1
        out.append(f'{_documents_named(client, documents, e.lost)} no longer '
                   f'{"match" if many else "matches"} a change in the plan')
    return out


def _named(name) -> str:
    """A document as the user knows it: by name, never by id."""
    return f'document "{name}"' if name else 'a document'


def _numbers(indexes: List[int]) -> str:
    """Sentence numbers as a reader says them: "3", "3 and 5", "3, 5 and 8"."""
    shown = [str(i) for i in sorted(indexes)]
    return shown[0] if len(shown) == 1 else ', '.join(shown[:-1]) + ' and ' + shown[-1]


def changed_sentences(recorded: list, now: Dict[str, tuple]) -> Optional[List[int]]:
    """The numbers of the recorded sentences whose fingerprint differs now, or
    None when one of them is gone (the plan names a sentence that no longer
    exists, so it cannot apply at all)."""
    out: List[int] = []
    for entry in recorded:
        if not isinstance(entry, dict) or not entry.get('id') or not entry.get('print'):
            return None
        found = now.get(entry['id'])
        if found is None:
            return None
        if found[1] != entry['print']:
            out.append(found[0])
    return out


def stale_documents(client, documents: list, reread=None) -> list:
    """Which of the plan's documents changed since it was made: every write
    inside a document bumps its version, so a version mismatch means the
    plan's ids and offsets may have been read from data that is no longer
    there.

    A document whose record lists ``sentences`` (the fingerprint of each one
    the plan's changes depend on) is checked more finely when its version has
    moved: ``reread(document_id)`` gives the fingerprints as they are now, and
    only those sentences are compared, so an edit elsewhere in the document
    does not refuse the plan (ruled 2026-09-28). Without a list, or
    without ``reread``, the version alone decides, as it always did.

    A document an earlier run of the plan held (``held_from``) is not
    compared: that run may have written to it, which moves its version and
    changes its sentences, and the check would refuse the run again saying
    nothing was written. The run again holds it at the version the first run
    held it at, so what landed is answered from its first send, and what did
    not claims the version the answers leave, which the server refuses if
    anyone else has written since."""
    out = []
    for d in documents:
        # A record with no id or no version cannot be checked, and skipping it
        # applied the plan anyway: the one case this exists to catch is the
        # one where the check could not run.
        if not isinstance(d, dict) or not d.get('id'):
            out.append('the plan names a document it cannot identify, so nothing can be checked '
                       'against it')
            continue
        if d.get('version') is None:
            out.append(f'{_named(d.get("name"))} was recorded without a version, so '
                       f'whether it has changed since the plan was made cannot be told')
            continue
        try:
            now = client.documents.get(d['id'])
        except Exception as e:  # noqa: BLE001 - deleted or unreadable: the plan cannot apply
            out.append(f'{_named(d.get("name"))} could not be read ({requester_message(e)})')
            continue
        # Reached by rules alone: what they match there is checked by its
        # digest when they are found again (`core.rules.check_matched`), so an
        # edit elsewhere in the document does not refuse the plan.
        if now.get('version') == d['version'] or d.get(HELD_FROM) is not None or d.get('rule'):
            continue
        named = _named(now.get('name') or d.get('name'))
        changed = None
        if d.get('sentences') and reread is not None:
            try:
                changed = changed_sentences(d['sentences'], reread(d['id']))
            except Exception:  # noqa: BLE001 - unreadable now: fall back to the version, which moved
                traceback.print_exc()
                changed = None
        if changed is None:
            out.append(f'{named} has changed since the plan was made')
        elif changed:
            many = len(changed) > 1
            out.append(f'sentence{"s" if many else ""} {_numbers(changed)} of {named} '
                       f'{"have" if many else "has"} changed since the plan was made')
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


# The stamp that records which projects a conversation may read, written onto
# the question when the set changed, on the same only-on-change rule as the
# place stamp above and for the same reason. It is not at the start of the
# message (the place stamp is), so it is looked for on a line of its own.
_PROJECTS_STAMP = '[Projects in this conversation: {names}]'
_PROJECTS_RE = re.compile(r'^\[Projects in this conversation: .*\]$', re.M)


def _projects_line(labels: List[str]) -> str:
    names = ', '.join(f'"{label}"' for label in labels)
    return _PROJECTS_STAMP.format(names=names if len(labels) > 1 else f'{names} only')


def projects_stamped(transcript: List[Dict[str, Any]], labels: List[str]) -> List[Dict[str, Any]]:
    """The transcript with its last message stamped with the projects this
    turn may read (the conversation's own first), if that set changed since
    the last stamp. A conversation that never read another project carries
    no stamp at all, and one that stops says so once."""
    if not labels or not transcript or transcript[-1].get('role') != 'user':
        return transcript
    line = _projects_line(labels)
    was = None
    for m in reversed(transcript[:-1]):
        content = m.get('content') if m.get('role') == 'user' else None
        found = _PROJECTS_RE.findall(content) if isinstance(content, str) else []
        if found:
            was = found[-1]
            break
    if was == line or (was is None and len(labels) == 1):
        return transcript
    last = transcript[-1]
    return transcript[:-1] + [{**last, 'content': f'{line}\n\n{last.get("content") or ""}'}]


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
