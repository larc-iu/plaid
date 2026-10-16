"""The requests a plan was made from, and a drop as those requests asked again.

Luke 2026-10-16: the plan after a drop is the plan its remaining requests make
when asked again from scratch, in the order they were made, over the same
stored data, a request answered "Nothing to change" included (REV7-PLAN-4).
So the workspace keeps every planning call the model made that was not
refused (:class:`Request`), and a drop takes the requests of the dropped
entries out and asks the rest again on an empty plan (:func:`replay`). What a
request asked that only a later request undid, what a rule found nothing to
change in, what an analysis took out: each comes back when what stood in its
way is dropped, since asking again is all a drop does.

Which entries a request stands for is read off the plan as it is asked
(:func:`owned`): the entries it adds or changes, by :func:`entry_key`, and for
a corpus-wide change its own rule, found or not. Dropping an entry takes out
every request that stands for it. A request that also stands for entries left
in the plan keeps them: it is asked again with the dropped ones held out
(``without``), and a drop by field takes only that field's values out of a
planned analysis (``without_fields``, Luke 2026-10-16, PLAN-2).
"""

import copy
import json
from typing import Any, Dict, Iterable, List, Optional

from ..core import keep as _keep, rules

#: The plan's own bookkeeping on an op, which says how it was asked rather
#: than what it writes.
BOOKKEEPING = ('seq', 'asked', 'analysis_asked', 'named_edits', 'card')


def entry_key(op: Dict[str, Any]) -> str:
    """Which entry of the plan ``op`` is, the same however often it is worked
    out again: a planned analysis by its word, a rule by its tool and
    arguments, a value (named or kept) by what it writes to, anything else by
    its target or, with none, what it holds."""
    from .bulk import asked_of
    from .workspace import op_target
    if op.get('kind') == 'set_analysis':
        key: List[Any] = ['analysis', op.get('word_id')]
    elif rules.is_rule(op):
        key = list(rules.target(op))
    elif _keep.is_keep(op):
        key = ['value', _keep.target(op)]
    else:
        base = asked_of(op)
        t = op_target(base if base is not None else op)
        key = ['value', t] if t is not None else ['op', _plain(op)]
    return json.dumps(key, default=str, ensure_ascii=False)


def _plain(op: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in op.items() if k not in BOOKKEEPING}


def fingerprints(ops: Iterable[Dict[str, Any]]) -> Dict[str, List[str]]:
    """Each entry of ``ops`` with what it holds, for :func:`owned`. A rule is
    left out: it changes whenever the plan before it does, and a request
    stands for a rule only by asking it."""
    out: Dict[str, List[str]] = {}
    for op in ops:
        if rules.is_rule(op):
            continue
        out.setdefault(entry_key(op), []).append(json.dumps(op, sort_keys=True, default=str, ensure_ascii=False))
    for v in out.values():
        v.sort()
    return out


def owned(before: Dict[str, List[str]], after: Dict[str, List[str]], rule: Optional[tuple]) -> List[str]:
    """The entries a request stands for: those it added or changed, and the
    rule it asked (``rule``, its target), whatever it found."""
    out = {k for k, v in after.items() if before.get(k) != v}
    if rule is not None:
        out.add(json.dumps(list(rule), default=str, ensure_ascii=False))
    return sorted(out)


class Request(dict):
    """One planning call: ``tool``, ``args`` as the model gave them,
    ``entry_no`` (the count of new entries before it, so a new entry keeps
    the key the model was given), ``owns`` (:func:`owned`), and what a drop
    held out of it (``without``, entry keys, and ``without_fields``, pairs of
    an analysis's key and a field's layer id)."""


def request(tool: str, args: Dict[str, Any], entry_no: int) -> Request:
    return Request(tool=tool, args=copy.deepcopy(args), entry_no=entry_no, owns=[])


def without_fields(rec: Dict[str, Any]) -> Dict[str, set]:
    out: Dict[str, set] = {}
    for key, layer in rec.get('without_fields') or ():
        out.setdefault(key, set()).add(layer)
    return out


def held_out(ws, op: Dict[str, Any], rec: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """``op`` as the request being asked again stages it: None when a drop
    held its entry out, a planned analysis less the fields a drop took out
    of it, else ``op`` itself."""
    if not rec:
        return op
    key = entry_key(op)
    if key in (rec.get('without') or ()):
        return None
    layers = without_fields(rec).get(key)
    if not layers or op.get('kind') != 'set_analysis':
        return op
    from .bulk import relabelled
    return relabelled(ws, op, [{**m, 'fields': [f for f in m.get('fields') or [] if f.get('layer_id') not in layers]}
                               for m in op.get('morphemes') or []])


def narrowed(ws, rec: Dict[str, Any], keys: set, layers_of: Dict[str, set]) -> Optional[Dict[str, Any]]:
    """``rec`` with the values of the fields a drop by field takes out of the
    planned analyses ``keys`` (``layers_of``, each analysis's layer ids),
    or None when nothing of it is left. A value named on one of their
    morphemes goes, the analysis stays (PLAN-2)."""
    hit = [k for k in rec.get('owns') or () if k in keys]
    if not hit:
        return rec
    tool, args = rec['tool'], rec['args']
    if tool == 'set_field':
        layers = set().union(*(layers_of[k] for k in hit))
        if isinstance(args.get('values'), dict):
            left = {name: v for name, v in args['values'].items() if _layer(ws, name) not in layers}
            if not left:
                return None
            return Request(rec, args={**args, 'values': left})
        return None if _layer(ws, args.get('field')) in layers else rec
    if tool in ('set_analysis', 'set_analysis_for_form'):
        pairs = {tuple(p) for p in rec.get('without_fields') or ()}
        pairs |= {(k, layer) for k in hit for layer in layers_of[k]}
        return Request(rec, without_fields=sorted(list(p) for p in pairs))
    return rec


def _layer(ws, name) -> Optional[str]:
    from .tools import _field_named
    try:
        return _field_named(ws, name).layer_id if isinstance(name, str) else None
    except Exception:  # noqa: BLE001 - a name no field has holds no field's values
        return None


def needs(ops: Iterable[Dict[str, Any]], keys: Iterable[str]) -> List[str]:
    """The planned analyses the entries ``keys`` of ``ops`` were asked on (a
    link to a morpheme of one): a request for them goes with that analysis,
    as a value named on one of its morphemes does."""
    keys = set(keys)
    return sorted({json.dumps(['analysis', op['analysis_word_id']], default=str, ensure_ascii=False)
                   for op in ops if op.get('analysis_word_id') and entry_key(op) in keys})


def asks_for(ws, rec: Dict[str, Any], field: Optional[str], document: Optional[str]) -> bool:
    """Whether the request ``rec`` asks for a change to ``field`` and in
    ``document`` (either None for any), as a drop by field or document reads
    the entries of the plan: a change that may reach other documents is not
    one in ``document``."""
    args = rec.get('args') or {}
    if field is not None:
        want = field.strip().casefold()
        names = [args.get('field')] + list(args.get('values') or {}) if isinstance(args.get('values'), dict) \
            else [args.get('field')]
        if want not in {n.strip().casefold() for n in names if isinstance(n, str)}:
            return False
    if document is not None:
        try:
            doc_id = ws.resolve_document_id(document)
            named = ws.resolve_document_id(args['document']) if args.get('document') else None
        except Exception:  # noqa: BLE001 - a name that names no document now
            return False
        if named != doc_id:
            return False
    return True


def after_drop(dropped_keys: set, requests: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """The requests a drop of the entries ``dropped_keys`` leaves: each that
    stands for none of them as it was, each that stands for some of them
    and for entries left with those held out, none that stands for them
    alone or was asked on a planned analysis dropped (``needs``)."""
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


def replay(ws, requests: List[Dict[str, Any]]) -> None:
    """Ask ``requests`` again, in order, on an empty plan: the plan they
    make from scratch. A request refused now stays a request, so a later
    drop that clears its way asks it again."""
    from .toolkit import call_tool
    reads, label = ws.reads, getattr(ws, 'step_label', None)
    entry_no = ws.entry_no
    ws.reads = None
    ws.restore(copy.deepcopy(ws.empty_plan))
    ws.requests = []
    try:
        for rec in requests:
            ws.replaying = rec
            ws.entry_no = rec.get('entry_no') or 0
            call_tool(ws, rec['tool'], copy.deepcopy(rec['args']))
    finally:
        ws.replaying = None
        ws.reads = reads
        ws.step_label = label
        ws.entry_no = max(ws.entry_no, entry_no)
    # What asking again said is not news: the model is told what the drop
    # changed, once, by the drop.
    ws.reported_replaced = ws.replaced
    ws.reported_took = ws.analysis_took
    ws.reported_unlinked = ws.unlinked
