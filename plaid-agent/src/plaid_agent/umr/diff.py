"""What applying a PENMAN text to a sentence would change.

The rule is plaid-umr's own (``UmrDocument.planPenman``), and it is a rule
rather than a merge: **nodes are matched by variable and edges by role and
target**, so renaming a variable is a new node and the old one goes, and
changing an edge's role is a new edge and the old one goes. Anything else
would have to guess which of two edits a rewritten graph meant.

The text is the ROOT's graph, so only what the root reaches is the text's to
delete: a second fragment the text never showed stays where it is.

The ops this returns are the plan's own, one per change, so the card the user
approves names each of them.
"""

from typing import Any, Dict, List, Tuple

from .penman import Graph, parse_penman
from .project import GNode, Sentence, UmrDoc, UmrProject, penman_of, reachable_from_root


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


def _umr_meta(node: GNode) -> dict:
    """A node's whole ``umr`` metadata object. A metadata patch replaces a
    namespace wholesale, so anything not restated would be dropped."""
    return dict(((node.metadata or {}).get('umr')) or {})


class GraphDiff:
    """The ops a PENMAN text stands for, and what they add up to."""

    def __init__(self, ops: List[Dict[str, Any]], errors: List[str]):
        self.ops = ops
        self.errors = errors

    @property
    def changes(self) -> int:
        return len(self.ops)


def plan_penman(doc: UmrDoc, sentence: Sentence, text: str, project: UmrProject) -> GraphDiff:
    """The plan ops that would make ``sentence``'s graph the one ``text``
    writes. ``errors`` is non-empty when the text does not parse, and the ops
    are then empty."""
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

        if old.concept != node.concept:
            updates.append({
                'kind': 'set_concept', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                'span_id': old.id, 'var': var, 'concept': node.concept,
                'label': f'{var}: {old.concept or "(no concept)"} becomes {node.concept}'})
        if _attr_key(old.attrs) != _attr_key(attrs):
            updates.append({
                'kind': 'set_attrs', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                'span_id': old.id, 'var': var, 'attrs': attrs,
                'umr_base': _umr_meta(old), 'umr_set': {'attrs': attrs},
                'label': (f'{var}: attributes {_attr_line(attrs)}' if attrs
                          else f'{var}: no attributes')})

        old_edges = [(e, f'{e.role} {doc.nodes_by_id[e.target].var}')
                     for e in old.out
                     if doc.nodes_by_id.get(e.target) is not None
                     and doc.nodes_by_id[e.target].sentence == sentence.index]
        next_by_key = {f'{e["role"]} {e["target"]}': e for e in edges}
        for edge, key in old_edges:
            wanted = next_by_key.get(key)
            if wanted is None:
                edges_delete.append({
                    'kind': 'delete_edge', 'document_id': did, 'ref': f's{sentence.index}.{var}',
                    'relation_id': edge.id, 'source': edge.source, 'target': edge.target,
                    'label': f'remove {var} {key}'})
            elif wanted['order'] != edge.order:
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
                    'target_var': e['target'], 'role': e['role'], 'order': e['order'],
                    'source_span_id': old.id,
                    'label': f'{var} {e["role"]} {e["target"]}'})

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
                    'umr_base': _umr_meta(node), 'umr_unset': ('root',),
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
                'umr_base': _umr_meta(new_root), 'umr_set': {'root': True},
                'label': f'{parsed.root} becomes the root of s{sentence.index}'})

    # Deletes first, so a variable a new node takes is free; then the marks
    # that must come off before another node wears one; then the rest.
    ops = deletes + edges_delete + root_ops + updates + creates + edges_add + orders
    for op in ops:
        op.setdefault('sentence', sentence.index)
        op.setdefault('sentence_id', sentence.id)
        op['graph_of'] = f'{did}:{sentence.index}'
    return GraphDiff(ops, [])


def _attr_line(attrs) -> str:
    return ' '.join(f'{a.get("rel")} {a.get("value")}' for a in attrs) or '(none)'


def round_trip(doc: UmrDoc, sentence: Sentence) -> str:
    """The sentence's own PENMAN. Re-applying it must plan nothing, which is
    the property every other diff rests on."""
    return penman_of(doc, sentence)
