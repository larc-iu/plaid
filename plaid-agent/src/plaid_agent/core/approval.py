"""Approving a plan: the checks made before anything is written, the run
under the documents' locks, and how its outcome is settled on the record and
said to the user once the locks are released."""

from typing import Any, Dict, List, Optional

from plaid_client import DocumentLockLost, service_source
from plaid_client.http import PlaidAPIError
from plaid_client.provenance import is_reviewed
from plaid_client.service import requester_message

from .conversation import ConversationStore, find_plan, now_iso, partial_note, partial_tally, plan_settling
from .ops import busy_why
from . import rules
from .opkind import ROW
from .plan import (EXPANSION, WRITING, DocumentsBusy, Expansion, ExpansionUnreadable, PlanError, PlanMovedOn,
                   PlanOutOfDate, RecordFull, ScopeMoved, expanding, forget_held, holding, plan_changes, stamp_of,
                   writing)
from .conversation import WROTE
from .staleness import _named, stale_documents
from .record_ops import _marks


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


#: What the model is told of a plan approved with nothing to write.
NOTHING_TO_WRITE_NOTE = ('(note) The plan only kept values as they are, so it was settled as discarded: nothing '
                         'was changed.')


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
