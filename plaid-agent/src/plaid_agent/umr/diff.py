"""What applying a PENMAN text to a sentence would change.

The rule is plaid-umr's own (``UmrDocument.planPenman``), and it is a rule
rather than a merge: **nodes are matched by variable and edges by role and
target**, so renaming a variable is a new node and the old one goes, and
changing an edge's role is a new edge and the old one goes. Anything else
would have to guess which of two edits a rewritten graph meant.

The text is the ROOT's graph, so only what the root reaches is the text's to
delete: a second fragment the text never showed stays where it is.

One variable typed over, where text mode would read a rename
(``UmrDocument._renameIn``), is still planned as a delete and a create here,
but the create and the edges it re-creates carry what they stand for
(``renamed_from``, ``renamed_edge``), so the relations the old node and its
edges already hold are kept as text mode keeps them.

The ops this returns are the plan's own, one per change, so the card the user
approves names each of them.

**Child order is not the text's to change unless asked** (``reorder``). The
order a node's children are written in is kept for export only (the canvas
draws by anchor order), and a model re-serializing a graph writes roles in
whatever order it likes. So by default a child already there keeps its place,
and a new one, attribute or relation, goes after everything, which is the rule
the editor writes by (``place_attributes``). Applying the text's positions
instead staged "s2e: :actor s2h moves to position 2" rows that nobody asked
for, most of them only because a sibling before them came or went. With
``reorder`` the text's order is applied as written, and a relation whose place
changes is a row of its own.
"""

from typing import Any, Dict, List, Optional, Tuple

from plaid_client.workflows.umr import Graph, cycle_edges, parse_penman
from plaid_client.workflows.umr.graph import next_order

from .project import Sentence, UmrDoc, UmrProject, attrs_change, penman_of, reachable_from_root


def _children(node) -> Tuple[List[dict], List[dict]]:
    """A parsed node's children split into attributes and edges, each keeping
    its place among the node's children (the order a write stores)."""
    attrs: List[dict] = []
    edges: List[dict] = []
    for order, child in enumerate(node.children):
        if child.kind == 'node':
            edges.append({'role': child.rel, 'target': child.value, 'order': order})
        else:
            attrs.append({'rel': child.rel, 'value': child.value, 'order': order})
    return attrs, edges


def _attr_key(attrs) -> str:
    return '\n'.join(f'{a.get("rel")} {a.get("value")}' for a in attrs)


def _placed_key(attrs) -> list:
    """Attributes with their places, in place order, for comparing two sets."""
    return sorted((a.get('order') or 0, str(a.get('rel')), str(a.get('value'))) for a in attrs)


def _keep_places(old, node, old_edge_order: Dict[str, int],
                 freed: Dict[str, List[int]]) -> Tuple[List[dict], Dict[str, int]]:
    """``node``'s attributes, and the order of each relation it adds, when the
    children ``old`` already has keep their places and new ones go after them
    all, in the order the text writes them. An attribute keeps its place when
    ``old`` has one of that relation (its value may change), as the editor
    places them. A relation to a child whose old relation the text drops
    (``freed``, by the child's variable) is a role change and takes that
    relation's place, as a relabel on the canvas does."""
    freed = {var: list(orders) for var, orders in freed.items()}
    free = [(a.get('rel'), a.get('order') or 0) for a in old.attrs]
    tail = next_order(old)
    attrs: List[dict] = []
    new_edges: Dict[str, int] = {}
    for child in node.children:
        if child.kind == 'node':
            key = f'{child.rel} {child.value}'
            if key not in old_edge_order and key not in new_edges:
                if freed.get(child.value):
                    new_edges[key] = freed[child.value].pop(0)
                else:
                    new_edges[key] = tail
                    tail += 1
            continue
        at = next((i for i, (rel, _o) in enumerate(free) if rel == child.rel), None)
        if at is None:
            order = tail
            tail += 1
        else:
            order = free.pop(at)[1]
        attrs.append({'rel': child.rel, 'value': child.value, 'order': order})
    return sorted(attrs, key=lambda a: a['order']), new_edges


def _order_differs(old, node, old_edge_order: Dict[str, int]) -> bool:
    """Whether the text writes the children ``old`` already has in another
    order than they are stored in. Only children on both sides count, so a
    child added or removed moves nothing here."""
    stored_attrs = sorted((a.get('order') or 0, a.get('rel')) for a in old.attrs)
    stored = sorted([(o, 'edge ' + key) for key, o in old_edge_order.items()]
                    + [(o, 'attr ' + str(rel)) for o, rel in stored_attrs])
    written = []
    for child in node.children:
        written.append(('edge ' if child.kind == 'node' else 'attr ') + (
            f'{child.rel} {child.value}' if child.kind == 'node' else str(child.rel)))
    both = set(written) & {k for _o, k in stored}
    return [k for k in written if k in both] != [k for _o, k in stored if k in both]


class GraphDiff:
    """The ops a PENMAN text stands for, and what they add up to.
    ``order_kept`` names the nodes whose children the text writes in another
    order than they are stored in, when that order was not applied (no
    ``reorder``), so the tool can say so rather than let it pass unnoticed."""

    def __init__(self, ops: List[Dict[str, Any]], errors: List[str], order_kept: List[str] = None,
                 refused: Optional[str] = None):
        self.ops = ops
        self.errors = errors
        self.order_kept = order_kept or []
        #: Why a text that reads is refused all the same (a new edge that
        #: would close a cycle), with no ops.
        self.refused = refused

    @property
    def changes(self) -> int:
        return len(self.ops)


#: A parent that is the node itself, in `_rename_in`'s parent sets. No
#: variable holds a bracket.
_SELF = '(self)'


def _rename_in(doc: UmrDoc, sentence: Sentence, parsed: Graph, written) -> Tuple[Any, str]:
    """The one node the text renames and its new variable, or ``(None, '')``.
    plaid-umr's ``UmrDocument._renameIn``: exactly one variable goes and one
    arrives, with the same concept, under the same parents by the same
    relations, or both the sentence's root."""
    gone = [n for n in sentence.nodes if n.id in written and n.var not in parsed.nodes]
    olds = {n.var for n in sentence.nodes}
    fresh = [v for v in parsed.nodes if v not in olds]
    if len(gone) != 1 or len(fresh) != 1:
        return None, ''
    node, to = gone[0], fresh[0]
    if parsed.nodes[to].concept != node.concept:
        return None, ''
    # A node that is its own parent (a `:quote` edge to itself) is written
    # under its own name on both sides, old and new, so it stands as one
    # placeholder that the rename does not change.
    old_parents = set()
    for e in node.into:
        source = doc.nodes_by_id.get(e.source)
        if source is not None and source.sentence == sentence.index:
            old_parents.add(f'{e.role} {_SELF if e.source == node.id else source.var}')
    new_parents = {f'{child.rel} {_SELF if v == to else v}'
                   for v, parent in parsed.nodes.items()
                   for child in parent.children if child.kind == 'node' and child.value == to}
    if old_parents != new_parents:
        return None, ''
    # A parentless node is the root or nothing: renaming the root is a
    # rename, renaming a loose fragment's head is a guess. An edge to itself
    # makes no node a parent.
    parents = [k for k in old_parents if not k.endswith(f' {_SELF}')]
    if not parents and not (node.root and parsed.root == to):
        return None, ''
    return node, to


def plan_penman(doc: UmrDoc, sentence: Sentence, text: str, project: UmrProject,
                reorder: bool = False) -> GraphDiff:
    """The plan ops that would make ``sentence``'s graph the one ``text``
    writes. ``errors`` is non-empty when the text does not parse, and the ops
    are then empty. ``reorder`` applies the order the text writes each node's
    children in; without it, children already there keep their places."""
    parsed: Graph = parse_penman(text)
    if parsed.errors:
        return GraphDiff([], [f'line {e.line}, column {e.col}: {e.message}' for e in parsed.errors])
    if not parsed.root:
        return GraphDiff([], ['The text has no graph.'])

    did = doc.id
    old_by_var = {n.var: n for n in sentence.nodes}
    new_vars = set(parsed.nodes)

    creates: List[Dict[str, Any]] = []
    updates: List[Dict[str, Any]] = []
    edges_add: List[Dict[str, Any]] = []
    edges_delete: List[Dict[str, Any]] = []
    orders: List[Dict[str, Any]] = []
    order_kept: List[str] = []

    for var, node in parsed.nodes.items():
        attrs, edges = _children(node)
        old = old_by_var.get(var)
        if old is None:
            creates.append({
                'kind': 'create_node', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                'var': var, 'concept': node.concept, 'attrs': attrs,
                'node_layer_id': project.node_layer_id, 'concept_layer_id': project.concept_layer_id,
                'text_id': doc.text_id, 'sentence_id': sentence.id,
                # Aligned to no word, so the anchor stands over the whole
                # sentence (the app's rule since c6313696).
                'begin': sentence.begin, 'end': sentence.end,
                'label': f'add ({var} / {node.concept})'})
            for e in edges:
                edges_add.append({
                    'kind': 'create_edge', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                    'relation_layer_id': project.relation_layer_id, 'source_var': var,
                    'target_var': e['target'], 'role': e['role'], 'order': e['order'],
                    'label': f'{var} {e["role"]} {e["target"]}'})
            continue

        old_edges = [(e, f'{e.role} {doc.nodes_by_id[e.target].var}')
                     for e in old.out
                     if doc.nodes_by_id.get(e.target) is not None
                     and doc.nodes_by_id[e.target].sentence == sentence.index]
        next_by_key = {f'{e["role"]} {e["target"]}': e for e in edges}
        # The children whose relation the text drops, by variable: one the
        # text relates again by another role keeps its place.
        freed: Dict[str, List[int]] = {}
        for edge, key in old_edges:
            if key not in next_by_key:
                freed.setdefault(doc.nodes_by_id[edge.target].var, []).append(edge.order or 0)
        if reorder:
            changed_attrs = _attr_key(old.attrs) != _attr_key(attrs) or \
                _placed_key(old.attrs) != _placed_key(attrs)
            new_edge_order = {f'{e["role"]} {e["target"]}': e['order'] for e in edges}
        else:
            stored_order = {key: e.order for e, key in old_edges}
            attrs, new_edge_order = _keep_places(old, node, stored_order, freed)
            changed_attrs = _placed_key(old.attrs) != _placed_key(attrs)
            if _order_differs(old, node, stored_order):
                order_kept.append(var)

        if old.concept != node.concept:
            updates.append({
                'kind': 'set_concept', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                'span_id': old.id, 'var': var, 'concept': node.concept,
                'label': f'{var}: {old.concept or "(no concept)"} becomes {node.concept}'})
        if changed_attrs:
            updates.append({
                'kind': 'set_attrs', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                'span_id': old.id, 'var': var, 'attrs': attrs,
                'umr_set': {'attrs': attrs},
                'label': f'{var}: {attrs_change(old.attrs, attrs)}'})

        for edge, key in old_edges:
            wanted = next_by_key.get(key)
            if wanted is None:
                edges_delete.append({
                    'kind': 'delete_edge', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                    'relation_id': edge.id, 'source': edge.source, 'target': edge.target,
                    'label': f'remove {var} {key}'})
            elif reorder and wanted['order'] != edge.order:
                orders.append({
                    'kind': 'set_edge_order', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                    'relation_id': edge.id, 'order': wanted['order'],
                    'label': f'{var}: {key} moves to position {wanted["order"] + 1}'})
        old_keys = {key for _e, key in old_edges}
        for e in edges:
            if f'{e["role"]} {e["target"]}' not in old_keys:
                edges_add.append({
                    'kind': 'create_edge', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                    'relation_layer_id': project.relation_layer_id, 'source_var': var,
                    'target_var': e['target'], 'role': e['role'],
                    'order': new_edge_order[f'{e["role"]} {e["target"]}'],
                    'source_span_id': old.id,
                    'label': f'{var} {e["role"]} {e["target"]}'})

    renamed, renamed_to = _rename_in(doc, sentence, parsed, reachable_from_root(doc, sentence))
    if renamed is not None:
        name_of = {n.id: (renamed_to if n.id == renamed.id else n.var) for n in sentence.nodes}
        for op in creates:
            if op['var'] == renamed_to:
                op['renamed_from'] = renamed.id
        stored_edges = {(name_of.get(e.source), e.role, name_of.get(e.target)): e
                        for n in sentence.nodes for e in n.out}
        for op in edges_add:
            was = stored_edges.get((op['source_var'], op['role'], op['target_var']))
            if was is not None:
                op['renamed_edge'] = was.id
                # The same relation re-made for the rename: from a node that
                # stays, it keeps its place rather than going after the rest.
                if not reorder and op['source_var'] in old_by_var:
                    op['order'] = was.order

    # The ends of a new edge, where both are nodes that already exist. A var
    # the plan is creating is left to the executor, which knows the span id
    # only once the batch that mints it has landed.
    for op in edges_add:
        for side in ('source', 'target'):
            known = old_by_var.get(op[f'{side}_var'])
            if known is not None:
                op[f'{side}_span_id'] = known.id

    written = reachable_from_root(doc, sentence)
    deletes: List[Dict[str, Any]] = []
    gone_ids = set()
    for node in sentence.nodes:
        if node.id in written and node.var not in new_vars:
            gone_ids.add(node.id)
            # The server's cascade: deleting the anchor tokens takes the
            # concept span, every edge on it and every document-level triple
            # on it. Declared, so a change to one of them elsewhere in the
            # plan is refused rather than failing the approved batch, and
            # counted on the row, because a coreference chain is a loss the
            # user cannot see from "remove (s1d / dog)".
            triples = [t.id for t in node.doc_out] + [t.id for t in node.doc_in]
            edges = [e.id for e in node.out] + [e.id for e in node.into]
            label = f'remove ({node.var} / {node.concept})'
            if triples:
                label += (f' and {len(triples)} document-level relation'
                          + ('s' if len(triples) > 1 else ''))
            deletes.append({
                'kind': 'delete_node', 'document_id': did, 'ref': f's{sentence.index}.{node.var}',
                'span_id': node.id, 'var': node.var,
                'token_ids': [p.id for p in node.pieces],
                'relation_ids': sorted(set(edges + triples)),
                'label': label})
    # An edge into or out of a deleted node goes with it (the server's
    # cascade), and a second delete would be a 404.
    edges_delete = [op for op in edges_delete
                    if op['source'] not in gone_ids and op['target'] not in gone_ids]

    root_ops: List[Dict[str, Any]] = []
    old_root = sentence.roots[0].var if sentence.roots else None
    if parsed.root != old_root:
        for node in sentence.nodes:
            if node.root and node.var != parsed.root and node.id not in gone_ids:
                root_ops.append({
                    'kind': 'unset_root', 'document_id': did,
                    'ref': f's{sentence.index}.{node.var}', 'span_id': node.id,
                    'umr_unset': ('root',),
                    'label': f'{node.var} is no longer the root'})
        new_root = old_by_var.get(parsed.root)
        if new_root is None:
            for op in creates:
                if op['var'] == parsed.root:
                    op['root'] = True
                    op['label'] += ' as the root'
        else:
            root_ops.append({
                'kind': 'set_root', 'document_id': did,
                'ref': f's{sentence.index}.{parsed.root}', 'span_id': new_root.id,
                'umr_set': {'root': True},
                'label': f'{parsed.root} becomes the root of s{sentence.index}'})

    # A new edge that would close a cycle UMR does not allow is refused, as
    # Text mode refuses it (the app's rule, `cycle_edges`). One the graph
    # already held stays: an imported file may bring such a cycle.
    closing = set(cycle_edges(parsed))
    for op in edges_add:
        edge = (op['source_var'], op['role'], op['target_var'])
        if edge in closing and op.get('renamed_edge') is None:
            return GraphDiff([], [], refused=f'{edge[1]} from {edge[0]} to {edge[2]} would '
                                             f'close a cycle.')

    # Deletes first, so a variable a new node takes is free; then the marks
    # that must come off before another node wears one; then the rest.
    ops = deletes + edges_delete + root_ops + updates + creates + edges_add + orders
    for op in ops:
        op.setdefault('sentence', sentence.index)
        op.setdefault('sentence_id', sentence.id)
        op['graph_of'] = f'{did}:{sentence.index}'
    return GraphDiff(ops, [], order_kept)


def round_trip(doc: UmrDoc, sentence: Sentence) -> str:
    """The sentence's own PENMAN. Re-applying it must plan nothing, which is
    the property every other diff rests on."""
    return penman_of(doc, sentence)
