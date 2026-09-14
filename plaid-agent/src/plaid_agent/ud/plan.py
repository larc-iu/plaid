"""Applying an approved UD plan.

The mechanics are :mod:`plaid_agent.core.plan`: batching against the server's
cap, counting what was committed so a failure part-way can say how far it got,
and the provenance an approval writes. What is here is the ops themselves.

**Every kind is declared once**, in :data:`KIND` below: its required keys, the
noun the user reads, which pass of the executor applies it (or, for a scope,
what it resolves into at approval), what it writes to, what it deletes, whether
it reshapes the document, and how like ops fold into one stored op.
``SCOPES``, ``RESHAPES_DOCUMENT``, ``RESHAPES_TOKEN``,
``compact_spec``, the summary and the executor's dispatch are all read off it (see
:mod:`plaid_agent.core.opkind`).

**Two batches, not one.** A batch op cannot refer to an id produced by an
earlier op in the SAME batch, and a relation needs its endpoints' lemma spans
to exist first. So every lemma span a plan has to create goes in one batch,
and the relations go in the next.
"""

from collections import Counter
from typing import Any, Dict, List

from ..core import opkind as ok
from ..core.opkind import OpKind
from ..core.plan import (CONFIRM, PlanError, Stamps, TrackingBatcher, apply_add_comment,
                         apply_restore_document, applying, created_id, expand_ops)
from .project import load_document, word_ref
from .review import all_words, confirm_targets, discard_targets

# `.shape` and `.sentences` are imported where they are used rather than here:
# both reach the tools for their refusals, and the tools read this module's
# registry, so importing them at the top would close the circle.

# A kind's tag for what it does to the shape of a document. RESHAPES_DOCUMENT
# is every kind tagged SENTENCE_SHAPE: moving where sentences begin renumbers
# every sentence after them, and references are positional, so no other op in
# the plan can be trusted to still mean what it said.
SENTENCE_SHAPE = 'sentence_shape'
WORD_SHAPE = 'word_shape'      # a token's words are deleted and remade
# The documents this op names are rewritten from scratch, and no others. Not
# ok.EXCLUSIVE: a plan may write to one document and parse another, so what it
# refuses is per document rather than per plan.
DOCUMENT_SHAPE = 'document_shape'

# The passes of the executor past the first. Heads need the ids the first
# batch mints; the parser runs outside the batches entirely.
IDS = 'ids'
PARSE = 'parse'

# Every pass `_execute` runs, which is the whole list a kind may be staged
# for. A kind declared outside them belongs to no pass: each pass would skip
# it, nothing would count it, and the operation label would say it was
# applied. The plan refuses before the first pass runs
# (`core.opkind.check_applicable`).
STAGES = (ok.BATCH, IDS, PARSE)

# How long the parser may say nothing before the plan gives up on it. This
# measures SILENCE, not elapsed time: the parser reports progress as it goes,
# so a long document does not trip it and a parser that has died does.
PARSE_SILENCE_S = 10 * 60


# --- the executor's shared state -------------------------------------------------

class Context:
    """What one run of the executor carries between its passes."""

    def __init__(self, client, ops, stamps: Stamps, counts: Counter, notes: List[str], b: TrackingBatcher):
        self.client = client
        self.ops = ops
        self.stamps = stamps
        self.stamp = stamps.stamp
        self.restamp = stamps.restamp
        self.counts = counts
        self.notes = notes
        self.b = b
        self.restores: List[Dict[str, Any]] = []
        # A word's lemma span, by word id, or an int result index for one this
        # plan is creating.
        self.lemma_at: Dict[str, Any] = {}
        # What this plan is ALREADY creating, by (layer, word). A relation
        # needs a lemma span to hang off, and if the same plan sets that
        # word's lemma there must not be two: the second create wins the read
        # and the value the user approved becomes invisible to every tool.
        # Keyed in the first pass and consulted in the second.
        self.creating: Dict[tuple, int] = {}

    def lemma_span(self, word_id):
        at = self.lemma_at.get(word_id)
        if isinstance(at, int):
            sid = created_id(self.b.results[at] if at < len(self.b.results) else None)
            if not sid:
                raise ValueError(f'could not create the lemma a dependency needs on {word_id}')
            self.lemma_at[word_id] = sid
            return sid
        return at


# --- what each kind does -----------------------------------------------------------

def _apply_set_span(ctx: Context, op) -> int:
    span_id, value = op.get('span_id'), op.get('value') or ''
    if span_id and value == '' and op.get('field') == 'lemma':
        # Clearing a UPOS or XPOS cell deletes its span. Lemma is the
        # exception, and it is not a cosmetic one: dependency relations hang
        # off lemma spans, so deleting one cascades every arc on that word,
        # including arcs a person drew and vouched for. A cleared lemma keeps
        # its null-valued span, exactly as the editor leaves it (ConlluDocument's
        # `updateAnnotation`) and as an unlemmatized import writes it.
        ctx.b.update('spans', span_id, value=None, metadata=ctx.restamp())
    elif span_id and value == '':
        ctx.b.add(lambda batch, sid=span_id: batch.spans.delete(sid))
    elif span_id:
        ctx.b.update('spans', span_id, value=value, metadata=ctx.restamp())
    elif value != '':
        ctx.creating[(op['layer_id'], op['token_id'])] = ctx.b.add(
            lambda batch, o=op, v=value: batch.spans.create(o['layer_id'], [o['token_id']], v, ctx.stamp()))
    else:
        return 0  # nothing to clear
    return 1


def _apply_set_deprel(ctx: Context, op) -> int:
    ctx.b.update('relations', op['relation_id'], value=op['deprel'], metadata=ctx.restamp())
    return 1


def _apply_confirm(ctx: Context, op) -> int:
    if op.get('span_id'):
        ctx.b.update('spans', op['span_id'], metadata=CONFIRM)
    else:
        ctx.b.update('relations', op['relation_id'], metadata=CONFIRM)
    return 1


def _apply_set_words(ctx: Context, op) -> int:
    from .shape import apply_set_words
    apply_set_words(op, ctx.b, ctx.stamp)
    return 1


def _apply_split_sentence(ctx: Context, op) -> int:
    from .sentences import apply_split_sentence
    apply_split_sentence(op, ctx.b, ctx.stamp)
    return 1


def _apply_merge_sentences(ctx: Context, op) -> int:
    from .sentences import apply_merge_sentences
    apply_merge_sentences(op, ctx.b, ctx.stamp)
    return 1


def _apply_del_relation(ctx: Context, op) -> int:
    ctx.b.add(lambda batch, i=op['relation_id']: batch.relations.delete(i))
    return 1


def _apply_set_head(ctx: Context, op) -> int:
    target = ctx.lemma_span(op['word_id'])
    src = ctx.lemma_span(op['head_id'])
    # One head per word: the old relation goes in the same batch as the new
    # one, so the word is never headless and never twice headed, whichever way
    # a failure falls.
    if op.get('relation_id'):
        ctx.b.add(lambda batch, i=op['relation_id']: batch.relations.delete(i))
    ctx.b.add(lambda batch, o=op, s=src, t=target: batch.relations.create(
        o['relation_layer_id'], s, t, o['deprel'], ctx.stamp() or None))
    return 1


def _apply_run_parse(ctx: Context, op) -> int:
    n = 0
    for did in op['document_ids']:
        _parse(ctx.client, op, did, ctx.notes, ctx.b, len(ctx.ops))
        n += 1
    return n


# --- what each kind counts as -------------------------------------------------------

_FIELD_VALUE = ('field value', 'field values')
_CLEARED = ('cleared value', 'cleared values')
_RELABELED = ('relabeled dependency', 'relabeled dependencies')
_REMOVED_DEP = ('removed dependency', 'removed dependencies')


def _set_span_summary(op, n):
    return [(_FIELD_VALUE if op.get('value') else _CLEARED, n)]


def _replace_scope_summary(op, n):
    return [(_RELABELED if op.get('field') == 'deprel' else _FIELD_VALUE, n)]


def _discard_scope_summary(op, n):
    per = op.get('per_field') or {}
    heads = int(per.get('deprel') or 0)
    out = []
    if heads:
        out.append((_REMOVED_DEP, heads))
    if n - heads:
        out.append((_CLEARED, n - heads))
    return out


def _split_sentence_summary(op, n):
    out = [(('sentence split', 'sentence splits'), 1)]
    # The relations it orphans go with it, and the user should see how many
    # rather than discover it afterwards.
    gone = len(op.get('relation_ids') or [])
    if gone:
        out.append((_REMOVED_DEP, gone))
    return out


def _run_parse_summary(op, n):
    return [(('parsed document', 'parsed documents'), len(op.get('document_ids') or []))]


# --- how a group of like ops reads on the card ---------------------------------------
#
# One line for a whole fold, declared with the kind it folds, so a kind that
# folds without a line to show is refused when this module is imported rather
# than when a plan first grows large enough to fold.

def _refs_phrase(members, limit: int = 8) -> str:
    refs = [m.get('ref') for m in members if m.get('ref')]
    shown = ', '.join(refs[:limit])
    return shown + (f', … {len(refs) - limit} more' if len(refs) > limit else '')


def _set_span_label(first, members) -> str:
    what = f'{first["field"]} = "{first["value"]}"' if first.get('value') else f'clear {first["field"]}'
    return f'{what} on {len(members)} words ({_refs_phrase(members)})'


def _set_head_label(first, members) -> str:
    return f'{first["deprel"]} on {len(members)} words ({_refs_phrase(members)})'


def _del_relation_label(first, members) -> str:
    return f'remove the head of {len(members)} words ({_refs_phrase(members)})'


def _confirm_label(first, members) -> str:
    return f'confirm {len(members)} values ({_refs_phrase(members)})'


# --- what a kind writes to, whatever kind it is --------------------------------------
# A change the model made BY NAME beats one a scope finds at approval, so the
# resolver has to ask whether the two touch the same thing. That question
# crosses kinds (a scope's set_deprel against a set_head the model staged), so
# it cannot be `OpKind.target`, which is about superseding within one kind's
# own vocabulary. Each kind that writes to a stored span or relation names it
# the same way here, and `entity_of` is the only reader.

def _span_entity(op):
    return ('span', op.get('layer_id'), op.get('token_id'))


def _relation_entity(op):
    return ('relation', op['relation_id']) if op.get('relation_id') else None


# --- what each scope stands for --------------------------------------------------
#
# A scope is stored as the predicate the model gave and resolved to per-span
# ops at approval, reading the document NOW. Each kind declares its own
# resolver beside everything else it declares, and `resolve_scopes` runs them
# without naming one.

class Resolution:
    """What the scopes of one plan resolve with: the client, the project, and
    the documents read so far, so two scopes over one document read it once."""

    def __init__(self, client, project):
        self.client = client
        self.project = project
        self._docs: Dict[str, Any] = {}

    def document(self, document_id: str):
        if document_id not in self._docs:
            self._docs[document_id] = load_document(self.client, self.project, document_id)
        return self._docs[document_id]


def _resolve_confirm_scope(res: Resolution, op):
    did = op['document_id']
    doc = res.document(did)
    fields = list(op.get('fields') or [])
    for sentence, w, f, span_id, relation_id in confirm_targets(all_words(doc), fields):
        ref = word_ref(sentence, w)
        yield {'kind': 'confirm', 'span_id': span_id, 'relation_id': relation_id,
               'token_id': w.id, 'document_id': did, 'ref': ref,
               'label': f'confirm the head of {ref}' if f == 'deprel' else f'confirm {f} on {ref}'}


def _resolve_discard_scope(res: Resolution, op):
    did = op['document_id']
    doc = res.document(did)
    fields = list(op.get('fields') or [])
    targets, _spared = discard_targets(all_words(doc), fields)
    for sentence, w, f, span, relation_id in targets:
        ref = word_ref(sentence, w)
        if f == 'deprel':
            yield {'kind': 'del_relation', 'word_id': w.id, 'relation_id': relation_id,
                   'document_id': did, 'ref': ref, 'label': f'discard the unconfirmed head of {ref}'}
        else:
            yield {'kind': 'set_span', 'layer_id': span.layer_id, 'token_id': w.id,
                   'span_id': span.id, 'value': '', 'field': f, 'document_id': did,
                   'ref': ref, 'label': f'discard the unconfirmed {f} on {ref}'}


def _resolve_replace_scope(res: Resolution, op):
    from .bulk import resolve_replace
    return resolve_replace(res.client, res.project, op)


# --- the registry -------------------------------------------------------------------

KIND = ok.registry([
    OpKind('set_span', _FIELD_VALUE, required=('layer_id', 'token_id'), apply=_apply_set_span,
           target=lambda op: ('span', op.get('layer_id'), op.get('token_id')),
           token_keys=('token_id',), extra={'entity': _span_entity},
           deletes=lambda op: ([op['span_id']] if op.get('span_id') and (op.get('value') or '') == '' else []),
           compact_each=('token_id', 'span_id', 'ref'), compact_label=_set_span_label,
           summary=_set_span_summary),
    OpKind('set_head', ('dependency', 'dependencies'), stage=IDS, apply=_apply_set_head,
           required=('word_id', 'head_id', 'lemma_layer_id', 'relation_layer_id', 'deprel'),
           target=lambda op: ('head', op.get('word_id')),
           token_keys=('word_id', 'head_id'), extra={'entity': _relation_entity},
           deletes=lambda op: [op.get('relation_id')],
           compact_each=('word_id', 'head_id', 'word_form', 'head_form', 'lemma_span_id',
                         'head_lemma_span_id', 'relation_id', 'ref'), compact_label=_set_head_label),
    OpKind('del_relation', _REMOVED_DEP, stage=IDS, apply=_apply_del_relation,
           required=('relation_id',), target=lambda op: ('head', op.get('word_id')),
           token_keys=('word_id',), extra={'entity': _relation_entity},
           deletes=lambda op: [op['relation_id']],
           compact_each=('word_id', 'relation_id', 'ref'), compact_label=_del_relation_label),
    # A confirmation writes to the span or the relation it names, so one whose
    # subject another change in the same plan throws away is refused as the
    # plan is built rather than dropped from a card the user approved.
    # `token_id` is the word the value sits on, which a confirmation does not
    # need to apply itself: it is there so a plan that deletes the word can be
    # seen to delete the value, which is named nowhere else.
    OpKind('confirm', ('confirmation', 'confirmations'), apply=_apply_confirm,
           token_keys=('span_id', 'relation_id', 'token_id'),
           compact_each=('span_id', 'relation_id', 'token_id', 'ref'), compact_label=_confirm_label),
    OpKind('run_parse', ('parsed document', 'parsed documents'), stage=PARSE, apply=_apply_run_parse,
           required=('document_ids', 'service_id', 'project_id', 'language'),
           shape=DOCUMENT_SHAPE, summary=_run_parse_summary),
    OpKind('set_words', ('reshaped token', 'reshaped tokens'), apply=_apply_set_words, shape=WORD_SHAPE,
           required=('token_id', 'text_id', 'forms', 'word_layer_id', 'form_layer_id', 'lemma_layer_id'),
           deletes_tokens=lambda op: list(op.get('existing_word_ids') or [])),
    OpKind('split_sentence', ('sentence split', 'sentence splits'), apply=_apply_split_sentence,
           required=('document_id', 'sentence_id', 'char_pos'), shape=SENTENCE_SHAPE,
           deletes=lambda op: list(op.get('relation_ids') or []), summary=_split_sentence_summary),
    OpKind('merge_sentences', ('sentence merge', 'sentence merges'), apply=_apply_merge_sentences,
           required=('document_id', 'sentence_id', 'previous_id'), shape=SENTENCE_SHAPE,
           deletes=lambda op: list(op.get('relation_ids') or [])),
    # A second restore of the SAME document replaces the first, the way every
    # other corrected instruction does: the plan still holds one restore, and
    # a model that named the wrong as_of can say so without the user having to
    # discard the plan. IGT declares the same.
    OpKind('restore_document', ('restored document', 'restored documents'), apply=apply_restore_document,
           required=('document_id', 'as_of'), shape=ok.EXCLUSIVE,
           target=lambda op: ('restore', op.get('document_id'))),
    # A scope names a document and fields, or a field and a pattern, and is
    # resolved to spans at approval, so the executor never sees one.
    OpKind('confirm_scope', ('confirmation', 'confirmations'), stage=ok.RESOLVED, shape=ok.SCOPE,
           required=('document_id', 'fields'), resolve=_resolve_confirm_scope,
           target=lambda op: ('scope', 'confirm_scope', op.get('document_id'))),
    # `clears` says a scope throws values away without being able to name
    # which until it is resolved, so two scopes over one document cannot share
    # a plan when either of them does.
    OpKind('discard_scope', ('discarded prediction', 'discarded predictions'), stage=ok.RESOLVED,
           shape=ok.SCOPE, required=('document_id', 'fields'), summary=_discard_scope_summary,
           resolve=_resolve_discard_scope,
           target=lambda op: ('scope', 'discard_scope', op.get('document_id')),
           extra={'clears': lambda op: True}),
    OpKind('replace_scope', _FIELD_VALUE, stage=ok.RESOLVED, shape=ok.SCOPE,
           required=('field', 'pattern'), summary=_replace_scope_summary,
           resolve=_resolve_replace_scope,
           target=lambda op: ('replace', op.get('field'), op.get('pattern'),
                              op.get('replacement'), op.get('document_id')),
           extra={'clears': lambda op: not (op.get('replacement') or '')}),
    OpKind('set_deprel', _RELABELED, required=('relation_id', 'deprel'), apply=_apply_set_deprel,
           extra={'entity': _relation_entity}),
    OpKind('add_comment', ('comment', 'comments'), required=('entity_type', 'entity_id', 'body'),
           apply=apply_add_comment),
])

# Every table below is the registry read a different way.
# A scope is a kind that says how to resolve itself, so a new one joins every
# guard built on this by declaring a resolver.
SCOPES = ok.scopes(KIND)
RESHAPES_DOCUMENT = ok.shaped(KIND, SENTENCE_SHAPE)
RESHAPES_TOKEN = ok.shaped(KIND, WORD_SHAPE)
# Kinds that rewrite the documents they name from scratch, and kinds that own
# their whole plan. A restore is the second; a parse is only the first.
REWRITES_DOCUMENT = ok.shaped(KIND, DOCUMENT_SHAPE)
EXCLUSIVE_KINDS = ok.shaped(KIND, ok.EXCLUSIVE)


def docs_of_op(op: Dict[str, Any]) -> set:
    """The documents an op reaches: one, a parse's list, or every document a
    corpus-wide replacement matched. Every guard that reasons about what a
    plan touches asks this, the tools' as well as the executor's, so the two
    cannot drift into disagreeing about what an op reaches."""
    out = set()
    if op.get('document_id'):
        out.add(op['document_id'])
    out.update(op.get('document_ids') or [])
    out.update(op.get('documents') or [])
    return out


def entity_of(op: Dict[str, Any]):
    """The stored span or relation an op writes to, named the same way
    whichever kind writes it, or None where it names none."""
    spec = KIND.get(op.get('kind'))
    fn = spec.extra.get('entity') if spec is not None else None
    return fn(op) if fn else None


def scope_clears(op: Dict[str, Any]) -> bool:
    """Whether a scope throws values away. It cannot say which until it is
    resolved, so two scopes over one document are refused when either does."""
    spec = KIND.get(op.get('kind'))
    fn = spec.extra.get('clears') if spec is not None else None
    return bool(fn and fn(op))


def validate_ops(ops: List[Dict[str, Any]]) -> None:
    """Reject a malformed plan BEFORE anything is written."""
    for i, op in enumerate(ops):
        spec = ok.kind_of(KIND, op, index=i)
        kind = spec.name
        for key in spec.required:
            if not op.get(key):
                raise ValueError(f'op {i} ({kind}): missing {key}')
        if kind == 'confirm' and not (op.get('span_id') or op.get('relation_id')):
            raise ValueError(f'op {i} (confirm): needs a span_id or a relation_id')
        # A restore rewrites every layer of the document, so anything else in
        # the plan would address what it is about to replace. Read off the
        # registry's tag, so a second kind that owns its plan is refused by
        # declaring itself rather than by being named here.
        if spec.shape == ok.EXCLUSIVE and len(ops) > 1:
            raise ValueError(f'op {i + 1} ({kind}): a {spec.noun[0]} must be the only op in its plan')
    # A parse rewrites a document from scratch, so anything else this plan
    # writes into the same document would be thrown away by it. The tools
    # refuse the combination as it is built. This is the backstop, because a
    # plan that silently lost half its changes is the worst outcome here.
    # Reshaping a token deletes and remakes its words, so an op that names one
    # of those words would be writing to something that will not exist.
    reshaped = ok.removed_tokens(KIND, ops)
    # A scope reaches every word of its document, so it clashes with any
    # reshape there, without naming a word for the check below to catch.
    reshaped_docs = {op.get('document_id') for op in ops if op.get('kind') in RESHAPES_TOKEN}
    for op in ops:
        if op.get('kind') in SCOPES and docs_of_op(op) & reshaped_docs:
            raise ValueError('this plan both reshapes a token and changes every matching word of its '
                             'document, and the reshape deletes some of them')
    if reshaped:
        # What each kind writes to is the registry's own declaration, so a new
        # kind that names a word joins this check by declaring its keys.
        for op in ops:
            if op.get('kind') in RESHAPES_TOKEN:
                continue
            if ok.written_to(KIND, op) & reshaped:
                raise ValueError('this plan both reshapes a token and annotates one of its words, '
                                 'and the reshape deletes that word')
    # Two reshapes of the same token delete its words twice and then create
    # both sets, so the token ends up holding the union or the batch fails
    # outright. Either way it is not what was approved.
    seen_reshapes = set()
    for op in ops:
        if op.get('kind') not in RESHAPES_TOKEN:
            continue
        words = frozenset(op.get('existing_word_ids') or [])
        if words & seen_reshapes:
            raise ValueError('this plan reshapes the same token twice; keep the one you want '
                             '(plan_status, drop_planned)')
        seen_reshapes |= words
    # A sentence boundary moving renumbers every sentence after it, and every
    # reference in this plan is positional: s7.w2 means a different word once
    # s3 has been cut. Rather than resolve that with a rule nobody will
    # remember, a plan that moves a boundary does that and nothing else to the
    # document. The tools refuse the combination as it is built. This is the
    # backstop.
    # Per DOCUMENT: a boundary moving in one renumbers nothing in another, so a
    # plan may move one boundary and still edit a different document.
    moved: Dict[Any, int] = {}
    for op in ops:
        if op.get('kind') in RESHAPES_DOCUMENT:
            moved[op.get('document_id')] = moved.get(op.get('document_id'), 0) + 1
    if moved:
        others = set().union(*(docs_of_op(op) for op in ops
                               if op.get('kind') not in RESHAPES_DOCUMENT)) & set(moved)
        if others:
            raise ValueError('this plan both moves a sentence boundary in and edits '
                             + ', '.join(sorted(others))
                             + ', and the boundary renumbers the references the edits use')
        crowded = sorted(d for d, n in moved.items() if n > 1)
        if crowded:
            raise ValueError('a plan moves at most one sentence boundary per document, and this '
                             'one moves several in ' + ', '.join(crowded)
                             + ': each renumbers the sentences the next would name')
    parsed = set().union(*(docs_of_op(op) for op in ops if op.get('kind') in REWRITES_DOCUMENT))
    if parsed:
        clash = set().union(*(docs_of_op(op) for op in ops
                              if op.get('kind') not in REWRITES_DOCUMENT)) & parsed
        if clash:
            raise ValueError('this plan both parses and edits ' + ', '.join(sorted(clash))
                             + ', and a parse would throw the edits away')


def _deleted_by_the_plan(ops) -> set:
    """Spans and relations other ops in the plan delete. A patch of one is a
    404 and the batch it shares is atomic, so a confirmation of something the
    plan throws away would refuse the whole plan after the user approved it.
    A cleared field is the case that arises: the value is machine-made and
    unconfirmed, which is exactly why it is being cleared and exactly what a
    confirmation of the document reaches for."""
    return ok.removed_ids(KIND, ops, only_certain=True)


def normalize_ops(ops: List[Dict[str, Any]]):
    """Drop ops a later op supersedes, and say so. Returns (ops, notes)."""
    notes: List[str] = []
    out: List[Dict[str, Any]] = []
    last: Dict[Any, int] = {}
    gone = _deleted_by_the_plan(ops)
    for op in ops:
        kind = op.get('kind')
        # A change to something this plan deletes. The tools refuse the pair
        # while it is being staged, in both orders, and a scope drops what an
        # explicit change already covers, so reaching here means the plan was
        # built some way neither covers. Refusing the whole plan says so,
        # where dropping the change left a card promising it.
        if gone and ok.written_to(KIND, op) & gone:
            raise ValueError(f'{op.get("label") or kind}: this plan deletes what it writes to')
        # What an op writes to is the registry's own declaration, the same one
        # the workspace supersedes by while the plan is built. Written here as
        # well, the two drifted: a kind declared with a target was deduped
        # while staging and not here.
        key = ok.target_of(KIND, op)
        if key is None:
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
    ops = expand_ops(ops)
    validate_ops(ops)
    ops, notes = resolve_scopes(client, project, ops)
    ops, superseded = normalize_ops(ops)
    notes += superseded
    counts: Counter = Counter()
    return applying(ops, lambda tracker: _execute(client, ops, label=label, counts=counts,
                                                  notes=notes, stamps=stamps, tracker=tracker))


def resolve_scopes(client, project, ops: List[Dict[str, Any]]):
    """The per-span ops a scope stands for, read from the document NOW.
    Returns (ops, notes).

    Each scope kind declares its own resolver and this dispatches on that, so
    a kind added later is resolved without being named here.

    Approval has already refused the plan if the document's version moved
    since the model counted, so what is found here is what it counted.
    Nothing is written: this only reads, and a document that cannot be read
    refuses the whole plan before any batch opens."""
    notes: List[str] = []
    if not any(ok.resolver(KIND, op) for op in ops):
        return ops, notes
    if project is None:
        raise ValueError('a whole-document review needs the project to read the document with')
    # A change the model made by name beats one a scope finds at approval,
    # whichever came first: the scope's preview read stored values, not
    # planned ones, and last-wins by position would let it override a
    # set_field the user read on the card.
    named = [op for op in ops if not ok.resolver(KIND, op)]
    named_entities = {entity_of(op) for op in named} - {None}
    named_gone = ok.removed_ids(KIND, named, only_certain=True)

    def named_too(o) -> bool:
        """The model made this same change by name, on the same span or the
        same relation. Which entity each kind names is the kind's own
        declaration, so this held for four kinds named here and none of the
        ones added since."""
        return entity_of(o) in named_entities

    def clashes(o) -> str:
        """Why this change the scope found cannot stand beside what the model
        named, and '' where the two do not meet.

        The same rule seen a second way: a change made by name also beats one
        a scope finds when the two would meet as a write and a delete of one
        span (confirming a value a set_field clears, discarding one a confirm
        names). Left in, that pair refused the plan at the last step, after
        the user had approved it.
        """
        clash = ok.delete_clash(KIND, named, o, named_gone)
        if not clash:
            return ''
        victim, _killer = clash
        if victim is not o:
            return 'another change in this plan writes to what it deletes'
        return ('the plan deletes what it confirms' if o.get('kind') == 'confirm'
                else 'the plan deletes what it writes to')

    def keep(o) -> bool:
        """Whether a change the scope stands for joins the plan. A clash is
        noted: the card counted this change, so the applied message has to
        account for it going."""
        why = clashes(o)
        if why:
            notes.append(f'dropped: {o.get("label") or o.get("kind")} ({why})')
            return False
        return not named_too(o)

    return ok.resolve_ops(KIND, Resolution(client, project), ops, keep), notes


def _run(ctx: Context, ops, stage: str) -> None:
    """One pass of the executor: every op whose kind belongs to ``stage``."""
    for op in ops:
        spec = KIND[op['kind']]
        if spec.stage != stage:
            continue
        n = spec.apply(ctx, op)
        n = 1 if n is None else n
        # An applier that wrote nothing (clearing a value that was not there)
        # adds no key. A zero-valued one reaches the user as "0 field values"
        # on the applied card.
        if n:
            ctx.counts[spec.noun[1]] += n


def _execute(client, ops, *, label, counts, notes, stamps: Stamps, tracker=None) -> Dict[str, int]:
    # An unknown plan operation kind, one that should have been resolved away,
    # or one staged for a pass below that does not exist refuses before any
    # pass runs rather than being written as nothing under a label saying it
    # was applied.
    ok.check_applicable(KIND, ops, STAGES, first=0)
    with client.operation(label):
        ctx = Context(client, ops, stamps, counts, notes, TrackingBatcher(client, tracker=tracker))
        b = ctx.b

        # --- pass 1: the columns, and any lemma span a relation is going to need ---
        # Every kind the executor sees that is not waiting on a minted id.
        _run(ctx, ops, ok.BATCH)

        # Second sub-pass: the lemma spans a relation is going to need, now
        # that `creating` says which ones the plan already makes. A word with
        # no lemma at all gets one valued with its FORM. The app does the same
        # when a person draws an arc onto an unannotated word, except that it
        # uses the token's surface text, which is wrong for a part of a
        # multi-word token ("al" for both halves of a + el). The form is right
        # in every case the surface is, and right in the case it is not.
        for op in ops:
            if op.get('kind') != 'set_head':
                continue
            for wid, form, existing in ((op['word_id'], op.get('word_form') or '', op.get('lemma_span_id')),
                                        (op['head_id'], op.get('head_form') or '', op.get('head_lemma_span_id'))):
                if wid in ctx.lemma_at:
                    continue
                if existing:
                    ctx.lemma_at[wid] = existing
                    continue
                planned = ctx.creating.get((op['lemma_layer_id'], wid))
                if planned is not None:
                    # The user approved a lemma for this word in this very
                    # plan. Hang the relation off THAT span rather than making
                    # a second one seeded from the form.
                    ctx.lemma_at[wid] = planned
                    continue
                ctx.lemma_at[wid] = b.add(
                    lambda batch, o=op, w=wid, f=form: batch.spans.create(
                        o['lemma_layer_id'], [w], f, ctx.stamp()))

        # The relations need those spans to exist, so the batch has to land first.
        b.flush()

        # The server's own restore, after the batches and never with them: it
        # is one operation of its own and a plan holds at most one.
        for op in ctx.restores:
            client.documents.restore(op['document_id'], op['as_of'])
            b.applied += 1

        # --- pass 2: what needed the first batch's ids ---
        from .shape import finish_set_words
        for op in ops:
            if op.get('kind') == 'set_words':
                finish_set_words(op, b, b.results, ctx.stamp)
        _run(ctx, ops, IDS)
        b.flush()

        # --- pass 3: the parser ---
        # Last, and outside the batches, because it is not a write of ours at
        # all: it is another service rewriting whole documents, under its own
        # document lock, for as long as that takes.
        _run(ctx, ops, PARSE)

    result = dict(counts)
    if notes:
        result['notes'] = notes
    return result


# --- summary --------------------------------------------------------------------

def _plural(name: str, n: int) -> str:
    """"dependency" -> "dependencies", not "dependencys". The plan's own
    nouns carry their plural with them; this is for counts read off a
    server summary, where the noun is picked at run time (see `.restore`)."""
    if n == 1:
        return name
    return name[:-1] + 'ies' if name.endswith('y') else name + 's'


def summarize(ops: List[Dict[str, Any]]) -> str:
    """A plan in one phrase, for the audit label and the applied message."""
    return ok.summarize(KIND, ops, ok.stored_count, common_first=True)


def _parse(client, op, document_id: str, notes: List[str], b, total: int) -> None:
    """Ask the project's parser to re-parse one document, and wait.

    A plan may write to one document and parse another, so by the time the
    parser answers, earlier batches may already stand. The count comes from
    the batcher rather than being assumed to be zero."""
    from plaid_client.services import request_service
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
