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

from ..core import docload, fingerprint as fp, opkind
from ..core.args import sentence_number
from plaid_client import uuid7
from plaid_client.workflows.umr import (concept_problem,
                                        new_variable_problem, parse_attribute_line,
                                        relation_form_problem,
                                        unknown_doc_relation_problem,
                                        unknown_relation_problem, variable_form_problem,
                                        written_value_problem)
from plaid_client.workflows.umr.inventory import node_under_attribute_problem

from ..core.limits import OVERVIEW_DOCS, SAMPLE_LINES
from ..core.tools import ToolError, truncate
from ..core.workspace import BaseWorkspace
from .diff import plan_penman
from .plan import (GRAPH_KINDS, KIND, attr_line, attrs_scope_held, attrs_scope_targets, graphs_of_op, holds,
                   replacing_phrase, sentence_graph_key)
from .project import (DOC_CONSTANTS, GNode, GROUPS, Sentence, UmrDoc, UmrProject, attrs_change,
                      gloss_headers, group_of, load_document, node_ref, place_attributes,
                      numbering, render_document, render_document_graph, resolve)

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
    # A new node's anchor names the text, but at its sentence's own extent,
    # which the sentence's fingerprint holds: the node depends on its
    # sentence, not on the whole text.
    NOT_CONTENT_KEYS = ('text_id',)

    def render(self, doc, **kw) -> str:
        return render_document(doc, self.project, doc.gloss, **kw)

    def sentence_position(self, doc, item) -> Optional[int]:
        """``s5`` is the sentence the app shows as 5: in a document numbered
        by its file, the file's snt5, wherever it stands."""
        try:
            n = sentence_number(str(item).split('.')[0] if isinstance(item, str) else item, 'sentence')
        except ValueError:
            return None
        if n is None:
            return None
        s = doc.by_number(n)
        if s is not None:
            return s.index
        if all(s.number == s.index for s in doc.sentences):
            return None
        raise ValueError(f's{n}: {numbering(doc)}')

    def sentence_shown(self, doc, sentence) -> int:
        return sentence.number

    def sentence_print(self, doc, sentence) -> str:
        """The sentence's graph and words, and the gloss lines on its
        sentence, words and morphemes, which the model reads its graph from
        and another app writes. The document keeps those apart from the
        sentence, so they are added here."""
        ids = {sentence.id} | {w.id for w in sentence.words} | {m.id for m in sentence.morphemes}
        gloss = {layer: {t: v for t, v in values.items() if t in ids}
                 for layer, values in (doc.gloss or {}).items()}
        return fp.fingerprint({'sentence': sentence, 'gloss': gloss}, origin=sentence.begin)

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
        self.refuse_unwritable(op, replacing=replacing)
        self.refuse_unknown_relation(op)
        self.refuse_second_graph(op, replacing=replacing)

    def refuse_unwritable(self, op: Dict[str, Any], replacing: Optional[int] = None) -> None:
        """A concept, relation, variable or value the .umr file cannot hold,
        as every editor path in the app refuses it: stored anyway, the export
        refuses the document (ruled 2026-09-27).

        Asked here, where every staged op passes, for the same reason as
        :meth:`refuse_unknown_relation`. A value already stored under that
        relation on that node is kept, as the app keeps it, so an edit of a
        node's other attributes is not refused for one it did not write.

        A new node's variable is held to what the app asks of every new name
        (``UmrDocument._newVariableProblem``): the convention, its own
        sentence, not a document graph's ``s<n>s0``, and not in use in the
        document. Otherwise the assistant could plan a second document block
        or a new variable shared with another sentence, which the export lets
        through. A constant (``author``) belongs to no sentence and is not one.
        """
        kind = op.get('kind')
        doc = self._docs.get(op.get('document_id'))
        node = None
        if kind == 'set_attrs' and doc is not None:
            node = doc.nodes_by_id.get(op.get('span_id'))
        stored = {(a.get('rel'), a.get('value')) for a in (node.attrs if node else [])}
        problems = []
        if kind == 'create_node':
            problems += [variable_form_problem(op.get('var')), concept_problem(op.get('concept'))]
            if not op.get('constant') and doc is not None:
                problems.append(new_variable_problem(op.get('var'), doc.number_of(op.get('sentence')),
                                                     self._taken_variables(doc, replacing)))
        if kind == 'rename_node':
            # A new name for a stored node, held to what the app asks of one
            # (Text mode asks a rename `_newVariableProblem` too).
            problems.append(variable_form_problem(op.get('var')))
            if doc is not None:
                problems.append(new_variable_problem(op.get('var'), doc.number_of(op.get('sentence')),
                                                     self._taken_variables(doc, replacing)))
        if kind == 'set_concept':
            problems += [concept_problem(op.get('concept')),
                         self._concept_under_problem(op, doc, replacing)]
        if kind == 'create_edge':
            problems += [relation_form_problem(op.get('role')),
                         self._node_under_problem(op, doc, replacing)]
        if kind in ('create_node', 'set_attrs'):
            for a in op.get('attrs') or []:
                if (a.get('rel'), a.get('value')) in stored:
                    continue
                problems += [relation_form_problem(a.get('rel')),
                             written_value_problem(a.get('value'), a.get('rel'))]
        if kind == 'attrs_scope':
            problems.append(relation_form_problem(op.get('rel')))
            if op.get('value'):
                problems.append(written_value_problem(op.get('value'), op.get('rel')))
        why = next((p for p in problems if p), None)
        if why:
            var = op.get('var') or op.get('source_var')
            raise ToolError((f'{var}: ' if var else '') + why)

    def _node_under_problem(self, op: Dict[str, Any], doc: Optional[UmrDoc],
                            replacing: Optional[int] = None) -> Optional[str]:
        """Why the node a new edge points at cannot stand under its role, as
        Text mode refuses it (``node_under_attribute_problem``), or None. The
        source's concept is the one the plan gives it (a node it creates or a
        concept it sets) before the one stored."""
        source = op.get('source_var')
        concept = None
        for i, o in enumerate(self.ops + [op]):
            if i == replacing or o.get('document_id') != op.get('document_id'):
                continue
            if o.get('kind') in ('create_node', 'set_concept') and o.get('var') == source:
                concept = o.get('concept')
        if concept is None and doc is not None:
            node = doc.nodes_by_id.get(op.get('source_span_id'))
            concept = node.concept if node is not None else None
        return node_under_attribute_problem(op.get('role'), concept)

    def _concept_under_problem(self, op: Dict[str, Any], doc: Optional[UmrDoc],
                               replacing: Optional[int] = None) -> Optional[str]:
        """Why the concept ``op`` gives a stored node puts a node it points at
        under a relation that then takes a value only (a name's ``:opN``,
        ``:ARG2`` of have-polarity-91), or None, as the app's canvas and Text
        mode refuse it (``UmrDocument._newlyUnderProblem``). The node's stored
        edges the plan does not delete count, and one already in such a place
        under the stored concept (an import brought it) is kept. The new
        edges from it come after this op in the one Text-mode change a plan
        may make to a sentence, and :meth:`_node_under_problem` asks them of
        this concept."""
        node = doc.nodes_by_id.get(op.get('span_id')) if doc is not None else None
        if node is None:
            return None
        gone = set()
        for i, o in enumerate(self.ops):
            if i == replacing or o.get('document_id') != op.get('document_id'):
                continue
            if o.get('kind') == 'delete_edge':
                gone.add(o.get('relation_id'))
            elif o.get('kind') == 'delete_node':
                gone.update(o.get('relation_ids') or [])
        for e in node.out:
            if e.id in gone or node_under_attribute_problem(e.role, node.concept):
                continue
            why = node_under_attribute_problem(e.role, op.get('concept'))
            if why:
                return why
        return None

    def _taken_variables(self, doc: UmrDoc, replacing: Optional[int] = None) -> set:
        """Every variable the document holds once this plan is applied, as far
        as a new name is concerned: what is stored, less what the plan deletes
        (the batch deletes first), plus what the plan already creates or
        renames a node to. The op ``replacing`` names is not part of the plan
        any more."""
        taken = {n.var for n in doc.nodes_by_id.values() if n.var}
        ops = [o for i, o in enumerate(self.ops)
               if i != replacing and o.get('document_id') == doc.id]
        taken -= {o.get('var') for o in ops if o.get('kind') == 'delete_node'}
        taken |= {o.get('var') for o in ops if o.get('kind') in ('create_node', 'rename_node')}
        return taken

    def refuse_unknown_relation(self, op: Dict[str, Any]) -> None:
        """A relation UMR does not have, as the app refuses it on every editor
        path (``UmrDocument.relationProblem`` in plaid-umr).

        Asked here, where every staged op passes, rather than in the tools, so
        a new tool that writes a relation cannot route around it. What the op
        writes is judged where it lands, as the canvas and text mode judge it:
        a relation already stored among that node's attributes is kept (an
        imported file may carry one UMR does not have), and one stored only on
        another node or edge is not. A new edge and a new node hold nothing
        yet, so everything they bring is judged. A renamed node keeps its
        edges and attributes where they are, so a rename writes no relation.
        """
        kind = op.get('kind')
        if kind == 'create_triple':
            why = unknown_doc_relation_problem(op.get('group'), op.get('rel'))
            if why:
                raise ToolError(why)
            return
        doc = self._docs.get(op.get('document_id'))
        if kind == 'create_edge':
            written = [(op.get('role'), set())]
        elif kind == 'create_node':
            written = [(a.get('rel'), set()) for a in op.get('attrs') or []]
        elif kind == 'set_attrs':
            node = doc.nodes_by_id.get(op.get('span_id')) if doc is not None else None
            kept = {a.get('rel') for a in node.attrs} if node is not None else set()
            written = [(a.get('rel'), kept) for a in op.get('attrs') or []]
        elif kind == 'attrs_scope':
            # Kept only when every node the scope lands on already holds it.
            targets = list(attrs_scope_targets(doc, op)) if doc is not None else []
            holds = bool(targets) and all(
                any(a.get('rel') == op.get('rel') for a in node.attrs)
                for _s, node, _placed in targets)
            written = [(op.get('rel'), {op.get('rel')} if holds else set())]
        else:
            return
        for rel, kept in written:
            why = None if rel in kept else unknown_relation_problem(rel)
            if why:
                var = op.get('var') or op.get('source_var')
                where = f'{var}: ' if var else ''
                raise ToolError(where + why)

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
        ops = compact_ops(self.mark_replaced_work(copy.deepcopy(self.ops)),
                          opkind.compact_spec(KIND))
        return {'id': uuid7(), 'summary': summarize(self.ops),
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
    s = doc.by_number(n)
    if s is None:
        raise ToolError(f's{n}: {numbering(doc)}')
    return s


def _node(doc: UmrDoc, sentence: Sentence, var: str) -> GNode:
    node = sentence.node(var)
    if node is None:
        known = ', '.join(n.var for n in sentence.nodes[:20]) or 'none'
        raise ToolError(f'Sentence s{sentence.number} has no node "{var}". Its nodes: {known}')
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
        raise ToolError(f'This plan already replaces the graph of s{s.number} in "{doc.name}", and '
                        f'this change was worked out against the graph it replaces. Keep one of '
                        f'the two (plan_status, drop_planned), or plan them in separate turns.')


def t_apply_penman(ws: Workspace, document: str = None, sentence=None, text: str = None,
                   reorder: bool = False) -> str:
    doc = ws.doc(document)
    s = _sentence(ws, doc, sentence)
    _no_graph_planned(ws, doc, s)
    if not (text or '').strip():
        raise ToolError('Give text: the sentence graph in PENMAN, starting at its root node.')
    diff = plan_penman(doc, s, text, ws.project, reorder=str(reorder).strip().lower() == 'true')
    if diff.errors:
        if 'after the topmost closing bracket' in diff.errors[0]:
            # Copied whole from a read of a sentence holding several graphs.
            raise ToolError('The text holds more than one graph. apply_penman takes the root\'s graph '
                            'alone, the first one read_document prints, and leaves the parts after it '
                            'as they are: give that one only.')
        raise ToolError('The graph could not be read. ' + diff.errors[0])
    if diff.refused:
        raise ToolError(diff.refused)
    # The order the text writes children in is not applied without reorder.
    # Said, so a user who asked for a new order is not told it was done.
    kept = ''
    if diff.order_kept:
        kept = (f' The text writes the children of {", ".join(diff.order_kept)} in another order than '
                f'they are stored in, and that order was not applied: pass reorder=true only if the '
                f'user asked for it.')
    if not diff.ops:
        return f'Nothing to change: s{s.number} already holds that graph.' + kept
    ws.add_ops(_staged(diff.ops))
    counts: Dict[str, int] = {}
    for op in diff.ops:
        counts[op['kind']] = counts.get(op['kind'], 0) + 1
    what = ', '.join(f'{n} {k.replace("_", " ")}' for k, n in sorted(counts.items()))
    return (f'Planned {len(diff.ops)} change(s) to the graph of s{s.number} in "{doc.name}" '
            f'({what}).' + _removals(diff.ops) + kept)


def _removes(op: Dict[str, Any]) -> bool:
    """Whether a staged change takes something away: a node or a relation
    deleted, or an attribute a node's new line drops (``attrs_change`` says
    "removes :rel"). Asked of the change, not of its label's words, which
    hold concepts such as remove-01."""
    if op.get('kind') in ('delete_node', 'delete_edge'):
        return True
    return op.get('kind') == 'set_attrs' and 'removes :' in str(op.get('label'))


# How many of a plan's removals a tool result names before it counts the rest.
REMOVALS_SHOWN = 20


def _removals(ops: List[Dict[str, Any]]) -> str:
    """What the staged changes take away, in the card's own words: a node
    removed with the document-level relations it takes, a relation removed,
    an attribute a node's new line drops. The count of changes alone left the
    model telling the user it had added an attribute where the card said it
    removed another one."""
    gone = [str(op.get('label')) for op in ops if op.get('label') and _removes(op)]
    if not gone:
        return ''
    shown = gone[:REMOVALS_SHOWN]
    more = len(gone) - len(shown)
    return (' It removes: ' + '; '.join(shown)
            + (f'; and {more} more' if more else '') + '.')


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
    # The one key that changes, never the composed namespace: a second op on
    # this node in the same plan then cannot restore it as it was read (see
    # plan._apply_span_meta).
    ws.add_ops(_staged([{
        'kind': 'set_attrs', 'document_id': doc.id, 'ref': node_ref(s, node),
        'sentence': s.index, 'sentence_id': s.id, 'span_id': node.id, 'var': node.var,
        'attrs': placed, 'attr_line': attr_line(placed), 'umr_set': {'attrs': placed},
        'label': f'{node.var}: {attrs_change(node.attrs, placed)}'}]))
    # What changes, as the card says it, so a line that drops an attribute the
    # model did not write says so.
    return (f'Planned the attributes of {node.var} in s{s.number}: {shown} '
            f'({attrs_change(node.attrs, placed)}).')


def t_set_attribute_for_concept(ws: Workspace, document: str = None, concept: str = None,
                                rel: str = None, value: str = None, regex: bool = False,
                                whole: bool = False, case_sensitive: bool = False,
                                overwrite: bool = False) -> str:
    """One attribute over every node in a document whose concept matches.

    A node that already has the attribute is left alone unless ``overwrite``
    (ruling umr-assist-where-missing), and an overwrite names on the card what
    it replaces ("replacing process on 5"), so neither the model nor the
    approver can replace a value without seeing it."""
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
        'case_sensitive': bool(case_sensitive), 'overwrite': bool(overwrite)}
    # The count and the examples come from the same reader the resolver uses,
    # so the card counts what approval will stage. It is read again at
    # approval, against the document as it is then.
    targets = list(attrs_scope_targets(doc, op))
    what = f'{rel} {value}' if value else f'{rel} removed'
    # The nodes left alone because they already have the attribute, said to
    # the model so a request that meant to change them can be planned again.
    kept = [] if (overwrite or not value) else attrs_scope_held(doc, op)
    kept_note = ''
    if kept:
        kept_note = (f'{len(kept)} node(s) with that concept already have {rel} and are left as '
                     f'they are (' + ', '.join(f's{s.number}.{n.var} {" ".join(holds(n, rel))}'
                                               for s, n in kept[:SAMPLE_LINES])
                     + (', …' if len(kept) > SAMPLE_LINES else '')
                     + '). Pass overwrite=true only if the user asked to replace existing values.')
    if not targets:
        return (f'Nothing to change: no node in "{doc.name}" with a concept matching "{concept}" '
                f'would end up different ({what}).' + (f' {kept_note}' if kept_note else ''))
    replacing = replacing_phrase(targets, rel) if value else ''
    op['count'] = len(targets)
    op['label'] = (f'{what} on {len(targets)} node(s) with concept "{concept}" in "{doc.name}"'
                   + (f', replacing {replacing}' if replacing else ''))
    ws.add_ops(_staged([op]))
    out = [f'Planned {what} on {len(targets)} node(s) in "{doc.name}"'
           + (f', replacing {replacing}' if replacing else '') + ', read again when you approve it:']
    for s, node, _placed in targets[:SAMPLE_LINES]:
        was = ' '.join(holds(node, rel))
        out.append(f'  s{s.number}.{node.var}  ({node.concept}' + (f', was {was}' if was else '') + ')')
    if len(targets) > SAMPLE_LINES:
        out.append(f'  … and {len(targets) - SAMPLE_LINES} more')
    if kept_note:
        out.append(kept_note)
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


def _later_end(a: Optional[GNode], b: Optional[GNode]) -> Optional[GNode]:
    """The end of a triple in the LATER sentence, which is where the app writes
    a cross-sentence triple (in that sentence's block), so the card files it
    there too. A constant (no sentence) loses to any node."""
    ends = [n for n in (a, b) if n is not None]
    return max(ends, key=lambda n: n.sentence or 0) if ends else None


def t_add_triple(ws: Workspace, document: str = None, a: str = None, rel: str = None,
                 b: str = None, group: str = None, sentence=None) -> str:
    doc = ws.doc(document)
    rel = (rel or '').strip()
    if not rel.startswith(':'):
        raise ToolError('Give rel: a document-level relation, which starts with a colon '
                        '(:same-entity, :before, :full-affirmative).')
    group = (group or '').strip()
    if group and group not in GROUPS:
        raise ToolError(f'group must be one of {", ".join(GROUPS)}.')
    # Refused before either end is looked at, and with the group as the
    # model gave it: a relation in no group is not a "modal" one just because
    # group_of files the unknown there.
    why = unknown_doc_relation_problem(group or None, rel)
    if why:
        raise ToolError(why)
    group = group or group_of(rel)
    source = _end(ws, doc, a, 'source')
    target = _end(ws, doc, b, 'target')
    if source['var'] == target['var']:
        raise ToolError('A triple joins two different nodes.')
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
    # one whose block writes it is named, and its record lists it, in the
    # batch that makes it (plan.py). A sentence with no record gets one over
    # the sentence.
    if source.get('constant') and target.get('constant'):
        if not doc.sentences:
            raise ToolError(f'"{doc.name}" has no sentences to write the triple in.')
        s = _sentence(ws, doc, sentence) if sentence is not None else doc.sentences[0]
        op['record_id'] = s.record_token
        op['record_triples'] = list(s.record_triples)
        if not s.record_token:
            op['node_layer_id'] = ws.project.node_layer_id
            op['text_id'] = doc.text_id
            op['begin'], op['end'] = s.begin, s.end
        op['sentence'] = s.index
        op['sentence_id'] = s.id
        op['ref'] = f's{s.number}'
    else:
        anchor = _later_end(source['node'], target['node'])
        if anchor is not None and anchor.sentence:
            op['sentence'] = anchor.sentence
            op['sentence_id'] = doc.sentences[anchor.sentence - 1].id
            op['ref'] = f's{doc.number_of(anchor.sentence)}.{anchor.var}'
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
    anchor = _later_end(source['node'], target['node'])
    if anchor is not None and anchor.sentence:
        op['sentence'] = anchor.sentence
        op['sentence_id'] = doc.sentences[anchor.sentence - 1].id
        op['ref'] = f's{anchor.sentence}.{anchor.var}'
    ws.add_ops(_staged([op]))
    return (f'Planned removing ({source["var"]} {found.rel} {target["var"]}) from "{doc.name}".'
           )


# --- whose work a change replaces -----------------------------------------------
#
# What each kind rewrites or removes, for the card's "replace accepted work"
# line (core/work.py). A node's provenance sits on its concept span, an edge's
# and a triple's on the relation.

def _node_of(ws: Workspace, op: Dict[str, Any]) -> Optional[GNode]:
    doc = ws._docs.get(op.get('document_id'))
    return doc.nodes_by_id.get(op.get('span_id')) if doc is not None else None


def _replaced_attrs(ws: Workspace, op: Dict[str, Any]) -> List[str]:
    """A node's attributes are its work only where a value it held goes or
    changes: adding one beside them replaces nothing."""
    node = _node_of(ws, op)
    if node is None:
        return []
    kept = {(a.get('rel'), str(a.get('value'))) for a in op.get('attrs') or []}
    lost = [a for a in node.attrs if (a.get('rel'), str(a.get('value'))) not in kept]
    return [node.id] if lost else []


def _replaced_by_scope(ws: Workspace, op: Dict[str, Any]) -> List[str]:
    """The nodes a concept-wide change takes a value from: an overwrite's,
    or a removal's."""
    doc = ws._docs.get(op.get('document_id'))
    if doc is None:
        return []
    rel = op.get('rel') or ''
    return [node.id for _s, node, _placed in attrs_scope_targets(doc, op) if holds(node, rel)]


_NONE = None
REPLACES = {
    'set_concept': lambda ws, op: [op.get('span_id')],
    # A new name over the one a person gave the node.
    'rename_node': lambda ws, op: [op.get('span_id')],
    'unset_root': lambda ws, op: [op.get('span_id')],
    'delete_node': lambda ws, op: [op.get('span_id')] + list(op.get('relation_ids') or []),
    'set_attrs': _replaced_attrs,
    'delete_edge': lambda ws, op: [op.get('relation_id')],
    'set_edge_order': lambda ws, op: [op.get('relation_id')],
    'delete_triple': lambda ws, op: [op.get('relation_id')],
    'attrs_scope': _replaced_by_scope,
    # A root mark put on a node takes nothing: the node that loses it is the
    # plan's unset_root.
    'set_root': _NONE,
    'create_node': _NONE, 'create_edge': _NONE, 'create_triple': _NONE,
    # Prose: the card's Rewrite line says so already.
    'add_guideline': _NONE, 'revise_guideline': _NONE, 'rewrite_guideline': _NONE,
}
Workspace.REPLACES = REPLACES


__all__ = ['PLAN_NOTE', 'REPLACES', 'Workspace',
           't_add_triple', 't_apply_penman', 't_delete_triple', 't_document_graph',
           't_project_overview', 't_set_attribute_for_concept',
           't_set_attributes']
