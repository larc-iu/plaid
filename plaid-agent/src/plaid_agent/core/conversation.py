"""The conversation record: how a chat with the assistant is stored.

A conversation lives in the user's private key/value store on the Plaid
server (``client.user_data``), private to that user and following them
across devices, under two keys per conversation. ``<app>`` is the app's own
short tag, so one user's assistants never read each other's conversations:

``<app>:assistant:<project>:meta:<id>``
    A small sidebar entry: title, timestamps, which assistant answers, how
    many turns, and ``pending`` while work is under way (the request id, so
    a browser that comes back can rejoin it).
``<app>:assistant:<project>:conv:<id>``
    The transcript the model sees (``messages``: OpenAI-shaped, tool calls
    and results included, so a later turn builds on what an earlier one
    read) and what the person sees (``display``: user, assistant, and error
    items, an assistant item carrying its plan, citations, and trace).

The service owns the record while it works: the browser appends the user's
message and marks the conversation pending, submits the request, and from
then on only reads. The service loads the record, runs the turn, and writes
the reply back before reporting the request done, so the answer lands
whether or not anyone is still watching the request's stream.

Keys are snake_case here and camelCase in the browser. The clients recase
them on the wire, so both sides read one record.
"""

import copy
import json
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from plaid_client.http import PlaidAPIError

from .plan import expand_ops
from .trace import summarize_steps

# What one stored record may weigh, when the server does not say. A turn's
# tool results are almost all of a conversation's weight and the part it can
# spare: the reply that drew conclusions from them stays, and so does every
# question and every plan. Past the budget the oldest tool results are
# dropped, in order, until it fits.
#
# This is a budget in BYTES. The record's real cap is the server's, which it
# publishes (`record_budget`), and this is the fallback for a server that does
# not. It is also what the model TRANSCRIPT is held to when the model's window
# is not known: when the server's cap was 1MB the cap bounded the transcript
# as well, and at the 5MB default or whatever an operator raises it to
# (`[user_data] max_value_mb`) it no longer does. With the window known the transcript
# is held to a share of it in tokens instead (`prune`'s ``transcript``).
CONVERSATION_BUDGET = 700_000
# The share of the server's cap the service fills. The service is not the
# record's only writer: the browser adds the next message and a discard's note
# to the record as it stands, so a record pruned to the cap exactly took the
# user's next message back as a 413, and the turn ran without it.
RECORD_HEADROOM = 0.9
DROPPED = '[This result was dropped to keep the conversation within its size limit.]'
TITLE_MAX = 60


# How long a read or a write of the record waits out a server that is away,
# in seconds: restarting (a proxy's 502, 503 or 504) or not answering at all.
# A turn that ends while the server restarts is minutes of work, and its
# answer is written only here: a save that gave up at once lost it although
# the server was back fifteen seconds later.
SERVER_AWAY_S = 120
_AWAY = (None, 0, 502, 503, 504)
_pause = time.sleep


def _patiently(call):
    """``call()``, tried again while the server is away, up to
    :data:`SERVER_AWAY_S`. Any other refusal is raised at once. A put
    replaces the whole value, so sending it again stores what sending it once
    does."""
    waited, delay = 0.0, 1.0
    while True:
        try:
            return call()
        except PlaidAPIError as e:
            if e.status not in _AWAY or waited >= SERVER_AWAY_S:
                raise
        _pause(delay)
        waited += delay
        delay = min(delay * 2, 15.0)


def conv_key(app: str, project_id: str, conv_id: str) -> str:
    return f'{app}:assistant:{project_id}:conv:{conv_id}'


def meta_key(app: str, project_id: str, conv_id: str) -> str:
    return f'{app}:assistant:{project_id}:meta:{conv_id}'


def now_iso(at: Optional[datetime] = None) -> str:
    """``at`` (now by default) as the record writes every time: UTC, to the
    millisecond, with a ``Z``, the same string a browser's
    ``Date.toISOString`` gives (plaid-ui ``itemTime``)."""
    at = at or datetime.now(timezone.utc)
    return at.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class MissingConversation(Exception):
    """No record under the conversation's keys (never saved, or deleted)."""


class RecordMoved(Exception):
    """The record kept changing under a write that was made again on it each
    time, more times than :data:`WRITE_TRIES`."""


# How many times a write of the record is made again on what is stored when
# another writer's write landed first (a 409 on the version it was made from).
# Each try reads the record again, so only a writer racing every one of them
# runs out.
WRITE_TRIES = 8


def _moved(e: PlaidAPIError) -> bool:
    return e.status == 409


class ConversationStore:
    """Read and write one user's conversations on a project, under one app's
    key prefix.

    The record has two writers, the browser and the service, and each keeps a
    copy. A write names the version of the entry it was made from
    (``user_data.put(..., version=)``), so a write from a copy that another
    write overtook is refused (409) rather than putting back what was there
    before it. :meth:`write` then reads the record again and makes its change
    on what it finds. The store remembers, per conversation, the version and
    the value of each key as this request last read or wrote them."""

    def __init__(self, client, user_id: str, project_id: str, app: str):
        self.client = client
        self.user_id = user_id
        self.project_id = project_id
        self.app = app
        #: key -> (version, value) as last read or written here
        self._seen: Dict[str, Tuple[int, Any]] = {}

    def load(self, conv_id: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """(conversation, meta). Raises :class:`MissingConversation`."""
        conv = self._get(conv_key(self.app, self.project_id, conv_id))
        meta = self._get(meta_key(self.app, self.project_id, conv_id))
        if conv is None or meta is None:
            raise MissingConversation(conv_id)
        return _record(conv), dict(meta)

    def meta(self, conv_id: str) -> Optional[Dict[str, Any]]:
        return self._get(meta_key(self.app, self.project_id, conv_id))

    def owned_by(self, conv_id: str, request_id: Optional[str]) -> bool:
        """Whether this request may still write the conversation: its meta
        exists (the conversation was not deleted meanwhile) and its pending
        marker names this request or none (the user did not move on)."""
        return _owns(self.meta(conv_id), request_id)

    def save(self, conv_id: str, conv: Dict[str, Any], meta: Dict[str, Any]) -> None:
        """The transcript first, then the sidebar entry: a reader takes the
        entry as the signal that the transcript is complete. Written whatever
        is stored, as a script or a test sets a record up. A turn writes with
        :meth:`write`."""
        self._put(conv_key(self.app, self.project_id, conv_id),
                  {'messages': conv['messages'], 'display': conv['display']})
        self._put(meta_key(self.app, self.project_id, conv_id), meta)

    def write(self, conv_id: str, change: Callable[[Dict[str, Any]], Optional[Dict[str, Any]]],
              meta_of: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
              request_id: Optional[str] = None) -> bool:
        """Write ``change`` of the conversation, made on the record as it is
        stored, and then the sidebar entry ``meta_of(conversation, meta as
        stored)``. False, writing nothing, when the conversation was deleted,
        when its pending marker names another request (the user moved on), or
        when ``change`` answers None. ``change`` answering the record it was
        given unchanged writes the sidebar entry alone.

        Each write names the version this request last read or wrote. When
        another write landed first (409) both keys are read again and
        ``change`` is made again on them, so ``change`` must find its own
        work already there (a lost answer to a write that landed is sent
        again and refused the same way) and leave it as it is. A sidebar
        entry refused that way is rebuilt from what is stored, over the
        transcript this request wrote. Raises :class:`RecordMoved` after
        :data:`WRITE_TRIES` refusals in a row. A transcript refused as too
        large (413) under a cap other than the one the server reports now
        (core restarted with another) is made once more, so ``change`` fits
        it to the cap there is."""
        ckey = conv_key(self.app, self.project_id, conv_id)
        mkey = meta_key(self.app, self.project_id, conv_id)
        # The sidebar entry is read afresh (it is small): it says whether the
        # user moved on while this request worked.
        self._forget(mkey)
        refitted = False
        for _ in range(WRITE_TRIES):
            conv, meta = self._latest(ckey), self._latest(mkey)
            if not isinstance(conv, dict) or not isinstance(meta, dict) or not _owns(meta, request_id):
                return False
            current = _record(conv)
            new = change(current)
            if new is None:
                return False
            if new is not current:
                # Every settled plan as it is kept (`compact_plan`), as the
                # browser writes them too.
                new = {**new, 'display': compact_settled(new['display'])}
                cap = value_cap(self.client)
                try:
                    self._put(ckey, {'messages': new['messages'], 'display': new['display']},
                              guarded=True)
                except PlaidAPIError as e:
                    if e.status == 413 and not refitted and value_cap(self.client) != cap:
                        # The client read the cap again on the 413, and it is
                        # not the one ``change`` fitted the record to (core
                        # restarted with another): made once more, on it.
                        refitted = True
                        continue
                    if not _moved(e):
                        raise
                    self._forget(ckey, mkey)
                    continue
            break
        else:
            raise RecordMoved(conv_id)
        for _ in range(WRITE_TRIES):
            try:
                self._put(mkey, meta_of(new, meta), guarded=True)
                return True
            except PlaidAPIError as e:
                if not _moved(e):
                    raise
            # Another writer wrote the entry since: built again on its entry,
            # and on the transcript as it now stands (it may hold that
            # writer's message too).
            self._forget(ckey, mkey)
            meta = self._latest(mkey)
            if not isinstance(meta, dict):
                return False
            stored = self._latest(ckey)
            if isinstance(stored, dict):
                new = _record(stored)
        raise RecordMoved(conv_id)

    def _latest(self, key: str) -> Any:
        """The value as this request last saw it, read when it has not."""
        if key not in self._seen:
            self.read(key)
        return self._seen.get(key, (0, None))[1]

    def _forget(self, *keys: str) -> None:
        for key in keys:
            self._seen.pop(key, None)

    def _put(self, key: str, value: Any, guarded: bool = False) -> None:
        """One value, sent again while the server is away (`_patiently`).
        Without this a lost answer to the transcript's put left the sidebar
        entry unwritten, and the turn read as unfinished although it was
        stored, so Retry asked the model the same question twice. And a turn
        that ended while the server restarted lost its answer.

        ``guarded`` names the version this request last read or wrote
        (0 when it saw no entry), so the write is refused (409) when another
        landed since. A write sent again after its answer was lost is refused
        the same way when the first one landed, and :meth:`write` finds its
        own change in the record."""
        version = self._seen.get(key, (0, None))[0] if guarded else None
        answer = _patiently(lambda: self.client.user_data.put(self.user_id, key, value, version=version))
        stored = (answer or {}).get('version') if isinstance(answer, dict) else None
        if isinstance(stored, int):
            self._seen[key] = (stored, json.loads(json.dumps(value)))
        else:
            self._forget(key)

    def read(self, key: str) -> Any:
        """One value under this user's keys, whatever JSON it is, or None when
        there is nothing there. Public because the conversation is not the only
        thing stored under its own prefix: the files attached to it are stored
        beside it (see :mod:`.files`), as plain strings rather than objects."""
        try:
            entry = _patiently(lambda: self.client.user_data.get(self.user_id, key))
        except PlaidAPIError as e:
            if e.status == 404:
                self._seen[key] = (0, None)
                return None
            raise
        value = (entry or {}).get('value')
        version = (entry or {}).get('version')
        if isinstance(version, int):
            self._seen[key] = (version, value)
        return value

    def _get(self, key: str) -> Optional[Dict[str, Any]]:
        value = self.read(key)
        return value if isinstance(value, dict) else None


def _record(conv: Dict[str, Any]) -> Dict[str, Any]:
    """A copy of a stored conversation for a caller to change: the store
    keeps the value as stored, which a change made in place must not touch
    (an approval writes the versions it holds onto its plan's documents)."""
    return copy.deepcopy({'messages': conv.get('messages') or [], 'display': conv.get('display') or []})


def _owns(meta: Optional[Dict[str, Any]], request_id: Optional[str]) -> bool:
    """Whether a request may write a conversation whose sidebar entry is
    ``meta``: it exists, and its pending marker names this request or none."""
    if not isinstance(meta, dict):
        return False
    pending = meta.get('pending') or {}
    marked = pending.get('request_id') if isinstance(pending, dict) else None
    return not marked or not request_id or marked == request_id


def pending_kept(prev: Optional[Dict[str, Any]], request_id: Optional[str],
                 pending: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """The pending marker a write by ``request_id`` leaves: ``pending`` when
    it sets one, and when it clears its own (``pending`` None), the stored
    entry's ``prev`` when that names another request, which is the user's
    newer work and is kept."""
    if pending is not None:
        return pending
    marked = (prev or {}).get('pending') if isinstance(prev, dict) else None
    other = marked.get('request_id') if isinstance(marked, dict) else None
    return marked if other and other != request_id else None


# --- items ----------------------------------------------------------------------

# Every item of a conversation carries ``created_at``, when it was written
# (`now_iso`): a question when it was asked, a reply or an error when the turn
# ended. The browser stamps the items it writes the same way (plaid-ui
# ``itemTime``). A plan's own times stay where they were: its id dates its
# staging, ``settled_at`` its decision.

def user_item(text: str) -> Dict[str, Any]:
    return {'kind': 'user', 'text': text, 'created_at': now_iso()}


def assistant_item(text: str, plan: Optional[Dict[str, Any]], citations: List[Dict[str, Any]],
                   steps: List[Dict[str, Any]], steps_summary: str, model: Optional[str],
                   usage: Optional[Dict[str, int]] = None,
                   context_note: str = '', version: Optional[str] = None,
                   service: Optional[str] = None) -> Dict[str, Any]:
    """What the person sees of a reply. A step's own output is not repeated
    here: it is the ``tool`` message with the same id in the transcript.

    ``usage`` is ``{sent, received, window, total}`` for the turn that
    produced this reply: ``sent`` and ``received`` are its last model call,
    ``total`` is every call added up (`agent.Spend`), and ``window`` is absent
    when the model's limit is not known. It lives
    per reply rather than on the sidebar entry so that the growth is visible
    and so that reading the newest is how you get the current figure.

    ``context_note`` says what the turn was GIVEN, as against what it did: at
    present, how much of the project's guidelines were in the prompt. It is
    per reply and not per conversation because the answer changes as the
    manual is written, and it is shown at all because a rule the model was
    never given is the one way this fails without anyone seeing it.

    ``model``, ``version`` and ``service`` name what answered: the model,
    the assistant's prompt version (``service.agent_version``) and the
    service id it answered as. All three are per reply because the operator
    can restart the service on another model or another release in the
    middle of a conversation, and a plan's writes name the one that proposed
    it, not the one running when it is approved.
    """
    item = {'kind': 'assistant', 'text': text or '', 'plan': plan, 'citations': citations or [],
            'status': None, 'model': model, 'steps': steps or [], 'steps_summary': steps_summary or '',
            'created_at': now_iso()}
    if version:
        item['version'] = version
    if service:
        item['service'] = service
    if usage:
        item['usage'] = usage
    if context_note:
        item['context_note'] = context_note
    return item


def error_item(text: str, stopped: bool = False, model: Optional[str] = None,
               version: Optional[str] = None, service: Optional[str] = None,
               steps: Optional[List[Dict[str, Any]]] = None,
               calls: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """A turn that ended without an answer. ``model``, ``version`` and
    ``service`` say which assistant it was asked of, as on an answer.

    ``steps`` are the tool calls the turn made before it failed or was
    stopped, as an answer's are (`trace.trace_step`), and ``calls`` what each
    was sent and answered: ``{id, name, arguments, result}``, the arguments as
    the model wrote them and the result as the tool returned it (cut to
    ``MAX_RESULT_CHARS`` like every result). An answer keeps these in the
    model transcript, but a failed turn's messages leave the transcript (a
    retry must not send them again), so they are kept on the item instead,
    which the model never reads. `prune` drops their results first, then
    them, like an old answer's."""
    item: Dict[str, Any] = {'kind': 'error', 'text': text, 'created_at': now_iso()}
    if stopped:
        item['stopped'] = True
    if steps:
        item['steps'] = steps
        item['steps_summary'] = summarize_steps(steps)
    if calls:
        item['calls'] = calls
    if model:
        item['model'] = model
    if version:
        item['version'] = version
    if service:
        item['service'] = service
    return item


def title_from(text: str) -> str:
    t = ' '.join((text or '').split())
    return t[:TITLE_MAX - 1] + '…' if len(t) > TITLE_MAX else t


def build_meta(prev: Optional[Dict[str, Any]], conv_id: str, conv: Dict[str, Any], service_id: Optional[str],
               model: Optional[str], pending: Optional[Dict[str, Any]] = None,
               version: Optional[str] = None) -> Dict[str, Any]:
    """The sidebar entry after a write. The title is set once, from the first
    message; the assistant recorded is the one that answered, by its model and
    its version (``BaseAssistantService.version``), as each turn names them."""
    prev = prev or {}
    first_user = next((d for d in conv['display'] if d.get('kind') == 'user'), None)
    return {
        'id': conv_id,
        'title': prev.get('title') or (title_from(first_user['text']) if first_user else 'New conversation'),
        'created_at': prev.get('created_at') or now_iso(),
        'updated_at': now_iso(),
        'service_id': service_id or prev.get('service_id'),
        'model': model or prev.get('model'),
        'version': version or prev.get('version'),
        'turns': sum(1 for d in conv['display'] if d.get('kind') == 'user'),
        'pending': pending,
        # The document a docked conversation is about. The app writes it when
        # it opens the conversation and never again, so this rewrite is the
        # only thing that can lose it, and losing it means the panel starts a
        # new thread instead of resuming the one about this document.
        'about': prev.get('about'),
    }


# --- plans ----------------------------------------------------------------------

def find_plan(conv: Dict[str, Any], plan_id: str) -> Tuple[int, Optional[Dict[str, Any]]]:
    """(index, display item) of the assistant item carrying the plan, or (-1, None)."""
    for i, d in enumerate(conv['display']):
        plan = d.get('plan') if isinstance(d, dict) else None
        if plan and plan.get('id') == plan_id:
            return i, d
    return -1, None


# What a plan keeps of each change it proposed (`proposed_changes`), for a
# record that outlives its ops. At most this many changes are kept, and `proposed_count` says how many there
# were. A bulk change across a corpus is one decision, and 500 of its changes
# are about 40KB of a record whose budget is megabytes.
PROPOSED_MAX = 500
# The most characters of a proposed value kept, in code points.
PROPOSED_VALUE_MAX = 24


def _proposed_target(op: Dict[str, Any], keys: Sequence[str]) -> Optional[str]:
    for key in keys:
        v = op.get(key)
        if isinstance(v, list):
            v = v[0] if v else None
        if isinstance(v, str) and v:
            return v
    return None


def _proposed_value(op: Dict[str, Any], keys: Sequence[str]):
    for key in keys:
        v = op.get(key)
        if isinstance(v, str):
            return v if len(v) <= PROPOSED_VALUE_MAX else v[:PROPOSED_VALUE_MAX - 1] + '…'
        if isinstance(v, int) and not isinstance(v, bool):
            return v
    return None


def proposed_changes(ops: List[Dict[str, Any]], target_keys: Sequence[str], value_keys: Sequence[str],
                     other_keys: Optional[Dict[str, str]] = None) -> Tuple[List[list], int]:
    """``([kind, target id, short value], ...)`` for the changes a plan
    proposes, the first :data:`PROPOSED_MAX` of them, and how many there are.
    A kind that joins two things (a relation's second end, say) is
    ``[kind, target id, short value, other id]``, the other id read from the
    key ``other_keys`` names for that kind (a list at its first entry, None
    when the op names none yet), so each kind has one shape.

    A plan that is discarded or refused writes nothing, so the audit log never
    sees what it proposed. This is what the record keeps of it, a few dozen
    bytes a change, once ``ops`` are gone (`compact_plan`). The target is the
    first of ``target_keys`` an op names (a list read at its first entry), the
    value the first of ``value_keys`` holding a string or a whole number,
    clipped to :data:`PROPOSED_VALUE_MAX` code points. The keys are the app's
    (``BaseAssistantService.proposed_keys``). Each change's outcome is the
    plan's: approval is of the whole plan.

    A rule (``core.rules``) is not listed: ``[kind, None, None]`` would say
    nothing, and its card row says everything (tool, arguments, counts per
    document, a sample), so it adds only its total to the count.
    """
    out: List[list] = []
    total = 0
    plain = []
    for op in ops:
        if not isinstance(op, dict):
            continue
        if isinstance(op.get('matched'), list):
            total += int(op.get('count') or 0)
        else:
            plain.append(op)
    for op in expand_ops(plain):
        total += 1
        if len(out) < PROPOSED_MAX:
            change = [op.get('kind'), _proposed_target(op, target_keys), _proposed_value(op, value_keys)]
            other = (other_keys or {}).get(op.get('kind'))
            if other:
                change.append(_proposed_target(op, (other,)))
            out.append(change)
    return out, total


#: How many of a settled plan's rows (``changes`` and ``labels``) the record
#: keeps. A plan of thousands of changes kept its whole card once settled,
#: about half a kilobyte a row, and a conversation of a few such plans filled
#: the record (5MB) with cards nobody could approve any more (2026-10-08).
SETTLED_ROWS_MAX = 200


def compact_plan(item: Dict[str, Any]) -> Dict[str, Any]:
    """A settled plan's card without what only approving it needed.

    ``ops`` and ``documents`` are what approval executes and checks, and they
    were most of a long conversation's weight (Eline's 1MB thread was 618KB of
    plans). Once the plan is applied, discarded, out of date or replaced,
    nothing reads them again: the card is drawn from ``changes`` and
    ``labels``, and the audit log is the record of what was written.
    ``op_count`` keeps the card's rows lined up with the ops they stood for
    (`planRows` in plaid-ui). ``expansion``, what its corpus-wide changes
    found while an approval ran (`plan.Expansion`), goes with them, and so
    does ``writing``, which says an approval under way may have written.
    Of ``changes`` and ``labels`` the first :data:`SETTLED_ROWS_MAX` stay, and
    ``omitted`` says what the rest held: how many rows, how many of them
    rewrote the text and how many of a person's values they replaced, the
    totals the card states. A rule's row (``rule``, see core/rules.py) is never
    cut: it is one row, and the only record of what a rule proposed. One past
    the cap is kept after the first rows with its place on the card (``row``).
    What each change targeted and proposed stays, small, as ``proposed``
    (`proposed_changes`, written when the plan was staged), since a plan that
    wrote nothing is in no log.
    An undecided plan is never compacted: it can still be approved.
    Every write of the record runs this over every settled plan, and it
    answers the same item when there is nothing to drop.
    Mirrored by ``compactPlan`` in plaid-ui.
    """
    plan = item.get('plan')
    if not plan or item.get('status') is None:
        return item
    changes = plan.get('changes') if isinstance(plan.get('changes'), list) else []
    labels = plan.get('labels') if isinstance(plan.get('labels'), list) else []
    rest = [(i, c) for i, c in enumerate(changes) if i >= SETTLED_ROWS_MAX]
    ruled = [{'row': i, **c} for i, c in rest if isinstance(c, dict) and c.get('rule') is not None]
    rows = max(len(changes) - len(ruled), len(labels))
    if 'ops' not in plan and 'expansion' not in plan and 'writing' not in plan and rows <= SETTLED_ROWS_MAX:
        return item
    kept = {k: v for k, v in plan.items() if k not in ('ops', 'documents', 'expansion', 'writing')}
    if 'ops' in plan:
        kept['op_count'] = len(plan.get('ops') or [])
    if rows > SETTLED_ROWS_MAX:
        dropped = [c for _, c in rest if isinstance(c, dict) and c.get('rule') is None]
        if 'changes' in plan:
            kept['changes'] = changes[:SETTLED_ROWS_MAX] + ruled
        if 'labels' in plan:
            kept['labels'] = labels[:SETTLED_ROWS_MAX]
        kept['omitted'] = {
            'count': rows - SETTLED_ROWS_MAX,
            'writes_text': sum(1 for c in dropped if c.get('writes_text')),
            'replaces_work': sum(int(c.get('replaces_work') or 0) for c in dropped),
        }
    return {**item, 'plan': kept}


def compact_settled(display: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [compact_plan(d) if isinstance(d, dict) else d for d in display]


def settle_plan(conv: Dict[str, Any], index: int, status: Optional[str], note: Optional[str],
                **fields) -> Dict[str, Any]:
    """A plan's outcome: the status on its card, plus a note in the model
    transcript (user role) so the next turn knows whether its proposal happened.
    A settled plan is compacted at once (`compact_plan`), and says when it was
    settled (``settled_at``)."""
    display = [(compact_plan({**d, 'status': status, 'settled_at': now_iso(), **fields}) if i == index else d)
               for i, d in enumerate(conv['display'])]
    messages = conv['messages'] + ([{'role': 'user', 'content': note}] if note else [])
    return {'messages': messages, 'display': display}


def replace_undecided(display: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Every plan still waiting for a decision, marked replaced: the turn
    staging a new plan calls this before adding its own. The model starts
    each turn with an empty plan and restates what still applies, so an older
    card left approvable offered a second, overlapping set of changes beside
    the newer one (Luke's ruling, 2026-10-05). A plan whose approval was
    interrupted is left alone: its changes may have been written."""
    stamp = now_iso()
    return [
        compact_plan({**d, 'status': 'replaced', 'settled_at': stamp})
        if isinstance(d, dict) and d.get('plan') and d.get('status') is None and not d.get('interrupted')
        else d
        for d in display
    ]


# --- what a request writes, made on the record as it is stored --------------------
#
# A request writes the record at its end, minutes after it read it, and the
# browser may have written it meanwhile (settled the turn as unanswered after
# a server restart, discarded a plan, sent a question from another tab). Each
# write is therefore a change made on the stored record
# (`ConversationStore.write`), never a copy of the one this request read.

def _same_item(a: Any, b: Any) -> bool:
    """Whether two display items are the same one: an item is not edited
    after it is written, apart from its plan, so its kind, time and text say
    which it is."""
    return (isinstance(a, dict) and isinstance(b, dict)
            and all(a.get(k) == b.get(k) for k in ('kind', 'created_at', 'text')))


def turn_ending(base: Dict[str, Any], asked: List[Dict[str, Any]], item: Dict[str, Any],
                added: Sequence[Dict[str, Any]] = (), replaces: bool = False,
                fit: Callable[[Dict[str, Any]], Dict[str, Any]] = lambda c: c):
    """The change that ends a turn with ``item`` (its reply, or the error
    item of a turn that failed or was stopped), for :meth:`ConversationStore.write`.

    ``base`` is the record as the turn read it, whose last display item is
    the question. ``asked`` is what the model transcript holds up to the
    answer, the question as the turn stamped it, kept whether or not the turn
    was answered, and ``added`` what the turn adds after it.
    ``replaces``: the reply stages a plan, so every plan still waiting is
    marked replaced (`replace_undecided`). ``fit`` holds the result to the
    record's budget (`prune`).

    Made on the stored record: the items before the question are taken as
    stored (a plan discarded meanwhile stays discarded), an unanswered or
    stopped line the browser wrote for this question gives way to the
    outcome, and a note the browser added to the transcript is kept. Nothing
    is written when the question is no longer there (the conversation was
    rewound or replaced) or a newer question follows it (the user moved on),
    and the record is left as it is when it already holds ``item``."""
    n = len(base['display'])
    question = base['display'][n - 1] if n else None
    known = base['messages']

    def change(stored: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        shown = stored['display']
        if len(shown) < n or (n and not _same_item(shown[n - 1], question)):
            return None
        after = shown[n:]
        if any(_same_item(d, item) for d in after):
            return stored
        if any(isinstance(d, dict) and d.get('kind') == 'user' for d in after):
            return None
        kept = [d for d in after if not (isinstance(d, dict) and d.get('kind') == 'error')]
        earlier = replace_undecided(shown[:n]) if replaces else list(shown[:n])
        held = stored['messages']
        notes = held[len(known):] if held[:len(known)] == known else []
        return fit({'messages': list(asked) + notes + list(added), 'display': earlier + kept + [item]})
    return change


# The outcomes of a plan that wrote to the project.
WROTE = ('applied', 'partial')


_KEEP = object()


def plan_settling(plan_id: str, status: Optional[str] = None, note: Optional[str] = None,
                  documents: Optional[List[Dict[str, Any]]] = None, expansion: Any = _KEEP,
                  writing: Any = _KEEP, undecided: bool = False, **fields):
    """The change an approval writes on the plan ``plan_id``: ``status``
    (with ``note`` for the model and ``fields`` on the card, `settle_plan`),
    or with no status, the plan's ``documents`` as the run holds them (the
    versions it held them at, `plan.held_from`) while it is undecided, and
    ``expansion``, what its scopes resolved to on that run (`plan.Expansion`),
    None to forget it, and ``writing`` (`plan.WRITING`), falsy to drop it.
    A plan already settled (see `WROTE` for the one exception), or one that
    is gone, leaves the record as it is, or with ``undecided`` (a run about to
    send its first change, `plan.writing`) is not written at all."""
    def change(stored: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        index, item = find_plan(stored, plan_id)
        if item is None:
            return None if undecided else stored
        if status is not None:
            was = item.get('status')
            # A plan settled meanwhile keeps that outcome, unless this run
            # wrote (applied, partial) and the outcome there says it did not
            # (discarded in another tab while the run held the documents).
            if was == status or (was is not None and (status not in WROTE or was in WROTE)):
                return stored
            return settle_plan(stored, index, status, note, **fields)
        plan = item.get('plan') or {}
        if item.get('status') is not None:
            return None if undecided else stored
        new = dict(plan)
        if documents is not None and 'documents' in plan:
            new['documents'] = json.loads(json.dumps(documents))
        if expansion is not _KEEP:
            if expansion is None:
                new.pop('expansion', None)
            else:
                new['expansion'] = json.loads(json.dumps(expansion))
        if writing is not _KEEP:
            if writing:
                new['writing'] = writing
            else:
                new.pop('writing', None)
        if new == plan:
            return stored
        display = list(stored['display'])
        display[index] = {**item, 'plan': new}
        return {'messages': stored['messages'], 'display': display}
    return change


def partial_tally(written_n: int, total: int, partly_n: int = 0, were: bool = False) -> str:
    """How much of a plan that stopped partway was written, in one clause:
    "400 of 600 changes written". ``written_n`` counts each change of a folded
    row, ``partly_n`` the changes another service wrote in part (a parse that
    stopped partway), which have no count of their own here. ``were`` reads
    it as a sentence for the model rather than for the card."""
    verb = 'were written' if were else 'written'
    if not partly_n:
        return f'{written_n} of {total} changes {verb}'
    if not written_n:
        return f'{partly_n} of {total} changes {verb} in part'
    return f'{written_n} of {total} changes {verb}, and {partly_n} more in part'


def partial_note(labels: Sequence[str], written: Sequence[int], unknown: bool, why: str,
                 parts: Optional[Dict[int, Tuple[int, int]]] = None,
                 sizes: Optional[Sequence[int]] = None, partly: Sequence[int] = ()) -> str:
    """What the model is told of a plan that stopped partway (Luke's ruling
    Q4, 2026-09-29): how many of its changes were written, which, and which
    were not, so the next turn plans only what is missing. ``labels`` are the
    card's rows, ``written`` the rows written in full, ``parts`` for a row
    that folds many changes and was written in part, how many of how many,
    ``sizes`` how many changes each row folds (1 when not given), and
    ``partly`` the rows another service wrote in part. The count leads with
    changes, as the card does, not rows."""
    done = set(written)
    parts = parts or {}
    sizes = list(sizes) if sizes is not None else [1] * len(labels)
    partly = [i for i in partly if i not in done and i not in parts]

    def name(i):
        label = labels[i] or f'change {i + 1}'
        if i in parts:
            k, n = parts[i]
            label += f' ({k} of {n} written)'
        elif i in partly:
            label += ' (written in part)'
        return label

    def listed(rows):
        shown = [name(i) for i in rows[:PARTIAL_LISTED]]
        more = len(rows) - len(shown)
        return '; '.join(shown) + (f'; and {more} more' if more > 0 else '')
    yes = [i for i in range(len(labels)) if i in done]
    no = [i for i in range(len(labels)) if i not in done]
    written_n = sum(sizes[i] for i in yes) + sum(k for k, _ in parts.values())
    out = (f'(note) Applying stopped partway ({why}): '
           f'{partial_tally(written_n, sum(sizes), len(partly), were=True)}.')
    if yes:
        out += f' Written: {listed(yes)}.'
    # A change of several batches can be partly in the document (its first
    # batch committed, a later one did not), and one whose batch lost its
    # answer may be in it whole: neither is "not written".
    if no:
        out += (f' {"Not known to be written" if unknown else "Not written"} in full: {listed(no)}. '
                'Read the document before planning them again.')
    return out


#: How many changes a partial note names on each side before it counts the rest.
PARTIAL_LISTED = 20


# --- size ---------------------------------------------------------------------

def _bytes(value: Any) -> int:
    """The bytes the SERVER will count for this value, not the bytes Python
    would write.

    The store measures `clojure.data.json`'s output, which escapes every
    non-ASCII character as ``\\uXXXX`` and every ``/`` as ``\\/``, and writes
    no space after a comma or a colon. Counted the Python way a Cyrillic
    conversation weighed a third of what the server saw: it sat under its
    budget, prune never fired, and the save came back 413.
    """
    text = json.dumps(value, ensure_ascii=True, separators=(',', ':'))
    return len(text.encode('utf-8')) + text.count('/')


def conversation_bytes(conv: Dict[str, Any]) -> int:
    return _bytes({'messages': conv.get('messages') or [], 'display': conv.get('display') or []})


def value_cap(client) -> Optional[int]:
    """The cap the server enforces on one stored value, as it publishes it
    at ``GET /info`` (``user_data_value_bytes``), or None when it does not
    say. Read from the client every time: the client reads ``/info`` again
    when its connection to the server comes back and after a 413, so the
    figure is the one the server has now, never a copy taken at startup."""
    try:
        reported = (client.server.limits() or {}).get('user_data_value_bytes')
    except Exception:  # noqa: BLE001 - an unreachable or older server just has no figure
        return None
    return reported if isinstance(reported, int) and reported > 0 else None


def record_budget(client, default: int = CONVERSATION_BUDGET) -> int:
    """What the service may fill of the cap the server enforces on one stored
    value (`value_cap`): the cap less the browser's room (`RECORD_HEADROOM`).
    A server that does not report one gets the fallback, which is what the
    budget was before anybody asked."""
    cap = value_cap(client)
    return default if cap is None else int(cap * RECORD_HEADROOM)


def prune(conv: Dict[str, Any], budget: int = CONVERSATION_BUDGET,
          transcript: Optional[Tuple[int, Callable[[Any], int]]] = None) -> Dict[str, Any]:
    """Thin the record until it fits its budget, oldest and cheapest first.

    ``transcript`` is ``(limit, measure)``: the most the model transcript
    (``messages``) may cost by ``measure``, which is the model's tokens when
    its window is known. Stage one then also drops old tool results until the
    transcript fits, whatever the record weighs. Without it the transcript is
    held to `CONVERSATION_BUDGET` bytes, which is what bounded it when the
    record's own limit was 1MB.

    Three stages, because the budget counts `display` as well as `messages`
    and only the first stage used to run: a conversation whose weight was in
    `display` came back still over budget with every tool result destroyed for
    nothing, and then the save was refused by the server.

    What a stage may take is the question. A tool RESULT is recoverable by
    asking again. A step TRACE is diagnostic, and its output is the `tool`
    message stage one already took. CITATIONS are the evidence a reply rests
    on, so they go last and never from the newest reply. An undecided PLAN is
    never touched at any stage: the user has not decided on it yet.

    Before any of that, and whatever the size, every settled plan is compacted
    (`compact_plan`). That is not trimming: it drops only what nothing reads.
    """
    display = conv.get('display') or []
    if any(compact_plan(d) is not d for d in display if isinstance(d, dict)):
        conv = {**conv, 'display': compact_settled(display)}
    limit, measure = transcript or (CONVERSATION_BUDGET, _bytes)
    excess = conversation_bytes(conv) - budget
    over = sum(measure(m) for m in conv['messages']) - limit
    if excess <= 0 and over <= 0:
        return conv

    dropped = _bytes(DROPPED)
    messages = []
    for m in conv['messages']:
        if (excess <= 0 and over <= 0) or m.get('role') != 'tool' or m.get('content') == DROPPED:
            messages.append(m)
            continue
        excess -= _bytes(m.get('content')) - dropped
        thinner = {**m, 'content': DROPPED}
        over -= measure(m) - measure(thinner)
        messages.append(thinner)
    conv = {**conv, 'messages': messages}
    if excess <= 0:
        return conv

    # A failed or stopped turn keeps its calls' results on its own item (see
    # `error_item`), where they are tool results like any other: they go
    # next, oldest first, the newest item's too, since the model never reads
    # them and the reader of the record has their steps and arguments still.
    display = list(conv.get('display') or [])
    for i, item in enumerate(display):
        if excess <= 0:
            break
        if item.get('kind') != 'error' or not item.get('calls'):
            continue
        calls = []
        for c in item['calls']:
            if excess > 0 and isinstance(c, dict) and c.get('result') not in (None, DROPPED):
                excess -= _bytes(c['result']) - dropped
                c = {**c, 'result': DROPPED}
            calls.append(c)
        display[i] = {**item, 'calls': calls}
    if excess <= 0:
        return {**conv, 'display': display}

    # Stages two and three walk `display` oldest first and leave the last item
    # whole, because that is the reply on screen. A failed turn's steps go with
    # the calls they name.
    for key in ('steps', 'citations'):
        for i in range(max(0, len(display) - 1)):
            if excess <= 0:
                break
            item = display[i]
            if item.get('kind') not in ('assistant', 'error') or not item.get(key):
                continue
            excess -= _bytes(item[key])
            thinner = {**item, key: []}
            if key == 'steps' and item.get('calls'):
                excess -= _bytes(item['calls'])
                thinner['calls'] = []
            display[i] = thinner
        if excess <= 0:
            break
    return {**conv, 'display': display}
