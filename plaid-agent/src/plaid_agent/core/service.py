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
"""

import threading
import weakref
import time
import traceback
from datetime import timedelta
from typing import Any, Dict, List, Optional, Tuple

from plaid_client import BaseService, DocumentLockLost, TASKS, service_source
from plaid_client.http import PlaidAPIError
from plaid_client.provenance import is_reviewed
from plaid_client.service import requester_message

from .agent import ModelConfig, Toolkit
from .conversation import (ConversationStore, build_meta, find_plan, now_iso, partial_note, partial_tally, pending_kept,
                           plan_settling)
from .ops import ANOTHER_PROJECT, OPS, STALE_PAGE, busy_why, parse_time
from . import rules
from .opkind import ROW
from .plan import (EXPANSION, WRITING, DocumentsBusy, Expansion, ExpansionUnreadable, PlanError, PlanMovedOn,
                   PlanOutOfDate, RecordFull, ScopeMoved, documents_to_lock, expanding, forget_held, holding,
                   plan_changes, stamp_of, writing)
from .conversation import WROTE
from .web import WebConfig
from .version import AGENT_VERSION, agent_sources, agent_version  # noqa: F401 - AGENT_VERSION for the tests
from .service_cli import ServiceCli, build_web_config, check_hint  # noqa: F401 - re-exported for an app
from .staleness import _named, changed_sentences, stale_documents  # noqa: F401 - changed_sentences for the tests
from .turn import THINKING_TAIL, Turn, focus_note, projects_stamped, stamped  # noqa: F401 - for the tests
from .record_ops import RecordOps, _Op, _marks

#: What the model is told of a plan approved with nothing to write.
NOTHING_TO_WRITE_NOTE = ('(note) The plan only kept values as they are, so it was settled as discarded: nothing '
                         'was changed.')


class BaseAssistantService(ServiceCli, RecordOps, Turn, BaseService):
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

    # --- the ops that start work -----------------------------------------------------

    def _op_approve(self, ctx) -> None:
        plan_id = ctx.data.get('plan_id')
        with ctx.lock:
            if self._running_here(ctx):
                return
            conv, meta = self._prepare(ctx)
            if ctx.data.get('preflight'):
                self._preflight(ctx, conv, meta, plan_id)
                return
            if ctx.data.get('wrote_first') and self._settle_page_written(ctx, conv, plan_id):
                return
            if not self._gate(ctx, conv, meta):
                return
            if not ctx.data.get('wrote_first') and self._settle_in_force(ctx, conv, plan_id):
                return
            marker = meta.get('pending')
            if not (isinstance(marker, dict) and marker.get('request_id') == ctx.request_id):
                mark = {'kind': 'apply', 'request_id': ctx.request_id, 'service_id': self.service_id,
                        'plan_id': plan_id, 'as_human': bool(ctx.data.get('as_human')),
                        'started_at': now_iso()}
                written = ctx.store.write_meta(
                    ctx.conv_id, lambda m: m if _marks(m, ctx.request_id) else None if busy_why(m.get('pending'))
                    else self._holding(ctx, {**m, 'pending': mark}))
                if written is None:
                    now = ctx.store.meta(ctx.conv_id)
                    if now is None:
                        self._refuse(ctx, 'gone')
                    else:
                        self._refuse(ctx, busy_why(now.get('pending')) or 'busy-apply', meta=now)
                    return
                meta = written
            self._busy[ctx.key] = {'request_id': ctx.request_id, 'kind': 'apply', 'plan_id': plan_id}
        try:
            try:
                project = self.load_project(ctx.client, ctx.store.project_id)
            except ValueError as e:
                self._write(ctx.store, ctx.conv_id, lambda stored: stored, ctx.request_id)
                ctx.helper.error(str(e))
                return
            self._apply(ctx.client, project, ctx.store, ctx.conv_id, conv, meta,
                        {'plan_id': plan_id, 'as_human': ctx.data.get('as_human')}, ctx.request_id, ctx.helper)
        finally:
            self._leave(ctx)

    def _preflight(self, ctx, conv, meta, plan_id) -> None:
        """What a page asks before it writes a plan of its own (`page_wrote`):
        every check approval makes before it writes, answered ``ready`` or
        refused as the approval would be, writing nothing. The page writes
        only after ``ready``, then sends the approval with ``wrote_first``.
        Under the lock."""
        if not self._gate(ctx, conv, meta):
            return
        _, item = find_plan(conv, plan_id) if plan_id else (-1, None)
        if item is None:
            ctx.helper.error('No such plan in this conversation')
            return
        why = decided_refusal(item)
        if why:
            ctx.helper.error(why)
            return
        ops = (item.get('plan') or {}).get('ops') or []
        if not ops and item.get('status') is None:
            ctx.helper.error('Nothing to apply')
            return
        try:
            refusal = self.may_approve(ctx.client, ctx.store.project_id, ctx.store.user_id, ops)
        except Exception as e:  # noqa: BLE001 - the reason goes to the requester as one line
            refusal = ('Nothing was written. Who may approve it could not be read: '
                       f'{requester_message(e, secrets=self.REQUEST_SECRETS)}')
        if refusal:
            ctx.helper.error(refusal)
            return
        if item.get('status') is None:
            # The page writes next: a discard of the plan from now on asks
            # whether it did (`_op_discard`), and records it as this approval
            # would have: the box as ticked, the approver's review as read now.
            facts = {'as_human': bool(ctx.data.get('as_human')),
                     'reviewed': self._reviewed_now(ctx)}
            if not self._set_mark(ctx, plan_id, facts):
                self._refuse(ctx, 'gone')
                return
        ctx.helper.complete({'kind': 'ready'})

    def _discard_page_written(self, ctx, item, plan_id, meta) -> bool:
        """A discard of a plan its page may have written: settled applied,
        and answered so, when the page wrote it. True when it did. Under the
        lock."""
        if not (item.get('plan') or {}).get(PAGE_WRITING):
            return False
        # A ready preflight let the page write, and its approval never
        # came (lost, the service offline): written, it is applied,
        # as a run that wrote settles applied over a discard.
        # Its own page wrote them: settings that read as planned by
        # another route (a tab closed before its write, the change
        # then made by hand) leave it discardable.
        counts = self._page_wrote(ctx, item)
        if not (counts and self._page_operation(ctx, item, plan_id) is not False):
            return False
        facts = item['plan'][PAGE_WRITING]
        facts = facts if isinstance(facts, dict) else {}
        written = self._settle_written(ctx, item, plan_id, as_human=bool(facts.get('as_human')),
                                       reviewed=bool(facts.get('reviewed')))
        self._refuse(ctx, 'decided', ALREADY_WRITTEN,
                     meta=written if written is not None else meta)
        return True

    def _set_mark(self, ctx, plan_id, facts) -> bool:
        """Write ``facts`` as the plan's :data:`PAGE_WRITING` mark (None
        takes it off), on an undecided plan. False when the conversation is
        gone."""
        def mark(stored):
            index, it = find_plan(stored, plan_id)
            if it is None or it.get('status') is not None:
                return None
            plan = {k: v for k, v in it['plan'].items() if k != PAGE_WRITING}
            if facts is not None:
                plan[PAGE_WRITING] = facts
            display = list(stored['display'])
            display[index] = {**it, 'plan': plan}
            return {'messages': stored['messages'], 'display': display}
        return bool(self._write(ctx.store, ctx.conv_id, mark, None))

    def _op_unmark(self, ctx) -> None:
        """The page's write after a ready preflight failed: the mark comes
        off, unless the settings read as planned after all (then a discard
        still records the plan applied). Answers done either way."""
        plan_id = ctx.data.get('plan_id')
        with ctx.lock:
            conv, meta = self._prepare(ctx)
            if conv is None:
                self._refuse(ctx, 'gone')
                return
            _, item = find_plan(conv, plan_id) if plan_id else (-1, None)
            if (item is not None and item.get('status') is None and (item.get('plan') or {}).get(PAGE_WRITING)
                    and not self._page_wrote(ctx, item)):
                self._set_mark(ctx, plan_id, None)
            self._done(ctx, ctx.store.meta(ctx.conv_id) or meta)

    def _reviewed_now(self, ctx) -> bool:
        try:
            return bool(self._reviewed(ctx.client, ctx.store.project_id, ctx.store.user_id))
        except Exception:  # noqa: BLE001 - unreadable: recorded by the box, as an unreviewed approver's
            traceback.print_exc()
            return False

    def _page_wrote(self, ctx, item) -> Optional[Dict[str, int]]:
        """:meth:`page_wrote` of a plan item, None on any failure to tell."""
        ops = ((item or {}).get('plan') or {}).get('ops') or []
        if not ops:
            return None
        try:
            return self.page_wrote(ctx.client, ctx.store.project_id, ops)
        except Exception:  # noqa: BLE001 - not known to be written: the approval goes as any other
            traceback.print_exc()
            return None

    def _page_operation(self, ctx, item, plan_id) -> Optional[bool]:
        """:meth:`page_operation_wrote` of a plan item, read from a little
        before the plan was made (the service's clock and core's may
        differ). None on any failure to tell."""
        ops = ((item or {}).get('plan') or {}).get('ops') or []
        made = parse_time((item or {}).get('created_at'))
        since = now_iso(made - PAGE_AUDIT_SLACK) if made else None
        try:
            return self.page_operation_wrote(ctx.client, ctx.store.project_id, ops, plan_id, since)
        except Exception:  # noqa: BLE001 - not known: read as written, as before the log was asked
            traceback.print_exc()
            return None

    def _settle_in_force(self, ctx, conv, plan_id) -> bool:
        """Settle as applied an undecided plan the app writes itself whose
        changes already read as planned, approved with nothing written by
        its page (no ``wrote_first``, and no write under its operation in
        the audit log): another route made them. It is applied, as ruled
        (REV-AGENT R2-3), and the answer and the note say nothing was
        written. A plan its page wrote, whose approval was lost, takes the
        approval's own path. True when it settled. Under the lock."""
        if conv is None or not plan_id:
            return False
        _, item = find_plan(conv, plan_id)
        if item is None or item.get('status') is not None:
            return False
        counts = self._page_wrote(ctx, item)
        if not counts or self._page_operation(ctx, item, plan_id) is not False:
            return False
        if self._settle_written(ctx, item, plan_id, note=f'(note) The plan was approved. {IN_FORCE}') is None:
            self._refuse(ctx, 'gone')
            return True
        ctx.helper.complete({'kind': 'applied', 'applied': 0, 'counts': [], 'message': IN_FORCE})
        return True

    def _settle_page_written(self, ctx, conv, plan_id) -> bool:
        """Settle as applied a plan whose page said it wrote it
        (``wrote_first``) after a ``ready`` preflight, when its changes read
        as planned, and answer so. True when it did.

        The page has written by now, so nothing the approval checks may
        refuse it: another request under way, another tab holding the
        conversation, a discard or a newer plan that landed after the
        preflight. The record follows what is written, as a run that wrote
        settles applied over a discard. Another request's marker is kept.
        A plan whose changes read as planned by any other route takes the
        approval's own path. Under the lock."""
        if conv is None or not plan_id:
            return False
        _, item = find_plan(conv, plan_id)
        if item is None or item.get('status') in WROTE:
            return False
        counts = self._page_wrote(ctx, item)
        if not counts:
            return False
        ops = item['plan'].get('ops') or []
        if self._settle_written(ctx, item, plan_id) is None:
            ctx.helper.error('The changes were applied, but this conversation was deleted.')
            return True
        ctx.helper.complete({'kind': 'applied', 'applied': sum(counts.values()),
                             'counts': [{'kind': k, 'count': n} for k, n in counts.items()],
                             'message': f'Applied {self.summarize(ops)}.'})
        return True

    def _settle_written(self, ctx, item, plan_id, as_human: Optional[bool] = None,
                        reviewed: Optional[bool] = None, note: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Settle a plan its page wrote as applied, recorded as the
        approval's own path records it: by this approval's box and the
        approver's review now, or by ``as_human`` and ``reviewed`` as the
        preflight of an approval that never came stored them. The sidebar
        entry as written, or None when the conversation is gone."""
        plan = item['plan']
        ops = plan.get('ops') or []
        summary = plan.get('summary') or self.summarize(ops)
        note = note or f'(note) The plan was approved and applied: {summary}.'
        # Recorded as the approval's own path records it: a reviewed
        # approver's approval is a contribution, whatever the box said.
        if reviewed is None:
            reviewed = self._reviewed_now(ctx)
        if as_human is None:
            as_human = bool(ctx.data.get('as_human'))
        earlier = stamp_of(plan.get(WRITING))
        stamp_mode = earlier[0] if earlier else ('contributed' if reviewed else 'human' if as_human else 'verified')
        outcome = {'as_human': stamp_mode == 'human', **({'contributed': True} if stamp_mode == 'contributed' else {})}
        self._remember_applied(plan_id, 'applied', note, outcome)
        change = plan_settling(plan_id, 'applied', note, documents=plan.get('documents'),
                               expansion=plan.get(EXPANSION), writing=plan.get(WRITING), **outcome)
        if not self._write(ctx.store, ctx.conv_id, change, None):
            return None
        return ctx.store.meta(ctx.conv_id) or {}

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
            response_helper.error(decided_refusal(item))
            return
        # A second approval of the same plan (a retried request, a double
        # click) does not write it twice.
        if item.get('status') == 'applied' or (plan_id in self._applied_plans):
            settled()
            response_helper.complete({'kind': 'applied', 'applied': 0, 'counts': [], 'duplicate': True,
                                      'message': 'This plan was already applied. Nothing was written again.'})
            return
        if item.get('status') in ('replaced', 'discarded', 'stale'):
            settled()
            response_helper.error(decided_refusal(item))
            return
        ops = plan.get('ops') or []
        if not ops:
            settled()
            response_helper.error('Nothing to apply')
            return
        if not plan_changes(ops):
            # Only values kept as they are: approving it writes nothing, so
            # it settles as discarded, as its card offers (Luke 2026-10-16).
            settled('discarded', NOTHING_TO_WRITE_NOTE)
            response_helper.error('Nothing to write. The plan was discarded.')
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
        # A run again stamps as its first run did, whatever this request asks
        # and whatever the setting is now: it resends that run's batches under
        # the same keys, and the server refuses a used key with another body
        # (422 idempotency-key-reused), so a changed stamp could never finish.
        earlier = stamp_of(plan.get(WRITING))
        if earlier:
            stamp_mode, contributor = earlier
        else:
            try:
                contributor = store.user_id if self._reviewed(client, store.project_id, store.user_id) else None
            except Exception as e:  # noqa: BLE001 - the reason goes to the requester as one line
                settled()
                response_helper.error('Nothing was written. The project\'s review settings could not be '
                                      f'read: {requester_message(e, secrets=self.REQUEST_SECRETS)}')
                return
            stamp_mode = ('contributed' if contributor else 'human' if approve.get('as_human')
                          else 'verified')
        as_human = stamp_mode == 'human'
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
        return f'{which} is locked by another run. Try again in a minute.'

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
        def out_of_date(reasons, then=None):
            # Settled as out of date, so the card stops offering an Approve
            # that can only fail again, and the model is told on the next turn.
            said = ' '.join(_sentence(s) for s in reasons)

            def refuse():
                # The card says why, in the same words (`reason`).
                settled('stale', f'(note) The plan was not applied: {said} Nothing was written.', reason=said)
                response_helper.error(f'Nothing was written. {said} {then or "Ask the assistant to plan again."}')
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
            writing(client, plan, documents, lambda: remember(undecided=True), run=run, ops=ops,
                    stamp=stamp_mode, contributor=contributor)
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
                    raise
        except ScopeMoved as e:
            # A corpus-wide change found again reaches documents the plan was
            # not made over: never checked, never locked, not on the card.
            return out_of_date(_reach_moved(client, documents, e))
        except PlanOutOfDate as e:
            # Something the plan names outside its documents is gone, which no
            # document version says. Asked before the first write.
            return out_of_date(e.reasons, e.then)
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
                    if why == KEY_REUSED:
                        response_helper.error(f'Failed to apply the plan: {why}. Check those changes in '
                                              f'History, then ask the assistant to plan again.')
                    else:
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
                # A row another service wrote in part and counted (a parse
                # that stopped partway) is said in its count, kept on the
                # record too (Luke 2026-10-16).
                count = e.partly_count if len(partly) == 1 else None
                if count:
                    n, of, unit = count
                    outcome = (f'Written in part: {n} of {of} {unit}.' if not written_n
                               else f'{partial_tally(written_n, sum(sizes), 1)} ({n} of {of} {unit}).')
                fields = {'written': done, 'outcome': outcome, **({'unknown': True} if e.unknown else {}),
                          **({'in_part': list(count)} if count else {})}
                said = (f'Partly applied{". " if count and not written_n else ": "}{outcome} '
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


#: On a plan the page writes, set by a ready preflight: the page may have
#: written it since. Settling the plan clears it (`compact_plan`).
PAGE_WRITING = 'page_writing'
#: Why a discard of such a plan, written, settled it applied.
ALREADY_WRITTEN = 'The settings were already written, so the plan is recorded as applied.'
#: What an approval of such a plan answers when its settings were already in
#: force and its page wrote nothing (`_settle_in_force`).
IN_FORCE = 'The settings were already in force. Nothing was written.'
#: How far before a plan was made its page's operation is looked for.
PAGE_AUDIT_SLACK = timedelta(minutes=10)


def decided_refusal(item: Dict[str, Any]) -> Optional[str]:
    """Why a plan settled otherwise may not be approved, as the approval
    says it, or None (undecided, or applied, which a second approval answers
    as a duplicate)."""
    return {'partial': 'This plan was partly applied. Ask the assistant to finish it.',
            'replaced': 'A newer plan replaced this one. Approve the newer plan.',
            'discarded': 'The plan was discarded',
            'stale': 'The plan is out of date. Ask the assistant to plan again.'}.get(item.get('status'))


def audit_label(summary: str) -> str:
    """The label of a plan's operation, which History and the audit feed
    show: ``Assistant: <the plan's summary>`` as plain text, cut short with
    an ellipsis past :data:`AUDIT_LABEL_MAX`."""
    from .bidi import for_model
    from .plan import clip_caption
    # Plain text: the card's summary isolates each value for display, and
    # the marks left in the label kept a search for the value from finding it.
    label = for_model(f'Assistant: {summary}')
    if len(label) <= AUDIT_LABEL_MAX:
        return label
    return clip_caption(label, AUDIT_LABEL_MAX - 1) + '…'


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


#: A run again whose request differs from the one its first run sent under
#: the same key (422 ``idempotency-key-reused``): that run wrote some of the
#: plan, and this one can never finish it.
KEY_REUSED = 'an earlier run of this plan wrote some of it differently'


def _key_reused(e: BaseException) -> bool:
    """Whether the server refused a request of ``e``'s run as a used key with
    another body."""
    cause = e
    while cause is not None:
        if (isinstance(cause, PlaidAPIError) and cause.status == 422
                and isinstance(cause.response_data, dict)
                and cause.response_data.get('error') == 'idempotency-key-reused'):
            return True
        cause = cause.__cause__
    return False


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
    if _key_reused(e):
        return KEY_REUSED
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
