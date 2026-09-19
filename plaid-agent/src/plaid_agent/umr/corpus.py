"""Corpus-wide reads, through the query engine.

How a query runs, how a pattern is written, and the three shapes of answer are
:mod:`plaid_agent.core.corpus`. What is here is the clauses that name what UMR
annotates and the reads built on them.

A graph node is a SPAN in the concept layer and a relation is a RELATION in
the relation layer, so both are things the engine already knows how to count.
What the engine does not know is a node's attributes, which live in the span's
metadata: those are read off the documents a query narrowed to, never by
scanning the corpus.

Project-wide reads and target finding run as server-side queries; documents
are fetched only to render the hits a tool shows, so the cost follows what is
displayed rather than the size of the corpus.
"""

import re
from typing import Any, Dict, List

from ..core.corpus import Corpus as BaseCorpus, rx
from ..core.limits import GROUP_LIMIT, READ_LIMITS
from ..core.args import clamp_limit
from ..core.tools import ToolError
from .project import UmrProject
from .tools import Workspace

#: Documents a corpus read loads to show its hits. A hit here renders as one
#: line naming the node and its sentence, so a good few documents fit.
RENDER_DOC_BUDGET = 12

COUNTABLE = ('concept', 'role', 'attribute', 'document-relation')


class Corpus(BaseCorpus):
    """Query helpers bound to one workspace."""

    def __init__(self, ws: Workspace):
        super().__init__(ws)
        self.p: UmrProject = ws.project

    def group(self, where: List[Any], group: List[str], aggregates=None,
              limit: int = GROUP_LIMIT) -> List[list]:
        """Grouped rows, sorted here by count descending because the engine
        will not order an aggregate."""
        rows = super().group(where, group, aggregates, limit)
        return sorted(rows, key=lambda r: -r[-1])

    # --- clauses ----------------------------------------------------------

    def node(self, var: str = '?n', **c) -> list:
        """A graph node: a span in the concept layer."""
        return ['span', var, {'layer': self.p.concept_layer_id, **c}]

    def edge(self, var: str = '?r', **c) -> list:
        """A sentence-level relation between two nodes."""
        return ['relation', var, {'layer': self.p.relation_layer_id, **c}]

    def triple(self, var: str = '?t', **c) -> list:
        """A document-level relation: temporal, modal or coreference."""
        return ['relation', var, {'layer': self.p.document_graph_layer_id, **c}]

    def sizes(self) -> Dict[str, int]:
        """How much corpus there is."""
        return {
            'sentences': self.count([['token', '?s', {'layer': self.p.sentence_layer_id}]], ['?s']),
            'nodes': self.count([self.node('?n')], ['?n']),
            'relations': self.count([self.edge('?r')], ['?r']),
        }


# --- the reads built on it ------------------------------------------------------

def _spec(pattern: str, regex: bool, whole: bool, case_sensitive: bool):
    return rx(pattern, regex=regex, whole=whole, case_sensitive=case_sensitive)


def t_find_nodes(ws: Workspace, concept: str = None, role: str = None, attribute: str = None,
                 document: str = None, regex: bool = False, whole: bool = False,
                 case_sensitive: bool = False, limit: int = None) -> str:
    """Nodes by their concept, by a relation they carry, or by an attribute."""
    if not any((concept, role, attribute)):
        raise ToolError('Give concept, role or attribute: what to look for.')
    limit = clamp_limit(limit, *READ_LIMITS['search'])
    corpus = ws.corpus
    if concept:
        where = [corpus.node('?n', value=_spec(concept, regex, whole, case_sensitive))]
        var = '?n'
    elif role:
        where = [corpus.edge('?r', value=_spec(role, regex, whole, case_sensitive))]
        var = '?r'
    else:
        # Attributes are metadata, which the engine does not index by value, so
        # the read is narrowed by the document and scanned here.
        where = [corpus.node('?n')]
        var = '?n'

    if document:
        doc_ids = [ws.resolve_document_id(document)]
        totals = {}
    else:
        rows = corpus.documents_with(where, var)
        totals = dict(rows)
        doc_ids = [d for d, _n in rows][:RENDER_DOC_BUDGET]
    if not doc_ids:
        return 'No node matched.'

    def matches(node) -> bool:
        if concept:
            return _matches(node.concept, concept, regex, whole, case_sensitive)
        if role:
            return any(_matches(e.role, role, regex, whole, case_sensitive) for e in node.out)
        return any(_matches(f'{a.get("rel")} {a.get("value")}', attribute, regex, whole,
                            case_sensitive) or _matches(str(a.get('rel')), attribute, regex,
                                                        whole, case_sensitive)
                   for a in node.attrs)

    ws.read_ahead(doc_ids)
    shown: List[str] = []
    found = 0
    for did in doc_ids:
        doc = ws.doc(did)
        for s in doc.sentences:
            for node in s.nodes:
                if not matches(node):
                    continue
                found += 1
                if len(shown) < limit:
                    extra = ''
                    if role:
                        extra = ' ' + ' '.join(f'{e.role} {doc.nodes_by_id[e.target].var}'
                                               for e in node.out
                                               if e.target in doc.nodes_by_id
                                               and _matches(e.role, role, regex, whole,
                                                            case_sensitive))
                    elif attribute and node.attrs:
                        extra = ' ' + node.attr_line()
                    shown.append(f'"{doc.name}" s{s.index}.{node.var}  ({node.concept}){extra}')
    if not shown:
        return 'No node matched.'
    total = sum(totals.values()) if totals else found
    head = f'{found} node(s) shown from {len(doc_ids)} document(s)'
    if totals and len(totals) > len(doc_ids):
        head += f'; the corpus has {total} hit(s) in {len(totals)} documents'
    out = [head + ':']
    out += shown
    if found > len(shown):
        out.append(f'... and {found - len(shown)} more in the documents read.')
    out.append(ws.corpus.clipped_note('nodes').lstrip('\n') or '')
    return '\n'.join(line for line in out if line)


def _matches(value: str, pattern: str, regex: bool, whole: bool, case_sensitive: bool) -> bool:
    text = value or ''
    p = pattern if regex else re.escape(pattern)
    if whole:
        p = f'^(?:{p})$'
    try:
        return bool(re.search(p, text, 0 if case_sensitive else re.I))
    except re.error as e:
        raise ToolError(f'That pattern is not a valid regular expression: {e}') from None


def t_frequency_list(ws: Workspace, what: str = 'concept', document: str = None,
                     limit: int = None) -> str:
    """The commonest concepts, roles or document-level relations, with counts."""
    if what not in COUNTABLE:
        raise ToolError(f'what must be one of: {", ".join(COUNTABLE)}.')
    limit = clamp_limit(limit, *READ_LIMITS['frequency_list'])
    corpus = ws.corpus
    if what == 'attribute':
        return _attribute_counts(ws, document, limit)
    clause = {'concept': corpus.node, 'role': corpus.edge,
              'document-relation': corpus.triple}[what]
    where = [clause('?x')]
    if document:
        did = ws.resolve_document_id(document)
        where = [clause('?x', doc=did)]
    rows = corpus.group(where, ['?x.value'])
    rows = [r for r in rows if r[0]]
    if not rows:
        return f'No {what} values found.'
    total = sum(r[-1] for r in rows)
    out = [f'{len(rows)} distinct {what}(s), {total} in all'
           + (f' in "{ws.doc(document).name}"' if document else '') + ':']
    for value, count in rows[:limit]:
        out.append(f'  {count:>6}  {value}')
    if len(rows) > limit:
        out.append(f'  ... and {len(rows) - limit} more')
    note = corpus.clipped_note(f'{what} counts')
    return '\n'.join(out) + note


def _attribute_counts(ws: Workspace, document: str, limit: int) -> str:
    """Attributes live in a span's metadata, which the engine does not index,
    so this reads documents. One document, or the few with the most nodes."""
    corpus = ws.corpus
    if document:
        doc_ids = [ws.resolve_document_id(document)]
    else:
        doc_ids = [d for d, _n in corpus.documents_with([corpus.node('?n')], '?n')][:RENDER_DOC_BUDGET]
    if not doc_ids:
        return 'No attributes found.'
    ws.read_ahead(doc_ids)
    counts: Dict[str, int] = {}
    for did in doc_ids:
        doc = ws.doc(did)
        for s in doc.sentences:
            for node in s.nodes:
                for a in node.attrs:
                    key = f'{a.get("rel")} {a.get("value")}'
                    counts[key] = counts.get(key, 0) + 1
    if not counts:
        return 'No attributes found.'
    rows = sorted(counts.items(), key=lambda kv: -kv[1])
    out = [f'{len(rows)} distinct attribute(s) over {len(doc_ids)} document(s):']
    for value, count in rows[:limit]:
        out.append(f'  {count:>6}  {value}')
    if len(rows) > limit:
        out.append(f'  ... and {len(rows) - limit} more')
    if not document and len(doc_ids) >= RENDER_DOC_BUDGET:
        out.append(f'(note) Attributes are metadata, which the query engine does not index, so '
                   f'this counts the {RENDER_DOC_BUDGET} documents with the most nodes. Name a '
                   f'document for a complete answer.')
    return '\n'.join(out)
