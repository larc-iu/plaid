"""What igt adds to a drop that asks the plan's requests again (core/requests.py).

The replay is core's (:class:`plaid_agent.core.requests.Replaying`). igt's
plan holds more than values: planned analyses, new entries, rules found over
the plan's own changes. So it keys its entries its own way
(:func:`entry_key`: an analysis by its word, a new entry by the key the model
was given, which survives a field set on it later), a request asked of a
morpheme of a planned analysis or linking to a new entry of the plan needs
that analysis or entry (:func:`needs`, :func:`asked_on_analyses`), and a drop
by field takes only that field's values out of a planned analysis
(:func:`narrowed`, Luke 2026-10-16, PLAN-2).
"""

import functools
import json
from typing import Any, Dict, Iterable, List, Optional

from ..core import keep as _keep, rules
from ..core.requests import Request, key_of

#: The plan's own bookkeeping on an op, which says how it was asked rather
#: than what it writes.
BOOKKEEPING = ('seq', 'asked', 'analysis_asked', 'named_edits', 'card')


def entry_key(op: Dict[str, Any]) -> str:
    """Which entry of the plan ``op`` is, the same however often it is worked
    out again: a planned analysis by its word, a rule by its tool and
    arguments, a new entry by its key, a value (named or kept) by what it
    writes to, anything else by its target or, with none, what it holds.
    Asked of every op of the plan twice a request, so it reads the op's kind
    first."""
    kind = op.get('kind')
    if kind == 'set_analysis':
        key: List[Any] = ['analysis', op.get('word_id')]
    elif kind == 'create_entry':
        key = new_entry(op.get('key'))
    elif rules.is_rule(op):
        key = list(rules.target(op))
    elif kind == _keep.KEEP:
        key = ['value', _keep.target(op)]
    else:
        base = _asked_of()(op)
        t = _op_target()(base if base is not None else op)
        key = ['value', t] if t is not None else ['op', _plain(op)]
    return key_of(key)


@functools.lru_cache(maxsize=None)
def _asked_of():
    from .bulk import asked_of
    return asked_of


@functools.lru_cache(maxsize=None)
def _op_target():
    from .workspace import op_target
    return op_target


def new_entry(key: Optional[str]) -> List[Any]:
    return ['entry', key]


def rule_key(target: tuple) -> str:
    return key_of(list(target))


def is_rule_key(key: str) -> bool:
    return key.startswith('["rule",')


def _plain(op: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in op.items() if k not in BOOKKEEPING}


def held_in(op: Dict[str, Any]) -> Optional[str]:
    """What an entry holds, for whether a request changed it. A rule is left
    out: it changes whenever the plan before it does, and a request stands
    for a rule only by asking it."""
    if rules.is_rule(op):
        return None
    return json.dumps(op, sort_keys=True, default=str, ensure_ascii=False)


def without_fields(rec: Dict[str, Any]) -> Dict[str, set]:
    out: Dict[str, set] = {}
    for key, layer in rec.get('without_fields') or ():
        out.setdefault(key, set()).add(layer)
    return out


def less_fields(ws, op: Dict[str, Any], rec: Dict[str, Any]) -> Dict[str, Any]:
    """A planned analysis less the fields a drop by field took out of it."""
    layers = without_fields(rec).get(entry_key(op))
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
    hit = sorted({k for k in list(rec.get('owns') or ()) + list(rec.get('needs') or ()) if k in keys})
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
    """What the entries ``keys`` of ``ops`` were asked on: the planned
    analysis a link to one of its morphemes was made against, the new entry
    a link links to. A request for them goes with that analysis or entry, as
    a value named on one of its morphemes does."""
    keys = set(keys)
    out = set()
    for op in ops:
        if entry_key(op) not in keys:
            continue
        if op.get('analysis_word_id'):
            out.add(key_of(['analysis', op['analysis_word_id']]))
        if op.get('new_entry_key'):
            out.add(key_of(new_entry(op['new_entry_key'])))
    return sorted(out)


def asked_on_analyses(ws, args: Dict[str, Any]) -> List[str]:
    """The planned analyses a call names a morpheme of (``sN.wN.mN`` of a
    word the plan analyses), as the plan stands before it runs: the call is
    asked of that analysis and goes with it, whatever it changed there."""
    from .tools import _planned_place
    refs = args.get('refs') if 'refs' in args else [args.get('ref')]
    if isinstance(refs, str):
        refs = [refs]
    if not isinstance(refs, list) or not args.get('document') or not any(
            o.get('kind') == 'set_analysis' for o in ws.ops):
        return []
    try:
        doc = ws.doc(args['document'])
    except Exception:  # noqa: BLE001 - the call itself says what is wrong with its document
        return []
    out = set()
    for ref in refs:
        if not isinstance(ref, str):
            continue
        try:
            place = _planned_place(ws, doc, ref)
        except Exception:  # noqa: BLE001 - nor is a reference this reads wrongly ours to refuse
            continue
        if place is not None:
            out.add(key_of(['analysis', place.word.id]))
    return sorted(out)
