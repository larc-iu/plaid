"""A plan the page writes itself, with the user's own session, where a
delegated token may not write (`BaseAssistantService.page_wrote`): the
preflight that lets the page write, the mark it leaves on the plan, and how
such a plan is settled once its changes read as planned."""

import traceback
from datetime import timedelta
from typing import Any, Dict, Optional

from plaid_client.service import requester_message

from .conversation import find_plan, now_iso, plan_settling
from .ops import parse_time
from .plan import EXPANSION, WRITING, stamp_of
from .conversation import WROTE
from .approval import decided_refusal


class PageWrites:
    """The page-written plans of `BaseAssistantService`."""

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
            # A review that cannot be read refuses, as the approval does.
            try:
                reviewed = self._reviewed_now(ctx, None)
            except Exception as e:  # noqa: BLE001 - the reason goes to the requester as one line
                ctx.helper.error(self._review_unread(e))
                return
            facts = {'as_human': bool(ctx.data.get('as_human')), 'reviewed': reviewed}
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

    def _reviewed_now(self, ctx, item) -> bool:
        """Whether the approver's work is reviewed: as the preflight's mark on
        ``item`` stored it, else read now (`_reviewed`, which raises on a
        failed read)."""
        facts = ((item or {}).get('plan') or {}).get(PAGE_WRITING)
        if isinstance(facts, dict) and 'reviewed' in facts:
            return bool(facts['reviewed'])
        return bool(self._reviewed(ctx.client, ctx.store.project_id, ctx.store.user_id))

    def _review_unread(self, e) -> str:
        """The refusal of an approval whose review settings could not be read."""
        return ('Nothing was written. The project\'s review settings could not be read: '
                f'{requester_message(e, secrets=self.REQUEST_SECRETS)}')

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
        try:
            reviewed = self._reviewed_now(ctx, item)
        except Exception as e:  # noqa: BLE001 - the reason goes to the requester as one line
            ctx.helper.error(self._review_unread(e))
            return True
        if self._settle_written(ctx, item, plan_id, reviewed=reviewed,
                                note=f'(note) The plan was approved. {IN_FORCE}') is None:
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
        approver's review as the preflight's mark stored it (read now when
        there is no mark, raising on a failed read), or by ``as_human`` and
        ``reviewed`` as the preflight of an approval that never came stored
        them. The sidebar entry as written, or None when the conversation is
        gone."""
        plan = item['plan']
        ops = plan.get('ops') or []
        summary = plan.get('summary') or self.summarize(ops)
        note = note or f'(note) The plan was approved and applied: {summary}.'
        # Recorded as the approval's own path records it: a reviewed
        # approver's approval is a contribution, whatever the box said.
        if reviewed is None:
            reviewed = self._reviewed_now(ctx, item)
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
