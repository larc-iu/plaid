"""The requests a plan was made from, and a drop as those requests asked again.

Luke 2026-10-16: the plan after a drop is the plan its remaining requests make
when asked again from scratch, in the order they were made, over the same
stored data, a request answered "Nothing to change" included (REV7-PLAN-4).
Every app's workspace mixes in :class:`Replaying`: it keeps every planning
call the model made that was not refused, and a drop takes the requests of
the dropped entries out and asks the rest again on an empty plan. A keep that
a later scope still holds, a value a later request read as planned, what an
analysis took out, a rule that found nothing: each is what asking again
makes it. An app says how its entries are keyed and what a drop does beside
the replay (entries kept in part, entries a request needs), through the
hooks below; the replay itself is this one.

A request is identified by what it ASKED, not by what it changed (REV8-PLAN):
it stands for every entry it names, the ones it adds or changes, the ones it
asked for again as they already were (an op it staged that the plan held
already, or a value a tool notes with :meth:`Replaying.asks`), and a scope or
rule it staged, found or not. So a value asked twice is one entry, and a drop
of it takes both asks, as a rule asked twice is one rule. Dropping an entry
takes out every request that stands for it alone. A request that also stands
for entries left in the plan keeps them: it is asked again with the dropped
ones held out (``without``). A drop by document or field also takes the part
of every request in that document or field that the plan no longer shows (an
entry an analysis took out, a value that already held what it asks), by
where each entry was when it was asked (``where``).

A drop reads nothing from the store again: each request's reads when it was
first asked are reused (:meth:`Replaying.reused_read`), so a drop costs the
plan's own work and no queries, and the plan after it is the remaining
requests asked over the same stored data, as the ruling says. A plan not made
of its requests alone (one staged some other way, or resumed from an earlier
form) is dropped from in place, as before.
"""

import copy
import json
from typing import Any, Dict, Iterable, List, Optional, Tuple

from plaid_client import uuid7

from . import keep as _keep, opkind
from .tools import Refusal


def key_of(parts: Any) -> str:
    """An entry key, in the one form every app's keys take."""
    return json.dumps(parts, default=str, ensure_ascii=False, sort_keys=True)


def value_key(target: Any) -> str:
    """The key of the entry that writes to ``target`` (an op's target)."""
    return key_of(['value', list(target) if isinstance(target, tuple) else target])


class Request(dict):
    """One planning call: ``tool``, ``args`` as the model gave them, ``rid``
    (its own, kept as it is asked again), ``owns`` (the entries it stands
    for), ``where`` (each entry's documents and fields when it was asked),
    what a drop held out of it (``without``, entry keys) and whatever the app
    keeps beside (``needs``, the entries it was asked on)."""


def request(tool: str, args: Dict[str, Any], **extra: Any) -> Request:
    return Request(tool=tool, args=copy.deepcopy(args), rid=str(uuid7()), owns=[], **extra)


def owned(before: Dict[str, str], after: Dict[str, str], asked: Iterable[str] = ()) -> List[str]:
    """The entries a request stands for: those it added or changed, and those
    it asked (``asked``), whatever came of them."""
    return sorted({k for k, v in after.items() if before.get(k) != v} | set(asked))


def after_drop(dropped_keys: set, requests: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The requests a drop of the entries ``dropped_keys`` leaves: each that
    stands for none of them as it was, each that stands for some of them and
    for entries left with those held out, none that stands for them alone or
    needs one of them (``needs``: an entry of the plan the request was asked
    on, which the app names)."""
    out = []
    for rec in requests:
        owns = set(rec.get('owns') or ())
        hit = owns & dropped_keys
        if set(rec.get('needs') or ()) & dropped_keys:
            continue
        if not hit:
            out.append(rec)
        elif owns - dropped_keys:
            out.append(Request(rec, without=sorted(set(rec.get('without') or ()) | hit)))
    return out


class _StashReader:
    """The workspace's document reader, which hands back a document a drop
    put aside (:meth:`Replaying.replay`) rather than read it again, and notes
    which request read each document."""

    def __init__(self, ws, inner):
        self._ws, self._inner = ws, inner

    def get(self, doc_id: str, *args, **kwargs):
        doc = self._ws._doc_stash.pop(doc_id, None)
        if doc is None:
            doc = self._inner.get(doc_id, *args, **kwargs)
        if self._ws._reading is not None:
            self._ws._request_loaded.setdefault(self._ws._reading, set()).add(doc_id)
        return doc

    def read_ahead(self, entries, **kwargs):
        self._inner.read_ahead([e for e in entries if e[0] not in self._ws._doc_stash], **kwargs)

    def __getattr__(self, name):
        return getattr(self._inner, name)


def _plural(n: int, one: str, many: str) -> str:
    return f'{n} {one if n == 1 else many}'


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
        # ``replaying``. While one runs, the entries it asks (with their
        # documents and fields), and its id, which its reads are kept under.
        self.requests: List[Dict[str, Any]] = []
        self.empty_plan: Optional[Dict[str, Any]] = None
        self.replaying: Optional[Dict[str, Any]] = None
        self.keys_asked: Optional[Dict[str, List[set]]] = None
        self.request_reads: Dict[str, Dict[str, Any]] = {}
        self._reading: Optional[str] = None
        # The documents each request was the first to read, and the ones a
        # drop put aside: asked from scratch, a document only a dropped
        # request read is not read, and a card or a pin that reads the
        # documents loaded reads it as unread (:meth:`replay`).
        self._request_loaded: Dict[str, set] = {}
        self._doc_stash: Dict[str, Any] = {}

    @property
    def reader(self):
        return _StashReader(self, super().reader)

    def call_tool(self, tool: str, args: Dict[str, Any]) -> str:
        raise NotImplementedError

    # --- which entry an op is ------------------------------------------------

    def entry_key(self, op: Dict[str, Any]) -> str:
        """Which entry of the plan ``op`` is, the same however often it is
        asked again: what it writes to (a keep by the value it keeps, which
        is what a change named on that value writes to), else what it holds."""
        t = _keep.target(op) if _keep.is_keep(op) else self.op_target(op)
        return value_key(t) if t is not None else key_of(['op', self._plain(op)])

    def held_in(self, op: Dict[str, Any]) -> Optional[str]:
        """What the entry ``op`` holds, to tell whether a request changed it,
        or None to leave it out. A scope is held to what it was asked, not to
        the counts the plan's later changes settle on it, so a change named
        on one of its values does not stand for it."""
        held = self._plain(op)
        if opkind.resolver(self.KIND, op):
            held = {k: v for k, v in held.items() if k not in self.REQUEST_SETTLED}
        return json.dumps(held, sort_keys=True, default=str, ensure_ascii=False)

    def fingerprints(self, ops: Iterable[Dict[str, Any]]) -> Dict[str, str]:
        return self._scan(ops)[0]

    def _scan(self, ops: Iterable[Dict[str, Any]]) -> tuple:
        """Each entry of ``ops`` with what it holds (:meth:`held_in`), and
        the ops of each entry."""
        out: Dict[str, List[str]] = {}
        by_key: Dict[str, List[Dict[str, Any]]] = {}
        # Every request scans the whole plan twice, and most of its ops are
        # the very dicts the last scan read, unchanged: what an op was read as
        # is kept while it compares equal to the copy read then, which costs
        # far less than reading it again (REV8-PLAN-7).
        seen, cache = getattr(self, '_scanned', None) or {}, {}
        for op in ops:
            hit = seen.get(id(op))
            if hit is not None and hit[0] is op and hit[1] == op:
                k, held = hit[2], hit[3]
            else:
                k, held = self.entry_key(op), self.held_in(op)
                hit = (op, copy.deepcopy(op), k, held)
            cache[id(op)] = hit
            by_key.setdefault(k, []).append(op)
            if held is not None:
                out.setdefault(k, []).append(held)
        self._scanned = cache
        return {k: json.dumps(sorted(v)) for k, v in out.items()}, by_key

    def is_rule_key(self, key: str) -> bool:
        """Whether ``key`` is a corpus-wide change's own, as the app keys one: where
        it reaches is read off the plan, never kept with the request."""
        return False

    # --- what a request asks -----------------------------------------------------

    def asks(self, key: str, docs: Iterable[str] = (), fields: Iterable[str] = ()) -> None:
        """Note that the request running now asks for the entry ``key`` (in
        ``docs``, of ``fields``), whatever comes of it: a value it names that
        already holds what it asks, or that the plan already writes so."""
        if self.keys_asked is None:
            return
        at = self.keys_asked.setdefault(key, [set(), set()])
        at[0].update(d for d in docs if d)
        at[1].update(f for f in fields if f)

    def asks_value(self, target: Any, docs: Iterable[str] = (), fields: Iterable[str] = ()) -> None:
        self.asks(value_key(target), docs, fields)

    def reused_read(self, body: str, read) -> Any:
        """The store's answer to the query ``body`` for the request running
        now: what it answered when the request was first asked, while a drop
        asks it again, else ``read()``, kept for the next drop. Outside a
        request, ``read()``."""
        rid = self._reading
        if rid is None:
            return read()
        reads = self.request_reads.setdefault(rid, {})
        if body not in reads:
            reads[body] = read()
        return copy.deepcopy(reads[body])

    # --- the app's part ------------------------------------------------------------

    def new_request(self, tool: str, args: Dict[str, Any]) -> Request:
        return request(tool, args)

    def request_extra(self, tool: str, args: Dict[str, Any]) -> Any:
        """What the app reads of the plan before a request runs, handed to
        :meth:`request_owns` and :meth:`request_needs`."""
        return None

    def request_owns(self, rec: Dict[str, Any], before: Dict[str, str], now: Dict[str, str],
                     asked: Iterable[str], extra: Any) -> List[str]:
        return owned(before, now, asked)

    def request_needs(self, rec: Dict[str, Any], extra: Any) -> List[str]:
        return []

    def replay_begin(self, rec: Dict[str, Any]) -> None:
        """Before ``rec`` is asked again."""

    def replayed(self, rec: Dict[str, Any]) -> None:
        """After ``rec`` was asked again, what the drop held out of it gone."""

    def replay_done(self) -> None:
        """After a drop asked every request again: what asking again said is
        not news, the drop tells the model what changed, once."""
        self.reported_replaced = self.replaced

    def held_out(self, op: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """``op`` as the request asked again stages it: None when a drop
        took its entry."""
        if self.replaying is not None and self.entry_key(op) in (self.replaying.get('without') or ()):
            return None
        return op

    # --- a request as it runs --------------------------------------------------

    def request_begin(self, tool: str, args: Dict[str, Any]) -> Any:
        if self.replaying is not None:
            rec = Request(self.replaying)
        else:
            if not self.requests and not self.ops:
                self.empty_plan = copy.deepcopy(self.snapshot())
            rec = self.new_request(tool, args)
        self.keys_asked = {}
        self._reading = rec.get('rid')
        return rec, self.fingerprints(self.ops), self.request_extra(tool, args)

    def request_end(self, asked: Any, answer: str) -> None:
        rec, before, extra = asked
        notes, self.keys_asked, self._reading = self.keys_asked or {}, None, None
        if self.replaying is None and isinstance(answer, Refusal):
            self.request_reads.pop(rec.get('rid'), None)
            return
        if self.replaying is not None:
            # What a drop held out of it, wherever the tool put it.
            out = set(rec.get('without') or ())
            if out and any(self.entry_key(o) in out for o in self.ops):
                self.ops[:] = [o for o in self.ops if self.entry_key(o) not in out]
                self._gone_at = -1
            self.replayed(rec)
        notes = {k: v for k, v in notes.items() if k not in set(rec.get('without') or ())}
        now, by_key = self._scan(self.ops)
        rec['owns'] = self.request_owns(rec, before, now, notes, extra)
        needs = self.request_needs(rec, extra)
        if needs:
            rec['needs'] = needs
        else:
            rec.pop('needs', None)
        rec['where'] = self._request_where(rec, notes, by_key)
        self.requests.append(rec)

    def _request_where(self, rec: Dict[str, Any], notes: Dict[str, List[set]],
                       by_key: Dict[str, List[Dict[str, Any]]]) -> Dict[str, List[List[str]]]:
        """Where each entry ``rec`` stands for is (documents, fields): as the
        plan holds it now, as the tool noted it, and as it was when asked
        before (an entry the plan no longer shows keeps where it was)."""
        owns = [k for k in rec['owns'] if not self.is_rule_key(k)]
        if not owns:
            return {}
        at: Dict[str, List[set]] = {k: [set(), set()] for k in owns}
        for k, (docs, fields) in (rec.get('where') or {}).items():
            if k in at:
                at[k][0].update(docs)
                at[k][1].update(fields)
        for k, (docs, fields) in notes.items():
            if k in at:
                at[k][0].update(docs)
                at[k][1].update(fields)
        for k in at:
            for op in by_key.get(k) or ():
                at[k][0].update(self.op_documents(op))
                at[k][1].update(self.op_fields(op))
        return {k: [sorted(d), sorted(f)] for k, (d, f) in at.items()}

    def add_op(self, op: Dict[str, Any]) -> None:
        op = self.held_out(op)
        if op is None:
            return
        # Asked, whether or not it changes the plan: the same op the plan
        # holds already is asked again.
        if self.keys_asked is not None:
            self.asks(self.entry_key(op))
        super().add_op(op)

    def add_ops(self, ops: List[Dict[str, Any]]) -> None:
        super().add_ops([o for o in (self.held_out(op) for op in ops) if o is not None])

    # --- a drop ------------------------------------------------------------------

    def asked_whole(self, ops: Optional[List[Dict[str, Any]]] = None) -> bool:
        """Whether the plan (``ops``, by default the plan's) is made of its
        requests alone, so a drop may ask them again."""
        if self.empty_plan is None:
            return False
        owns = {k for r in self.requests for k in r.get('owns') or ()}
        return all(self.entry_key(o) in owns for o in (self.ops if ops is None else ops))

    def drop_in_place(self, dropped: List[Dict[str, Any]], field: Optional[str],
                      document: Optional[str]) -> str:
        """A plan not made of its requests is dropped from in place."""
        return super().after_drop(dropped, field, document)

    def drop_narrowing(self, dropped: List[Dict[str, Any]], field: Optional[str]) -> Dict[str, set]:
        """The entries of ``dropped`` a drop by ``field`` keeps in part (an
        entry that holds other fields loses only that one's values): taken out of
        ``dropped`` here, keyed to what they lose."""
        return {}

    def narrow_requests(self, requests: List[Dict[str, Any]], narrow: Dict[str, set]) -> List[Dict[str, Any]]:
        return requests

    def drop_measure(self, pre: List[Dict[str, Any]]) -> Any:
        """What the app reads of the plan before a drop, for its note."""
        return None

    def after_drop(self, dropped: List[Dict[str, Any]], field: Optional[str] = None,
                   document: Optional[str] = None) -> str:
        if not self.asked_whole(self.ops + list(dropped)):
            return self.drop_in_place(dropped, field, document)
        pre = self.ops + list(dropped)
        narrow = self.drop_narrowing(dropped, field) if field is not None else {}
        live = {self.entry_key(o) for o in pre}
        gone = {self.entry_key(o) for o in dropped}
        if field is not None or document is not None:
            gone |= self._dormant_in(live, field, document)
        reqs = self.narrow_requests(self.requests, narrow) if narrow else self.requests
        reqs = after_drop(gone, reqs)
        if field is not None or document is not None:
            # A request that stands for nothing in the plan now, and asks for
            # what the drop names, goes too: asked again, it would put back
            # what the drop took out.
            reqs = [r for r in reqs if set(r.get('owns') or ()) & live
                    or not self.asks_for(r, field, document)]
        measure = self.drop_measure(pre)
        left = {self.entry_key(o): o for o in self.ops}
        left.update({k: o for o in pre for k in [self.entry_key(o)] if k in narrow})
        # As the drop found them, before anything went (drop_planned counted
        # them over the whole plan).
        counts = self.rule_counts(settle=False)
        self.replay(reqs)
        now = {self.entry_key(o): o for o in self.ops}
        went = [o for k, o in left.items() if k not in now]
        back = [k for k in now if k not in left]
        grew = [(name, n, counts[k][0]) for k, (n, name) in self.rule_counts(settle=True).items()
                if k in counts and n > counts[k][0]]
        return self.drop_note(dropped, went, back, field, narrow, measure) + self.grew_note(grew, len(dropped))

    def _dormant_in(self, live: set, field: Optional[str], document: Optional[str]) -> set:
        """The entries requests stand for that the plan does not show (an
        analysis took them out, they held what was asked already) and that
        lie in ``document`` alone and are of ``field``, by where they were
        when asked: a drop by document or field takes those parts too
        (REV8-PLAN-3)."""
        try:
            doc_id = self.resolve_document_id(document) if document is not None else None
        except Exception:  # noqa: BLE001 - the drop itself said what was wrong with it
            return set()
        want = field.strip().casefold() if field is not None else None
        out = set()
        for rec in self.requests:
            for k, (docs, fields) in (rec.get('where') or {}).items():
                if k in live or self.is_rule_key(k):
                    continue
                if doc_id is not None and set(docs) != {doc_id}:
                    continue
                if want is not None and want not in {f.casefold() for f in fields}:
                    continue
                out.add(k)
        return out

    def rule_counts(self, settle: bool) -> Dict[str, tuple]:
        """Each corpus-wide change of the plan by its key: how many changes
        it makes and its line, so a drop can say which grew. ``settle``:
        counted again over the plan as it stands, else as last counted."""
        return {self.entry_key(op): (op['count'], op.get('change') or op.get('label') or '') for op in self.ops
                if opkind.resolver(self.KIND, op) and isinstance(op.get('count'), int)}

    def grew_note(self, grew: List[tuple], dropped: int) -> str:
        """A drop that left a corpus-wide change more to change says so: the
        model may have told the user the old number (REV8-PLAN-6)."""
        if not grew:
            return ''
        many = len(grew) != 1
        parts = [f'{name} now makes {_plural(n, "change", "changes")}, {n - was} more than before'
                 for name, n, was in grew]
        return (f' {"These corpus-wide changes find" if many else "A corpus-wide change finds"} more to '
                f'change without the dropped change{"s" if dropped != 1 else ""}: {"; ".join(parts)}.')

    def drop_note(self, dropped: List[Dict[str, Any]], went: List[Dict[str, Any]], back: List[str],
                  field: Optional[str], narrow: Dict[str, set], measure: Any) -> str:
        """What a drop changed beside what it dropped, said in sentences
        (each starting with a space)."""
        keeps = sum(1 for o in went if _keep.is_keep(o))
        others = len(went) - keeps
        return ((f' {_plural(keeps, "value", "values")} kept out of it went with it: nothing in '
                 f'the plan would change {"it" if keeps == 1 else "them"} now.' if keeps else '')
                + (f' {others} other entr{"ies" if others != 1 else "y"} went with it: asked again without '
                   f'the dropped change, {"they plan" if others != 1 else "it plans"} nothing.' if others else '')
                + self.back_note(back, dropped))

    def back_note(self, back: List[str], dropped: List[Dict[str, Any]]) -> str:
        if not back:
            return ''
        return (f' {len(back)} entr{"ies" if len(back) != 1 else "y"} that the dropped '
                f'change{"s" if len(dropped) != 1 else ""} had held out of the plan '
                f'{"are" if len(back) != 1 else "is"} back in it.')

    def asks_for(self, rec: Dict[str, Any], field: Optional[str], document: Optional[str]) -> bool:
        """Whether the request ``rec`` asks for a change to ``field`` and in
        ``document`` (either None for any), as a drop by field or document
        reads the entries of the plan: a change that may reach other
        documents is not one in ``document``."""
        args = rec.get('args') or {}
        if field is not None:
            want = field.strip().casefold()
            names = [args.get('field')] + (list(args['values']) if isinstance(args.get('values'), dict) else [])
            if want not in {n.strip().casefold() for n in names if isinstance(n, str)}:
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
        # The documents the plan's requests read are put aside, each read back
        # (from here, not the store) by the first request asked again that
        # reads it, so the documents loaded are those the remaining requests
        # read, as they are asked from scratch.
        for rec in self.requests:
            for did in self._request_loaded.pop(rec.get('rid'), ()):
                if did in self._docs:
                    self._doc_stash[did] = self._docs.pop(did)
        self.restore(copy.deepcopy(self.empty_plan))
        self.requests = []
        try:
            for rec in requests:
                self.replaying = rec
                self.replay_begin(rec)
                self.call_tool(rec['tool'], copy.deepcopy(rec['args']))
        finally:
            self.replaying = None
            self.reads = reads
            self.step_label = label
        keep = {r.get('rid') for r in self.requests}
        self.request_reads = {k: v for k, v in self.request_reads.items() if k in keep}
        self.replay_done()

    def after_discard(self) -> None:
        super().after_discard()
        self.requests = []
        self.empty_plan = None
        self.request_reads = {}

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


__all__: Tuple[str, ...] = ('Replaying', 'Request', 'after_drop', 'key_of', 'owned', 'request', 'value_key')
