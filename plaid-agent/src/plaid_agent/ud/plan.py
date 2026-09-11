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
from .sentences import apply_merge_sentences, apply_split_sentence
from .shape import apply_set_words, finish_set_words

KINDS = ('set_span', 'set_head', 'del_relation', 'confirm', 'run_parse', 'set_words',
         'split_sentence', 'merge_sentences', 'restore_document')

# Ops that move where sentences begin, which renumbers every sentence after
# them. References are positional, so no other op in the plan can be trusted
# to still mean what it said.
RESHAPES_DOCUMENT = ('split_sentence', 'merge_sentences')

# How long the parser may say nothing before the plan gives up on it. This
# measures SILENCE, not elapsed time: the parser reports progress as it goes,
# so a long document does not trip it and a parser that has died does.
PARSE_SILENCE_S = 10 * 60

REQUIRED = {
    'set_span': ('layer_id', 'token_id'),
    'set_head': ('word_id', 'head_id', 'lemma_layer_id', 'relation_layer_id', 'deprel'),
    'del_relation': ('relation_id',),
    'confirm': (),
    'run_parse': ('document_ids', 'service_id', 'project_id', 'language'),
    'set_words': ('token_id', 'text_id', 'forms', 'word_layer_id', 'form_layer_id',
                  'lemma_layer_id'),
    'split_sentence': ('document_id', 'sentence_id', 'char_pos'),
    'merge_sentences': ('document_id', 'sentence_id', 'previous_id'),
    'restore_document': ('document_id', 'as_of'),
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
        # A restore rewrites every layer of the document, so anything else in the
        # plan would address what it is about to replace.
        if kind == 'restore_document' and len(ops) > 1:
            raise ValueError(f'op {i + 1} (restore_document): a restore must be the only '
                             f'op in its plan')
    # A parse rewrites a document from scratch, so anything else this plan
    # writes into the same document would be thrown away by it. The tools
    # refuse the combination as it is built; this is the backstop, because a
    # plan that silently lost half its changes is the worst outcome here.
    # Reshaping a token deletes and remakes its words, so an op that names one
    # of those words would be writing to something that will not exist.
    reshaped = {w for op in ops if op.get('kind') == 'set_words'
                for w in (op.get('existing_word_ids') or [])}
    if reshaped:
        for op in ops:
            if op.get('kind') in ('set_span', 'set_head', 'del_relation') and (
                    op.get('token_id') in reshaped or op.get('word_id') in reshaped):
                raise ValueError('this plan both reshapes a token and annotates one of its words, '
                                 'and the reshape deletes that word')
    # A sentence boundary moving renumbers every sentence after it, and every
    # reference in this plan is positional: s7.w2 means a different word once
    # s3 has been cut. Rather than resolve that with a rule nobody will
    # remember, a plan that moves a boundary does that and nothing else to the
    # document. The tools refuse the combination as it is built; this is the
    # backstop.
    # Per DOCUMENT: a boundary moving in one renumbers nothing in another, so a
    # plan may move one boundary and still edit a different document.
    moved: Dict[Any, int] = {}
    for op in ops:
        if op.get('kind') in RESHAPES_DOCUMENT:
            moved[op.get('document_id')] = moved.get(op.get('document_id'), 0) + 1
    if moved:
        others = {op.get('document_id') for op in ops
                  if op.get('kind') not in RESHAPES_DOCUMENT} & set(moved)
        if others:
            raise ValueError('this plan both moves a sentence boundary in and edits '
                             + ', '.join(sorted(others))
                             + ', and the boundary renumbers the references the edits use')
        crowded = sorted(d for d, n in moved.items() if n > 1)
        if crowded:
            raise ValueError('a plan moves at most one sentence boundary per document, and this '
                             'one moves several in ' + ', '.join(crowded)
                             + ': each renumbers the sentences the next would name')
    parsed = {d for op in ops if op.get('kind') == 'run_parse' for d in (op.get('document_ids') or [])}
    if parsed:
        clash = {op.get('document_id') for op in ops if op.get('kind') != 'run_parse'} & parsed
        if clash:
            raise ValueError('this plan both parses and edits ' + ', '.join(sorted(clash))
                             + ', and a parse would throw the edits away')


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
    # Only a failure inside `flush` carries `_applied` out with it. Everything
    # else raised mid-plan (a parser refusing, a word that could not be made)
    # arrives bare, and reporting 0 there told the user "Nothing was written"
    # while earlier batches stood committed. The batcher itself is the count.
    tracker: Dict[str, Any] = {}
    try:
        return _execute(client, ops, label=label, counts=counts, notes=notes, stamps=stamps,
                        tracker=tracker)
    except PlanError:
        raise
    except Exception as e:
        applied = getattr(e, '_applied', None)
        if applied is None:
            b = tracker.get('batcher')
            applied = b.applied if b is not None else 0
        raise PlanError(f'{type(e).__name__}: {e}', applied, len(ops)) from e


def _execute(client, ops, *, label, counts, notes, stamps: Stamps, tracker=None) -> Dict[str, int]:
    stamp, restamp = stamps.stamp, stamps.restamp

    with client.operation(label):
        b = TrackingBatcher(client)
        if tracker is not None:
            tracker['batcher'] = b
        restores: List[Dict[str, Any]] = []

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
            elif kind == 'set_words':
                apply_set_words(client, op, b, stamp)
                counts['reshaped tokens'] += 1
            elif kind == 'restore_document':
                restores.append(op)  # after the batches: the server's own operation
                counts['restored documents'] += 1
            elif kind == 'split_sentence':
                apply_split_sentence(client, op, b, stamp)
                counts['sentence boundaries'] += 1
            elif kind == 'merge_sentences':
                apply_merge_sentences(client, op, b, stamp)
                counts['sentence boundaries'] += 1

        # The relations need those spans to exist, so the batch has to land first.
        b.flush()

        # The server's own restore, after the batches and never with them: it
        # is one operation of its own and a plan holds at most one.
        for op in restores:
            client.documents.restore(op['document_id'], op['as_of'])
            b.applied += 1

        def lemma_span(word_id):
            at = lemma_at.get(word_id)
            if isinstance(at, int):
                sid = created_id(b.results[at] if at < len(b.results) else None)
                if not sid:
                    raise ValueError(f'could not create the lemma a dependency needs on {word_id}')
                lemma_at[word_id] = sid
                return sid
            return at

        # --- pass 2: what needed the first batch's ids ---
        for op in ops:
            if op.get('kind') == 'set_words':
                finish_set_words(client, op, b, b.results, stamp)
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

        # --- pass 3: the parser ---
        # Last, and outside the batches, because it is not a write of ours at
        # all: it is another service rewriting whole documents, under its own
        # document lock, for as long as that takes.
        for op in ops:
            if op.get('kind') != 'run_parse':
                continue
            for did in op['document_ids']:
                _parse(client, op, did, notes, b, len(ops))
                counts['parsed documents'] += 1

    result = dict(counts)
    if notes:
        result['notes'] = notes
    return result


# --- summary --------------------------------------------------------------------

def _plural(name: str, n: int) -> str:
    """"dependency" -> "dependencies", not "dependencys"."""
    if n == 1:
        return name
    return name[:-1] + 'ies' if name.endswith('y') else name + 's'


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
        elif kind == 'run_parse':
            c['parsed document'] += len(op.get('document_ids') or [])
        elif kind == 'set_words':
            c['reshaped token'] += 1
        elif kind == 'split_sentence':
            c['sentence split'] += 1
            # The relations it orphans go with it, and the user should see how
            # many rather than discover it afterwards.
            gone = len(op.get('relation_ids') or [])
            if gone:
                c['removed dependency'] += gone
        elif kind == 'merge_sentences':
            c['sentence merge'] += 1
        elif kind == 'restore_document':
            c['restored document'] += 1
    if not c:
        return 'no changes'
    return ', '.join(f'{n} {_plural(name, n)}' for name, n in c.most_common())


def _parse(client, op, document_id: str, notes: List[str], b, total: int) -> None:
    """Ask the project's parser to re-parse one document, and wait.

    A plan may write to one document and parse another, so by the time the
    parser answers, earlier batches may already stand. The count comes from
    the batcher rather than being assumed to be zero."""
    from plaid_client.services import request_service
    from ..core.plan import PlanError
    try:
        request_service(client, op['project_id'], op['service_id'],
                        {'document_id': document_id, 'language': op['language'],
                         'overwrite': bool(op.get('overwrite'))},
                        timeout=PARSE_SILENCE_S)
    except TimeoutError:
        # The request outlives the call: the parse is probably still running,
        # so saying it failed would be worse than saying what is true.
        notes.append(f'the parser stopped reporting on {document_id}; it may still be running')
    except Exception as e:  # noqa: BLE001 - whatever the service said, the user needs it
        raise PlanError(f'the parser refused {document_id}: {e}', b.applied, total) from e

