"""The assistant as a Plaid service (task ``assist``, delegating).

A conversation lives in the requester's private key/value store on the
Plaid server (see :mod:`.conversation`), and this service is its only
writer. The page sends one request per thing the user does, naming an
``op`` (see :mod:`.ops`), and reads the record. A turn appends the user's
message, answers it, and writes the outcome back BEFORE reporting the
request done, so the reply lands whether or not the page is still watching,
and a page that comes back reads it from the record (or rejoins the request
by id while it is still running). Every request is served with the
REQUESTER's own client (the server mints a short-lived token for them), so
reads are limited to what they may read, approved edits are attributed to
them in the audit log, and the record is theirs.

Request data:
    project_id       the project, which must be the one the request was posted
                     to (``delegated_projects[0]``, the turn's own project)
    conversation_id  the conversation
    tab              the tab that sent it, which must hold the conversation
                     (`ops.hold_free`) for an op that acts inside it
    op               send, retry, approve, discard, attach, delete, rename, hold,
                     with the fields `ops` lists. A request with no op comes from
                     a page that writes the record itself and is refused
                     (`ops.STALE_PAGE`).
    (projects)       the other projects the user added to the conversation ride
                     on their message's display item as ``projects: [{id,
                     name}]``, and the turn may READ those as well (see
                     core/reach.py). Plans stay in project_id.
    where            on send: {kind, id, name} for what the user is looking at,
                     sent fresh with EVERY turn because the panel outlives the
                     screen it was opened from. It is a DEFAULT, not a fence:
                     the model is told what is open so an unqualified question
                     is about that, and every tool that reads the rest of the
                     project stays available.

Result data:
    {kind: 'turn', message, plan: {id, summary, ...} | null, citations, steps, steps_summary}
    {kind: 'stopped'}                       the requester cancelled the turn
    {kind: 'applied', applied: n, counts: [{kind, count}], message}
    {kind: 'done', meta}                    an op that needs no model
    {kind: 'refused', why, message, meta}   an op turned down, said in ``message``
A send reports progress ``recorded: true`` once the message is in the record.
The record is the full outcome: a page re-reads it on any of these.

ALL OF THAT IS THE SAME IN EVERY APP. What an app fills in is what its
assistant knows about: the project it loads, the workspace and tools a turn
runs against, the prompt, how a citation resolves, and how a plan is applied.
Those are the methods marked below, and a subclass that answers them is a
working assistant service.

The class is assembled from one mixin per job, each in its own module: the
flags and startup (`service_cli`), the record ops and the send that starts a
turn (`record_ops`), the turn (`turn`), approval (`approval`, with the
staleness check in `staleness`) and the plans a page writes itself
(`page_writes`). What is here is the request's dispatch, the conversation
lock and busy table, the record's write and the memory of applied plans.
"""

import threading
import weakref
import traceback
from typing import Any, Dict, List, Optional, Tuple

from plaid_client import BaseService, TASKS

from .agent import ModelConfig, Toolkit
from .conversation import ConversationStore, build_meta, pending_kept
from .ops import ANOTHER_PROJECT, OPS, STALE_PAGE
from .plan import documents_to_lock
from .web import WebConfig
from .version import agent_sources, agent_version
from .service_cli import ServiceCli
from .turn import Turn, focus_note
from .record_ops import RecordOps, _Op
from .approval import Approving
from .page_writes import PageWrites


class BaseAssistantService(ServiceCli, RecordOps, Approving, PageWrites, Turn, BaseService):
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
        # One conversation, one thing at a time (see `_conv_lock`): a lock per
        # conversation, keyed (user, project, conversation), and what runs
        # there in this process, {request_id, kind, plan_id, cancel}.
        # Held weakly: a lock goes from the table once nothing holds or waits
        # on it, so the table does not grow with every conversation ever
        # touched, and never while a thread could still be using it.
        self._locks: 'weakref.WeakValueDictionary[tuple, Any]' = weakref.WeakValueDictionary()
        self._locks_guard = threading.Lock()
        self._busy: Dict[tuple, Dict[str, Any]] = {}
        # Answers whose write the server never answered, written again later.
        self._unsaved: Dict[tuple, Dict[str, Any]] = {}
        # When each (user, project) was last swept for files left behind.
        self._swept: Dict[tuple, float] = {}

    # --- what the app knows ------------------------------------------------------

    #: The app's own modules, which the hooks below are answered from: its
    #: tool table (``TOOLS``, ``tools_for``, ``call_tool``), its prompt
    #: (``SYSTEM``, ``WEB``, ``CODE``, ``build_system_prompt``,
    #: ``project_brief``) and its plan (``execute_plan``, ``summarize``), with
    #: its tracer and its workspace class. An app names them here rather than
    #: forwarding each one by hand.
    TOOLKIT = PROMPT = PLAN = TRACER = WORKSPACE = None

    def toolkit(self) -> Toolkit:
        """The app's tools and its words for them. Built once, at setup."""
        return Toolkit(tools_for=self.TOOLKIT.tools_for, call_tool=self.TOOLKIT.call_tool, tracer=self.TRACER)

    def load_project(self, client, project_id):
        """The app's model of the project. Raises ValueError with a message
        for the user when the project is not one this assistant can serve."""
        raise NotImplementedError

    def make_workspace(self, client, project, on_progress):
        """What a turn runs against: the app's own workspace, which holds the
        plan as the model builds it (``ops``, ``plan_payload()``) and takes a
        web session on ``web`` when the operator configured one."""
        return self.WORKSPACE(client, project, on_progress=on_progress)

    def system_prompt(self, project, web: bool) -> str:
        """What the model is told before the conversation."""
        return self.PROMPT.build_system_prompt(project, web=web)

    def prompt_template(self) -> Tuple[List[str], List[Dict[str, Any]]]:
        """The system prompt's texts before a project fills them in (every
        section, whether or not a turn includes it), and every tool schema the
        model can be offered. The assistant's version is a hash of them."""
        return [self.PROMPT.SYSTEM, self.PROMPT.WEB, self.PROMPT.CODE], self.TOOLKIT.TOOLS

    def project_brief(self, project) -> str:
        """Another project's shape, in the lines the app's own prompt states
        its project's shape in, for a turn that may read it. The harness adds
        its name and its guideline titles, and cuts it to a budget."""
        return self.PROMPT.project_brief(project)

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
        it the way the tools take it back: by its name, its own in the project
        (ruling 5). An app that docks its assistant beside anything else
        answers for that too and falls back here.
        """
        where = where or {}
        if where.get('kind') != 'document':
            return None
        document_id = where.get('id')
        names = [d.get('name') or '' for d in ws.documents() if d['id'] == document_id]
        if not names:
            return None
        return self.document_place(names[0] or document_id)

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
        return self.PLAN.execute_plan(client, ops, source=source, label=label, project=project,
                                      stamp_mode=stamp_mode, contributor=contributor, requester=requester,
                                      detail=detail, seed=seed)

    def summarize(self, ops: List[Dict[str, Any]]) -> str:
        """A plan in one phrase, for the audit label and the applied message."""
        return self.PLAN.summarize(ops)

    def partial_label(self, ops: List[Dict[str, Any]], written: List[int], summary: str) -> str:
        """The History label of a plan that stopped partway: the changes
        written in full (card rows ``written``), or, when none was, the plan
        it was part of."""
        done = [ops[i] for i in written if 0 <= i < len(ops)]
        from .bidi import for_model
        if done:
            return for_model(f'Assistant, partly applied: {self.summarize(done)}')
        return for_model(f'Assistant, partly applied: part of {summary}')

    def page_wrote(self, client, project_id: str, ops: List[Dict[str, Any]]) -> Optional[Dict[str, int]]:
        """For a plan the app writes itself, with the user's session, before
        it sends the approval (what a delegated token may not write): the
        per-kind counts when what it changes already reads as planned, else
        None. Such a plan is applied once that is so, whatever else the
        approval would refuse, once the page says it wrote it
        (`_settle_page_written`). No plan of the base is one."""
        return None

    def page_operation_wrote(self, client, project_id: str, ops: List[Dict[str, Any]], plan_id: str,
                             since: Optional[str]) -> Optional[bool]:
        """For a plan the app writes itself (`page_wrote`): whether the
        audit log holds a write the page made under the plan's own operation
        (kind ``assistant-plan``, its ref naming ``plan_id``, plaid-ui
        ``planOperation``) since ``since``. None when it cannot tell, which
        is read as written. No plan of the base is one."""
        return None

    def may_approve(self, client, project_id: str, user_id: str, ops: List[Dict[str, Any]]) -> Optional[str]:
        """Why ``user_id`` may not approve ``ops``, asked before a page
        writes a plan of its own (`_preflight`), or None. The base leaves it to
        the server."""
        return None

    def documents_to_lock(self, ops: List[Dict[str, Any]], documents: List[Dict[str, Any]]) -> List[str]:
        """The documents an approval holds locked from its staleness check to
        its last write: every one the plan writes. An app whose plan hands a
        document to another service, which locks it itself, leaves that one
        out."""
        return documents_to_lock(ops, documents)

    # --- the request -------------------------------------------------------------

    def process_request(self, request_data: dict, response_helper) -> None:
        client = request_data.get('requester_client')
        # The turn works in the project the request was posted to, which core
        # puts first among the projects the requester's token reaches. A
        # request whose data names another project is refused, so a turn never
        # runs in a project this assistant was not started on.
        scope = request_data.get('delegated_projects') or ()
        project_id = scope[0] if scope else None
        user_id = request_data.get('requester_id')
        conv_id = request_data.get('conversation_id')
        if client is None or not project_id or not user_id:
            response_helper.error('Missing project_id or requester credentials')
            return
        named = request_data.get('project_id')
        if named and named != project_id:
            response_helper.error(ANOTHER_PROJECT)
            return
        if not conv_id:
            response_helper.error('Missing conversation_id')
            return
        op = request_data.get('op')
        if not op:
            # A page from before the service wrote the record alone: it wrote
            # the message and its marker itself and asks for a turn on them.
            response_helper.error(STALE_PAGE)
            return
        if op not in OPS:
            response_helper.error(f'Unknown request: {op}')
            return
        store = ConversationStore(client, user_id, project_id, self.APP)
        ctx = _Op(self, request_data, response_helper, store, conv_id,
                  getattr(response_helper, 'request_id', None))
        getattr(self, f'_op_{op}')(ctx)

    # --- one conversation, one thing at a time --------------------------------------
    #
    # Every op takes the conversation's lock, reads the record, settles what a
    # dead request left there, decides, writes and lets go. A turn or an
    # approval enters the busy table inside the lock and leaves it once its
    # outcome is written. The lock is never held while the model or a plan's
    # writes run.

    def _conv_lock(self, key) -> threading.RLock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = self._locks[key] = threading.RLock()
            return lock

    def _running_here(self, ctx) -> bool:
        """Whether this very request already runs in this process (core
        handed it over a second time). Refused as busy, so the model is not
        asked twice and a plan is not applied twice. Under the lock."""
        running = self._busy.get(ctx.key) or {}
        if not ctx.request_id or running.get('request_id') != ctx.request_id:
            return False
        self._refuse(ctx, 'busy-apply' if running.get('kind') == 'apply' else 'busy-turn')
        return True

    def _leave(self, ctx) -> None:
        with ctx.lock:
            if (self._busy.get(ctx.key) or {}).get('request_id') == ctx.request_id:
                del self._busy[ctx.key]

    # --- writing the record ---------------------------------------------------------

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
        with self._conv_lock((store.user_id, store.project_id, conv_id)):
            written = store.write(conv_id, change, meta_of, request_id)
        if not written:
            print(f'Conversation {conv_id} moved on; the outcome of request {request_id} is not written.')
            return False
        return True

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
