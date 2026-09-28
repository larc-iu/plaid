"""One reading of the UMR storage model: a document response as sentences with
their words, morphemes, graph nodes, edges and document-level triples.

This is the Python side of ``plaid-umr/src/domain/sentenceGraph.js``
(``buildDocumentGraph``). Everything that writes UMR writes it into the shape
this reads, so there is one answer to every question the shape raises:

* a node's anchor is one token per contiguous piece on the node layer, and a
  node aligned to NO word stands over the whole of its sentence, so what says a
  node is unaligned is its ``umr.sentence`` record and never the anchor's width
  (ruled 2026-09-19);
* a CONSTANT (``author``, ``document-creation-time``) belongs to no sentence:
  its anchor is a zero-width token at offset 0, which would otherwise fall in
  the first sentence;
* a morpheme token covers the whole of its word, so a morpheme's own text is
  ``metadata.form`` and never the baseline between its offsets;
* attributes and edges share ONE order space, the child's position in the
  PENMAN node;
* a document-level triple is written in the block of the LATER of the two
  sentences it joins.

The readers that used to hold a copy of these rules each: this module, the two
bundled UMR services and the assistant in ``plaid-agent``.
"""

from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Tuple

from plaid_client.provenance import is_protected

from . import penman
from .inventory import DOC_CONSTANTS, DOC_RELATIONS, GROUPS  # noqa: F401  (re-exported)
from .layers import UmrLayers, umr_metadata

#: The coreference relations, whichever way they point. ``:contains`` is in the
#: coref set too, but read as temporal unless a write says otherwise.
COREF_RELATIONS = frozenset(DOC_RELATIONS['coref']) - {':contains'}

#: The temporal relations. ``:contains`` is in two groups, which is why a write
#: records the group rather than leaving it to ``group_of``.
TEMPORAL_RELATIONS = frozenset(DOC_RELATIONS['temporal'])

#: The roles a graph may cycle through: an edge with one of these into a node
#: does not make it a child, so the root of
#: ``(s / say-01 :ARG1 (b / believe-01 :quote s))`` is still say-01.
CYCLE_ROLES = frozenset({':quote', ':modal-predicate'})

#: What a gloss line writes where a token has no value.
MISSING = '_'


def group_of(rel: str) -> str:
    """Which document-level group a relation belongs to, for one written by a
    path that did not record it."""
    name = str(rel or '')
    if name in COREF_RELATIONS:
        return 'coref'
    if name in TEMPORAL_RELATIONS:
        return 'temporal'
    return 'modal'


@dataclass
class Piece:
    """One contiguous anchor of a node: a token on the node layer, covering the
    whole sentence where the node is aligned to no word."""
    id: str
    begin: int
    end: int


@dataclass
class Word:
    id: str
    index: int
    begin: int
    end: int
    text: str


@dataclass
class Morpheme:
    id: str
    begin: int
    end: int
    text: str
    #: IGT's ``metadata.morphType``, the FLEx morph-type name ("stem",
    #: "prefix", "enclitic"), or None where the morpheme has none.
    morph_type: Optional[str] = None


@dataclass
class Edge:
    id: str
    source: str        # a concept span id
    target: str
    role: str
    order: int
    #: The whole metadata, provenance keys and all.
    metadata: Optional[dict] = None
    #: The sentence whose block writes this edge: its source's.
    sentence: Optional[int] = None


@dataclass
class Triple:
    id: str
    source: str
    target: str
    rel: str
    group: str
    sentences: List[int] = dc_field(default_factory=list)
    #: The whole metadata, provenance keys and all.
    metadata: Optional[dict] = None
    #: The sentences whose block writes this triple (see :func:`read_document`).
    blocks: List[int] = dc_field(default_factory=list)


@dataclass
class Node:
    """One graph node: a span in the concept layer."""
    id: str
    var: str
    concept: str
    attrs: List[dict] = dc_field(default_factory=list)
    constant: bool = False
    root: bool = False
    metadata: Optional[dict] = None
    pieces: List[Piece] = dc_field(default_factory=list)
    sentence: Optional[int] = None
    #: The sentence token this node RECORDS, carried by exactly the nodes
    #: aligned to no word. Not the sentence it stands in (``sentence``).
    sentence_token: Optional[str] = None
    alignment: List[Tuple[int, int]] = dc_field(default_factory=list)
    out: List[Edge] = dc_field(default_factory=list)
    into: List[Edge] = dc_field(default_factory=list)
    doc_out: List[Triple] = dc_field(default_factory=list)
    doc_in: List[Triple] = dc_field(default_factory=list)

    @property
    def aligned(self) -> bool:
        """Aligned to words, which is what the absence of a sentence record
        says. A node aligned to nothing stands over the whole of its sentence,
        so reading the anchor's width instead would align it to every word."""
        return not self.sentence_token and any(p.end > p.begin for p in self.pieces)

    @property
    def piece_ids(self) -> List[str]:
        return [p.id for p in self.pieces]

    def attr_line(self) -> str:
        return ' '.join(f'{a.get("rel")} {a.get("value")}' for a in self.attrs)


@dataclass
class Sentence:
    id: str
    index: int
    begin: int
    end: int
    text: str
    snt: Optional[Any] = None
    words: List[Word] = dc_field(default_factory=list)
    morphemes: List[Morpheme] = dc_field(default_factory=list)
    stored_ilg: List[dict] = dc_field(default_factory=list)
    meta: List[Any] = dc_field(default_factory=list)
    raw_graph: Optional[str] = None
    raw_alignment: Optional[str] = None
    nodes: List[Node] = dc_field(default_factory=list)
    edges: List[Edge] = dc_field(default_factory=list)
    triples: List[Triple] = dc_field(default_factory=list)
    roots: List[Node] = dc_field(default_factory=list)

    def node(self, var: str) -> Optional[Node]:
        for n in self.nodes:
            if n.var == var:
                return n
        return None

    def _touching(self):
        """Every edge and document-level triple on a node of this sentence, at
        either end."""
        for n in self.nodes:
            yield from n.out
            yield from n.into
            yield from n.doc_out
            yield from n.doc_in

    def _own(self, relation) -> bool:
        """Whether this sentence's block writes ``relation``."""
        if isinstance(relation, Triple):
            return self.index in relation.blocks
        return relation.sentence == self.index

    @property
    def person_made(self) -> bool:
        """Whether anything of this sentence's graph was built or confirmed by
        a person: a node, or an edge or document-level triple this sentence's
        block writes, that is human-made, contributed or verified, which the
        machine-writer contract (``plaid_client.provenance``, rule 2) says a
        service must not replace. A person's edge or triple that ANOTHER
        sentence's block writes onto one of its nodes does not make it this
        sentence's work: that keeps it too, as a sentence another links to
        (:attr:`redraftable`)."""
        return (any(is_protected(n.metadata or {}) for n in self.nodes)
                or any(is_protected(r.metadata or {})
                       for r in self._touching() if self._own(r)))

    @property
    def redraftable(self) -> bool:
        """Whether an overwrite may replace this sentence's graph. Replacing it
        deletes every edge and triple on its nodes, so it may not when a person
        made any of them, nor when one is written in ANOTHER sentence's block:
        an edge from another sentence's node, or a triple the later sentence
        writes. Those belong to a graph the run was not asked to redraft."""
        if self.person_made:
            return False
        for r in self._touching():
            if isinstance(r, Triple):
                if r.blocks != [self.index]:
                    return False
            elif not self._own(r):
                return False
        return True

    def morphemes_of(self, word: Word) -> List[Morpheme]:
        return [m for m in self.morphemes if word.begin <= m.begin and m.end <= word.end]


@dataclass
class UmrDocument:
    id: str
    name: str
    text_id: Optional[str]
    body: str
    sentences: List[Sentence] = dc_field(default_factory=list)
    constants: List[Node] = dc_field(default_factory=list)
    nodes_by_id: Dict[str, Node] = dc_field(default_factory=dict)
    metadata: dict = dc_field(default_factory=dict)
    version: Optional[int] = None
    #: ``{gloss layer id: {first token id: value}}``, so a sentence's gloss
    #: lines resolve without a second read.
    gloss: Dict[str, Dict[str, str]] = dc_field(default_factory=dict)

    @property
    def node_count(self) -> int:
        return sum(len(s.nodes) for s in self.sentences)

    @property
    def taken_variables(self) -> set:
        """Every variable the document already uses. Variables are unique per
        DOCUMENT, because the document graph cites an earlier sentence's nodes
        by name."""
        return {n.var for n in self.nodes_by_id.values() if n.var}

    def constant(self, name: str) -> Optional[Node]:
        for c in self.constants:
            if c.var == name:
                return c
        return None

    def node_named(self, name: str) -> Optional[Node]:
        """A node by variable anywhere in the document, or a constant by name.
        A variable carries its own sentence, so it is unique in a document."""
        node = self.constant(name)
        if node is not None:
            return node
        for s in self.sentences:
            found = s.node(name)
            if found is not None:
                return found
        return None


def begins_in(begin: int, lo: int, hi: int) -> bool:
    """Half-open containment, so a zero-width piece still belongs somewhere."""
    return lo <= begin < hi


def _overlaps(a_begin: int, a_end: int, b_begin: int, b_end: int) -> bool:
    return a_begin < b_end and b_begin < a_end


def alignment_of(node: Node, words: List[Word]) -> List[Tuple[int, int]]:
    """The 1-based inclusive word ranges a node's pieces cover. Asked only of a
    node aligned to words: one aligned to none stands over its whole sentence,
    and reading that would cover every word of it."""
    ranges: List[Tuple[int, int]] = []
    for piece in node.pieces:
        covered = [w for w in words if _overlaps(piece.begin, piece.end, w.begin, w.end)]
        if covered:
            ranges.append((covered[0].index, covered[-1].index))
    return ranges


def roots_of(sentence: Sentence, nodes_by_id: Dict[str, Node]) -> List[Node]:
    """The sentence's roots, as ``sentenceGraph.js`` ``rootsOf`` has them, in
    the same order. A node marked as the root (the file's own, kept at import)
    is one whatever reaches it, since a released graph may cycle back into its
    root through more than ``:quote``. Then one root for each part no root
    reaches: a node of it nothing in the sentence reaches but a cycle role, the
    largest part first, and for a cycle with no way in, the node that reaches
    the most of it, ties to the first in anchor order. A node a marked root
    reaches is never a root, so a clause re-entered only by ``:quote`` is not
    a second one.

    The order is the app's because the first root is the one the file writes
    and every part after it is printed in this order (:func:`sentence_penman`),
    which the Compare tab reads back byte for byte."""
    if not sentence.nodes:
        return []

    def in_sentence(node_id: str) -> bool:
        node = nodes_by_id.get(node_id)
        return node is not None and node.sentence == sentence.index

    def reach(starts, into: Optional[set] = None) -> set:
        into = set() if into is None else into
        stack = list(starts)
        while stack:
            node = stack.pop()
            if node is None or node.id in into:
                continue
            into.add(node.id)
            stack.extend(nodes_by_id[e.target] for e in node.out if in_sentence(e.target))
        return into

    roots = [n for n in sentence.nodes if n.root]
    reached = reach(roots)

    def new_reach(node: Node) -> int:
        return len(reach([node]) - reached)

    entries = [(n, new_reach(n)) for n in sentence.nodes
               if n.id not in reached
               and not any(in_sentence(e.source) and e.role not in CYCLE_ROLES for e in n.into)]
    entries.sort(key=lambda entry: -entry[1])  # stable, as the app's sort is
    for node, _size in entries:
        if node.id in reached:
            continue
        roots.append(node)
        reach([node], reached)
    while True:
        left = [n for n in sentence.nodes if n.id not in reached]
        if not left:
            return roots
        best, best_size = left[0], -1
        for node in left:
            size = new_reach(node)
            if size > best_size:
                best, best_size = node, size
        roots.append(best)
        reach([best], reached)


def _tokens_of(layer) -> List[dict]:
    return sorted((layer or {}).get('tokens') or [], key=lambda t: (t['begin'], t['end']))


def read_document(raw: dict, layers: UmrLayers,
                  gloss: Optional[Dict[str, Dict[str, str]]] = None) -> UmrDocument:
    """A document response (read with its body) as a graph.

    ``layers`` comes from :func:`resolve_layers`; ``gloss`` is the gloss layers'
    values when the caller wants them (:func:`layers.gloss_values`).
    """
    body = layers.body
    # Plaid's offsets are CODE POINTS everywhere and Python strings are too, so
    # a slice is a slice.
    sentences: List[Sentence] = []
    for i, token in enumerate(_tokens_of(layers.sentence_layer), start=1):
        meta = umr_metadata(token)
        sentences.append(Sentence(
            id=token['id'], index=i, begin=token['begin'], end=token['end'],
            text=meta.get('text') or body[token['begin']:token['end']].rstrip('\n'),
            snt=meta.get('snt'), stored_ilg=list(meta.get('ilg') or []),
            meta=list(meta.get('meta') or []), raw_graph=meta.get('rawGraph'),
            raw_alignment=meta.get('rawAlignment')))

    def sentence_of(begin: int) -> Optional[Sentence]:
        for s in sentences:
            if begins_in(begin, s.begin, s.end):
                return s
        return None

    for token in _tokens_of(layers.word_layer):
        s = sentence_of(token['begin'])
        if s is None:
            continue
        s.words.append(Word(id=token['id'], index=len(s.words) + 1, begin=token['begin'],
                            end=token['end'], text=body[token['begin']:token['end']]))

    # A morpheme token covers the WHOLE of its word, by the shared token
    # hierarchy: the segmentation is in `metadata.form` and the extent says only
    # which word the morpheme belongs to. Reading the baseline between its
    # offsets gave every morpheme of a word the word itself. An empty form is
    # IGT's "emptied by hand" and stays empty rather than falling back.
    for token in sorted((layers.morpheme_layer or {}).get('tokens') or [],
                        key=lambda t: (t['begin'], t['end'], t.get('precedence') or 0)):
        s = sentence_of(token['begin'])
        if s is None:
            continue
        meta = token.get('metadata') or {}
        form = meta.get('form')
        morph_type = meta.get('morphType')
        s.morphemes.append(Morpheme(
            id=token['id'], begin=token['begin'], end=token['end'],
            text=form if isinstance(form, str) else body[token['begin']:token['end']],
            morph_type=morph_type if isinstance(morph_type, str) and morph_type else None))

    node_tokens = {t['id']: t for t in ((layers.node_layer or {}).get('tokens') or [])}
    nodes_by_id: Dict[str, Node] = {}
    constants: List[Node] = []
    for span in (layers.concept_layer or {}).get('spans') or []:
        meta = umr_metadata(span)
        pieces = sorted((Piece(id=t['id'], begin=t['begin'], end=t['end'])
                         for t in (node_tokens.get(tid) for tid in span.get('tokens') or [])
                         if t is not None),
                        key=lambda p: (p.begin, p.end))
        node = Node(
            id=span['id'], var=meta.get('var') or '',
            concept=span.get('value') if span.get('value') is not None else '',
            attrs=sorted(list(meta.get('attrs') or []), key=lambda a: a.get('order') or 0),
            constant=meta.get('constant') is True, root=meta.get('root') is True,
            # The WHOLE metadata, not just the `umr` half: the flat provenance
            # keys beside it are what says whether a person made this node.
            metadata=span.get('metadata'), pieces=pieces,
            sentence_token=meta.get('sentence') or None)
        nodes_by_id[span['id']] = node
        if node.constant:
            constants.append(node)
            continue
        s = sentence_of(pieces[0].begin) if pieces else None
        if s is not None:
            node.sentence = s.index
            s.nodes.append(node)

    relations: List[dict] = []
    doc_relations: List[dict] = []
    for relation_layer in (layers.concept_layer or {}).get('relation_layers') or []:
        if relation_layer['id'] == layers.relation_layer['id']:
            relations = list(relation_layer.get('relations') or [])
        elif relation_layer['id'] == layers.document_graph_layer['id']:
            doc_relations = list(relation_layer.get('relations') or [])

    for rel in relations:
        source = nodes_by_id.get(rel.get('source'))
        target = nodes_by_id.get(rel.get('target'))
        if source is None or target is None:
            continue
        edge = Edge(id=rel['id'], source=rel['source'], target=rel['target'],
                    role=rel.get('value') or '',
                    order=umr_metadata(rel).get('order') or 0,
                    metadata=rel.get('metadata'), sentence=source.sentence)
        source.out.append(edge)
        target.into.append(edge)
        if source.sentence is not None:
            sentences[source.sentence - 1].edges.append(edge)

    for rel in doc_relations:
        source = nodes_by_id.get(rel.get('source'))
        target = nodes_by_id.get(rel.get('target'))
        if source is None or target is None:
            continue
        meta = umr_metadata(rel)
        triple = Triple(id=rel['id'], source=rel['source'], target=rel['target'],
                        rel=rel.get('value') or '',
                        group=meta.get('group') or group_of(rel.get('value') or ''),
                        sentences=list(meta.get('sentences') or []),
                        metadata=rel.get('metadata'))
        source.doc_out.append(triple)
        target.doc_in.append(triple)
        # The triple is written in the block of the LATER of its two sentences.
        # One between two constants belongs to the sentences its metadata lists.
        later = max(source.sentence or 0, target.sentence or 0)
        if later > 0:
            triple.blocks = [later]
        elif source.constant and target.constant:
            triple.blocks = [n for n in triple.sentences if 1 <= n <= len(sentences)]
        for n in triple.blocks:
            sentences[n - 1].triples.append(triple)

    for s in sentences:
        for node in s.nodes:
            node.alignment = alignment_of(node, s.words) if node.aligned else []
        s.nodes.sort(key=lambda n: (n.pieces[0].begin if n.pieces else 0, n.var))
        s.edges.sort(key=lambda e: e.order)
        s.roots = roots_of(s, nodes_by_id)

    return UmrDocument(id=raw.get('id'), name=raw.get('name') or '', text_id=layers.text_id,
                       body=body, sentences=sentences, constants=constants,
                       nodes_by_id=nodes_by_id, metadata=raw.get('metadata') or {},
                       version=raw.get('version'), gloss=dict(gloss or {}))


# --- the stored graph as PENMAN -----------------------------------------------

def penman_nodes(doc: UmrDocument, sentence: Sentence) -> Dict[str, penman.Node]:
    """One sentence's stored graph as PENMAN nodes: a node's children are its
    attributes and its in-sentence edges, in stored order."""
    nodes: Dict[str, penman.Node] = {}
    for node in sentence.nodes:
        children: List[penman.Child] = []
        for a in node.attrs:
            value = str(a.get('value') or '')
            children.append(penman.Child(a.get('rel') or '',
                                         penman.STRING_KIND if value.startswith('"')
                                         else penman.ATOM,
                                         value, order=a.get('order') or 0))
        for e in node.out:
            target = doc.nodes_by_id.get(e.target)
            if target is None or target.sentence != sentence.index:
                continue
            children.append(penman.Child(e.role, penman.NODE, target.var, order=e.order))
        children.sort(key=lambda c: c.order)
        nodes[node.var] = penman.Node(var=node.var, concept=node.concept, children=children)
    return nodes


def penman_of(doc: UmrDocument, sentence: Sentence) -> str:
    """One sentence's graph as PENMAN, exactly as the app's text mode shows it:
    tree edges by first-visit depth-first walk in stored order, every other
    reference a bare variable."""
    root = sentence.roots[0].var if sentence.roots else None
    return penman.graph_text(penman_nodes(doc, sentence), root)


def sentence_penman(doc: UmrDocument, sentence: Sentence) -> str:
    """EVERY node of a sentence as PENMAN, as the app's ``penmanOf`` and text
    mode print it (``sentenceGraph.js`` ``sentencePenman``): the root's graph,
    then each part the root does not reach as a graph of its own, in the order
    of the roots and then of the nodes, parted by a blank line. A node is
    written out once, in the first graph that reaches it. :func:`penman_of`
    is the root's graph alone, as the file writes it."""
    every = penman_nodes(doc, sentence)
    shown: set = set()
    parts: List[str] = []
    for top in [r.var for r in sentence.roots] + list(every):
        if top in shown or top not in every:
            continue
        nodes = {v: n for v, n in every.items() if v not in shown}
        parts.append(penman.graph_text(nodes, top))
        stack = [top]
        while stack:
            v = stack.pop()
            if v in shown or v not in nodes:
                continue
            shown.add(v)
            stack.extend(c.value for c in nodes[v].children if c.kind == penman.NODE)
    return '\n\n'.join(parts)


def reachable_from_root(doc: UmrDocument, sentence: Sentence) -> set:
    """The concept span ids the sentence's first root reaches. The PENMAN text is
    the root's graph, so only what the root reaches is the text's to change: a
    fragment the text never showed stays."""
    seen: set = set()
    stack = list(sentence.roots[:1])
    while stack:
        node = stack.pop()
        if node is None or node.id in seen:
            continue
        seen.add(node.id)
        for e in node.out:
            target = doc.nodes_by_id.get(e.target)
            if target is not None and target.sentence == sentence.index:
                stack.append(target)
    return seen


# --- a node's attributes ------------------------------------------------------

def next_order(node: Node) -> int:
    """The next free position among a node's children: attributes and edges
    share one order, the file's child order."""
    orders = [e.order for e in node.out] + [a.get('order') or 0 for a in node.attrs]
    return max(orders) + 1 if orders else 0


def place_attributes(node: Node, attrs: List[dict]) -> List[dict]:
    """``attrs`` as the node should store them: one that was already there keeps
    its place among the node's children, and a new one goes after everything.
    The rule the editor writes by, so a graph written back keeps its child
    order."""
    free = [(a.get('rel'), a.get('order') or 0) for a in node.attrs]
    tail = next_order(node)
    placed: List[dict] = []
    for a in attrs:
        at = next((i for i, (rel, _o) in enumerate(free) if rel == a['rel']), None)
        if at is None:
            order = tail
            tail += 1
        else:
            order = free.pop(at)[1]
        placed.append({'rel': a['rel'], 'value': a['value'], 'order': order})
    return placed


def with_attribute(node: Node, rel: str, value: str) -> List[dict]:
    """The node's attributes with ``rel`` set to ``value``, or removed where
    ``value`` is empty. Everything else keeps its value and its place."""
    attrs = [{'rel': a.get('rel'), 'value': a.get('value')} for a in node.attrs
             if a.get('rel') != rel]
    if value:
        attrs.append({'rel': rel, 'value': value})
    return place_attributes(node, attrs)
