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

from collections import Counter
from typing import Any, Dict, List

from ..core import guidelines as _guidelines
from ..core import opkind as ok
from ..core.opkind import OpKind
from ..core.plan import PlanError, Stamps, TrackingBatcher, applying, created_id, expand_ops

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
    wholesale, so the op carries the whole object rather than the one key that
    changed."""
    ctx.b.update('spans', op['span_id'], metadata={**ctx.restamp(), UMR: op.get('umr') or {}})
    return 1


def _apply_set_edge_order(ctx: Context, op) -> int:
    ctx.b.update('relations', op['relation_id'], metadata={UMR: {'order': op['order']}})
    return 1


def _apply_create_node(ctx: Context, op) -> int:
    """The anchor token. A node made here is UNALIGNED, so the token is
    zero-width at the start of its sentence, exactly as the editor makes one
    before a person anchors it to words."""
    key = (op['document_id'], op['var'])
    ctx.token_at[key] = ctx.b.add(lambda batch, o=op: batch.tokens.bulk_create([{
        'token_layer_id': o['node_layer_id'], 'text': o['text_id'],
        'begin': o.get('begin') or 0, 'end': o.get('begin') or 0}]))
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
    OpKind('delete_node', ('removed node', 'removed nodes'), required=('token_ids',),
           apply=_apply_delete_node,
           target=lambda op: ('node', op.get('span_id')),
           deletes=lambda op: [op.get('span_id')],
           deletes_tokens=lambda op: list(op.get('token_ids') or []),
           compact_each=('span_id', 'token_ids', 'var', 'ref', 'label'),
           compact_label=_group_label),
    OpKind('delete_edge', ('removed relation', 'removed relations'), required=('relation_id',),
           apply=_apply_delete_relation,
           target=lambda op: ('edge-gone', op.get('relation_id')),
           deletes=lambda op: [op['relation_id']],
           compact_each=('relation_id', 'source', 'target', 'ref', 'label'),
           compact_label=_group_label),
    OpKind('delete_triple', ('removed document-level relation',
                             'removed document-level relations'),
           required=('relation_id',), apply=_apply_delete_relation,
           target=lambda op: ('triple-gone', op.get('relation_id')),
           deletes=lambda op: [op['relation_id']]),
    OpKind('set_concept', _CONCEPT, required=('span_id',), apply=_apply_set_concept,
           target=lambda op: ('concept', op.get('span_id')), token_keys=('span_id',),
           compact_each=('span_id', 'var', 'concept', 'ref', 'label'), compact_label=_group_label),
    OpKind('set_attrs', _ATTRS, required=('span_id',), apply=_apply_span_meta,
           target=lambda op: ('attrs', op.get('span_id')), token_keys=('span_id',),
           compact_each=('span_id', 'var', 'attrs', 'umr', 'ref', 'label'),
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
           compact_each=('var', 'concept', 'attrs', 'begin', 'root', 'ref', 'label'),
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
])

SCOPES = ok.scopes(KIND)
EXCLUSIVE_KINDS = ok.shaped(KIND, ok.EXCLUSIVE)
#: Kinds a graph replacement stages. Everything one ``apply_penman`` call
#: stages carries ``graph_of``, and the tools refuse a second call over the
#: same sentence.
GRAPH_KINDS = ('delete_node', 'delete_edge', 'set_concept', 'set_attrs', 'set_root',
               'unset_root', 'set_edge_order', 'create_node', 'create_edge')


def docs_of_op(op: Dict[str, Any]) -> set:
    """The documents an op reaches. Every guard that reasons about what a plan
    touches asks this, so the tools and the executor cannot drift into
    disagreeing about what an op reaches."""
    out = set()
    if op.get('document_id'):
        out.add(op['document_id'])
    out.update(op.get('document_ids') or [])
    return out


def graphs_of_op(op: Dict[str, Any]) -> set:
    """The sentence graphs an op rewrites, as ``document:sentence``."""
    return {op['graph_of']} if op.get('graph_of') else set()


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
    # Two replacements of one sentence's graph. The second was worked out
    # against the graph the first replaces, so its variables and its ids mean
    # something else by the time it runs. The tools refuse the pair as the plan
    # is built; this is the backstop, because a plan that silently applied half
    # of each is the worst outcome here.
    # One call stages many ops over one graph, so what is counted is the
    # STAGING, not the ops: each call tags its ops with its own id.
    stagings: Dict[str, set] = {}
    for op in ops:
        for key in graphs_of_op(op):
            stagings.setdefault(key, set()).add(op.get('staging') or '')
    crowded = sorted(k for k, v in stagings.items() if len(v) > 1)
    if crowded:
        raise ValueError('this plan replaces the same sentence graph twice: '
                         + ', '.join(crowded))
    # A change to something the plan deletes. The tools refuse the pair in
    # either order as it is staged; reaching here means the plan was built some
    # way neither covers.
    gone = ok.removed_ids(KIND, ops, only_certain=True)
    if gone:
        for op in ops:
            if ok.written_to(KIND, op) & gone:
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
    ops, notes = normalize_ops(ops)
    counts: Counter = Counter()
    return applying(ops, lambda tracker: _execute(client, project, ops, label=label, counts=counts,
                                                  notes=notes, stamps=stamps, tracker=tracker))


def _run(ctx: Context, ops, stage: str) -> None:
    """One pass of the executor: every op whose kind belongs to ``stage``."""
    for op in ops:
        spec = KIND[op['kind']]
        if spec.stage != stage:
            continue
        n = spec.apply(ctx, op)
        n = 1 if n is None else n
        if n:
            ctx.counts[spec.noun[1]] += n


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
        _run(ctx, ops, ok.BATCH)
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
            ctx.span_at[(op['document_id'], op['var'])] = b.add(
                lambda batch, o=op, t=token, m=meta: batch.spans.create(
                    o['concept_layer_id'], [t], o.get('concept') or '',
                    {**ctx.stamp(), UMR: m}))
            made += 1
        if made:
            b.flush()

        # --- pass 3: the relations between those spans ----------------------
        _run(ctx, ops, LINKS)
        b.flush()

    result = dict(counts)
    if notes:
        result['notes'] = notes
    return result


def summarize(ops: List[Dict[str, Any]]) -> str:
    """A plan in one phrase, for the audit label and the applied message."""
    return ok.summarize(KIND, ops, ok.stored_count, common_first=True)


__all__ = ['KIND', 'STAGES', 'GRAPH_KINDS', 'SCOPES', 'EXCLUSIVE_KINDS', 'Context',
           'PlanError', 'docs_of_op', 'graphs_of_op', 'execute_plan', 'normalize_ops',
           'summarize', 'validate_ops']
