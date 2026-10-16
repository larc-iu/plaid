"""The requests a plan was made from, and a drop as those requests asked again.

Luke 2026-10-16: the plan after a drop is the plan its remaining requests make
when asked again from scratch, in the order they were made, over the same
stored data, a request answered "Nothing to change" included (REV7-PLAN-4).
An app whose plan holds more than its ops (planned analyses, new entries)
keeps its own. This is the same for an app whose plan is its ops alone:
:class:`Replaying` keeps every planning call the model made that was not
refused, and a drop takes the requests of the dropped entries out and asks
the rest again on an empty plan. A keep that a later scope still holds, a
value a later request read as planned, a value asked twice: each is what
asking again makes it.

Which entries a request stands for is read off the plan as it is asked
(:func:`owned`): the entries it adds or changes, by :meth:`Replaying.entry_key`,
and a scope it stages, changed or not, so a scope asked twice is one entry
and dropping it takes every ask, as a rule asked twice is one rule. Dropping an entry takes out
every request that stands for it alone. A request that also stands for
entries left in the plan keeps them: it is asked again with the dropped ones
held out (``without``).

A plan not made of its requests alone (one staged some other way, or resumed
from an earlier form) is dropped from in place, as before.
"""

import copy
import json
from typing import Any, Dict, Iterable, List, Optional, Tuple

from . import keep as _keep, opkind
from .tools import Refusal



class Request(dict):
    """One planning call: ``tool``, ``args`` as the model gave them,
    ``owns`` (:func:`owned`) and what a drop held out of it (``without``,
    entry keys)."""


def request(tool: str, args: Dict[str, Any]) -> Request:
    return Request(tool=tool, args=copy.deepcopy(args), owns=[])


def owned(before: Dict[str, str], after: Dict[str, str], asked: Iterable[str] = ()) -> List[str]:
    """The entries a request stands for: those it added or changed, and the
    scopes it staged (``asked``), whatever they found."""
    return sorted({k for k, v in after.items() if before.get(k) != v} | set(asked))


def after_drop(dropped_keys: set, requests: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The requests a drop of the entries ``dropped_keys`` leaves: each that
    stands for none of them as it was, each that stands for some of them and
    for entries left with those held out, none that stands for them alone."""
    out = []
    for rec in requests:
        owns = set(rec.get('owns') or ())
        hit = owns & dropped_keys
        if not hit:
            out.append(rec)
        elif owns - dropped_keys:
            out.append(Request(rec, without=sorted(set(rec.get('without') or ()) | hit)))
    return out


class Replaying:
    """What an app's workspace adds to keep its requests and drop by asking
    them again. Mixed in before the core workspace; the app says how one of
    its tools is called (:meth:`call_tool`), and which keys of its ops say
    how they were staged or counted rather than what they write."""

    #: Keys an op carries about how it was staged (a call's tag, a card)
    #: rather than what it writes: left out of what an entry holds.
    REQUEST_BOOKKEEPING: Tuple[str, ...] = ()
    #: Keys of a scope that the plan's other changes settle (its counts and
    #: its line): left out of what a scope holds, so a change named on one
    #: of its values does not stand for it.
    REQUEST_SETTLED: Tuple[str, ...] = ('count', 'label', 'matched')

    def init_requests(self) -> None:
        # The planning calls this turn's plan was made from, in order, and the
        # plan with none of them asked. While one is asked again, it is
        # ``replaying``. The scopes the call running now staged.
        self.requests: List[Dict[str, Any]] = []
        self.empty_plan: Optional[Dict[str, Any]] = None
        self.replaying: Optional[Dict[str, Any]] = None
        self.scopes_asked: set = set()

    def call_tool(self, tool: str, args: Dict[str, Any]) -> str:
        raise NotImplementedError

    # --- which entry an op is ------------------------------------------------

    def entry_key(self, op: Dict[str, Any]) -> str:
        """Which entry of the plan ``op`` is, the same however often it is
        asked again: what it writes to (a keep by the value it keeps, which
        is what a change named on that value writes to), else what it holds."""
        t = _keep.target(op) if _keep.is_keep(op) else self.op_target(op)
        key = ['value', t] if t is not None else ['op', self._plain(op)]
        return json.dumps(key, default=str, ensure_ascii=False, sort_keys=True)

    def fingerprints(self, ops: Iterable[Dict[str, Any]]) -> Dict[str, str]:
        """Each entry of ``ops`` with what it holds. A scope is held to what
        it was asked, not to the counts the plan's later changes settle on
        it, so a change named on one of its values does not stand for it."""
        out: Dict[str, List[str]] = {}
        for op in ops:
            held = self._plain(op)
            if opkind.resolver(self.KIND, op):
                held = {k: v for k, v in held.items() if k not in self.REQUEST_SETTLED}
            out.setdefault(self.entry_key(op), []).append(
                json.dumps(held, sort_keys=True, default=str, ensure_ascii=False))
        return {k: json.dumps(sorted(v)) for k, v in out.items()}

    # --- a request as it runs --------------------------------------------------

    def request_begin(self, tool: str, args: Dict[str, Any]) -> Any:
        if self.replaying is not None:
            rec = Request(self.replaying)
        else:
            if not self.requests and not self.ops:
                self.empty_plan = copy.deepcopy(self.snapshot())
            rec = request(tool, args)
        self.scopes_asked = set()
        return rec, self.fingerprints(self.ops)

    def request_end(self, asked: Any, answer: str) -> None:
        rec, before = asked
        scopes, self.scopes_asked = self.scopes_asked, set()
        if self.replaying is None and isinstance(answer, Refusal):
            return
        if self.replaying is not None:
            # What a drop held out of it, wherever the tool put it.
            out = set(rec.get('without') or ())
            if out and any(self.entry_key(o) in out for o in self.ops):
                self.ops[:] = [o for o in self.ops if self.entry_key(o) not in out]
                self._gone_at = -1
        rec['owns'] = owned(before, self.fingerprints(self.ops), scopes)
        self.requests.append(rec)

    def held_out(self, op: Dict[str, Any]) -> bool:
        """Whether the request asked again holds ``op`` out: a drop took its
        entry."""
        return self.replaying is not None and self.entry_key(op) in (self.replaying.get('without') or ())

    def add_op(self, op: Dict[str, Any]) -> None:
        if self.held_out(op):
            return
        if opkind.resolver(self.KIND, op):
            self.scopes_asked.add(self.entry_key(op))
        super().add_op(op)

    def add_ops(self, ops: List[Dict[str, Any]]) -> None:
        super().add_ops([op for op in ops if not self.held_out(op)])

    # --- a drop ------------------------------------------------------------------

    def asked_whole(self, ops: Optional[List[Dict[str, Any]]] = None) -> bool:
        """Whether the plan (``ops``, by default the plan's) is made of its
        requests alone, so a drop may ask them again."""
        if self.empty_plan is None:
            return False
        owns = {k for r in self.requests for k in r.get('owns') or ()}
        return all(self.entry_key(o) in owns for o in (self.ops if ops is None else ops))

    def after_drop(self, dropped: List[Dict[str, Any]], field: Optional[str] = None,
                   document: Optional[str] = None) -> str:
        if not self.asked_whole(self.ops + list(dropped)):
            return super().after_drop(dropped, field, document)
        pre = self.ops + list(dropped)
        reqs = after_drop({self.entry_key(o) for o in dropped}, self.requests)
        if field is not None or document is not None:
            # A request that stands for nothing in the plan now, and asks for
            # what the drop names, goes too: asked again, it would put back
            # what the drop took out.
            live = {self.entry_key(o) for o in pre}
            reqs = [r for r in reqs if set(r.get('owns') or ()) & live
                    or not self.asks_for(r, field, document)]
        left = {self.entry_key(o): o for o in self.ops}
        self.replay(reqs)
        now = {self.entry_key(o) for o in self.ops}
        went = [o for k, o in left.items() if k not in now]
        back = [k for k in now if k not in left]
        keeps = sum(1 for o in went if _keep.is_keep(o))
        others = len(went) - keeps
        return ((f' {keeps} {"value" if keeps == 1 else "values"} kept out of it went with it: nothing in '
                 f'the plan would change {"it" if keeps == 1 else "them"} now.' if keeps else '')
                + (f' {others} other entr{"ies" if others != 1 else "y"} went with it: asked again without '
                   f'the dropped change, {"they plan" if others != 1 else "it plans"} nothing.' if others else '')
                + (f' {len(back)} entr{"ies" if len(back) != 1 else "y"} that the dropped '
                   f'change{"s" if len(dropped) != 1 else ""} had held out of the plan '
                   f'{"are" if len(back) != 1 else "is"} back in it.' if back else ''))

    def asks_for(self, rec: Dict[str, Any], field: Optional[str], document: Optional[str]) -> bool:
        """Whether the request ``rec`` asks for a change to ``field`` and in
        ``document`` (either None for any), as a drop by field or document
        reads the entries of the plan."""
        args = rec.get('args') or {}
        if field is not None:
            name = args.get('field')
            if not isinstance(name, str) or name.strip().casefold() != field.strip().casefold():
                return False
        if document is not None:
            try:
                doc_id = self.resolve_document_id(document)
                named = self.resolve_document_id(args['document']) if args.get('document') else None
            except Exception:  # noqa: BLE001 - a name that names no document now
                return False
            if named != doc_id:
                return False
        return True

    def replay(self, requests: List[Dict[str, Any]]) -> None:
        """Ask ``requests`` again, in order, on an empty plan: the plan they
        make from scratch. A request refused now stays a request, so a later
        drop that clears its way asks it again."""
        reads, label = self.reads, getattr(self, 'step_label', None)
        self.reads = None
        self.restore(copy.deepcopy(self.empty_plan))
        self.requests = []
        try:
            for rec in requests:
                self.replaying = rec
                self.call_tool(rec['tool'], copy.deepcopy(rec['args']))
        finally:
            self.replaying = None
            self.reads = reads
            self.step_label = label
        # What asking again said is not news: the model is told what the drop
        # changed, once, by the drop.
        self.reported_replaced = self.replaced

    def after_discard(self) -> None:
        super().after_discard()
        self.requests = []
        self.empty_plan = None

    # --- across turns ------------------------------------------------------------

    def plan_state(self) -> Dict[str, Any]:
        state = super().plan_state()
        state['requests'] = [dict(r) for r in self.requests] if self.asked_whole() else None
        return state

    def resume(self, state: Dict[str, Any], documents: List[Dict[str, Any]]) -> None:
        empty = self.snapshot()
        super().resume(state, documents)
        if isinstance(state.get('requests'), list):
            self.requests = [Request(r) for r in state['requests']]
            self.empty_plan = empty

    def _plain(self, op: Dict[str, Any]) -> Dict[str, Any]:
        return {k: v for k, v in op.items() if k not in self.REQUEST_BOOKKEEPING}


__all__: Tuple[str, ...] = ('Replaying', 'Request', 'after_drop', 'owned', 'request')
