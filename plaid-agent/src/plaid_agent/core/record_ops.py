"""The ops on a conversation record that the page sends (`core.ops`): each
takes the conversation's lock, reads the record, settles what a dead request
left there, decides, writes and lets go. Here are the ones that need no model,
the send and retry that start a turn, and the answers the record could not
take, kept and written again."""

import threading
import re
import time
import traceback
from typing import Any, Dict, Optional

from plaid_client import ServiceCancelled

from .conversation import (DIED_NOTE, DIED_OUTCOME, DISCARDED_NOTE, MESSAGE_ROOM, MissingConversation, build_meta, conversation_bytes,
                           error_item, find_plan, kept_meta, now_iso, prune, record_budget, rewind_for_retry,
                           settle_plan, title_from, turn_ending, user_item, value_cap)
from .files import store_parts, sweep_orphans
from .ops import CONVERSATION_FULL, MESSAGE_TOO_LONG, about_of, busy_why, hold_free, refused


class RecordOps:
    """The record ops of `BaseAssistantService`."""

    def _alive(self, ctx, pending: Dict[str, Any]) -> bool:
        """Whether the request a marker names is still under way: this
        process runs it, or another assistant process that is online on the
        project does. A marker naming no service (an old page's) has nothing
        behind it."""
        rid = pending.get('request_id')
        sid = pending.get('service_id')
        if rid and rid == ctx.request_id:
            return True
        if not rid or not sid:
            return False
        if sid == self.service_id:
            return (self._busy.get(ctx.key) or {}).get('request_id') == rid
        try:
            found = ctx.client.messages.discover_services(ctx.store.project_id) or []
        except Exception:  # noqa: BLE001 - an unanswered lookup keeps the other's work
            return True
        return any(isinstance(s, dict) and s.get('service_id') == sid and s.get('online') is not False
                   for s in found)

    def _prepare(self, ctx):
        """The record as stored, ``(conv, meta)``, or ``(None, None)`` when
        there is none, after writing an answer this process still holds for
        it and settling a marker a dead request left. Under the lock."""
        self._flush_unsaved(ctx.key)
        try:
            conv, meta = ctx.store.load(ctx.conv_id)
        except MissingConversation:
            return None, None
        pending = meta.get('pending')
        if pending and not (isinstance(pending, dict) and self._alive(ctx, pending)):
            settled = self._settle_dead(ctx, pending)
            if settled is None:
                return None, None
            conv, meta = settled
        return conv, meta

    def _settle_dead(self, ctx, pending):
        """What a request that will never end left (the service restarted, or
        an old page's marker): a turn's marker is cleared and nothing is
        added, since an unanswered question already reads as one with Retry.
        An approval's plan is settled partly applied, since any of its changes
        may be written (`DIED_OUTCOME`), and the model is told so. The record
        as written, or None when it is gone."""
        dead = pending.get('request_id') if isinstance(pending, dict) else None
        plan_id = pending.get('plan_id') if isinstance(pending, dict) and pending.get('kind') == 'apply' else None

        def change(stored):
            if not plan_id:
                return stored
            index, item = find_plan(stored, plan_id)
            if item is None or item.get('status') is not None:
                return stored
            return settle_plan(stored, index, 'partial', DIED_NOTE, written=[], outcome=DIED_OUTCOME,
                               as_human=bool(pending.get('as_human')))
        out = {}

        def meta_of(conv, prev):
            marked = prev.get('pending')
            same = marked == pending or (isinstance(marked, dict) and marked.get('request_id') == dead)
            meta = kept_meta(prev, conv if conv is not out.get('read') else None,
                             **({'pending': None} if same else {}))
            out['conv'], out['meta'] = conv, meta
            return meta

        def tracked(stored):
            out['read'] = stored
            return change(stored)
        if not ctx.store.write(ctx.conv_id, tracked, meta_of, None):
            return None
        print(f'Conversation {ctx.conv_id}: settled what request {dead} left.')
        return out['conv'], out['meta']

    def _refuse(self, ctx, why, message=None, meta=None) -> None:
        ctx.helper.complete(refused(why, message, meta))

    def _done(self, ctx, meta) -> None:
        ctx.helper.complete({'kind': 'done', 'meta': meta})

    def _holding(self, ctx, meta) -> Dict[str, Any]:
        """The entry with this tab holding it from now."""
        return {**meta, 'holder': {'tab': ctx.tab, 'at': now_iso()}} if ctx.tab else meta

    def _gate(self, ctx, conv, meta, *, work: bool = True, take: bool = False) -> bool:
        """Whether this tab may act now. Refuses (and says so) when the
        conversation is gone, another tab holds it, or, for ``work``, a turn
        or an approval is under way there."""
        if conv is None:
            self._refuse(ctx, 'gone')
            return False
        if not hold_free(meta, ctx.tab, take):
            self._refuse(ctx, 'held', meta=meta)
            return False
        why = busy_why(meta.get('pending'))
        if work and why and (meta['pending'] or {}).get('request_id') != ctx.request_id:
            self._refuse(ctx, why, meta=meta)
            return False
        return True

    # --- the ops that need no model ---------------------------------------------------

    def _op_hold(self, ctx) -> None:
        with ctx.lock:
            conv, meta = self._prepare(ctx)
            take = bool(ctx.data.get('take'))
            if not self._gate(ctx, conv, meta, work=False, take=take):
                return
            written = ctx.store.write_meta(ctx.conv_id, lambda m: self._holding(ctx, m))
            if written is None:
                self._refuse(ctx, 'gone')
                return
        self._done(ctx, written)

    def _op_rename(self, ctx) -> None:
        title = title_from(str(ctx.data.get('title') or ''))
        with ctx.lock:
            if not title:
                ctx.helper.error('A conversation needs a name.')
                return
            written = ctx.store.write_meta(ctx.conv_id, lambda m: {**m, 'title': title})
            if written is None:
                self._refuse(ctx, 'gone')
                return
        self._done(ctx, written)

    def _op_attach(self, ctx) -> None:
        f = ctx.data.get('file') or {}
        parts = f.get('parts')
        if (not isinstance(f, dict) or not _ID_RE.match(str(f.get('id') or ''))
                or not isinstance(parts, list) or not parts or not all(isinstance(p, str) for p in parts)):
            ctx.helper.error('That file could not be read.')
            return
        with ctx.lock:
            conv, meta = self._prepare(ctx)
            if conv is not None and not hold_free(meta, ctx.tab):
                self._refuse(ctx, 'held', meta=meta)
                return
            store_parts(ctx.store, ctx.conv_id, f['id'], parts)
        self._done(ctx, meta)

    def _op_delete(self, ctx) -> None:
        with ctx.lock:
            meta = ctx.store.meta(ctx.conv_id)
            pending = (meta or {}).get('pending')
            if isinstance(pending, dict) and pending.get('kind') == 'apply' and self._alive(ctx, pending):
                self._refuse(ctx, 'delete-applying', meta=meta)
                return
            running = self._busy.get(ctx.key)
            if running is not None:
                # Stopped first: what it would write finds the entry gone.
                running['cancel'] = True
            ctx.store.delete(ctx.conv_id)
            self._unsaved.pop(ctx.key, None)
        self._sweep(ctx)
        self._done(ctx, None)

    def _op_discard(self, ctx) -> None:
        plan_id = ctx.data.get('plan_id')
        with ctx.lock:
            conv, meta = self._prepare(ctx)
            if not self._gate(ctx, conv, meta):
                return
            _, item = find_plan(conv, plan_id) if plan_id else (-1, None)
            if item is None:
                ctx.helper.error('No such plan in this conversation')
                return
            if item.get('status') == 'stale':
                if item.get('dismissed'):
                    self._done(ctx, meta)
                    return
            elif item.get('status') == 'discarded':
                self._done(ctx, meta)
                return
            elif item.get('status') is not None:
                self._refuse(ctx, 'decided', meta=meta)
                return
            elif self._discard_page_written(ctx, item, plan_id, meta):
                return
            out = {}

            def change(stored):
                index, it = find_plan(stored, plan_id)
                if it is None:
                    return None
                if it.get('status') == 'stale':
                    if it.get('dismissed'):
                        return stored
                    display = list(stored['display'])
                    display[index] = {**it, 'dismissed': True, 'dismissed_at': now_iso()}
                    return {'messages': stored['messages'], 'display': display}
                if it.get('status') == 'discarded':
                    # Its discard landed (this one's, its answer lost and the
                    # write made again, or another's): discarded is the outcome.
                    return stored
                if it.get('status') is not None:
                    return None
                return settle_plan(stored, index, 'discarded', DISCARDED_NOTE)

            def meta_of(c, prev):
                out['meta'] = self._holding(ctx, kept_meta(prev, c))
                return out['meta']
            if not ctx.store.write(ctx.conv_id, change, meta_of, ctx.request_id):
                self._refuse(ctx, 'decided', meta=meta)
                return
        self._done(ctx, out['meta'])

    # --- the ops that start a turn ---------------------------------------------------

    def _op_send(self, ctx, retry: bool = False) -> None:
        data = ctx.data
        with ctx.lock:
            if self._running_here(ctx):
                return
            conv, meta = self._prepare(ctx)
            create = bool(data.get('create')) and not retry
            if conv is None and not create:
                self._refuse(ctx, 'gone')
                return
            own = _own_question(conv, meta, ctx.request_id) if conv is not None else None
            if own is not None and own['answered']:
                # Sent again after its answer was lost: the answer is in the record.
                ctx.helper.complete({'kind': 'turn', 'message': own['answer'], 'again': True})
                return
            if conv is not None and own is None and not self._gate(ctx, conv, meta):
                return
            if own is None:
                written = self._record_question(ctx, conv, meta, retry)
                if written is None:
                    return
            else:
                written = self._remark(ctx, conv, meta, own['where'])
                if written is None:
                    return
            conv, meta, where = written
            self._busy[ctx.key] = {'request_id': ctx.request_id, 'kind': 'turn'}
        try:
            try:
                ctx.helper.progress(2, 'Thinking…', recorded=True)
            except ServiceCancelled:
                ctx.helper.cancelled = True
            try:
                project = self.load_project(ctx.client, ctx.store.project_id)
            except ValueError as e:
                self._write(ctx.store, ctx.conv_id,
                            turn_ending(conv, conv['messages'],
                                        error_item(str(e), model=self.cfg.model, version=self.version,
                                                   service=self.service_id)),
                            ctx.request_id)
                ctx.helper.error(str(e))
                return
            self._turn(ctx.client, project, ctx.store, ctx.conv_id, conv, meta, ctx.request_id, ctx.helper,
                       {**data, 'where': where}, cancel=lambda: bool((self._busy.get(ctx.key) or {}).get('cancel')))
        finally:
            self._leave(ctx)

    def _op_retry(self, ctx) -> None:
        self._op_send(ctx, retry=True)

    def _record_question(self, ctx, conv, meta, retry: bool):
        """Append the user's message (or, for ``retry``, the last one again
        after its attempt), mark the turn and the tab's hold, and write it in
        one record write. ``(conv, meta, where)`` as written, or None when
        refused (said so)."""
        data = ctx.data
        client = ctx.client
        if retry:
            rewound = rewind_for_retry(conv)
            if rewound is None:
                self._refuse(ctx, 'answered', meta=meta)
                return None
            base, asked = rewound
            text = asked['text']
            fields = {'files': asked.get('files'), 'projects': asked.get('projects'),
                      'where': asked.get('where'), 'retry': True}
        else:
            base = conv or {'messages': [], 'display': []}
            text = str(data.get('text') or '').strip()
            if not text:
                ctx.helper.error('The message is empty.')
                return None
            fields = {'files': data.get('files'), 'projects': data.get('projects'), 'where': data.get('where')}
        item = user_item(text, request_id=ctx.request_id, **fields)
        said = {'role': 'user', 'content': text}
        cap = value_cap(client)
        budget = record_budget(client)

        def appended(stored):
            if any(isinstance(d, dict) and d.get('request_id') == ctx.request_id for d in stored['display']):
                return stored
            new = {'messages': stored['messages'] + [said], 'display': stored['display'] + [item]}
            if conversation_bytes(new) > budget:
                new = prune(new, budget, (float('inf'), lambda m: 0))
            return new
        first = appended(base)
        if cap is not None and conversation_bytes(first) > budget:
            before = conversation_bytes(base)
            message = CONVERSATION_FULL if before + MESSAGE_ROOM >= budget else MESSAGE_TOO_LONG
            self._refuse(ctx, 'full', message, meta=meta)
            return None
        marker = {'kind': 'turn', 'request_id': ctx.request_id, 'service_id': self.service_id,
                  'started_at': now_iso()}
        if conv is None:
            meta = build_meta(None, ctx.conv_id, first, self.service_id, self.cfg.model, pending=marker,
                              version=self.version)
            meta['about'] = about_of(fields.get('where'))
            meta = self._holding(ctx, meta)
            if not ctx.store.create(ctx.conv_id, first, meta):
                self._refuse(ctx, 'gone')
                return None
            self._sweep(ctx)
            stored, meta = ctx.store.load(ctx.conv_id)
            return stored, meta, fields.get('where')
        out = {}

        def change(stored):
            # This request's question already landed (its write was answered
            # with nothing and made again): rewinding again would take the
            # question's model copy off and add a lost line under it.
            if any(isinstance(d, dict) and d.get('request_id') == ctx.request_id for d in stored['display']):
                out['conv'] = stored
                return stored
            if retry:
                again = rewind_for_retry(stored)
                if again is None:
                    return None
                stored = again[0]
            out['conv'] = appended(stored)
            return out['conv']

        def meta_of(c, prev):
            out['meta'] = self._holding(ctx, build_meta(prev, ctx.conv_id, c, prev.get('service_id') or self.service_id,
                                                       prev.get('model') or self.cfg.model, pending=marker,
                                                       version=prev.get('version') or self.version))
            return out['meta']
        if not ctx.store.write(ctx.conv_id, change, meta_of, ctx.request_id):
            now = ctx.store.meta(ctx.conv_id)
            if now is None:
                self._refuse(ctx, 'gone')
            elif retry and out.get('conv') is None:
                self._refuse(ctx, 'answered', meta=now)
            else:
                self._refuse(ctx, busy_why(now.get('pending')) or 'busy-turn', meta=now)
            return None
        stored, meta = ctx.store.load(ctx.conv_id)
        return stored, meta, fields.get('where')

    def _remark(self, ctx, conv, meta, where):
        """A request sent again whose question is in the record: its marker
        put back if a settle cleared it, nothing appended."""
        marker = meta.get('pending')
        if isinstance(marker, dict) and marker.get('request_id') == ctx.request_id:
            return conv, meta, where
        if marker:
            self._refuse(ctx, busy_why(marker) or 'busy-turn', meta=meta)
            return None
        mark = {'kind': 'turn', 'request_id': ctx.request_id, 'service_id': self.service_id,
                'started_at': now_iso()}
        written = ctx.store.write_meta(ctx.conv_id, lambda m: m if _marks(m, ctx.request_id) else
                                       None if m.get('pending') else self._holding(ctx, {**m, 'pending': mark}))
        if written is None:
            self._refuse(ctx, 'gone')
            return None
        return conv, written, where

    # --- answers the record could not take, and files left behind ---------------------

    def _keep_unsaved(self, store, conv_id, change, request_id, model) -> None:
        """An answer whose write the server never answered: kept here and
        written again, with the next op on the conversation first, and in the
        background while the request's token lives."""
        key = (store.user_id, store.project_id, conv_id)
        entry = {'store': store, 'conv_id': conv_id, 'change': change, 'request_id': request_id,
                 'model': model, 'until': time.monotonic() + UNSAVED_FOR_S}
        self._unsaved[key] = entry

        def again():
            delay = 15.0
            while time.monotonic() < entry['until'] and self._unsaved.get(key) is entry:
                time.sleep(delay)
                delay = min(delay * 2, 300.0)
                self._flush_unsaved(key)
        threading.Thread(target=again, daemon=True).start()

    def _flush_unsaved(self, key) -> None:
        entry = self._unsaved.get(key)
        if entry is None:
            return
        with self._conv_lock(key):
            if self._unsaved.get(key) is not entry:
                return
            if time.monotonic() > entry['until']:
                self._unsaved.pop(key, None)
                return
            try:
                self._write(entry['store'], entry['conv_id'], entry['change'], entry['request_id'],
                            entry['model'])
            except Exception:  # noqa: BLE001 - kept for the next try
                traceback.print_exc()
                return
            self._unsaved.pop(key, None)

    def _sweep(self, ctx) -> None:
        """Delete the parts of files whose conversation has no entry (an
        attach whose send never came), older than an hour, once an hour per
        user and project."""
        tag = (ctx.store.user_id, ctx.store.project_id)
        now = time.monotonic()
        if now - self._swept.get(tag, -ORPHAN_SWEEP_S) < ORPHAN_SWEEP_S:
            return
        self._swept[tag] = now
        try:
            sweep_orphans(ctx.store)
        except Exception:  # noqa: BLE001 - a sweep is housekeeping
            traceback.print_exc()


#: How long an answer whose write was never answered is kept and tried again:
#: as long as the request's delegated token lives (core's default, an hour).
UNSAVED_FOR_S = 60 * 60

#: How often files left behind are looked for, per user and project.
ORPHAN_SWEEP_S = 60 * 60

_ID_RE = re.compile(r'^[0-9A-Za-z-]{8,64}$')


class _Op:
    """One request on a conversation: what it asked, who asked, and the
    conversation's lock."""

    def __init__(self, service, data, helper, store, conv_id, request_id):
        self.data = data
        self.helper = helper
        self.store = store
        self.conv_id = conv_id
        self.request_id = request_id
        self.client = data.get('requester_client')
        self.tab = data.get('tab') or None
        self.key = (store.user_id, store.project_id, conv_id)
        self.lock = service._conv_lock(self.key)


def _marks(meta, request_id) -> bool:
    """Whether the entry's marker names this request: its own write of it
    landed and the answer was lost, so the write made again finds it there."""
    pending = (meta or {}).get('pending')
    return bool(request_id) and isinstance(pending, dict) and pending.get('request_id') == request_id


def _own_question(conv, meta, request_id) -> Optional[Dict[str, Any]]:
    """The question this request already recorded (it was sent again after
    its answer was lost, or delivered twice), as ``{answered, answer,
    where}``, or None. Found by its request id on the item, or by the
    marker naming this request."""
    if not request_id:
        return None
    display = conv['display']
    at = next((i for i in range(len(display) - 1, -1, -1)
               if isinstance(display[i], dict) and display[i].get('kind') == 'user'
               and display[i].get('request_id') == request_id), None)
    marker = (meta or {}).get('pending')
    if at is None:
        if not (isinstance(marker, dict) and marker.get('request_id') == request_id):
            return None
        at = next((i for i in range(len(display) - 1, -1, -1)
                   if isinstance(display[i], dict) and display[i].get('kind') == 'user'), None)
        if at is None:
            return None
    after = [d for d in display[at + 1:] if isinstance(d, dict)]
    answer = next((d for d in after if d.get('kind') == 'assistant'), None)
    return {'answered': answer is not None, 'answer': (answer or {}).get('text') or '',
            'where': display[at].get('where')}
