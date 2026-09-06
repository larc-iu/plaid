"""The conversation record: how a chat with the assistant is stored.

A conversation lives in the user's private key/value store on the Plaid
server (``client.user_data``), private to that user and following them
across devices, under two keys per conversation:

``igt:assistant:<project>:meta:<id>``
    A small sidebar entry: title, timestamps, which assistant answers, how
    many turns, and ``pending`` while work is under way (the request id, so
    a browser that comes back can rejoin it).
``igt:assistant:<project>:conv:<id>``
    The transcript the model sees (``messages``: OpenAI-shaped, tool calls
    and results included, so a later turn builds on what an earlier one
    read) and what the person sees (``display``: user, assistant, and error
    items; an assistant item carries its plan, citations, and trace).

The service owns the record while it works: the browser appends the user's
message and marks the conversation pending, submits the request, and from
then on only reads. The service loads the record, runs the turn, and writes
the reply back before reporting the request done, so the answer lands
whether or not anyone is still watching the request's stream.

Keys are snake_case here and camelCase in the browser; the clients recase
them on the wire, so both sides read one record.
"""

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from plaid_client.http import PlaidAPIError

# A single stored value may weigh a megabyte (plaid-core's user_data). A
# turn's tool results are almost all of a conversation's weight and the part
# it can spare: the reply that drew conclusions from them stays, and so does
# every question and every plan. Past the budget the oldest tool results are
# dropped, in order, until it fits. The same transcript is what the next turn
# sends the model, so this also keeps a long conversation inside its context.
CONVERSATION_BUDGET = 700_000
DROPPED = '[This result was dropped to keep the conversation within its size limit.]'
TITLE_MAX = 60


def conv_key(project_id: str, conv_id: str) -> str:
    return f'igt:assistant:{project_id}:conv:{conv_id}'


def meta_key(project_id: str, conv_id: str) -> str:
    return f'igt:assistant:{project_id}:meta:{conv_id}'


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class MissingConversation(Exception):
    """No record under the conversation's keys (never saved, or deleted)."""


class ConversationStore:
    """Read and write one user's conversations on a project."""

    def __init__(self, client, user_id: str, project_id: str):
        self.client = client
        self.user_id = user_id
        self.project_id = project_id

    def load(self, conv_id: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        """(conversation, meta). Raises :class:`MissingConversation`."""
        conv = self._get(conv_key(self.project_id, conv_id))
        meta = self._get(meta_key(self.project_id, conv_id))
        if conv is None or meta is None:
            raise MissingConversation(conv_id)
        return ({'messages': list(conv.get('messages') or []), 'display': list(conv.get('display') or [])},
                dict(meta))

    def meta(self, conv_id: str) -> Optional[Dict[str, Any]]:
        return self._get(meta_key(self.project_id, conv_id))

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
        self.client.user_data.put(self.user_id, conv_key(self.project_id, conv_id),
                                  {'messages': conv['messages'], 'display': conv['display']})
        self.client.user_data.put(self.user_id, meta_key(self.project_id, conv_id), meta)

    def _get(self, key: str) -> Optional[Dict[str, Any]]:
        try:
            entry = self.client.user_data.get(self.user_id, key)
        except PlaidAPIError as e:
            if e.status == 404:
                return None
            raise
        value = (entry or {}).get('value')
        return value if isinstance(value, dict) else None


# --- items ----------------------------------------------------------------------

def user_item(text: str) -> Dict[str, Any]:
    return {'kind': 'user', 'text': text}


def assistant_item(text: str, plan: Optional[Dict[str, Any]], citations: List[Dict[str, Any]],
                   steps: List[Dict[str, Any]], steps_summary: str, model: Optional[str]) -> Dict[str, Any]:
    """What the person sees of a reply. A step's own output is not repeated
    here: it is the ``tool`` message with the same id in the transcript."""
    return {'kind': 'assistant', 'text': text or '', 'plan': plan, 'citations': citations or [],
            'status': None, 'model': model, 'steps': steps or [], 'steps_summary': steps_summary or ''}


def error_item(text: str, stopped: bool = False) -> Dict[str, Any]:
    item: Dict[str, Any] = {'kind': 'error', 'text': text}
    if stopped:
        item['stopped'] = True
    return item


def title_from(text: str) -> str:
    t = ' '.join((text or '').split())
    return t[:TITLE_MAX - 1] + '…' if len(t) > TITLE_MAX else t


def build_meta(prev: Optional[Dict[str, Any]], conv_id: str, conv: Dict[str, Any], service_id: Optional[str],
               model: Optional[str], pending: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The sidebar entry after a write. The title is set once, from the first
    message; the assistant recorded is the one that answered."""
    prev = prev or {}
    first_user = next((d for d in conv['display'] if d.get('kind') == 'user'), None)
    return {
        'id': conv_id,
        'title': prev.get('title') or (title_from(first_user['text']) if first_user else 'New conversation'),
        'created_at': prev.get('created_at') or now_iso(),
        'updated_at': now_iso(),
        'service_id': service_id or prev.get('service_id'),
        'model': model or prev.get('model'),
        'turns': sum(1 for d in conv['display'] if d.get('kind') == 'user'),
        'pending': pending,
    }


# --- plans ----------------------------------------------------------------------

def find_plan(conv: Dict[str, Any], plan_id: str) -> Tuple[int, Optional[Dict[str, Any]]]:
    """(index, display item) of the assistant item carrying the plan, or (-1, None)."""
    for i, d in enumerate(conv['display']):
        plan = d.get('plan') if isinstance(d, dict) else None
        if plan and plan.get('id') == plan_id:
            return i, d
    return -1, None


def settle_plan(conv: Dict[str, Any], index: int, status: Optional[str], note: Optional[str],
                **fields) -> Dict[str, Any]:
    """A plan's outcome: the status on its card, plus a note in the model
    transcript (user role) so the next turn knows whether its proposal happened."""
    display = [({**d, 'status': status, **fields} if i == index else d) for i, d in enumerate(conv['display'])]
    messages = conv['messages'] + ([{'role': 'user', 'content': note}] if note else [])
    return {'messages': messages, 'display': display}


# --- size ---------------------------------------------------------------------

def _bytes(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False).encode('utf-8'))


def conversation_bytes(conv: Dict[str, Any]) -> int:
    return _bytes({'messages': conv.get('messages') or [], 'display': conv.get('display') or []})


def prune(conv: Dict[str, Any], budget: int = CONVERSATION_BUDGET) -> Dict[str, Any]:
    """Drop the oldest tool results until the record fits its budget."""
    excess = conversation_bytes(conv) - budget
    if excess <= 0:
        return conv
    dropped = _bytes(DROPPED)
    messages = []
    for m in conv['messages']:
        if excess <= 0 or m.get('role') != 'tool' or m.get('content') == DROPPED:
            messages.append(m)
            continue
        excess -= _bytes(m.get('content')) - dropped
        messages.append({**m, 'content': DROPPED})
    return {**conv, 'messages': messages}
