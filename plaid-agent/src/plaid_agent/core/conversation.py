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

import json
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from plaid_client.http import PlaidAPIError

from .plan import expand_ops

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
# as well, and at 5MB it no longer does. With the window known the transcript
# is held to a share of it in tokens instead (`prune`'s ``transcript``).
CONVERSATION_BUDGET = 700_000
# The share of the server's cap the service fills. The service is not the
# record's only writer: the browser adds the next message and a discard's note
# to the record as it stands, so a record pruned to the cap exactly took the
# user's next message back as a 413, and the turn ran without it.
RECORD_HEADROOM = 0.9
DROPPED = '[This result was dropped to keep the conversation within its size limit.]'
TITLE_MAX = 60


def conv_key(app: str, project_id: str, conv_id: str) -> str:
    return f'{app}:assistant:{project_id}:conv:{conv_id}'


def meta_key(app: str, project_id: str, conv_id: str) -> str:
    return f'{app}:assistant:{project_id}:meta:{conv_id}'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class MissingConversation(Exception):
    """No record under the conversation's keys (never saved, or deleted)."""


class ConversationStore:
    """Read and write one user's conversations on a project, under one app's
    key prefix."""

    def __init__(self, client, user_id: str, project_id: str, app: str):
        self.client = client
        self.user_id = user_id
        self.project_id = project_id
        self.app = app

    def load(self, conv_id: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """(conversation, meta). Raises :class:`MissingConversation`."""
        conv = self._get(conv_key(self.app, self.project_id, conv_id))
        meta = self._get(meta_key(self.app, self.project_id, conv_id))
        if conv is None or meta is None:
            raise MissingConversation(conv_id)
        return ({'messages': list(conv.get('messages') or []), 'display': list(conv.get('display') or [])},
                dict(meta))

    def meta(self, conv_id: str) -> Optional[Dict[str, Any]]:
        return self._get(meta_key(self.app, self.project_id, conv_id))

    def owned_by(self, conv_id: str, request_id: Optional[str]) -> bool:
        """Whether this request may still write the conversation: its meta
        exists (the conversation was not deleted meanwhile) and its pending
        marker names this request or none (the user did not move on)."""
        meta = self.meta(conv_id)
        if meta is None:
            return False
        pending = meta.get('pending') or {}
        marked = pending.get('request_id') if isinstance(pending, dict) else None
        return not marked or not request_id or marked == request_id

    def save(self, conv_id: str, conv: Dict[str, Any], meta: Dict[str, Any]) -> None:
        """The transcript first, then the sidebar entry: a reader takes the
        entry as the signal that the transcript is complete."""
        self._put(conv_key(self.app, self.project_id, conv_id),
                  {'messages': conv['messages'], 'display': conv['display']})
        self._put(meta_key(self.app, self.project_id, conv_id), meta)

    def _put(self, key: str, value: Any) -> None:
        """One value, sent again once when its answer was lost. A put replaces
        the whole value, so sending it twice stores what sending it once
        does. Without this a lost answer to the transcript's put left the
        sidebar entry unwritten, and the turn read as unfinished although it
        was stored, so Retry asked the model the same question twice."""
        try:
            self.client.user_data.put(self.user_id, key, value)
        except PlaidAPIError as e:
            if e.status:
                raise
            self.client.user_data.put(self.user_id, key, value)

    def read(self, key: str) -> Any:
        """One value under this user's keys, whatever JSON it is, or None when
        there is nothing there. Public because the conversation is not the only
        thing stored under its own prefix: the files attached to it are stored
        beside it (see :mod:`.files`), as plain strings rather than objects."""
        try:
            entry = self.client.user_data.get(self.user_id, key)
        except PlaidAPIError as e:
            if e.status == 404:
                return None
            raise
        return (entry or {}).get('value')

    def _get(self, key: str) -> Optional[Dict[str, Any]]:
        value = self.read(key)
        return value if isinstance(value, dict) else None


# --- items ----------------------------------------------------------------------

def user_item(text: str) -> Dict[str, Any]:
    return {'kind': 'user', 'text': text}


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
            'status': None, 'model': model, 'steps': steps or [], 'steps_summary': steps_summary or ''}
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
               version: Optional[str] = None, service: Optional[str] = None) -> Dict[str, Any]:
    """A turn that ended without an answer. ``model``, ``version`` and
    ``service`` say which assistant it was asked of, as on an answer."""
    item: Dict[str, Any] = {'kind': 'error', 'text': text}
    if stopped:
        item['stopped'] = True
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
    """
    out: List[list] = []
    total = 0
    for op in expand_ops([op for op in ops if isinstance(op, dict)]):
        total += 1
        if len(out) < PROPOSED_MAX:
            change = [op.get('kind'), _proposed_target(op, target_keys), _proposed_value(op, value_keys)]
            other = (other_keys or {}).get(op.get('kind'))
            if other:
                change.append(_proposed_target(op, (other,)))
            out.append(change)
    return out, total


def compact_plan(item: Dict[str, Any]) -> Dict[str, Any]:
    """A settled plan's card without what only approving it needed.

    ``ops`` and ``documents`` are what approval executes and checks, and they
    were most of a long conversation's weight (Eline's 1MB thread was 618KB of
    plans). Once the plan is applied, discarded or out of date, nothing reads
    them again: the card is drawn from ``changes`` and ``labels``, and the
    audit log is the record of what was written. ``op_count`` keeps the card's
    rows lined up with the ops they stood for (`planRows` in plaid-ui).
    What each change targeted and proposed stays, small, as ``proposed``
    (`proposed_changes`, written when the plan was staged), since a plan that
    wrote nothing is in no log.
    An undecided plan is never compacted: it can still be approved.
    Mirrored by ``compactPlan`` in plaid-ui.
    """
    plan = item.get('plan')
    if not plan or item.get('status') is None or 'ops' not in plan:
        return item
    kept = {k: v for k, v in plan.items() if k not in ('ops', 'documents')}
    kept['op_count'] = len(plan.get('ops') or [])
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


def partly_applied(conv: Dict[str, Any], index: int) -> Dict[str, Any]:
    """The plan at ``index`` failed after some of it was written. It stays
    undecided (the card still offers Approve and Discard), and the item says
    so, since a discard afterwards would otherwise read as nothing written."""
    display = [({**d, 'partly_applied': True} if i == index else d) for i, d in enumerate(conv['display'])]
    return {**conv, 'display': display}


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


def record_budget(client, default: int = CONVERSATION_BUDGET) -> int:
    """What the service may fill of the cap the server enforces on one stored
    value, which it publishes at ``GET /info``: the cap less the browser's
    room (`RECORD_HEADROOM`). A server that does not report one gets the
    fallback, which is what the budget was before anybody asked."""
    try:
        reported = (client.server.limits() or {}).get('user_data_value_bytes')
    except Exception:  # noqa: BLE001 - an unreachable or older server just has no figure
        return default
    if not (isinstance(reported, int) and reported > 0):
        return default
    return int(reported * RECORD_HEADROOM)


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

    # Stages two and three walk `display` oldest first and leave the last item
    # whole, because that is the reply on screen.
    display = list(conv.get('display') or [])
    for key in ('steps', 'citations'):
        for i in range(max(0, len(display) - 1)):
            if excess <= 0:
                break
            item = display[i]
            if item.get('kind') != 'assistant' or not item.get(key):
                continue
            excess -= _bytes(item[key])
            display[i] = {**item, key: []}
        if excess <= 0:
            break
    return {**conv, 'display': display}
