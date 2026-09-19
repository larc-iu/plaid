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
from ..core.tools import ToolError, truncate
from .project import UmrProject, reachable_from_root
from .tools import Workspace

# Documents a corpus read loads to show its hits. A hit here is one line
# naming the node and its sentence, which is what UD's is too, so UMR sets the
# same budget; IGT sets it lower, because a hit there is a block of aligned
# lines and fewer of them fit in one answer.
RENDER_DOC_BUDGET = 12

COUNTABLE = ('concept', 'role', 'attribute', 'document-relation')

#: What a search matches on: the words of the sentence, or the concepts of the
#: graph over it. Either way what comes back is SENTENCES, because a sentence
#: is what a UMR annotator opens and works on.
SEARCHABLE = ('words', 'concepts')

#: What "unfinished" means for a sentence graph. Each is something the editor
#: would show as wrong or missing, never a matter of taste.
WORKLIST_KINDS = ('ungraphed', 'unrooted', 'unaligned', 'disconnected')


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

    def word(self, var: str = '?w', **c) -> list:
        """A word of the baseline text: what a sentence is made of, and what a
        node is aligned to."""
        return ['token', var, {'layer': self.p.word_layer_id, **c}]

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


def t_search(ws: Workspace, pattern: str = None, where: str = 'words', document: str = None,
             regex: bool = False, whole: bool = False, case_sensitive: bool = False,
             limit: int = None) -> str:
    """Sentences whose words, or whose graph concepts, match."""
    if not pattern:
        raise ToolError('Give a pattern to search for.')
    if where not in SEARCHABLE:
        raise ToolError(f'where must be one of: {", ".join(SEARCHABLE)}.')
    limit = clamp_limit(limit, *READ_LIMITS['search'])
    corpus = ws.corpus
    if document:
        doc_ids = [ws.resolve_document_id(document)]
        totals = {}
    else:
        spec = _spec(pattern, regex, whole, case_sensitive)
        clause = (corpus.word('?w', value=spec) if where == 'words'
                  else corpus.node('?n', value=spec))
        rows = corpus.documents_with([clause], '?w' if where == 'words' else '?n')
        totals = dict(rows)
        doc_ids = [d for d, _n in rows][:RENDER_DOC_BUDGET]
    if not doc_ids:
        return f'No sentence matches "{pattern}".'

    ws.read_ahead(doc_ids)
    shown: List[str] = []
    found = 0
    for did in doc_ids:
        doc = ws.doc(did)
        for s in doc.sentences:
            if where == 'words':
                hit = [w.text for w in s.words
                       if _matches(w.text, pattern, regex, whole, case_sensitive)]
            else:
                hit = [f'{n.var} {n.concept}' for n in s.nodes
                       if _matches(n.concept, pattern, regex, whole, case_sensitive)]
            if not hit:
                continue
            found += 1
            if len(shown) < limit:
                shown.append(f'"{doc.name}" s{s.index}  {s.text}\n      {", ".join(hit)}')
    if not shown:
        return f'No sentence matches "{pattern}".'
    total = sum(totals.values()) if totals else found
    head = f'{found} sentence(s) shown from {len(doc_ids)} document(s)'
    if totals and len(totals) > len(doc_ids):
        head += f'; the corpus has {total} matching {where} in {len(totals)} documents'
    out = [head + ':'] + shown
    if found > len(shown):
        out.append(f'... and {found - len(shown)} more in the documents read.')
    return truncate('\n'.join(out) + corpus.clipped_note('sentences'))


def _unfinished(doc, kinds: List[str]) -> List[tuple]:
    """[(sentence, kind, what)] in one document. Each of these is something
    the editor draws as broken: a sentence nobody has drawn a graph for, a
    graph with no single root, a node anchored to no words, and a node the
    root does not reach (which is a fragment the PENMAN text never shows)."""
    out: List[tuple] = []
    for s in doc.sentences:
        if not s.nodes:
            if 'ungraphed' in kinds:
                out.append((s, 'ungraphed', s.text))
            continue
        if 'unrooted' in kinds and len(s.roots) != 1:
            out.append((s, 'unrooted', 'no root' if not s.roots
                        else 'roots ' + ', '.join(n.var for n in s.roots)))
        if 'unaligned' in kinds:
            loose = [n.var for n in s.nodes if not n.constant and not n.aligned]
            if loose:
                out.append((s, 'unaligned', ', '.join(loose)))
        if 'disconnected' in kinds and s.roots:
            reach = reachable_from_root(doc, s)
            stray = [n.var for n in s.nodes if n.id not in reach and not n.constant]
            if stray:
                out.append((s, 'disconnected', ', '.join(stray)))
    return out


def t_worklist(ws: Workspace, kind: str = None, document: str = None, limit: int = None) -> str:
    """What is unfinished, sentence by sentence, so a session has somewhere to
    start."""
    kinds = [kind] if kind else list(WORKLIST_KINDS)
    for k in kinds:
        if k not in WORKLIST_KINDS:
            raise ToolError(f'Unknown kind "{k}". One of: ' + ', '.join(WORKLIST_KINDS))
    limit = clamp_limit(limit, *READ_LIMITS['worklist'])
    # Whether a graph is finished is a property of the parsed document: the
    # query engine indexes the nodes but not what they add up to, so this
    # reads documents. One when the model names one, and otherwise the first
    # few, which it says.
    if document:
        doc_ids, capped = [ws.resolve_document_id(document)], 0
    else:
        ids = [d['id'] for d in ws.documents()]
        doc_ids, capped = ids[:RENDER_DOC_BUDGET], max(0, len(ids) - RENDER_DOC_BUDGET)
    if not doc_ids:
        return 'The project has no documents.'
    ws.read_ahead(doc_ids)
    rows: List[tuple] = []
    for did in doc_ids:
        doc = ws.doc(did)
        rows += [(doc, s, k, what) for s, k, what in _unfinished(doc, kinds)]
    if not rows:
        where = f' in "{ws.doc(doc_ids[0]).name}"' if document else f' in {len(doc_ids)} document(s)'
        return f'Nothing is unfinished{where} ({", ".join(kinds)}).'
    out: List[str] = []
    for k in kinds:
        mine = [r for r in rows if r[2] == k]
        if not mine:
            continue
        out.append(f'{k}: {len(mine)} sentence(s)')
        for doc, s, _k, what in mine[:limit]:
            out.append(f'  "{doc.name}" s{s.index}  {what}')
        if len(mine) > limit:
            out.append(f'  … and {len(mine) - limit} more (raise limit)')
    if capped:
        out.append(f'(note) Read the first {len(doc_ids)} documents of {len(doc_ids) + capped}. '
                   f'Name a document for a complete answer about it.')
    return truncate('\n'.join(out))


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
