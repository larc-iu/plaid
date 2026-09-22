"""The tools a UMR assistant may call, and the workspace they run against.

A tool returns TEXT for the model, never a structure: every failure is a
sentence it can read and recover from. A tool whose description starts with
``PLAN:`` proposes a change instead of making one, and what it proposes lands
on ``ws.ops`` for the user to approve.

Everything is addressed positionally (``s3``, ``s3.s3e``): see :mod:`.project`
for what a UMR project is shaped like and why the model never handles an id.
"""

import copy
import uuid
from typing import Any, Dict, List, Optional

from ..core import docload, opkind
from ..core.args import sentence_number
from plaid_client.workflows.umr import parse_attribute_line

from ..core.limits import OVERVIEW_DOCS, SAMPLE_LINES
from ..core.tools import ToolError, truncate
from ..core.workspace import BaseWorkspace
from .diff import plan_penman
from .plan import (GRAPH_KINDS, KIND, attrs_scope_targets, graphs_of_op, sentence_graph_key)
from .project import (DOC_CONSTANTS, GNode, GROUPS, Sentence, UmrDoc, UmrProject,
                      gloss_headers, group_of, load_document, node_ref, place_attributes,
                      render_document, render_document_graph, resolve)

# What counts as one change here, appended to the plan-is-full refusal.
PLAN_NOTE = ('Replacing a sentence graph counts as one change per node, relation and attribute '
             'set it touches.')

# Parsed documents, shared across turns and users of this process. See
# plaid_agent.core.docload for what the key covers and what it does not.
_DOC_CACHE = docload.DocCache()


class Workspace(BaseWorkspace):
    """One turn's view of a UMR project: what it has loaded and the plan it is
    proposing."""

    KIND = KIND
    PLAN_NOTE = PLAN_NOTE
    # No kind here sets one value on one token: a concept sits on a span over
    # an anchor token, so nothing reads a planned value back.
    SPAN_KIND = ''
    DOC_CACHE = _DOC_CACHE

    def render(self, doc, **kw) -> str:
        return render_document(doc, self.project, doc.gloss, **kw)

    def comment_anchor(self, doc: 'UmrDoc', ref: str) -> str:
        # A sentence's comments hang off its token, as in the other apps.
        try:
            thing = resolve(doc, ref)
        except ValueError as e:
            raise ToolError(str(e)) from None
        if not isinstance(thing, Sentence):
            raise ToolError(f'{ref} is not a sentence. A comment sits on a sentence or on '
                            f'the document.')
        return thing.id

    def __init__(self, client, project: UmrProject, on_progress=None):
        super().__init__(client, project, on_progress)

    def make_corpus(self):
        from .corpus import Corpus
        return Corpus(self)

    def load_doc(self, doc_id: str) -> UmrDoc:
        return load_document(self.client, self.project, doc_id)

    def doc(self, document: str) -> UmrDoc:
        did = self.resolve_document_id(document)
        if did not in self._docs:
            # Name it the way the user would: a corpus-wide tool passes an id,
            # and "Reading 019ed0b8-…" tells a watcher nothing.
            entry = next((d for d in self.documents() if d['id'] == did), {})
            self._docs[did] = self.reader.get(did, self._version_of(entry),
                                              entry.get('name') or document)
        return self._docs[did]

    # --- the plan ---------------------------------------------------------

    def guard_op(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        super().guard_op(op, replacing=replacing)
        self.refuse_second_graph(op, replacing=replacing)

    def refuse_second_graph(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """A graph replacement beside another change to that sentence's graph.

        Either one was worked out against a graph the other replaces, so its
        variables name different nodes and its ids may already be gone. BOTH
        ORDERS are refused: the attribute change after the replacement (which
        the tool refuses by name, in ``_no_graph_planned``) and the
        replacement after the attribute change, which used to stage happily
        and leave the two orders meaning different things.

        Refused as the plan is built, with ``validate_ops`` as the backstop.
        A document-level triple is not part of a sentence's graph and is left
        alone; the delete guard covers a triple on a node the graph removes.
        """
        graphs = graphs_of_op(op)
        if not graphs:
            return
        staging = op.get('staging')
        for i, prev in enumerate(self.ops):
            if i == replacing or prev.get('staging') == staging:
                continue
            if graphs_of_op(prev) & graphs:
                raise ToolError('This plan already replaces the graph of this sentence. Keep one '
                                'of the two (plan_status, drop_planned), or plan them in separate '
                                'turns.')
            if prev.get('kind') in GRAPH_KINDS and sentence_graph_key(prev) in graphs:
                raise ToolError(f'This plan already changes {self._where(prev)}, and that change '
                                f'was worked out against the graph this one replaces. Keep one of '
                                f'the two (plan_status, drop_planned), or plan them in separate '
                                f'turns.')

    def _where(self, op: Dict[str, Any]) -> str:
        """A planned change's sentence, as the user would name it."""
        doc = self._docs.get(op.get('document_id'))
        name = f' in "{doc.name}"' if doc is not None else ''
        return f's{op.get("sentence")}{name}'

    def plan_payload(self) -> Optional[Dict[str, Any]]:
        if not self.ops:
            return None
        from .changes import describe_changes
        from .plan import summarize
        from ..core.plan import compact_ops
        # A snapshot: the payload must not alias the live list, since it is
        # what the user approves later. Large groups of like ops are stored as
        # one (the summary still counts what they stand for).
        ops = compact_ops(copy.deepcopy(self.ops), opkind.compact_spec(KIND))
        return {'id': uuid.uuid4().hex, 'summary': summarize(self.ops),
                'labels': [op['label'] for op in ops], 'ops': ops,
                'changes': describe_changes(self, ops),
                'documents': self.touched_documents()}


# --- reading ------------------------------------------------------------------

def t_project_overview(ws: Workspace) -> str:
    p = ws.project
    out = [f'Project "{p.name}" (Uniform Meaning Representation)']
    if p.language:
        out.append(f'Language: {p.language}')
    out.append('')
    out.append('A sentence carries one graph, written in PENMAN. A node is a variable, a concept '
               'and any number of attributes; a relation joins two nodes. A node is addressed by '
               'its sentence and its variable: s3.s3e is the node s3e of sentence 3.')
    lines = gloss_headers(p)
    if lines:
        out.append('Gloss lines under each sentence: ' + ', '.join(lines) + '.')
    docs = ws.documents()
    out.append('')
    try:
        sizes = ws.corpus.sizes()
        out.append(f'Size: {len(docs)} documents, {sizes["sentences"]} sentences, '
                   f'{sizes["nodes"]} graph nodes, {sizes["relations"]} relations. search, '
                   f'find_nodes and frequency_list read the whole corpus at once; read_document '
                   f'reads one document a page at a time.')
        out.append('')
    except Exception:  # noqa: BLE001 - the overview is worth having without the size
        pass
    out.append(f'Documents ({len(docs)}):')
    for d in docs[:OVERVIEW_DOCS]:
        out.append(f'  "{d.get("name")}"')
    if len(docs) > OVERVIEW_DOCS:
        out.append(f'  ... and {len(docs) - OVERVIEW_DOCS} more (list_documents pages through them)')
    return '\n'.join(out)


def t_document_graph(ws: Workspace, document: str = None) -> str:
    return truncate(render_document_graph(ws.doc(document)))


# --- addressing helpers ---------------------------------------------------------

def _sentence(ws: Workspace, doc: UmrDoc, sentence) -> Sentence:
    n = sentence_number(str(sentence).split('.')[0] if isinstance(sentence, str) else sentence,
                        'sentence')
    if n is None:
        raise ToolError('Name a sentence, as a number or a reference like "s3".')
    if not 1 <= n <= len(doc.sentences):
        raise ToolError(f's{n}: document "{doc.name}" has {len(doc.sentences)} sentences')
    return doc.sentences[n - 1]


def _node(doc: UmrDoc, sentence: Sentence, var: str) -> GNode:
    node = sentence.node(var)
    if node is None:
        known = ', '.join(n.var for n in sentence.nodes[:20]) or 'none'
        raise ToolError(f'Sentence s{sentence.index} has no node "{var}". Its nodes: {known}')
    return node


# --- planning ------------------------------------------------------------------

def _staged(ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One tool call's ops, tagged with the call that made them, so a second
    call over the same sentence graph can be told apart from this one's."""
    staging = uuid.uuid4().hex
    for op in ops:
        op['staging'] = staging
    return ops


def _no_graph_planned(ws: Workspace, doc: UmrDoc, s: Sentence) -> None:
    """A second change to a sentence whose graph this plan already replaces.

    The second was worked out against the graph the first replaces, so its
    variables name different nodes and its ids may already be gone. Refused
    here, where the tool can name the sentence; ``Workspace.refuse_second_graph``
    and ``validate_ops`` are the backstops.
    """
    key = f'{doc.id}:{s.index}'
    if any(op.get('graph_of') == key for op in ws.ops):
        raise ToolError(f'This plan already replaces the graph of s{s.index} in "{doc.name}", and '
                        f'this change was worked out against the graph it replaces. Keep one of '
                        f'the two (plan_status, drop_planned), or plan them in separate turns.')


def t_apply_penman(ws: Workspace, document: str = None, sentence=None, text: str = None) -> str:
    doc = ws.doc(document)
    s = _sentence(ws, doc, sentence)
    _no_graph_planned(ws, doc, s)
    if not (text or '').strip():
        raise ToolError('Give text: the sentence graph in PENMAN, starting at its root node.')
    diff = plan_penman(doc, s, text, ws.project)
    if diff.errors:
        raise ToolError('The graph could not be read. ' + diff.errors[0])
    if not diff.ops:
        return f'Nothing to change: s{s.index} already holds that graph.'
    ws.add_ops(_staged(diff.ops))
    counts: Dict[str, int] = {}
    for op in diff.ops:
        counts[op['kind']] = counts.get(op['kind'], 0) + 1
    what = ', '.join(f'{n} {k.replace("_", " ")}' for k, n in sorted(counts.items()))
    return (f'Planned {len(diff.ops)} change(s) to the graph of s{s.index} in "{doc.name}" '
            f'({what}).')


def t_set_attributes(ws: Workspace, document: str = None, sentence=None, var: str = None,
                     line: str = None) -> str:
    doc = ws.doc(document)
    s = _sentence(ws, doc, sentence)
    _no_graph_planned(ws, doc, s)
    node = _node(doc, s, (var or '').strip())
    attrs, problems = parse_attribute_line(line or '')
    if problems:
        raise ToolError('The attribute line could not be read. ' + problems[0])
    placed = place_attributes(node, attrs)
    if [(a.get('rel'), a.get('value')) for a in node.attrs] == [(a['rel'], a['value']) for a in placed]:
        return f'Nothing to change: {node.var} already has those attributes.'
    shown = ' '.join(f'{a["rel"]} {a["value"]}' for a in placed) or '(none)'
    # The DELTA over the namespace as it was read, never the composed object:
    # the applier composes it, so a second op on this node in the same plan
    # builds on this one rather than restoring the node as it was read
    # (see plan._apply_span_meta).
    ws.add_ops(_staged([{
        'kind': 'set_attrs', 'document_id': doc.id, 'ref': node_ref(s, node),
        'sentence': s.index, 'sentence_id': s.id, 'span_id': node.id, 'var': node.var,
        'attrs': placed, 'umr_base': dict(((node.metadata or {}).get('umr')) or {}),
        'umr_set': {'attrs': placed}, 'label': f'{node.var}: attributes {shown}'}]))
    return f'Planned the attributes of {node.var} in s{s.index}: {shown}.'


def t_set_attribute_for_concept(ws: Workspace, document: str = None, concept: str = None,
                                rel: str = None, value: str = None, regex: bool = False,
                                whole: bool = False, case_sensitive: bool = False) -> str:
    """One attribute over every node in a document whose concept matches."""
    doc = ws.doc(document)
    concept = (concept or '').strip()
    if not concept:
        raise ToolError('Give concept: which nodes to change, e.g. "say-01".')
    rel = (rel or '').strip()
    if not rel.startswith(':'):
        raise ToolError('Give rel: an attribute, which starts with a colon (:aspect, '
                        ':refer-number, :polarity).')
    value = (value or '').strip()
    op: Dict[str, Any] = {
        'kind': 'attrs_scope', 'document_id': doc.id, 'concept': concept, 'rel': rel,
        'value': value, 'regex': bool(regex), 'whole': bool(whole),
        'case_sensitive': bool(case_sensitive)}
    # The count and the examples come from the same reader the resolver uses,
    # so the card counts what approval will stage. It is read again at
    # approval, against the document as it is then.
    targets = list(attrs_scope_targets(doc, op))
    what = f'{rel} {value}' if value else f'{rel} removed'
    if not targets:
        return (f'Nothing to change: no node in "{doc.name}" with a concept matching "{concept}" '
                f'would end up different ({what}).')
    op['count'] = len(targets)
    op['label'] = f'{what} on {len(targets)} node(s) with concept "{concept}" in "{doc.name}"'
    ws.add_ops(_staged([op]))
    out = [f'Planned {what} on {len(targets)} node(s) in "{doc.name}", read again when you '
           f'approve it:']
    for s, node, _placed in targets[:SAMPLE_LINES]:
        out.append(f'  s{s.index}.{node.var}  ({node.concept})')
    if len(targets) > SAMPLE_LINES:
        out.append(f'  … and {len(targets) - SAMPLE_LINES} more')
    return '\n'.join(out)


def _end(ws: Workspace, doc: UmrDoc, name: str, side: str) -> Dict[str, Any]:
    """One end of a document-level triple: a node named by its variable, or one
    of the constants the format allows. A constant with no node yet is made."""
    name = (name or '').strip()
    if not name:
        raise ToolError(f'Name the {side} of the triple: a node variable, or one of the '
                        f'constants ' + ', '.join(DOC_CONSTANTS) + '.')
    node = doc.node_named(name)
    constant = name in DOC_CONSTANTS
    if node is not None:
        # A constant stays a constant once some triple has made its node: it
        # still belongs to no sentence, so a triple between two of them still
        # has to say whose block writes it.
        return {'var': name, 'span_id': node.id, 'node': node, 'constant': constant}
    if constant:
        return {'var': name, 'span_id': None, 'node': None, 'constant': True}
    raise ToolError(f'No node "{name}" in "{doc.name}", and it is not one of the constants '
                    + ', '.join(DOC_CONSTANTS) + '.')


def t_add_triple(ws: Workspace, document: str = None, a: str = None, rel: str = None,
                 b: str = None, group: str = None, sentence=None) -> str:
    doc = ws.doc(document)
    rel = (rel or '').strip()
    if not rel.startswith(':'):
        raise ToolError('Give rel: a document-level relation, which starts with a colon '
                        '(:same-entity, :before, :full-affirmative).')
    source = _end(ws, doc, a, 'source')
    target = _end(ws, doc, b, 'target')
    if source['var'] == target['var']:
        raise ToolError('A triple joins two different nodes.')
    group = (group or '').strip() or group_of(rel)
    if group not in GROUPS:
        raise ToolError(f'group must be one of {", ".join(GROUPS)}.')
    existing = source['node']
    if existing is not None and target['node'] is not None:
        for t in existing.doc_out:
            if t.target == target['node'].id and t.rel == rel:
                return (f'Nothing to change: ({source["var"]} {rel} {target["var"]}) is already '
                        f'in the document graph.')

    staged: List[Dict[str, Any]] = []
    for end in (source, target):
        if end.get('constant') and not end['span_id']:
            staged.append({
                'kind': 'create_node', 'document_id': doc.id, 'var': end['var'],
                'concept': end['var'], 'attrs': [], 'constant': True,
                'node_layer_id': ws.project.node_layer_id,
                'concept_layer_id': ws.project.concept_layer_id,
                # A constant belongs to no sentence, so its anchor is a point
                # at the text's start, which is where the editor puts one.
                'text_id': doc.text_id, 'begin': 0, 'end': 0,
                'label': f'add the constant {end["var"]}'})
    op: Dict[str, Any] = {
        'kind': 'create_triple', 'document_id': doc.id,
        'document_graph_layer_id': ws.project.document_graph_layer_id,
        'source_var': source['var'], 'target_var': target['var'], 'rel': rel, 'group': group,
        'label': f'({source["var"]} {rel} {target["var"]})'}
    if source['span_id']:
        op['source_span_id'] = source['span_id']
    if target['span_id']:
        op['target_span_id'] = target['span_id']
    # A triple between two constants belongs to no sentence by itself, so the
    # one whose block writes it is named.
    if source.get('constant') and target.get('constant'):
        s = _sentence(ws, doc, sentence) if sentence is not None else doc.sentences[0]
        op['sentences'] = [s.index]
        op['sentence'] = s.index
        op['sentence_id'] = s.id
        op['ref'] = f's{s.index}'
    else:
        anchor = source['node'] or target['node']
        if anchor is not None and anchor.sentence:
            op['sentence'] = anchor.sentence
            op['sentence_id'] = doc.sentences[anchor.sentence - 1].id
            op['ref'] = f's{anchor.sentence}.{anchor.var}'
    staged.append(op)
    ws.add_ops(_staged(staged))
    return (f'Planned the document-level relation ({source["var"]} {rel} {target["var"]}) '
            f'[{group}] in "{doc.name}".')


def t_delete_triple(ws: Workspace, document: str = None, a: str = None, rel: str = None,
                    b: str = None) -> str:
    doc = ws.doc(document)
    rel = (rel or '').strip()
    source = _end(ws, doc, a, 'source')
    target = _end(ws, doc, b, 'target')
    if source['node'] is None or target['node'] is None:
        raise ToolError('Both ends of the triple have to exist. document_graph lists what is there.')
    found = next((t for t in source['node'].doc_out
                  if t.target == target['node'].id and (not rel or t.rel == rel)), None)
    if found is None:
        raise ToolError(f'No triple ({source["var"]} {rel or "…"} {target["var"]}) in '
                        f'"{doc.name}". document_graph lists what is there.')
    op: Dict[str, Any] = {
        'kind': 'delete_triple', 'document_id': doc.id, 'relation_id': found.id,
        'label': f'remove ({source["var"]} {found.rel} {target["var"]})'}
    anchor = source['node'] if source['node'].sentence else target['node']
    if anchor.sentence:
        op['sentence'] = anchor.sentence
        op['sentence_id'] = doc.sentences[anchor.sentence - 1].id
        op['ref'] = f's{anchor.sentence}.{anchor.var}'
    ws.add_ops(_staged([op]))
    return (f'Planned removing ({source["var"]} {found.rel} {target["var"]}) from "{doc.name}".'
           )


__all__ = ['PLAN_NOTE', 'Workspace',
           't_add_triple', 't_apply_penman', 't_delete_triple', 't_document_graph',
           't_project_overview', 't_set_attribute_for_concept',
           't_set_attributes']
