"""Approving a plan: the checks made before anything is written, the run
under the documents' locks, and how its outcome is settled on the record and
said to the user once the locks are released."""

from typing import Any, Dict, List, Optional

from plaid_client import DocumentLockLost, service_source
from plaid_client.service import requester_message

from .conversation import ConversationStore, MissingConversation, find_plan, now_iso, plan_settling
from .ops import busy_why
from . import rules
from .opkind import ROW
from .provenance import Requester
from .plan import DocumentsBusy, PlanError, PlanOutOfDate, ScopeMoved, holding, plan_changes
from .conversation import WROTE
from .staleness import _named, stale_documents
from .record_ops import _marks
from .outcome import Outcome, _sentence, partly_applied


class Approval:
    """One approval of one plan, as its run and its settling share it: the
    requester's client, the project, the conversation's store and id, the
    plan and its id, the request and its helper. `run_with` adds what the
    run writes with once the pre-checks pass."""

    def __init__(self, service, client, project, store: ConversationStore, conv_id: str, plan: Dict[str, Any],
                 plan_id: str, request_id, helper):
        self.service = service
        self.client = client
        self.project = project
        self.store = store
        self.conv_id = conv_id
        self.plan = plan
        self.plan_id = plan_id
        self.request_id = request_id
        self.helper = helper
        self.model = service.cfg.model
        self.ops: List[Dict[str, Any]] = []
        self.documents: List[Dict[str, Any]] = []
        self.summary = ''
        self.stamp_mode: Optional[str] = None
        self.contributor: Optional[str] = None
        self.detail: Dict[str, Any] = {}
        self.proposer = None

    def run_with(self, ops, documents, summary, stamp_mode, contributor, *, detail, proposer) -> None:
        """What the run writes with. ``detail`` and ``proposer`` are the model
        and version, and the service id, of the turn that proposed the plan."""
        self.ops, self.documents, self.summary = ops, documents, summary
        self.stamp_mode, self.contributor = stamp_mode, contributor
        self.detail, self.proposer = detail, proposer

    def settled(self, status=None, note=None, **fields) -> bool:
        """Clear the pending marker so the card is decidable again, and
        settle the plan as ``status`` when given (`plan_settling`). False
        when the conversation moved on, which `_write` reports rather than
        raising.

        An outcome that wrote (applied, partly applied) is written on the
        plan even when the conversation moved on (another request's
        marker stands): the record never says undecided over changes
        that landed, and the model is told. The other request's marker
        is kept. False only when the conversation is gone."""
        change = plan_settling(self.plan_id, status, note, **fields)
        if self.service._write(self.store, self.conv_id, change, self.request_id, self.model):
            return True
        return status in WROTE and self.service._write(self.store, self.conv_id, change, None, self.model)

    def still_undecided(self) -> bool:
        """Whether the record still has the plan undecided under this
        approval's marker, read just before the first change is sent: a
        discard that landed in between, another request that took the
        conversation, or the conversation deleted, and nothing is sent."""
        try:
            conv, meta = self.store.load(self.conv_id)
        except MissingConversation:
            return False
        _, item = find_plan(conv, self.plan_id)
        marker = meta.get('pending') if isinstance(meta, dict) else None
        return (item is not None and item.get('status') is None and isinstance(marker, dict)
                and marker.get('request_id') == self.request_id)


class Approving:
    """The approval of `BaseAssistantService`."""

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

    @staticmethod
    def _reviewed(client, project_id: str, user_id: str) -> bool:
        """Whether the approver's work is reviewed in the project, read from
        the server (:meth:`Requester.reviewed`). A failed read of the project
        or of the approver's record raises, and the approval is refused."""
        project = client.projects.get(project_id)
        return Requester(client, user_id, strict=True).reviewed(project)

    def _apply(self, client, project, store, conv_id, conv, meta, approve: dict, request_id, response_helper) -> None:
        plan_id = approve.get('plan_id')
        _, item = find_plan(conv, plan_id) if plan_id else (-1, None)
        if item is None:
            response_helper.error('No such plan in this conversation')
            return
        plan = item['plan']
        ap = Approval(self, client, project, store, conv_id, plan, plan_id, request_id, response_helper)
        settled = ap.settled

        # A plan that stopped partway is settled: finishing it is a new plan.
        if item.get('status') == 'partial':
            settled()
            response_helper.error(decided_refusal(item))
            return
        # A second approval of the same plan (a retried request, a double
        # click) does not write it twice.
        if item.get('status') == 'applied':
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
        try:
            contributor = store.user_id if self._reviewed(client, store.project_id, store.user_id) else None
        except Exception as e:  # noqa: BLE001 - the reason goes to the requester as one line
            settled()
            response_helper.error(self._review_unread(e))
            return
        stamp_mode = 'contributed' if contributor else 'human' if approve.get('as_human') else 'verified'
        documents = plan.get('documents') or []
        ap.run_with(ops, documents, plan.get('summary') or self.summarize(ops), stamp_mode, contributor,
                    detail=proposed_by(item), proposer=item['service'])
        # The plan is written in several requests, and a document opened in
        # between is half written: its editor's repair on open can delete what
        # the first batch made, and the next batch fails. So every document the
        # plan writes is held (see core/plan.py `holding`) from the staleness
        # check, which then reads the state the writes go onto, to the last
        # write. The conversation record is written only once they are
        # released: a lock that lapsed refuses every later write this client
        # makes while the block runs, the record's too, which would leave the
        # card pending over a plan that stopped partway.
        try:
            with holding(client, self.documents_to_lock(ops, documents)):
                outcome = self._check_and_execute(ap)
        except DocumentsBusy as e:
            name = next((d.get('name') for d in documents
                         if isinstance(d, dict) and d.get('id') == e.document_id), None)
            which = f'"{name}"' if name else 'A document'
            if e.cause is None:
                said = f'{which} is locked by another run. Try again in a minute.'
            else:
                said = (f'{which} could not be locked for the change '
                        f'({requester_message(e.cause, secrets=self.REQUEST_SECRETS)}). Approve again.')
            outcome = Outcome.refused(f'Nothing was written. {said}')
        self._settle(ap, outcome)

    def _settle(self, ap: 'Approval', outcome: Outcome) -> None:
        """Write what an approval's run came to on the record and answer the
        request: the one place every outcome is settled, after the documents'
        locks are released."""
        if outcome.counts is not None:
            self._settle_applied(ap, outcome.counts)
            return
        if outcome.failure is not None:
            outcome = self._failed(ap, outcome.failure)
        kept = ap.settled(outcome.status, outcome.note, **outcome.fields)
        if outcome.written is not None:
            said = outcome.message + ('' if kept else ' This conversation was deleted.')
            ap.helper.complete({'kind': 'applied', 'partial': True, 'applied': outcome.written,
                                'counts': [], 'message': said})
            return
        ap.helper.error(_moved_on(ap.store, ap.conv_id, ap.plan_id) if outcome.moved_on else outcome.message)

    @staticmethod
    def _failed(ap: 'Approval', e: PlanError) -> Outcome:
        """A run that failed (``e``): partly applied when it wrote, else
        refused with nothing written, worded as the user reads it."""
        why = 'the server did not answer' if e.unknown else _failure(ap.client, ap.documents, e)
        if e.wrote:
            return partly_applied(ap.ops, e, why)
        return Outcome.refused(f'Failed to apply the plan: {why}. Nothing was written.')

    def _settle_applied(self, ap: 'Approval', counts: Dict[str, Any]) -> None:
        """A plan written in full: settled applied and answered with its
        counts."""
        counts = dict(counts)
        notes = counts.pop('notes', [])
        # Card rows that wrote nothing under this approval (a contributor's
        # confirmation of only other contributors' work), which the card does
        # not show as applied.
        unwritten = counts.pop('unwritten', [])
        note = f'(note) The plan was approved and applied: {ap.summary}.' + (' ' + '; '.join(notes) if notes else '')
        # Settled even when the conversation moved on (`settled`), so the card
        # never offers Approve over work already done.
        # What the record keeps of the outcome: how the approval was recorded,
        # and what applying dropped (a change a later one superseded, say),
        # since each change's outcome is otherwise the plan's.
        outcome = {'as_human': ap.stamp_mode == 'human', **({'contributed': True} if ap.contributor else {}),
                   **({'apply_notes': notes} if notes else {}),
                   **({'unwritten': unwritten} if unwritten else {})}
        if not ap.settled('applied', note, **outcome):
            ap.helper.error('The changes were applied, but this conversation was deleted.')
            return
        ap.helper.progress(100, 'Done')
        ap.helper.complete({
            'kind': 'applied', 'applied': sum(counts.values()),
            'counts': [{'kind': k, 'count': n} for k, n in counts.items()],
            'message': f'Applied {self.summarize(ap.ops)}.' + ''.join(' ' + _sentence(n) for n in notes),
        })

    def _check_and_execute(self, ap: 'Approval') -> Outcome:
        """The staleness check and the writes, under the documents' locks.
        The writes name the assistant that proposed the plan (``ap.detail``
        and ``ap.proposer``: `provSource`, `provDetail`), and so does the
        operation's ref, whichever is running now. What the run came to, which
        `_settle` writes on the conversation record once the locks are
        released: the record must not be written under a lock that may have
        lapsed."""
        client, ops, documents = ap.client, ap.ops, ap.documents

        def out_of_date(reasons, then=None):
            # Settled as out of date, so the card stops offering an Approve
            # that can only fail again, and the model is told on the next turn.
            # The card says why, in the same words (`reason`).
            said = ' '.join(_sentence(s) for s in reasons)
            return Outcome.refused(f'Nothing was written. {said} {then or "Ask the assistant to plan again."}',
                                   'stale', f'(note) The plan was not applied: {said} Nothing was written.',
                                   reason=said)

        stale = self._stale(client, ap.project, documents)
        if stale:
            return out_of_date(stale)

        # Where an approval and a discard of the same plan meet: a plan is
        # never written after the record says it was decided.
        if not ap.still_undecided():
            return Outcome.refused(moved_on=True)
        ap.helper.progress(10, 'Applying changes…')
        # One operation of kind assistant-plan, naming the conversation, the
        # plan and the assistant that proposed it, so the audit log says which
        # writes a plan made. The app's own operation inside flattens into it.
        label = audit_label(ap.summary)
        source = service_source(ap.proposer)
        ref = f'conv:{ap.conv_id}/plan:{ap.plan_id}/{source}'
        try:
            # Keyed by the plan's id, and every row it creates is named by an
            # id drawn from it (`core.plan.Minter`): a request sent again after
            # its answer was lost is answered from its first send, or a create
            # is refused as a taken id, which the executor takes as made.
            keys = {'seed': ap.plan_id, 'stamps': {}}
            with client.operation(label, kind='assistant-plan', ref=ref, keys=keys) as operation:
                # Each op names its row on the card, so a plan that stops
                # partway can say which changes were written.
                try:
                    counts = self.execute_plan(client, [{**op, ROW: i} for i, op in enumerate(ops)],
                                               source=source,
                                               label=label, project=ap.project,
                                               stamp_mode=ap.stamp_mode, contributor=ap.contributor,
                                               requester=ap.store.user_id, detail=ap.detail,
                                               seed=ap.plan_id)
                except PlanError as e:
                    # History names what was written, not the whole plan.
                    if e.wrote:
                        partly_label = self.partial_label(ops, e.written or [], ap.summary)
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
            return Outcome.failed(e)
        except ValueError as e:
            return Outcome.refused(f'The plan was rejected before anything was written: {e}')
        return Outcome.applied(counts)

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


#: What the model is told of a plan approved with nothing to write.
NOTHING_TO_WRITE_NOTE = ('(note) The plan only kept values as they are, so it was settled as discarded: nothing '
                         'was changed.')


def _moved_on(store: ConversationStore, conv_id: str, plan_id: str) -> str:
    """Why an approval found the record moved on before it sent anything
    (`Approval.still_undecided`), as the page says it."""
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


#: The longest audit label a plan's operation carries, in code points. It
#: goes in the request's URL (``?group-message=``), percent-encoded, and the
#: core keeps 1,000 UTF-16 units of it, so a plan naming many rules stays
#: well inside both.
AUDIT_LABEL_MAX = 400


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
