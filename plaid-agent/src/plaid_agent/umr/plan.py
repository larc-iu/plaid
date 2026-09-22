"""Applying an approved UMR plan.

The mechanics are :mod:`plaid_agent.core.plan`: batching against the server's
cap, counting what was committed so a failure part-way can say how far it got,
and the provenance an approval writes. What is here is the ops themselves,
each declared once in :data:`KIND` (see :mod:`plaid_agent.core.opkind`).

**Three batches, not one.** A batch op cannot refer to an id an earlier op in
the SAME batch produced, and a node is three entities: an anchor token, the
concept span over it, and the relations between spans. So the anchor tokens go
in one batch, the spans in the next, and the edges and triples in the third.
That is the order ``umrImport.js`` writes a document in, and the order
``UmrDocument.applyPenman`` writes one sentence in.
"""

import re
from collections import Counter
from typing import Any, Dict, List

from ..core import guidelines as _guidelines
from ..core import opkind as ok
from ..core.opkind import OpKind
from ..core.plan import (PlanError, Resolution, Stamps, TrackingBatcher, applying,
                         created_id, docs_of_op, expand_ops)
from .project import load_document, node_ref, with_attribute

UMR = 'umr'

# The pass past the first. A span needs the anchor token the first batch mints,
# and it is made by the executor itself rather than by a kind of its own; an
# edge or a triple needs those spans, which is this pass.
LINKS = 'links'

#: Every pass ``_execute`` runs, which is the whole list a kind may be staged
#: for. A kind declared outside them belongs to no pass: each pass would skip
#: it, nothing would count it, and the operation label would say it was
#: applied.
STAGES = (ok.BATCH, LINKS)


# --- the executor's shared state ---------------------------------------------

class Context:
    """What one run of the executor carries between its passes."""

    def __init__(self, client, project, ops, stamps: Stamps, counts: Counter,
                 notes: List[str], b: TrackingBatcher):
        self.client = client
        self.project = project
        self.ops = ops
        self.stamps = stamps
        self.stamp = stamps.stamp
        self.restamp = stamps.restamp
        self.counts = counts
        self.notes = notes
        self.b = b
        # (document, variable) -> the anchor token's result index, then the
        # span's result index, then the span id once the batch has landed.
        self.token_at: Dict[tuple, Any] = {}
        self.span_at: Dict[tuple, Any] = {}
        # span id -> the `umr` namespace this run has written on it, so a
        # second op on the same node builds on the first (see _apply_span_meta).
        self.umr_now: Dict[str, Dict[str, Any]] = {}

    def _resolved(self, table: Dict[tuple, Any], key: tuple, what: str):
        at = table.get(key)
        if isinstance(at, int):
            result = self.b.results[at] if at < len(self.b.results) else None
            made = created_id(result)
            if not made:
                # A token create comes back as `ids`, a span create as `id`.
                body = (result or {}).get('body') if isinstance(result, dict) else None
                ids = (body or {}).get('ids') if isinstance(body, dict) else None
                made = ids[0] if ids else None
            if not made:
                raise ValueError(f'could not create the {what} {key[1]} this plan needs')
            table[key] = made
            return made
        return at

    def token_id(self, document_id: str, var: str):
        return self._resolved(self.token_at, (document_id, var), 'anchor for')

    def span_id(self, document_id: str, var: str):
        return self._resolved(self.span_at, (document_id, var), 'node')

    def end_of(self, op: Dict[str, Any], side: str):
        """One end of an edge or a triple: the span it already has, or the one
        this plan is creating for that variable."""
        known = op.get(f'{side}_span_id')
        if known:
            return known
        var = op.get(f'{side}_var')
        found = self.span_id(op['document_id'], var)
        if not found:
            raise ValueError(f'{op.get("label") or "an edge"}: no node {var} to hang it on')
        return found


# --- what each kind does ------------------------------------------------------

def _apply_delete_node(ctx: Context, op) -> int:
    """Deleting a node's anchor tokens takes the concept span and every
    relation on it with them, which is the server's cascade and the same write
    the editor makes."""
    ids = list(op.get('token_ids') or [])
    if not ids:
        return 0
    ctx.b.add(lambda batch, i=ids: batch.tokens.bulk_delete(i), weight=len(ids))
    return 1


def _apply_delete_relation(ctx: Context, op) -> int:
    ctx.b.add(lambda batch, i=op['relation_id']: batch.relations.delete(i))
    return 1


def _apply_set_concept(ctx: Context, op) -> int:
    ctx.b.update('spans', op['span_id'], value=op['concept'], metadata=ctx.restamp())
    return 1


def _apply_span_meta(ctx: Context, op) -> int:
    """A node's ``umr`` metadata, whole: a metadata patch replaces a namespace
    wholesale, so the write carries the whole object rather than the one key
    that changed.

    An op therefore carries its DELTA (``umr_set`` / ``umr_unset``) over the
    namespace as it was READ (``umr_base``), and the whole object is composed
    here. Carrying the composed object instead was wrong whenever one plan held
    two ops for one node: attributes and the root mark each snapshotted the node
    before the plan ran, so whichever landed second restored what the first had
    changed, and the node came out with its old root mark or no attributes. The
    two can arrive from different places (a graph diff and an attribute scope
    resolved at approval), so they are composed here, at the one funnel every
    namespace write reaches, and not where either is built."""
    sid = op['span_id']
    base = ctx.umr_now.get(sid)
    if base is None:
        base = dict(op.get('umr_base') or {})
    drop = set(op.get('umr_unset') or ())
    meta = {k: v for k, v in base.items() if k not in drop}
    meta.update(op.get('umr_set') or {})
    ctx.umr_now[sid] = meta
    ctx.b.update('spans', sid, metadata={**ctx.restamp(), UMR: meta})
    return 1


def _apply_set_edge_order(ctx: Context, op) -> int:
    ctx.b.update('relations', op['relation_id'], metadata={UMR: {'order': op['order']}})
    return 1


def _apply_create_node(ctx: Context, op) -> int:
    """The anchor token. A node made here is aligned to no word, so it stands
    over the WHOLE of its sentence, exactly as the editor makes one before a
    person anchors it to words (``UmrDocument.piecesFor``). It stood on a point
    at the sentence's start until ``c6313696``: core deletes a zero-width token
    a deletion spans, so an edit in another app that joined two sentences took
    the node with it. A constant belongs to no sentence and keeps its point at
    the text's start, which is what the editor gives one."""
    key = (op['document_id'], op['var'])
    begin = op.get('begin') or 0
    end = op.get('end') or begin
    ctx.token_at[key] = ctx.b.add(lambda batch, o=op, a=begin, z=end: batch.tokens.bulk_create([{
        'token_layer_id': o['node_layer_id'], 'text': o['text_id'], 'begin': a, 'end': z}]))
    return 1


def _apply_create_edge(ctx: Context, op) -> int:
    source = ctx.end_of(op, 'source')
    target = ctx.end_of(op, 'target')
    ctx.b.add(lambda batch, o=op, s=source, t=target: batch.relations.create(
        o['relation_layer_id'], s, t, o['role'], {**ctx.stamp(), UMR: {'order': o.get('order') or 0}}))
    return 1


def _apply_create_triple(ctx: Context, op) -> int:
    source = ctx.end_of(op, 'source')
    target = ctx.end_of(op, 'target')
    meta: Dict[str, Any] = {'group': op['group']}
    if op.get('sentences'):
        meta['sentences'] = list(op['sentences'])
    ctx.b.add(lambda batch, o=op, s=source, t=target, m=meta: batch.relations.create(
        o['document_graph_layer_id'], s, t, o['rel'], {**ctx.stamp(), UMR: m}))
    return 1


# --- what a scope stands for --------------------------------------------------
#
# A scope is stored as the predicate the model gave and resolved to per-node
# ops at approval, reading the document NOW. Each kind declares its own
# resolver beside everything else it declares, and `resolve_scopes` runs them
# without naming one.

def concept_matches(op: Dict[str, Any], concept: str) -> bool:
    """Whether a node's concept is one this scope names. The pattern is stored
    as the model wrote it, so the preview and the resolution read it the same
    way."""
    pattern = op.get('concept') or ''
    if not pattern:
        return False
    p = pattern if op.get('regex') else re.escape(pattern)
    if op.get('whole'):
        p = f'^(?:{p})$'
    return bool(re.search(p, concept or '', 0 if op.get('case_sensitive') else re.I))


def attrs_scope_targets(doc, op: Dict[str, Any]):
    """The nodes in ``doc`` this scope changes, with the attributes each ends
    up with. One reader, because the tool previews the count on the card and
    the resolver stages the changes, and the two have to mean the same set."""
    rel, value = op.get('rel') or '', op.get('value') or ''
    for s in doc.sentences:
        for node in s.nodes:
            if node.constant or not concept_matches(op, node.concept):
                continue
            placed = with_attribute(node, rel, value)
            if [(a.get('rel'), a.get('value')) for a in node.attrs] \
                    == [(a['rel'], a['value']) for a in placed]:
                continue
            yield s, node, placed


def _resolve_attrs_scope(res: Resolution, op):
    did = op['document_id']
    doc = res.document(did)
    rel, value = op.get('rel') or '', op.get('value') or ''
    for s, node, placed in attrs_scope_targets(doc, op):
        shown = f'{rel} {value}' if value else f'{rel} removed'
        yield {'kind': 'set_attrs', 'document_id': did, 'ref': node_ref(s, node),
               'sentence': s.index, 'sentence_id': s.id, 'span_id': node.id, 'var': node.var,
               'attrs': placed, 'umr_base': dict(((node.metadata or {}).get(UMR)) or {}),
               'umr_set': {'attrs': placed}, 'label': f'{node.var}: {shown}'}


def _attrs_scope_summary(op, n):
    """A scope counts as the attribute sets its preview found, so the approval
    line says how many nodes it stands for rather than one scope."""
    return [(_ATTRS, n)]


# --- what a group of like ops reads as ----------------------------------------

def _refs_phrase(members, limit: int = 8) -> str:
    refs = [m.get('ref') for m in members if m.get('ref')]
    shown = ', '.join(refs[:limit])
    return shown + (f', … {len(refs) - limit} more' if len(refs) > limit else '')


def _group_label(first, members) -> str:
    return f'{len(members)} changes to the graph ({_refs_phrase(members)})'


# --- the registry --------------------------------------------------------------

_NODE = ('node', 'nodes')
_EDGE = ('relation', 'relations')
_TRIPLE = ('document-level relation', 'document-level relations')
_CONCEPT = ('concept', 'concepts')
_ATTRS = ('attribute set', 'attribute sets')
_ROOT = ('root', 'roots')

KIND = ok.registry([
    # The project's annotation manual. Shared with the other apps: a guideline
    # has the same shape whatever the project annotates.
    *_guidelines.kinds(OpKind),
    # What a node delete really removes: the concept span, the anchor tokens
    # the write names, and the cascade the server runs over them (every edge
    # and every document-level triple on the node). All of it is declared, so
    # a plan that also touches one of those relations is refused as it is
    # built instead of failing the batch the user approved.
    OpKind('delete_node', ('removed node', 'removed nodes'), required=('token_ids',),
           apply=_apply_delete_node,
           target=lambda op: ('node', op.get('span_id')),
           deletes=lambda op: [op.get('span_id')] + list(op.get('relation_ids') or []),
           deletes_tokens=lambda op: list(op.get('token_ids') or []),
           compact_each=('span_id', 'token_ids', 'relation_ids', 'var', 'ref', 'label'),
           compact_label=_group_label),
    # `relation_id` is named as something the op NEEDS as well as something it
    # removes: a single relation delete of an id already gone is a 404 that
    # takes its whole batch with it, so a plan holding this and a node delete
    # that cascades the same relation is refused in either order (the pair
    # staged happily before, and one of the two orders failed at approval).
    OpKind('delete_edge', ('removed relation', 'removed relations'), required=('relation_id',),
           apply=_apply_delete_relation,
           target=lambda op: ('edge-gone', op.get('relation_id')),
           token_keys=('relation_id',),
           deletes=lambda op: [op['relation_id']],
           compact_each=('relation_id', 'source', 'target', 'ref', 'label'),
           compact_label=_group_label),
    OpKind('delete_triple', ('removed document-level relation',
                             'removed document-level relations'),
           required=('relation_id',), apply=_apply_delete_relation,
           target=lambda op: ('triple-gone', op.get('relation_id')),
           token_keys=('relation_id',),
           deletes=lambda op: [op['relation_id']]),
    OpKind('set_concept', _CONCEPT, required=('span_id',), apply=_apply_set_concept,
           target=lambda op: ('concept', op.get('span_id')), token_keys=('span_id',),
           compact_each=('span_id', 'var', 'concept', 'ref', 'label'), compact_label=_group_label),
    OpKind('set_attrs', _ATTRS, required=('span_id',), apply=_apply_span_meta,
           target=lambda op: ('attrs', op.get('span_id')), token_keys=('span_id',),
           compact_each=('span_id', 'var', 'attrs', 'umr_base', 'umr_set', 'ref', 'label'),
           compact_label=_group_label),
    OpKind('set_root', _ROOT, required=('span_id',), apply=_apply_span_meta,
           target=lambda op: ('root-on', op.get('span_id')), token_keys=('span_id',)),
    OpKind('unset_root', _ROOT, required=('span_id',), apply=_apply_span_meta,
           target=lambda op: ('root-off', op.get('span_id')), token_keys=('span_id',)),
    OpKind('set_edge_order', ('relation order', 'relation orders'), required=('relation_id',),
           apply=_apply_set_edge_order, target=lambda op: ('order', op.get('relation_id')),
           token_keys=('relation_id',),
           compact_each=('relation_id', 'order', 'ref', 'label'), compact_label=_group_label),
    OpKind('create_node', _NODE, required=('var', 'node_layer_id', 'concept_layer_id', 'text_id'),
           apply=_apply_create_node,
           target=lambda op: ('new-node', op.get('document_id'), op.get('var')),
           compact_each=('var', 'concept', 'attrs', 'begin', 'end', 'root', 'ref', 'label'),
           compact_label=_group_label),
    OpKind('create_edge', _EDGE, stage=LINKS, required=('relation_layer_id', 'role'),
           apply=_apply_create_edge,
           target=lambda op: ('new-edge', op.get('document_id'), op.get('source_var'),
                              op.get('role'), op.get('target_var')),
           token_keys=('source_span_id', 'target_span_id'),
           compact_each=('source_var', 'target_var', 'role', 'order', 'source_span_id',
                         'target_span_id', 'ref', 'label'),
           compact_label=_group_label),
    OpKind('create_triple', _TRIPLE, stage=LINKS,
           required=('document_graph_layer_id', 'rel', 'group'), apply=_apply_create_triple,
           target=lambda op: ('new-triple', op.get('document_id'), op.get('source_var'),
                              op.get('rel'), op.get('target_var')),
           token_keys=('source_span_id', 'target_span_id')),
    # One attribute over every node in a document whose concept matches,
    # stored as the predicate the model gave and resolved to one `set_attrs`
    # per node at approval, so the card carries one row rather than two
    # hundred and the values written are the ones in the document NOW.
    OpKind('attrs_scope', _ATTRS, stage=ok.RESOLVED, shape=ok.SCOPE,
           required=('document_id', 'concept', 'rel'), resolve=_resolve_attrs_scope,
           summary=_attrs_scope_summary,
           target=lambda op: ('attrs_scope', op.get('document_id'), op.get('concept'),
                              op.get('rel'))),
])

SCOPES = ok.scopes(KIND)
EXCLUSIVE_KINDS = ok.shaped(KIND, ok.EXCLUSIVE)
#: Kinds a graph replacement stages. Everything one ``apply_penman`` call
#: stages carries ``graph_of``, and the tools refuse a second call over the
#: same sentence.
GRAPH_KINDS = ('delete_node', 'delete_edge', 'set_concept', 'set_attrs', 'set_root',
               'unset_root', 'set_edge_order', 'create_node', 'create_edge')


def graphs_of_op(op: Dict[str, Any]) -> set:
    """The sentence graphs an op rewrites, as ``document:sentence``."""
    return {op['graph_of']} if op.get('graph_of') else set()


def sentence_graph_key(op: Dict[str, Any]) -> str:
    """The sentence graph a single-node change belongs to, written the way
    ``graph_of`` is, so the two can be compared."""
    if op.get('document_id') and op.get('sentence'):
        return f'{op["document_id"]}:{op["sentence"]}'
    return ''


def validate_ops(ops: List[Dict[str, Any]]) -> None:
    """Reject a malformed plan BEFORE anything is written."""
    for i, op in enumerate(ops):
        spec = ok.kind_of(KIND, op, index=i)
        for key in spec.required:
            if not op.get(key):
                raise ValueError(f'op {i} ({spec.name}): missing {key}')
        if spec.shape == ok.EXCLUSIVE and len(ops) > 1:
            raise ValueError(f'op {i + 1} ({spec.name}): a {spec.noun[0]} must be the only op '
                             f'in its plan')
    # A sentence graph replaced by one call and changed by another. Whichever
    # was staged second was worked out against a graph the other replaces, so
    # its variables and its ids mean something else by the time it runs. The
    # tools refuse the pair in either order as the plan is built; this is the
    # backstop, because a plan that silently applied half of each is the worst
    # outcome here.
    # One call stages many ops over one graph, so what is counted is the
    # STAGING, not the ops: each call tags its ops with its own id.
    replaced = {key for op in ops for key in graphs_of_op(op)}
    stagings: Dict[str, set] = {}
    for op in ops:
        keys = graphs_of_op(op)
        if not keys and op.get('kind') in GRAPH_KINDS:
            # A change to one node of a graph another call replaces.
            keys = {k for k in [sentence_graph_key(op)] if k in replaced}
        for key in keys:
            stagings.setdefault(key, set()).add(op.get('staging') or '')
    crowded = sorted(k for k, v in stagings.items() if len(v) > 1)
    if crowded:
        raise ValueError('this plan holds two separate changes to one sentence graph: '
                         + ', '.join(crowded))
    # A change to something the plan deletes. The tools refuse the pair in
    # either order as it is staged; reaching here means the plan was built some
    # way neither covers.
    for op in ops:
        # What the OTHER ops remove: an op never clashes with its own
        # deletion, since a delete of a relation names it so that a SECOND
        # delete of the same one is refused (ok.doomed_writes).
        if ok.doomed_writes(KIND, op, ops):
            raise ValueError(f'{op.get("label") or op.get("kind")}: this plan deletes what '
                             f'it writes to')


def normalize_ops(ops: List[Dict[str, Any]]):
    """Drop ops a later op supersedes, and say so. Returns (ops, notes)."""
    notes: List[str] = []
    out: List[Dict[str, Any]] = []
    last: Dict[Any, int] = {}
    for op in ops:
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
    return applying(ops, lambda tracker: _execute(client, project, ops, label=label, counts=counts,
                                                  notes=notes, stamps=stamps, tracker=tracker))


def resolve_scopes(client, project, ops: List[Dict[str, Any]]):
    """The per-node ops a scope stands for, read from the document NOW.
    Returns (ops, notes).

    Each scope kind declares its own resolver and this dispatches on that, so
    a kind added later is resolved without being named here.

    Approval has already refused the plan if the document's version moved
    since the model counted, so what is found here is what it counted. Nothing
    is written: this only reads, and a document that cannot be read refuses the
    whole plan before any batch opens.
    """
    notes: List[str] = []
    if not any(ok.resolver(KIND, op) for op in ops):
        return ops, notes
    if project is None:
        raise ValueError('a change over a whole document needs the project to read it with')
    # A change the model made by name beats one a scope finds at approval,
    # whichever came first: the scope previewed stored attributes, not planned
    # ones, so last-wins by position would let it override a set_attributes the
    # user read on the card.
    named = [op for op in ops if not ok.resolver(KIND, op)]
    named_targets = {ok.target_of(KIND, op) for op in named} - {None}
    named_gone = ok.removed_ids(KIND, named, only_certain=True)

    def keep(o) -> bool:
        if ok.target_of(KIND, o) in named_targets:
            notes.append(f'dropped: {o.get("label") or o.get("kind")} (the plan already names '
                         f'that node)')
            return False
        if ok.written_to(KIND, o) & named_gone:
            notes.append(f'dropped: {o.get("label") or o.get("kind")} (the plan deletes what it '
                         f'writes to)')
            return False
        return True

    return ok.resolve_ops(KIND, Resolution(client, project, load_document), ops, keep), notes


def _execute(client, project, ops, *, label, counts, notes, stamps: Stamps,
             tracker=None) -> Dict[str, int]:
    # An unknown kind, one that should have been resolved away, or one staged
    # for a pass that does not exist refuses before any pass runs, rather than
    # being written as nothing under a label saying it was applied.
    ok.check_applicable(KIND, ops, STAGES, first=0)
    with client.operation(label):
        ctx = Context(client, project, ops, stamps, counts, notes,
                      TrackingBatcher(client, tracker=tracker))
        b = ctx.b

        # --- pass 1: deletes, values, metadata, and every anchor token ------
        ok.run_stage(KIND, ctx, ops, ok.BATCH)
        b.flush()

        # --- pass 2: the concept spans over the tokens pass 1 minted --------
        made = 0
        for op in ops:
            if op.get('kind') != 'create_node':
                continue
            token = ctx.token_id(op['document_id'], op['var'])
            meta: Dict[str, Any] = {'var': op['var'], 'attrs': list(op.get('attrs') or [])}
            if op.get('constant'):
                meta['constant'] = True
            if op.get('root'):
                meta['root'] = True
            # A node aligned to no word records its sentence, as the editor
            # does: the record is what says so, and the anchor stands over the
            # whole sentence, so an edit to the text around it resizes the
            # anchor rather than taking the node with it.
            if op.get('sentence_id') and not op.get('constant'):
                meta['sentence'] = op['sentence_id']
            ctx.span_at[(op['document_id'], op['var'])] = b.add(
                lambda batch, o=op, t=token, m=meta: batch.spans.create(
                    o['concept_layer_id'], [t], o.get('concept') or '',
                    {**ctx.stamp(), UMR: m}))
            made += 1
        if made:
            b.flush()

        # --- pass 3: the relations between those spans ----------------------
        ok.run_stage(KIND, ctx, ops, LINKS)
        b.flush()

    result = dict(counts)
    if notes:
        result['notes'] = notes
    return result


def summarize(ops: List[Dict[str, Any]]) -> str:
    """A plan in one phrase, for the audit label and the applied message."""
    return ok.summarize(KIND, ops, ok.stored_count, common_first=True)


__all__ = ['KIND', 'STAGES', 'GRAPH_KINDS', 'SCOPES', 'EXCLUSIVE_KINDS', 'Context',
           'PlanError', 'Resolution', 'attrs_scope_targets', 'concept_matches', 'docs_of_op',
           'graphs_of_op', 'execute_plan', 'normalize_ops', 'resolve_scopes',
           'sentence_graph_key', 'summarize', 'validate_ops']
