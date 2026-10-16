"""Each corpus-wide change of a ud plan counted as approval writes it.

A discard of a document's predictions (``discard_scope``) and a replacement
over a field (``replace_scope``) are stored as one op each, with the count
their preview found. At approval a change the plan names on one of those
values wins, and so does a value the plan keeps out of it (core.keep,
:func:`core.opkind.named_beats_scope`). So the row, the plan's summary, the
applied message and History would count values approval never writes.

:func:`settle_scopes` takes them out, as igt's ``settle_rules`` does for a
rule: each scope keeps what its preview found (:data:`FOUND`) and its count,
line and card are that less every value a named op or a keep of the plan
stands on. Asked of the documents the turn has read, through each scope
kind's own ``takes`` (:func:`ud.plan.scope_taking`), so a value counts out
exactly when approval would leave it out.
"""

import copy
from typing import Any, Dict, List, Optional, Tuple

from ..core import rules, work
from ..core.bidi import qrx, qv
from ..core.history import doc_label
from ..core.keep import is_keep
from .plan import KIND, SCOPES, entity_of
from .project import FEATURES
from .review import counts_phrase

#: The key a scope op keeps what its preview found under, before anything
#: the plan names is taken out: ``{count, per_field, counted, card}``.
FOUND = 'found'

#: The kinds settled here: the scopes that change values. A confirmation
#: writes no value, so nothing a plan names is taken out of it.
SETTLED = ('discard_scope', 'replace_scope')


def _index(doc, cache: Optional[Dict[str, Dict[Any, tuple]]]) -> Dict[Any, tuple]:
    """Each word of ``doc`` by its id and by its relation's, built once per
    document in ``cache``."""
    if cache is not None and doc.id in cache:
        return cache[doc.id]
    out: Dict[Any, tuple] = {}
    for s in doc.sentences:
        for w in s.words:
            out[w.id] = (s, w)
            if w.relation_id:
                out.setdefault(('relation', w.relation_id), (s, w))
    if cache is not None:
        cache[doc.id] = out
    return out


def value_place(ws, op: Dict[str, Any], cache: Optional[dict] = None) -> Optional[Tuple[str, Any, Any, str, Any]]:
    """``(document id, sentence, word, field, span)`` of the stored value an
    op names, as a scope's ``takes`` asks, or None for an op that names no
    one value (or one in a document the turn has not read). ``cache`` holds
    each document's words by id across calls."""
    doc = ws._docs.get(op.get('document_id'))
    if doc is None:
        return None
    words = _index(doc, cache)
    kind = op.get('kind')
    feature = op.get('feature')
    if is_keep(op):
        kept = list(op.get('kept') or [])
        if kept[:1] == ['head'] and len(kept) == 2:
            found, field = words.get(kept[1]), 'deprel'
        elif kept[:1] == ['span'] and len(kept) == 4:
            found, field, feature = words.get(kept[2]), op.get('field'), kept[3]
        else:
            return None
    elif kind == 'set_span':
        found, field = words.get(op.get('token_id')), op.get('field')
    elif kind in ('set_head', 'del_relation'):
        found, field = words.get(op.get('word_id')), 'deprel'
    elif kind == 'set_deprel':
        found, field = words.get(('relation', op.get('relation_id'))), 'deprel'
    else:
        return None
    if found is None or not field:
        return None
    sentence, w = found
    if field == 'deprel':
        span = None
    elif field == FEATURES:
        span = w.feature_span(feature) if feature else None
    else:
        span = w.fields.get(field)
    return doc.id, sentence, w, field, span


def keep_holds(ws, op: Dict[str, Any]) -> bool:
    """Whether a scope of the plan would still change what the keep ``op``
    holds out of it."""
    from .plan import scope_taking
    place = value_place(ws, op)
    return place is not None and scope_taking(ws.ops, *place) is not None


def _found(op: Dict[str, Any]) -> Dict[str, Any]:
    if op.get(FOUND) is not None:
        return op[FOUND]
    return {'count': int(op.get('count') or 0), 'per_field': dict(op.get('per_field') or {}),
            'counted': int(op.get(work.COUNTED) or 0),
            **({'card': copy.deepcopy(op['card'])} if op.get('card') is not None else {})}


def settle_scopes(ws) -> None:
    """Each discard or replacement in ``ws.ops`` counted less the values a
    named op or a keep of the plan stands on, in place."""
    idx = [i for i, op in enumerate(ws.ops) if op.get('kind') in SETTLED]
    if not idx:
        return
    named = []
    cache: Dict[str, Dict[Any, tuple]] = {}
    for op in ws.ops:
        if op.get('kind') in SCOPES:
            continue
        ent = entity_of(op)
        if ent is None:
            continue
        place = value_place(ws, op, cache)
        if place is not None:
            named.append((ent, place))
    for i in idx:
        op = ws.ops[i]
        takes = KIND[op['kind']].extra['takes']
        taken: Dict[Any, tuple] = {}
        for ent, place in named:
            if ent not in taken and takes(op, *place):
                taken[ent] = place
        found = _found(op)
        if not taken and op.get(FOUND) is None:
            continue
        out = (_discard(ws, op, found, list(taken.values())) if op['kind'] == 'discard_scope'
               else _replace(ws, op, found, list(taken.values())))
        if out != op:
            ws.ops[i] = out


def _discard(ws, op, found, taken) -> Dict[str, Any]:
    per = dict(found['per_field'])
    for _d, _s, _w, field, _span in taken:
        per[field] = per.get(field, 0) - 1
    per = {f: n for f, n in per.items() if n > 0}
    n = max(0, found['count'] - len(taken))
    return {**op, FOUND: found, 'count': n, 'per_field': per,
            'label': discard_label(ws, op['document_id'], n, per)}


def discard_label(ws, document_id: str, n: int, per: Dict[str, int]) -> str:
    """A whole-document discard's row."""
    where = doc_label(ws, document_id, qv)
    if not n:
        return f'discard nothing in {where}: the plan names every unconfirmed machine value it found'
    return f'discard {n} unconfirmed machine values in {where} ({counts_phrase(per)})'


def replace_label(ws, op: Dict[str, Any], n: int, docs: int, accepted: int) -> str:
    """A field-wide replacement's row."""
    shown = qrx(op['pattern']) if op.get('regex') else qv(op['pattern'])
    where = (f' in {doc_label(ws, op["document_id"], qv)}' if op.get('document_id')
             else f' in {docs} document(s)')
    return (f'{op["field"]}: replace {shown} with {qv(op.get("replacement") or "")} on {n} value(s){where}'
            + work.counted_phrase(accepted))


def _replace(ws, op, found, taken) -> Dict[str, Any]:
    from .bulk import spec_of
    _spec, rep = spec_of(op)
    n = max(0, found['count'] - len(taken))
    accepted = found['counted']
    card = copy.deepcopy(found.get('card'))
    for doc_id, _s, w, field, span in taken:
        meta = w.relation_metadata if field == 'deprel' else (span.metadata if span is not None else None)
        if work.protected(meta):
            accepted -= 1
        if card is None:
            continue
        old = (w.deprel if field == 'deprel' else (span.value if span is not None else '')) or ''
        _less(card, doc_id, old, rep(old))
    out = {**op, FOUND: found, 'count': n, work.COUNTED: max(0, accepted)}
    if card is not None:
        card['total'] = n
        card['kinds'] = {k: n for k in card.get('kinds') or {}}
        out['card'] = card
        docs = len(card.get('documents') or []) + int((card.get('documents_more') or [0, 0])[0])
    else:
        docs = len(op.get('documents') or [])
    out['label'] = replace_label(ws, op, n, docs, max(0, accepted))
    return out


def _less(card: Dict[str, Any], doc_id: str, old: str, new: str) -> None:
    """One value out of a replacement's card: its document's count and its
    change's, or the counts of those the card lists without naming."""
    docs = card.get('documents') or []
    row = next((d for d in docs if d[0] == doc_id), None)
    if row is not None:
        row[2] -= 1
        card['documents'] = sorted((d for d in docs if d[2] > 0), key=lambda d: (-d[2], d[0] or ''))
    else:
        more = card.get('documents_more') or [0, 0]
        card['documents_more'] = [more[0], max(0, more[1] - 1)]
    rows: List[Dict[str, Any]] = card.get(rules.TRANSITIONS) or []
    t = next((r for r in rows if r['from'] == old and r['to'] == new), None)
    if t is not None:
        t['count'] -= 1
        # In the order rules.transitions gives them.
        card[rules.TRANSITIONS] = sorted((r for r in rows if r['count'] > 0),
                                         key=lambda r: (not r['notes'], -r['count'], r['from'], r['to']))
    else:
        more = card.get(rules.TRANSITIONS_MORE) or [0, 0]
        card[rules.TRANSITIONS_MORE] = [more[0], max(0, more[1] - 1)]
