"""Applying an approved UD plan.

The mechanics are :mod:`plaid_agent.core.plan`: batching against the server's
cap, counting what was committed so a failure part-way can say how far it got,
and the provenance an approval writes. What is here is the ops themselves.

**Two batches, not one.** A batch op cannot refer to an id produced by an
earlier op in the SAME batch, and a dependency needs its endpoints' lemma
spans to exist first. So every lemma span a plan has to create goes in one
batch, and the relations go in the next.
"""

from collections import Counter
from typing import Any, Dict, List, Optional

from ..core.plan import CONFIRM, PlanError, Stamps, TrackingBatcher, created_id

KINDS = ('set_span', 'set_head', 'del_relation', 'confirm')

REQUIRED = {
    'set_span': ('layer_id', 'token_id'),
    'set_head': ('word_id', 'head_id', 'lemma_layer_id', 'relation_layer_id', 'deprel'),
    'del_relation': ('relation_id',),
    'confirm': (),
}


def validate_ops(ops: List[Dict[str, Any]]) -> None:
    """Reject a malformed plan BEFORE anything is written."""
    for i, op in enumerate(ops):
        kind = op.get('kind') if isinstance(op, dict) else None
        if kind not in KINDS:
            raise ValueError(f'op {i}: unknown kind "{kind}"')
        for key in REQUIRED[kind]:
            if not op.get(key):
                raise ValueError(f'op {i} ({kind}): missing {key}')
        if kind == 'confirm' and not (op.get('span_id') or op.get('relation_id')):
            raise ValueError(f'op {i} (confirm): needs a span_id or a relation_id')


def normalize_ops(ops: List[Dict[str, Any]]):
    """Drop ops a later op supersedes, and say so. Returns (ops, notes)."""
    notes: List[str] = []
    out: List[Dict[str, Any]] = []
    last: Dict[Any, int] = {}
    for op in ops:
        kind = op.get('kind')
        if kind == 'set_span':
            key = ('span', op.get('layer_id'), op.get('token_id'))
        elif kind in ('set_head', 'del_relation'):
            key = ('head', op.get('word_id'))
        else:
            out.append(op)
            continue
        if key in last:
            out[last[key]] = op  # last one wins
            continue
        last[key] = len(out)
        out.append(op)
    dropped = len(ops) - len(out)
    if dropped:
        notes.append(f'{dropped} change(s) were superseded by a later change to the same thing')
    return out, notes


def execute_plan(client, ops: List[Dict[str, Any]], *, source: str, label: str, project=None,
                 stamp_mode: str = 'verified', contributor: str = None) -> Dict[str, int]:
    """Apply ``ops`` with ``client`` under one operation labelled ``label``.
    Per-kind counts of what was applied, plus ``notes``. Raises
    :class:`PlanError` with the applied count if a later batch fails."""
    stamps = Stamps(stamp_mode, source, contributor)
    validate_ops(ops)
    ops, notes = normalize_ops(ops)
    counts: Counter = Counter()
    try:
        return _execute(client, ops, label=label, counts=counts, notes=notes, stamps=stamps)
    except PlanError:
        raise
    except Exception as e:
        applied = getattr(e, '_applied', None)
        raise PlanError(f'{type(e).__name__}: {e}', applied if applied is not None else 0, len(ops)) from e


def _execute(client, ops, *, label, counts, notes, stamps: Stamps) -> Dict[str, int]:
    stamp, restamp = stamps.stamp, stamps.restamp

    with client.operation(label):
        b = TrackingBatcher(client)

        # --- pass 1: the columns, and any lemma span a head is going to need ---
        # A word with no lemma yet gets one valued with its FORM. The app does
        # the same when a person draws an arc onto an unannotated word, except
        # that it uses the token's surface text, which is wrong for a part of a
        # multi-word token ("al" for both halves of a + el). The form is right
        # in every case the surface is, and right in the case it is not.
        lemma_at: Dict[str, Any] = {}   # word id -> span id, or an int result index
        for op in ops:
            kind = op.get('kind')
            if kind == 'set_span':
                span_id, value = op.get('span_id'), op.get('value') or ''
                if span_id and value == '':
                    b.add(lambda sid=span_id: client.spans.delete(sid))
                elif span_id:
                    b.add(lambda sid=span_id, v=value: client.spans.update(sid, v))
                    b.add(lambda sid=span_id: client.spans.patch_metadata(sid, restamp()))
                elif value != '':
                    b.add(lambda o=op, v=value: client.spans.create(o['layer_id'], [o['token_id']], v, stamp()))
                else:
                    continue  # nothing to clear
                counts['field values'] += 1
            elif kind == 'confirm':
                if op.get('span_id'):
                    b.add(lambda i=op['span_id']: client.spans.patch_metadata(i, CONFIRM))
                else:
                    b.add(lambda i=op['relation_id']: client.relations.patch_metadata(i, CONFIRM))
                counts['confirmations'] += 1
            elif kind == 'set_head':
                for wid, form, existing in ((op['word_id'], op.get('word_form') or '', op.get('lemma_span_id')),
                                            (op['head_id'], op.get('head_form') or '', op.get('head_lemma_span_id'))):
                    if wid in lemma_at:
                        continue
                    if existing:
                        lemma_at[wid] = existing
                    else:
                        lemma_at[wid] = b.add(
                            lambda o=op, w=wid, f=form: client.spans.create(
                                o['lemma_layer_id'], [w], f, stamp()))

        # The relations need those spans to exist, so the batch has to land first.
        b.flush()

        def lemma_span(word_id):
            at = lemma_at.get(word_id)
            if isinstance(at, int):
                sid = created_id(b.results[at] if at < len(b.results) else None)
                if not sid:
                    raise ValueError(f'could not create the lemma a dependency needs on {word_id}')
                lemma_at[word_id] = sid
                return sid
            return at

        # --- pass 2: the dependencies ---
        for op in ops:
            kind = op.get('kind')
            if kind == 'del_relation':
                b.add(lambda i=op['relation_id']: client.relations.delete(i))
                counts['dependencies'] += 1
            elif kind == 'set_head':
                target = lemma_span(op['word_id'])
                src = lemma_span(op['head_id'])
                # One head per word: the old relation goes in the same batch as
                # the new one, so the word is never headless and never twice
                # headed, whichever way a failure falls.
                if op.get('relation_id'):
                    b.add(lambda i=op['relation_id']: client.relations.delete(i))
                b.add(lambda o=op, s=src, t=target: client.relations.create(
                    o['relation_layer_id'], s, t, o['deprel'], stamp() or None))
                counts['dependencies'] += 1
        b.flush()

    result = dict(counts)
    if notes:
        result['notes'] = notes
    return result


# --- summary --------------------------------------------------------------------

def summarize(ops: List[Dict[str, Any]]) -> str:
    """A plan in one phrase, for the audit label and the applied message."""
    c = Counter()
    for op in ops:
        kind = op.get('kind')
        if kind == 'set_span':
            c['field value' if op.get('value') else 'cleared value'] += 1
        elif kind == 'set_head':
            c['dependency'] += 1
        elif kind == 'del_relation':
            c['removed dependency'] += 1
        elif kind == 'confirm':
            c['confirmation'] += 1
    if not c:
        return 'no changes'
    parts = [f'{n} {name}' + ('s' if n != 1 else '') for name, n in c.most_common()]
    return ', '.join(parts)
