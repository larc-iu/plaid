"""The workspace a UMR assistant's tools run against: what one turn has
loaded and the plan it is building, with the refusals only this app owes
when something is staged (:mod:`.tools` holds the tools).
"""

from typing import Any, Dict, List, Optional

from plaid_client.workflows.umr import (concept_problem, new_variable_problem, relation_form_problem,
                                        unknown_doc_relation_problem, unknown_relation_problem,
                                        variable_form_problem, written_value_problem)
from plaid_client.workflows.umr.inventory import (ATTRIBUTE_VALUES, attribute_value_problem,
                                                  node_under_attribute_problem)

from ..core import docload, fingerprint as fp
from ..core.args import sentence_number
from ..core.bidi import plain_quote
from ..core.tools import ToolError, ValueRefusal, kind_of
from ..core.workspace import BaseWorkspace
from .plan import GRAPH_KINDS, KIND, attrs_scope_targets, graphs_of_op, holds, sentence_graph_key
from .project import Sentence, UmrDoc, load_document, numbering, render_document, resolve

# What counts as one change here, appended to the plan-is-full refusal.
PLAN_NOTE = ('Replacing a sentence graph counts as one change per node, relation and attribute '
             'set it touches.')

# Parsed documents, shared across turns and users of this process. See
# plaid_agent.core.docload for what the key covers and what it does not.
_DOC_CACHE = docload.DocCache()


def _closed_value_problem(rel, value) -> Optional[str]:
    """Why a NEW value of an attribute with a closed set of values (:aspect,
    :modal-strength, :refer-person, :refer-number) is not one of them, or
    None. An approved plan is confirmed work, so it writes listed values only,
    as ud's tools do. A model wrote :modal-strength "full-affirmative", quoted,
    on 33 nodes, and the plan was applied."""
    rel = str(rel or '').strip()
    if rel not in ATTRIBUTE_VALUES:
        return None
    return attribute_value_problem(rel, value)


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

    def op_sentences(self, op: Dict[str, Any], doc) -> Optional[set]:
        """A document-level triple depends on the sentences of its two
        nodes, and a constant (author, document-creation-time) on none, so an
        igt edit elsewhere in the document lets a plan of triples through
        (H17-ASSIST-8, ruled by Luke 2026-10-17). A triple between two
        constants pins the document."""
        if op.get('kind') == 'create_node' and op.get('constant'):
            return set()
        if op.get('kind') in ('create_triple', 'delete_triple'):
            constants = {n.id for n in doc.constants}
            index = self.sentence_index(doc)
            found: set = set()
            for key in ('source_span_id', 'target_span_id'):
                if op.get(key) and op[key] not in constants:
                    found |= index.get(op[key], set())
            return found or None
        return super().op_sentences(op, doc)

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
        raise ValueRefusal(f's{n}: {numbering(doc)}', kind='not-found')

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
            raise ToolError(str(e), kind=kind_of(e, 'not-found')) from None
        if not isinstance(thing, Sentence):
            raise ToolError(f'{ref} is not a sentence. A comment sits on a sentence or on '
                            f'the document.', kind='invalid-argument')
        return thing.id

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
                             written_value_problem(a.get('value'), a.get('rel')),
                             _closed_value_problem(a.get('rel'), a.get('value'))]
        if kind == 'attrs_scope':
            problems.append(relation_form_problem(op.get('rel')))
            if op.get('value'):
                problems += [written_value_problem(op.get('value'), op.get('rel')),
                             _closed_value_problem(op.get('rel'), op.get('value'))]
        why = next((p for p in problems if p), None)
        if why:
            var = op.get('var') or op.get('source_var')
            raise ToolError((f'{var}: ' if var else '') + why, kind='invalid-argument')

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
                raise ToolError(why, kind='invalid-argument')
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
                raise ToolError(where + why, kind='invalid-argument')

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
                                'of the two (discard_plan and stage the rest again), or plan them in separate '
                                'turns.', kind='conflict')
            if prev.get('kind') in GRAPH_KINDS and sentence_graph_key(prev) in graphs:
                raise ToolError(f'This plan already changes {self._where(prev)}, and that change '
                                f'was worked out against the graph this one replaces. Keep one of '
                                f'the two (discard_plan and stage the rest again), or plan them in separate '
                                f'turns.', kind='conflict')

    def _where(self, op: Dict[str, Any]) -> str:
        """A planned change's sentence, as the user would name it."""
        doc = self._docs.get(op.get('document_id'))
        name = f' in {plain_quote(doc.name)}' if doc is not None else ''
        return f's{op.get("sentence")}{name}'

    def describe_changes(self, ops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        # A rule's card row was built when it was staged and goes in
        # `changes` only.
        from .changes import describe_changes
        return describe_changes(self, ops)

    def summarize(self, ops: List[Dict[str, Any]]) -> str:
        from .plan import summarize
        return summarize(ops)
