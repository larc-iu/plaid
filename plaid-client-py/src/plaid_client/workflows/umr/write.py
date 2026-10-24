"""Writing drafted UMR graphs, and what a drafting run reports.

A service that drafts graphs hands :func:`write_graphs` one plan per sentence::

    {'sentence': Sentence,
     'pieces':   [(begin, end), ...],                  token extents
     'nodes':    [{'concept': str, 'meta': {...},
                   'piece_indexes': [i, ...]}, ...],   pieces by index
     'edges':    [{'source': i, 'target': i,
                   'role': ':ARG0', 'order': n}, ...]} nodes by index

and gets one atomic batch: anchors, then nodes, then edges, each naming the
ones before it by a ref to the ids they are created with. That is the order the
``.umr`` importer writes in (``src/domain/umrImport.js``).

Two services write this shape (drafting with a model, and the skeleton from
glosses). What they share lives here: the three request parameters
(:func:`draft_params`), reading the document and choosing the sentences to draft
(:func:`_begin_draft`), writing the plans and reporting (:func:`finish_draft`),
the writer and the progress budget. A service supplies only its plan per
sentence.
"""

import contextlib
import json
from dataclasses import dataclass, field as dc_field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

from plaid_client.provenance import PROV_DETAIL_KEY, PROV_KEY, PROVENANCE_KEYS, service_source
from plaid_client.service import (batch_body_budget, held_run, partly_written, progress_heartbeat,
                                  require_held)
from plaid_client.service_schema import Param

from ..requester import Requester, requester_of
from .graph import Edge, Node, Sentence, UmrDocument, read_document, words_under
from .layers import UMR_NAMESPACE, UmrLayers, gloss_values, resolve_layers
from .penman import next_variable


def anchor_pieces(ranges, words, sentence_extent) -> List[Tuple[int, int]]:
    """The anchor tokens for one node: one piece per aligned word range, or one
    piece over the whole sentence when the concept is not overtly realized.

    That is how a node aligned to no word is stored: what says it is unaligned is
    its sentence record, not the anchor, and an anchor over the sentence survives
    an edit to the text around it (``src/domain/umrReconcile.js``).
    """
    pieces: List[Tuple[int, int]] = []
    for begin, end in ranges or []:
        first = words[begin - 1] if 0 < begin <= len(words) else None
        last = words[end - 1] if 0 < end <= len(words) else None
        if first is None or last is None:
            continue
        pieces.append((first.begin, last.end))
    return pieces or [tuple(sentence_extent)]


class DraftProgress:
    """A fixed percentage budget over the phases, so the bar moves for the same
    reason on every document:

        2-10    reading the document and the project
        10-85   drafting
        85-100  writing

    ``report`` is a CANCELLATION CHECKPOINT (``ResponseHelper.progress`` raises),
    so every call in the write phase sits inside ``critical()``.
    """

    READ, DRAFT, WRITE = (2, 10), (10, 85), (85, 100)

    def __init__(self, helper=None):
        self._helper = helper

    @staticmethod
    def _percent(phase, fraction):
        low, high = phase
        return int(low + (high - low) * min(max(fraction, 0.0), 1.0))

    def report(self, phase, fraction, message):
        if self._helper:
            self._helper.progress(self._percent(phase, fraction), message)

    def heartbeat(self, phase, fraction, message):
        """Keep saying ``message`` through one model call, which reports nothing
        of its own and can outlast a requester's patience with silence."""
        if not self._helper:
            return contextlib.nullcontext()
        return progress_heartbeat(self._helper, self._percent(phase, fraction), message)


def _count(n: int, noun: str) -> str:
    return f'{n} {noun}' + ('' if n == 1 else 's')


def run_label(name: str, plans: Sequence[dict]) -> str:
    """What a run's write is called in History: ``UMR draft of sentence 3``,
    or ``UMR draft (4 sentences)``."""
    if len(plans) == 1:
        return f"{name} of sentence {plans[0]['sentence'].number}"
    return f'{name} ({len(plans)} sentences)'


def _predicted(frag: dict, prediction: dict) -> dict:
    """``frag`` with what the writer predicted added to its ``provDetail``,
    so accepted as drafted and corrected afterwards stay distinguishable once
    a person has verified the item (``plaid_client.provenance``). A write
    with no provenance stamp is a person's, and records no prediction."""
    if not frag.get(PROV_KEY):
        return frag
    return {**frag, PROV_DETAIL_KEY: {**(frag.get(PROV_DETAIL_KEY) or {}), **prediction}}


def _sentence_writes(layers: UmrLayers, plan: dict, frag: dict) -> dict:
    """One plan's writes: the old graph's anchors to delete, and the anchors,
    nodes and edges to create. A node names its anchors by their index among
    the plan's pieces and an edge its nodes by index among the plan's nodes,
    turned into batch refs when the sentence is queued."""
    nodes = []
    for node in plan['nodes']:
        meta = node['meta']
        # An aligned node records its words, as the app's writers do
        # (``words_under``). One aligned to none records its sentence instead.
        if 'sentence' not in meta:
            words = words_under([plan['pieces'][i] for i in node['piece_indexes']],
                                plan['sentence'].words)
            if words:
                meta = {**meta, 'words': words}
        prediction = {'value': node['concept']}
        attrs = [{'rel': a['rel'], 'value': a['value']}
                 for a in node['meta'].get('attrs') or []]
        if attrs:
            prediction['attrs'] = attrs
        nodes.append(({
            'span_layer_id': layers.concept_layer['id'],
            'value': node['concept'],
            'metadata': {**_predicted(frag, prediction), UMR_NAMESPACE: meta},
        }, list(node['piece_indexes'])))
    edges = [({
        'relation_layer_id': layers.relation_layer['id'],
        'value': edge['role'],
        'metadata': {**_predicted(frag, {'value': edge['role']}),
                     UMR_NAMESPACE: {'order': edge['order']}},
    }, edge['source'], edge['target']) for edge in plan['edges']]
    pieces = [{'token_layer_id': layers.node_layer['id'],
               'text': layers.text_id, 'begin': begin, 'end': end}
              for begin, end in plan['pieces']]
    # An aligned node's hold, after the plan's pieces (``holdFor`` in
    # plaid-umr's sentenceGraph.js): from where its words begin to the end of
    # its sentence, which keeps it when another app deletes its words' text.
    for node_op, indexes in nodes:
        if 'sentence' in node_op['metadata'][UMR_NAMESPACE]:
            continue
        text = [plan['pieces'][i] for i in indexes if plan['pieces'][i][1] > plan['pieces'][i][0]]
        if not text:
            continue
        indexes.append(len(pieces))
        pieces.append({'token_layer_id': layers.node_layer['id'], 'text': layers.text_id,
                       'begin': min(b for b, _ in text), 'end': plan['sentence'].end,
                       'metadata': {UMR_NAMESPACE: {'hold': True}}})
    doomed = [pid for node in plan['sentence'].nodes for pid in node.piece_ids]
    refs = sum(len(indexes) for _, indexes in nodes) + 2 * len(edges)
    size = (len(json.dumps([doomed, pieces, [n for n, _ in nodes], [e for e, _, _ in edges]]))
            + _REF_BYTES * refs)
    return {'doomed': doomed, 'pieces': pieces, 'nodes': nodes, 'edges': edges,
            'bytes': size}


def _same(a, b) -> bool:
    return json.dumps(a, sort_keys=True, default=str) == json.dumps(b, sort_keys=True, default=str)


def _restamp(stored: Optional[dict], planned: dict) -> List[dict]:
    """The metadata ops that make a stored row's metadata what a plan writes:
    each key the plan writes set, and each provenance key the row has that the
    plan's lacks (a person's verification) deleted. Its other keys stay."""
    return ([{'op': 'set', 'path': [k], 'value': v} for k, v in planned.items()]
            + [{'op': 'delete', 'path': [k]} for k in (stored or {})
               if k in PROVENANCE_KEYS and k not in planned])


def _keep_variables(planned: list, match: Dict[int, Node], number: int, taken) -> list:
    """``planned`` with each node kept with its concept (``match``) under its
    stored variable, as it was before the redraft (REV8-APPS-3). The plan mints
    variables in its graph's order, so a new node of the same letter written
    first took the kept node's, and the untouched kept node showed renamed. A
    planned node whose variable a kept node now holds takes a variable a kept
    node gave up, one of its own letter, else the next free one."""
    def var_of(op):
        return ((op['metadata'].get(UMR_NAMESPACE) or {}).get('var'))

    keeps = {k: n.var for k, n in match.items()
             if n.var and n.concept == planned[k][0]['value']}
    if not keeps:
        return planned
    held = set(keeps.values())
    freed = [var_of(planned[k][0]) for k in keeps
             if var_of(planned[k][0]) and var_of(planned[k][0]) not in held]
    used = held | {var_of(op) for k, (op, _i, _a) in enumerate(planned) if k not in keeps}
    out = []
    for k, (op, indexes, at) in enumerate(planned):
        var = keeps.get(k)
        if var is None and var_of(op) in held:
            letter = next_variable(number, op['value'], ())
            var = next((v for v in freed if v.rstrip('0123456789') == letter), None)
            if var is None:
                var = next_variable(number, op['value'], set(taken or ()) | used | set(freed))
            else:
                freed.remove(var)
            used.add(var)
        if var is not None and var != var_of(op):
            meta = {**op['metadata'], UMR_NAMESPACE: {
                **(op['metadata'].get(UMR_NAMESPACE) or {}), 'var': var}}
            op = {**op, 'metadata': meta}
        out.append((op, indexes, at))
    return out


def _keep_stored(plan: dict, unit: dict, taken=()) -> dict:
    """``unit`` with only the rows of its new graph that are not stored as
    they are (ruling 30, 2026-10-16, per row). A stored node with the concept,
    ``umr`` metadata and anchors the plan gives is kept as it is, with its
    anchors, edges and document-level triples. One with the same anchors is
    kept and its concept or metadata updated. An edge between two kept nodes
    with the role and metadata the plan gives is kept, one whose role or
    metadata changes is updated, and what the plan lacks is deleted. Only
    what is left is created, each new node on anchors of its own as a fresh
    write gives it, never on a kept node's (REV8-APPS-1: the canvas's Delete
    deletes a node's anchors, so a shared one took both nodes)."""
    sentence = plan['sentence']
    if not isinstance(sentence, Sentence) or not sentence.nodes:
        return unit
    # A node is matched by its pieces, its hold aside.
    pieces = [(p['begin'], p['end']) for p in unit['pieces']]
    held = {i for i, p in enumerate(unit['pieces']) if 'metadata' in p}
    planned = [(op, indexes, sorted(pieces[i] for i in indexes if i not in held))
               for op, indexes in unit['nodes']]
    stored = list(sentence.nodes)
    ranges = {n.id: sorted((p.begin, p.end) for p in n.pieces) for n in stored}
    match: Dict[int, Node] = {}   # planned node index -> the stored node it keeps
    updates = []

    def pair(test):
        for k, (op, _indexes, at) in enumerate(planned):
            if k in match:
                continue
            for n in stored:
                if n not in match.values() and test(op, at, n):
                    match[k] = n
                    break

    def umr_of(n):
        return (n.metadata or {}).get(UMR_NAMESPACE)

    def but_var(meta):
        return {key: value for key, value in (meta or {}).items() if key != 'var'}

    pair(lambda op, at, n: at == ranges[n.id] and op['value'] == n.concept
         and _same(op['metadata'].get(UMR_NAMESPACE), umr_of(n)))
    pair(lambda op, at, n: at == ranges[n.id] and op['value'] == n.concept
         and _same(but_var(op['metadata'].get(UMR_NAMESPACE)), but_var(umr_of(n))))
    pair(lambda op, at, n: at == ranges[n.id] and op['value'] == n.concept)
    pair(lambda op, at, n: at == ranges[n.id])
    planned = _keep_variables(planned, match, sentence.number, taken)
    for k, n in match.items():
        if planned[k][0]['value'] == n.concept and _same(
                planned[k][0]['metadata'].get(UMR_NAMESPACE), umr_of(n)):
            continue
        op = planned[k][0]
        updates.append({'id': n.id, 'value': op['value'],
                        'metadata': _restamp(n.metadata, op['metadata'])})

    kept_ids = {n.id for n in match.values()}
    kept_pieces = {p.id for n in match.values() for p in n.pieces}
    doomed_nodes = [n for n in stored if n.id not in kept_ids]
    doomed_pieces = list(dict.fromkeys(pid for n in doomed_nodes for pid in n.piece_ids
                                       if pid not in kept_pieces))
    # A node with an anchor a kept node stands on too is not taken by the
    # anchors' delete, so it is deleted itself.
    node_deletes = [n.id for n in doomed_nodes if any(p.id in kept_pieces for p in n.pieces)]

    new_pieces: List[dict] = []
    new_piece_of: Dict[int, int] = {}
    nodes = []
    new_node_of: Dict[int, int] = {}
    for k, (op, indexes, _at) in enumerate(planned):
        if k in match:
            continue
        anchors = []
        for i in indexes:
            if i not in new_piece_of:
                new_piece_of[i] = len(new_pieces)
                new_pieces.append(unit['pieces'][i])
            anchors.append(new_piece_of[i])
        new_node_of[k] = len(nodes)
        nodes.append((op, anchors))

    def end(k):
        return match[k].id if k in match else new_node_of[k]

    stored_edges: Dict[Tuple[str, str], List[Edge]] = {}
    for n in stored:
        for e in n.out:
            if e.source in kept_ids and e.target in kept_ids:
                stored_edges.setdefault((e.source, e.target), []).append(e)
    edges, edge_updates = [], []
    left = []
    for op, source, target in unit['edges']:
        ends = (end(source), end(target))
        here = stored_edges.get(ends) if isinstance(ends[0], str) and isinstance(ends[1], str) \
            else None
        same = next((e for e in here or [] if e.role == op['value'] and _same(
            (e.metadata or {}).get(UMR_NAMESPACE), op['metadata'].get(UMR_NAMESPACE))), None)
        if same is not None:
            here.remove(same)
        else:
            left.append((op, ends))
    for op, ends in left:
        here = stored_edges.get(ends) if isinstance(ends[0], str) and isinstance(ends[1], str) \
            else None
        if here:
            e = here.pop(0)
            edge_updates.append({'id': e.id, 'value': op['value'],
                                 'metadata': _restamp(e.metadata, op['metadata'])})
        else:
            edges.append((op, ends[0], ends[1]))
    edge_deletes = [e.id for rest in stored_edges.values() for e in rest]

    refs = sum(sum(isinstance(a, int) for a in anchors) for _, anchors in nodes) + sum(
        isinstance(s, int) + isinstance(t, int) for _, s, t in edges)
    size = (len(json.dumps([doomed_pieces, node_deletes, edge_deletes, new_pieces,
                            [n for n, _ in nodes], [e for e, _, _ in edges], updates,
                            edge_updates]))
            + _REF_BYTES * refs)
    return {'doomed': doomed_pieces, 'node_deletes': node_deletes, 'edge_deletes': edge_deletes,
            'pieces': new_pieces, 'nodes': nodes, 'edges': edges, 'node_updates': updates,
            'edge_updates': edge_updates, 'bytes': size}


def _writes_anything(unit: dict) -> bool:
    return any(unit.get(key) for key in ('doomed', 'node_deletes', 'edge_deletes', 'pieces',
                                         'nodes', 'edges', 'node_updates', 'edge_updates'))


#: What one ref beside a body costs on the wire, ``{"at": [...], "op": n,
#: "index": k}`` with its separators, rounded up.
_REF_BYTES = 64


def _queue_sentences(b, units: Sequence[dict], progress: DraftProgress, alone: bool) -> None:
    """Queue the writes of ``units`` on batch ``b``: the edges, nodes and
    anchors a redraft deletes, then anchors, nodes and edges, each naming the
    ones before it by a ref (a stored one by its id), then the updates of the
    stored nodes and edges whose value changes."""
    edge_deletes = [i for unit in units for i in unit.get('edge_deletes', [])]
    node_deletes = [i for unit in units for i in unit.get('node_deletes', [])]
    doomed = [pid for unit in units for pid in unit['doomed']]
    pieces = [piece for unit in units for piece in unit['pieces']]
    if alone and (doomed or node_deletes):
        progress.report(DraftProgress.WRITE, 0.1, f'Clearing {_count(len(doomed), "anchor")}…')
    if edge_deletes:
        b.relations.bulk_delete(edge_deletes)
    if node_deletes:
        b.spans.bulk_delete(node_deletes)
    if doomed:
        b.tokens.bulk_delete(doomed)
    piece_refs = []
    if pieces:
        if alone:
            progress.report(DraftProgress.WRITE, 0.3, f'Writing {_count(len(pieces), "anchor")}…')
        b.tokens.bulk_create(pieces)
        piece_refs = [b.ref(-1, k) for k in range(len(pieces))]

    span_ops: List[dict] = []
    piece_base = 0
    node_bases = []
    for unit in units:
        node_bases.append(len(span_ops))
        span_ops.extend({**op, 'tokens': [piece_refs[piece_base + a] if isinstance(a, int) else a
                                          for a in anchors]}
                        for op, anchors in unit['nodes'])
        piece_base += len(unit['pieces'])
    node_refs = []
    if span_ops:
        if alone:
            progress.report(DraftProgress.WRITE, 0.6, f'Writing {_count(len(span_ops), "node")}…')
        b.spans.bulk_create(span_ops)
        node_refs = [b.ref(-1, k) for k in range(len(span_ops))]

    def end(base, value):
        return node_refs[base + value] if isinstance(value, int) else value

    edge_ops = [{**op, 'source': end(base, source), 'target': end(base, target)}
                for unit, base in zip(units, node_bases)
                for op, source, target in unit['edges']]
    if edge_ops:
        if alone:
            progress.report(DraftProgress.WRITE, 0.9,
                            f'Writing {_count(len(edge_ops), "relation")}…')
        b.relations.bulk_create(edge_ops)
    node_updates = [u for unit in units for u in unit.get('node_updates', [])]
    if node_updates:
        b.spans.bulk_update(node_updates)
    edge_updates = [u for unit in units for u in unit.get('edge_updates', [])]
    if edge_updates:
        b.relations.bulk_update(edge_updates)


def write_graphs(client, layers: UmrLayers, plans: Sequence[dict], frag: dict,
                 progress: Optional[DraftProgress] = None, taken=()) -> None:
    """Anchors, then nodes, then edges, one atomic batch per group of sentences.

    A node names its anchors, and an edge its nodes, by a ref to the ids an
    earlier op of the batch creates (``batch.ref``). In three batches, a
    failure or a lost answer after the first left anchors with no node, which
    the editor's repair deleted on someone's next open, under their name.
    Now each sentence's graph goes whole in one batch, so a run that fails
    leaves every sentence with its old graph or its whole new one. The
    batches are as large as the server's body cap allows
    (:func:`~plaid_client.service.batch_body_budget`): the whole run in one
    request passed it on a long document.

    A plan for a sentence that already has a graph REPLACES it, row by row
    (:func:`_keep_stored`): what the plan gives as it is stored is left
    alone, a node or edge whose value changes is updated, and the anchors of
    a node the plan lacks are deleted first in the same batch, which cascades
    the node and every edge and document-level triple on it. So a plan for a
    sentence that is not :attr:`Sentence.redraftable` is refused before
    anything is written, whatever the caller decided.
    ``frag`` is the provenance stamp every write carries: it is FLAT and the
    app's own half sits beside it under ``umr``, exactly as the importer and
    the canvas write it. Each node's ``provDetail`` also records the concept
    and attributes it was drafted with, and each edge's its role.
    ``taken`` is every variable a new node may not take (``DraftRun.taken``).
    """
    progress = progress or DraftProgress(None)
    kept = [plan['sentence'].number for plan in plans
            if plan['sentence'].nodes and not plan['sentence'].redraftable]
    if kept:
        raise ValueError(f'Sentence {kept[0]} has work a draft may not replace.')
    units = [_keep_stored(plan, _sentence_writes(layers, plan, frag), taken) for plan in plans]
    units = [unit for unit in units if _writes_anything(unit)]
    if not units:
        return

    budget = batch_body_budget(client)
    groups: List[List[dict]] = []
    size = 0
    for unit in units:
        if groups and size + unit['bytes'] <= budget:
            groups[-1].append(unit)
            size += unit['bytes']
        else:
            groups.append([unit])
            size = unit['bytes']

    written = 0
    try:
        for group in groups:
            if len(groups) > 1:
                progress.report(DraftProgress.WRITE, written / len(units),
                                f'Writing sentences {written + 1} to {written + len(group)} '
                                f'of {len(units)}…')
            with client.batched() as b:
                _queue_sentences(b, group, progress, alone=len(groups) == 1)
            written += len(group)
    except Exception as error:
        if written:
            raise partly_written(written, len(units), 'drafted', error) from error
        raise


def draft_params() -> List[Param]:
    """The three parameters every drafting service takes: the scope, the
    sentence when the scope is one sentence, and whether to write over a
    machine-made graph."""
    return [
        Param.enum('scope', 'Scope',
                   [('document', 'The whole document'), ('sentence', 'One sentence')],
                   default='document',
                   description='Every sentence, or one sentence by its number.'),
        Param.number('sentence', 'Sentence', default=1, min=1,
                     description='Which sentence, when the scope is one sentence.'),
        Param.boolean('overwrite', 'Overwrite existing graphs', default=False,
                      description='Redraft machine-made graphs, including what a person '
                                  'deleted from them. Graphs a person built or confirmed '
                                  'are kept.'),
    ]


@dataclass
class DraftRun:
    """One drafting request, read: the document, the sentences to draft and
    the ones left alone, counted as the result reports them.

    ``taken`` is every variable a new node may not take. With ``overwrite`` on
    the graphs about to be replaced free theirs, so a redraft of sentence 1
    writes s1b again rather than s1b2.

    ``requester`` is who asked, named in the History label and in each
    stamp's ``provDetail`` (see :mod:`plaid_client.workflows.requester`).
    ``result`` is what :func:`finish_draft` reports, sent by :func:`drafting`
    once the document is let go."""
    document_id: str
    project_id: Optional[str]
    layers: UmrLayers
    document: UmrDocument
    progress: DraftProgress
    targets: List[Sentence]
    skipped: int
    kept: int
    linked: int
    taken: set
    requester: Requester = Requester()
    result: Optional[Dict[str, Any]] = None


@contextlib.contextmanager
def drafting(client, request_data: Dict[str, Any], response_helper):
    """A whole drafting run, held: the document lock is taken before the read
    the plans are made from and held through the last write (Luke's ruling
    R17, 2026-10-24: one rule for every service, so no edit can land while
    the model drafts, and no sentence has to be planned again). Yields the
    :class:`DraftRun` read under the lock, or None after reporting a missing
    document id. The body ends in :func:`finish_draft`, and the result it
    leaves on the run is sent once the document is free again::

        with drafting(client, request_data, response_helper) as run:
            if run is None:
                return
            ...
            finish_draft(client, response_helper, run, plans, failures, ...)
    """
    document_id = request_data.get('document_id')
    if not document_id:
        response_helper.error('Missing required parameter: documentId')
        yield None
        return
    with held_run(client, response_helper, document_id) as held:
        run = _begin_draft(client, request_data, response_helper)
        yield run
        held.result = run.result


def _begin_draft(client, request_data: Dict[str, Any], response_helper) -> DraftRun:
    """Read the document a drafting request names and choose its targets,
    under the lock :func:`drafting` holds.

    A sentence with words is a target when it has no graph, or when
    ``overwrite`` is on and its graph is :attr:`Sentence.redraftable`. A
    sentence a person built or confirmed is kept whatever ``overwrite`` says,
    and so is one that another sentence's block writes an edge or triple on
    (the machine-writer contract), as igt's analyzers redraft machine output
    only. With ``overwrite`` off the rest of the sentences with a graph are
    skipped: the ones an overwrite would redraft. A sentence number the
    document does not have is a ValueError."""
    document_id = request_data['document_id']
    # The parameters as BaseService coerced them against draft_params().
    scope, overwrite, wanted = request_data['scope'], request_data['overwrite'], int(request_data['sentence'])

    progress = DraftProgress(response_helper)
    progress.report(DraftProgress.READ, 0.0, 'Reading the document…')
    raw = client.documents.get(document_id, include_body=True)
    layers = resolve_layers(raw)
    document = read_document(raw, layers, gloss=gloss_values(raw, layers))

    in_scope = document.sentences
    if scope == 'sentence':
        in_scope = [s for s in in_scope if s.index == wanted]
        if not in_scope:
            raise ValueError(f'The document has no sentence {wanted}.')
    with_graph = [s for s in in_scope if s.words and s.nodes]
    targets = [s for s in in_scope
               if s.words and (not s.nodes or (overwrite and s.redraftable))]
    taken = document.taken_variables
    for s in targets:
        for node in s.nodes:
            taken.discard(node.var)
    return DraftRun(
        document_id=document_id, project_id=request_data.get('project_id'),
        layers=layers, document=document, progress=progress,
        targets=targets,
        skipped=0 if overwrite else len([s for s in with_graph if s.redraftable]),
        kept=len([s for s in with_graph if s.person_made]),
        linked=len([s for s in with_graph if not s.redraftable and not s.person_made]),
        taken=taken, requester=requester_of(client, request_data))


def finish_draft(client, response_helper, run: DraftRun, plans: Sequence[dict],
                 failures: List[dict], frag: dict,
                 operation: Union[str, Callable[[Sequence[dict]], str]], writing: str,
                 not_drafted: Sequence[int] = (), *, service_id: str) -> None:
    """Write ``plans`` and leave the run's result on ``run``, under the lock
    :func:`drafting` holds, which sends it.

    ``failures`` are ``{'sentence': n, 'reason': str}`` for the sentences the
    service could not plan, each also printed to the operator's log here.
    ``operation`` names the write in the history, or makes that name from the
    plans that are written (see :func:`run_label`), with the requester added
    here, as it is to ``frag``'s ``provDetail``. ``writing`` is the progress
    line while it runs. ``service_id`` is the drafting service's, which the
    operation names as a service run. The write cannot be stopped once begun:
    a stop while the document is half written would leave anchors with no
    nodes.

    A run that stopped before its last sentence (the model did not answer)
    names the sentences it never asked about in ``not_drafted``.

    The result is counts alone (the core manual, "Service results"): the app
    words what the person is told.
    """
    require_held(client, run.document_id)
    for failure in failures:
        print(f"Sentence {failure['sentence']} not drafted: {failure['reason']}")
    if not_drafted:
        print(f'Not asked: sentences {", ".join(str(n) for n in not_drafted)}')
    if plans:
        run.progress.report(DraftProgress.WRITE, 0.0, writing)
        if frag.get(PROV_KEY):
            frag = {**frag, PROV_DETAIL_KEY: run.requester.detail(frag.get(PROV_DETAIL_KEY))}
        with response_helper.critical():
            label = operation(plans) if callable(operation) else operation
            with client.operation(run.requester.label(label), kind='service-run',
                                  ref=service_source(service_id)):
                write_graphs(client, run.layers, plans, frag, run.progress, run.taken)
    run.result = {'document_id': run.document_id, 'status': 'success',
                  'sentences': len(run.document.sentences), 'drafted': len(plans),
                  'skipped': run.skipped, 'kept': run.kept,
                  'linked': run.linked, 'failed': len(failures),
                  'sentences_failed': list(failures),
                  'sentences_not_drafted': list(not_drafted)}
