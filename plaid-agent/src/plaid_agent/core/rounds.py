"""What the model was sent back and what it wrote, one model call at a time.

Each model call of a turn (a "round") is stored by the service as one value
beside the conversation, at ``<app>:assistant:<project>:round:<conv>:<round
id>``: the question as the model received it (first round only), the
reasoning the provider returned for the call (``thinking``, never sent back
to the model), the text the model wrote beside its tool calls, and each
call's whole arguments and its result exactly as the model was sent it. The record keeps only what draws the
work at a glance (a step's ``round``, ``said`` and ``saw``, core/trace.py), so
what the reader can open does not depend on what the record keeps for the
model, and the record barely grows.

The instructions the model was given (the system prompt and the tool list)
are stored once per conversation for each distinct prompt, at
``<app>:assistant:<project>:prompt:<conv>:<hash>``, and the first round of a
turn names the one it was sent (``prompt``).

Rounds and prompts are written by the service only, once each under a fresh
key, so they take neither the conversation's lock nor a version. They are
deleted with the conversation (`ConversationStore.delete`) and swept as
orphans with the files (`files.sweep_orphans`).
"""

import hashlib
import json
import threading
import traceback
from typing import Any, Callable, Dict, List, Optional, Set

from plaid_client import PlaidAPIError, uuid7

from .conversation import _bytes, _patiently, now_iso
from .files import value_budget

#: The kinds of value stored beside a conversation besides its files.
ROUND = 'round'
PROMPT = 'prompt'


def round_prefix(app: str, project_id: str, conv_id: str) -> str:
    return f'{app}:assistant:{project_id}:{ROUND}:{conv_id}:'


def round_key(app: str, project_id: str, conv_id: str, round_id: str) -> str:
    return round_prefix(app, project_id, conv_id) + round_id


def prompt_prefix(app: str, project_id: str, conv_id: str) -> str:
    return f'{app}:assistant:{project_id}:{PROMPT}:{conv_id}:'


def new_round(n: int, model: Optional[str], asked: Optional[str] = None) -> Dict[str, Any]:
    """A round as the loop starts it, once its model call has returned."""
    out: Dict[str, Any] = {'id': uuid7(), 'n': n, 'at': now_iso(), 'model': model, 'calls': []}
    if asked is not None:
        out['asked'] = asked
    return out


def call_record(call_id: str, name: str, arguments: str, result: str, cut: bool = False) -> Dict[str, Any]:
    """One tool call as its round keeps it: the arguments as the model wrote
    them, whole, and the result exactly as the model was sent it. ``cut``:
    the result was cut to `limits.MAX_RESULT_CHARS` (`limits.note_cut`)."""
    result = str(result)
    out = {'id': call_id, 'name': name, 'arguments': arguments, 'result': result, 'chars': len(result)}
    if cut:
        out['cut'] = True
    return out


def fit(rnd: Dict[str, Any], budget: int) -> Dict[str, Any]:
    """``rnd`` held to ``budget`` stored bytes: the reasoning is cut from its
    middle first, then the longest results, each with a line saying how much
    went, and the round says it was ``fitted``. A round under the budget is
    returned as it is."""
    over = _bytes(rnd) - budget
    if over <= 0:
        return rnd
    out = {**rnd}
    thinking = rnd.get('thinking')
    if isinstance(thinking, str) and _bytes(thinking) > 200:
        out['thinking'] = _middle_cut(thinking, over)
        over -= _bytes(thinking) - _bytes(out['thinking'])
    calls = [dict(c) for c in rnd.get('calls') or []]
    for c in sorted(calls, key=lambda c: -_bytes(c.get('result') or '')):
        if over <= 0:
            break
        text = c.get('result') or ''
        size = _bytes(text)
        if size <= 200:
            continue
        c['result'] = _middle_cut(text, over)
        over -= size - _bytes(c['result'])
    out.update(calls=calls, fitted=True)
    if over > 0 and out.get('asked'):
        out['asked'] = out['asked'][:max(0, len(out['asked']) - over)]
    return out


def _middle_cut(text: str, over: int) -> str:
    """``text`` less about ``over`` stored bytes from its middle, with a line
    saying how many characters went."""
    size = _bytes(text)
    # Characters cost from one to twelve stored bytes: keep a share of the
    # characters as large as the share of bytes that may stay.
    keep = max(0, int(len(text) * max(0, size - over - 200) / size))
    front, back = text[:keep // 2], text[len(text) - keep // 2:] if keep // 2 else ''
    cut = len(text) - len(front) - len(back)
    return f'{front}\n[{cut} characters cut to fit the store]\n{back}'


def prompt_value(system: str, tools: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The instructions as stored. The tool list is JSON text, as the model
    was sent it: stored as a value its keys would be recased by the clients."""
    return {'system': system, 'tools': json.dumps(tools, indent=2, ensure_ascii=False)}


def prompt_hash(system: str, tools: List[Dict[str, Any]]) -> str:
    raw = json.dumps(prompt_value(system, tools), sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:16]


class RoundKeeper:
    """One turn's rounds, stored as they finish, and what the turn has shown
    so far, which every progress event carries.

    ``trace`` is the turn's steps so far (the loop's own list), ``text`` the
    text the model call under way has written, ``thinking`` its reasoning so
    far, ``stored`` the rounds written.
    A round the store refused does not fail the turn: its steps say
    ``unstored`` and the panel draws them unopenable."""

    #: Prompts known stored, by key, in this process.
    _prompts_known: Set[str] = set()
    _prompts_lock = threading.Lock()

    def __init__(self, store, conv_id: str, system: Optional[str] = None,
                 tools: Optional[List[Dict[str, Any]]] = None):
        self.store_ = store
        self.conv_id = conv_id
        self.trace: List[Dict[str, Any]] = []
        self.text = ''
        self.thinking = ''
        # Called when ``thinking`` grew (the service sends a progress event).
        self.on_thinking = lambda: None
        self.stored: Set[str] = set()
        # The turn was stopped: a round write waiting out a server that is
        # away gives up, and its steps are drawn unstored.
        self.cancelled: Callable[[], bool] = lambda: False
        self.system = system
        self.tools = tools

    def follow(self, trace: List[Dict[str, Any]]) -> None:
        self.trace = trace

    def think(self, text: str) -> None:
        """The reasoning of the model call under way, whole so far ('' when
        a call starts)."""
        self.thinking = text
        if text:
            self.on_thinking()

    def live_trace(self) -> List[Dict[str, Any]]:
        """The steps so far as a progress event carries them: as they will be
        stored, plus ``stored`` on those whose round is written."""
        return [{**s, 'stored': True} if s.get('round') in self.stored else s for s in self.trace]

    def key(self, round_id: str) -> str:
        s = self.store_
        return round_key(s.app, s.project_id, self.conv_id, round_id)

    def store(self, rnd: Dict[str, Any]) -> bool:
        """Write ``rnd``. False when the store would not take it."""
        s = self.store_
        value = {**rnd, 'conversation_id': self.conv_id}
        try:
            if rnd.get('n') == 1 and self.system is not None:
                value['prompt'] = self._keep_prompt()
            value = fit(value, value_budget(s.client))
            _patiently(lambda: s.client.user_data.put(s.user_id, self.key(rnd['id']), value), self.cancelled)
        except Exception:  # noqa: BLE001 - the turn goes on, the step is drawn unopenable
            traceback.print_exc()
            return False
        self.stored.add(rnd['id'])
        return True

    def _keep_prompt(self) -> Optional[str]:
        """The hash of this turn's prompt, stored beside the conversation
        unless it already is. None when it could not be."""
        s = self.store_
        h = prompt_hash(self.system, self.tools or [])
        key = prompt_prefix(s.app, s.project_id, self.conv_id) + h
        with self._prompts_lock:
            if key in self._prompts_known:
                return h
        try:
            there = s.client.user_data.list(s.user_id, prefix=key, page_size=1) or []
            if not any(isinstance(e, dict) and e.get('key') == key for e in there):
                value = prompt_value(self.system, self.tools or [])
                _patiently(lambda: s.client.user_data.put(s.user_id, key, value), self.cancelled)
        except PlaidAPIError:
            traceback.print_exc()
            return None
        with self._prompts_lock:
            self._prompts_known.add(key)
        return h
