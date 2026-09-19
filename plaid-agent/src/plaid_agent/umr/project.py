"""The UMR project and document, as the assistant's tools see them.

A plaid-umr project is the shared substrate (a baseline text with sentence and
word token layers, and IGT's morphemes when the project has them) plus four
layers UMR owns, flagged under ``config.umr``:

    nodes          a ROOT token layer, one token per contiguous anchor piece,
                   zero-width where a node is unaligned
    concepts       a span layer, one span per graph node. ``value`` is the
                   concept and ``metadata.umr`` is
                   ``{var, attrs: [{rel, value, order}], constant?, root?}``
    relations      the sentence-level edges, ``value`` the role,
                   ``metadata.umr = {order}``
    documentGraph  the temporal, modal and coreference triples,
                   ``metadata.umr = {group, sentences?}``

This is a PORT of ``plaid-umr/src/domain/sentenceGraph.js`` and
``utils/umrLayerUtils.js``: what the model reads has to be what the canvas
draws and what the exporter writes, or a plan built on one would be applied
against the other.

**Addressing is positional.** ``s3`` is the third sentence and ``s3.s3e`` the
node whose variable is ``s3e`` in it, so the model handles a variable it read
in a graph and never an id.
"""

import re
from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Tuple

from plaid_client import ROLES, find_by_role

from ..core.guidelines import Guideline, load as load_guidelines
from ..core.project import find_layer  # noqa: F401  (re-exported for the tools)
from .penman import Child, Node as PNode, graph_text

UMR = 'umr'
MISSING = '_'

#: The layers UMR owns, by their ``config.umr`` flag.
NODES, CONCEPTS, RELATIONS, DOCUMENT_GRAPH = 'nodes', 'concepts', 'relations', 'documentGraph'

#: The nodes of a document-level relation that are not sentence variables.
DOC_CONSTANTS = ('root', 'author', 'null-conceiver', 'have-condition-91',
                 'document-creation-time', 'past-reference', 'present-reference',
                 'future-reference')

#: The groups a document-level relation falls in.
GROUPS = ('temporal', 'modal', 'coref')

#: The coreference relations, whichever way they point.
COREF_RELATIONS = frozenset({':same-entity', ':same-event', ':subset-of', ':subset'})

#: The roles a graph may cycle through: an edge with one of these into a node
#: does not make it a child, so the root of
#: ``(s / say-01 :ARG1 (b / believe-01 :quote s))`` is still say-01.
CYCLE_ROLES = frozenset({':quote', ':modal-predicate'})

_TEMPORAL = re.compile(r'^:(before|after|contained|overlap|depends-on|contains)$')
_COREF = re.compile(r'^:(same-entity|same-event|subset-of|subset)$')


def group_of(rel: str) -> str:
    """Which document-level group a relation belongs to, for one written by a
    path that did not record it. ``:contains`` is in two groups, which is why
    a write records the group rather than leaving it to this."""
    if _COREF.match(rel or ''):
        return 'coref'
    if _TEMPORAL.match(rel or ''):
        return 'temporal'
    return 'modal'


def _umr(config) -> dict:
    return (config or {}).get(UMR) or {}


def _flagged(layers, flag: str):
    for layer in layers or []:
        if _umr(layer.get('config')).get(flag) is True:
            return layer
    return None


# --- project ----------------------------------------------------------------

@dataclass
class GlossLayer:
    """Another app's annotation layer that a gloss line can read: IGT's fields
    say their scope and writing system, and a layer that says nothing takes the
    scope of the token layer it hangs off."""
    id: str
    name: str
    scope: str        # 'sentence', 'word' or 'morpheme'
    lang: Optional[str]


@dataclass
class UmrProject:
    id: str
    name: str
    language: str
    text_layer_id: str
    sentence_layer_id: str
    word_layer_id: str
    morpheme_layer_id: Optional[str]
    node_layer_id: str
    concept_layer_id: str
    relation_layer_id: str
    document_graph_layer_id: str
    gloss_layers: List[GlossLayer] = dc_field(default_factory=list)
    ilg: Optional[List[dict]] = None
    guidelines: List[Guideline] = dc_field(default_factory=list)

    def read_layer_ids(self) -> List[str]:
        """The layers a document read has to carry, for ``?layers=``. A project
        may hold layers this app never parses (UD's columns where the two share
        a project), and a layer carries its content only when it is named."""
        ids = [self.text_layer_id, self.sentence_layer_id, self.word_layer_id,
               self.morpheme_layer_id, self.node_layer_id, self.concept_layer_id,
               self.relation_layer_id, self.document_graph_layer_id]
        ids += [g.id for g in self.gloss_layers]
        return [i for i in dict.fromkeys(ids) if i]


def load_project(client, project_id: str) -> UmrProject:
    raw = client.projects.get(project_id)
    guidelines = load_guidelines(client, project_id)
    text_layer = find_by_role(raw.get('text_layers'), ROLES.BASELINE) or (raw.get('text_layers') or [None])[0]
    if not text_layer:
        raise ValueError('This project has no baseline text layer (not set up for UMR?)')
    token_layers = text_layer.get('token_layers') or []
    sentence = find_by_role(token_layers, ROLES.SENTENCE)
    word = find_by_role(token_layers, ROLES.WORD)
    morpheme = find_by_role(token_layers, ROLES.MORPHEME)
    nodes = _flagged(token_layers, NODES)
    concepts = _flagged((nodes or {}).get('span_layers'), CONCEPTS)
    relations = _flagged((concepts or {}).get('relation_layers'), RELATIONS)
    doc_graph = _flagged((concepts or {}).get('relation_layers'), DOCUMENT_GRAPH)
    missing = [name for name, layer in (('sentence', sentence), ('word', word),
                                        ('UMR node', nodes), ('UMR concept', concepts),
                                        ('UMR relation', relations),
                                        ('UMR document graph', doc_graph)) if not layer]
    if missing:
        raise ValueError('This project is missing its ' + ', '.join(missing)
                         + ' layer' + ('s' if len(missing) > 1 else '')
                         + '. A maintainer can finish setting it up on the project page.')

    gloss_layers: List[GlossLayer] = []
    for token_layer, scope in ((sentence, 'sentence'), (word, 'word'), (morpheme, 'morpheme')):
        for span_layer in (token_layer or {}).get('span_layers') or []:
            if (span_layer.get('config') or {}).get(UMR):
                continue
            igt = (span_layer.get('config') or {}).get('igt') or {}
            declared = str(igt.get('scope') or '').lower()
            gloss_layers.append(GlossLayer(
                id=span_layer['id'], name=span_layer.get('name') or '',
                scope='word' if declared == 'token' else (declared or scope),
                lang=igt.get('lang') or None))

    config = _umr(raw.get('config'))
    language = config.get('language')
    ilg = config.get('ilg')
    return UmrProject(
        id=raw['id'], name=raw.get('name') or '',
        language=language.strip() if isinstance(language, str) else '',
        text_layer_id=text_layer['id'], sentence_layer_id=sentence['id'],
        word_layer_id=word['id'], morpheme_layer_id=(morpheme or {}).get('id'),
        node_layer_id=nodes['id'], concept_layer_id=concepts['id'],
        relation_layer_id=relations['id'], document_graph_layer_id=doc_graph['id'],
        gloss_layers=gloss_layers, ilg=list(ilg) if isinstance(ilg, list) else None,
        guidelines=guidelines)


# --- document ---------------------------------------------------------------

@dataclass
class Piece:
    """One contiguous anchor of a node: a token on the node layer, zero-width
    where the node is not aligned to any word."""
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


@dataclass
class Edge:
    id: str
    source: str        # a concept span id
    target: str
    role: str
    order: int


@dataclass
class Triple:
    id: str
    source: str
    target: str
    rel: str
    group: str
    sentences: List[int] = dc_field(default_factory=list)


@dataclass
class GNode:
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
    alignment: List[Tuple[int, int]] = dc_field(default_factory=list)
    out: List[Edge] = dc_field(default_factory=list)
    into: List[Edge] = dc_field(default_factory=list)
    doc_out: List[Triple] = dc_field(default_factory=list)
    doc_in: List[Triple] = dc_field(default_factory=list)

    @property
    def aligned(self) -> bool:
        return any(p.end > p.begin for p in self.pieces)

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
    nodes: List[GNode] = dc_field(default_factory=list)
    edges: List[Edge] = dc_field(default_factory=list)
    triples: List[Triple] = dc_field(default_factory=list)
    roots: List[GNode] = dc_field(default_factory=list)

    def node(self, var: str) -> Optional[GNode]:
        for n in self.nodes:
            if n.var == var:
                return n
        return None

    @property
    def taken_variables(self) -> set:
        return {n.var for n in self.nodes}


@dataclass
class UmrDoc:
    id: str
    name: str
    text_id: Optional[str]
    body: str
    sentences: List[Sentence]
    constants: List[GNode]
    nodes_by_id: Dict[str, GNode]
    metadata: dict
    version: Optional[int]
    #: The gloss layers' values by first token id, layer by layer, so a
    #: sentence's gloss lines can be resolved without a second read.
    gloss: Dict[str, Dict[str, str]] = dc_field(default_factory=dict)

    @property
    def node_count(self) -> int:
        return sum(len(s.nodes) for s in self.sentences)

    def constant(self, name: str) -> Optional[GNode]:
        for c in self.constants:
            if c.var == name:
                return c
        return None

    def node_named(self, name: str) -> Optional[GNode]:
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


def _begins_in(begin: int, lo: int, hi: int) -> bool:
    """Half-open containment, so a zero-width piece still belongs somewhere."""
    return lo <= begin < hi


def _overlaps(a_begin: int, a_end: int, b_begin: int, b_end: int) -> bool:
    return a_begin < b_end and b_begin < a_end


def load_document(client, project: UmrProject, document_id: str) -> UmrDoc:
    raw = client.documents.get(document_id, include_body=True, layers=project.read_layer_ids())
    return parse_document(raw, project)


def _token_layer(raw, layer_id):
    _, layer = find_layer(raw.get('text_layers'), layer_id)
    return layer or {}


def _span_layer(raw, token_layer_id, span_layer_id):
    for span_layer in _token_layer(raw, token_layer_id).get('span_layers') or []:
        if span_layer['id'] == span_layer_id:
            return span_layer
    return {}


def parse_document(raw: dict, project: UmrProject) -> UmrDoc:
    text_layer, _ = find_layer(raw.get('text_layers'), project.sentence_layer_id)
    text = (text_layer or {}).get('text') or {}
    body = text.get('body') or ''
    chars = list(body)

    def slice_text(begin, end):
        return ''.join(chars[begin:end])

    sentence_tokens = sorted(_token_layer(raw, project.sentence_layer_id).get('tokens') or [],
                             key=lambda t: (t['begin'], t['end']))
    word_tokens = sorted(_token_layer(raw, project.word_layer_id).get('tokens') or [],
                         key=lambda t: (t['begin'], t['end']))
    morpheme_tokens = sorted(_token_layer(raw, project.morpheme_layer_id).get('tokens') or [],
                             key=lambda t: (t['begin'], t['end'])) if project.morpheme_layer_id else []
    node_tokens = _token_layer(raw, project.node_layer_id).get('tokens') or []
    node_tokens_by_id = {t['id']: t for t in node_tokens}
    concept_layer = _span_layer(raw, project.node_layer_id, project.concept_layer_id)
    spans = concept_layer.get('spans') or []
    relations: List[dict] = []
    doc_relations: List[dict] = []
    for relation_layer in concept_layer.get('relation_layers') or []:
        if relation_layer['id'] == project.relation_layer_id:
            relations = list(relation_layer.get('relations') or [])
        elif relation_layer['id'] == project.document_graph_layer_id:
            doc_relations = list(relation_layer.get('relations') or [])

    sentences: List[Sentence] = []
    for i, token in enumerate(sentence_tokens, start=1):
        meta = _umr(token.get('metadata'))
        sentences.append(Sentence(
            id=token['id'], index=i, begin=token['begin'], end=token['end'],
            text=meta.get('text') or slice_text(token['begin'], token['end']).rstrip('\n'),
            snt=meta.get('snt'), stored_ilg=list(meta.get('ilg') or []),
            meta=list(meta.get('meta') or []), raw_graph=meta.get('rawGraph')))

    def sentence_of(begin: int) -> Optional[Sentence]:
        for s in sentences:
            if _begins_in(begin, s.begin, s.end):
                return s
        return None

    for token in word_tokens:
        s = sentence_of(token['begin'])
        if s is None:
            continue
        s.words.append(Word(id=token['id'], index=len(s.words) + 1, begin=token['begin'],
                            end=token['end'], text=slice_text(token['begin'], token['end'])))
    for token in morpheme_tokens:
        s = sentence_of(token['begin'])
        if s is None:
            continue
        s.morphemes.append(Morpheme(id=token['id'], begin=token['begin'], end=token['end'],
                                    text=slice_text(token['begin'], token['end'])))

    nodes_by_id: Dict[str, GNode] = {}
    constants: List[GNode] = []
    for span in spans:
        meta = _umr(span.get('metadata'))
        pieces = sorted((Piece(id=t['id'], begin=t['begin'], end=t['end'])
                         for t in (node_tokens_by_id.get(tid) for tid in span.get('tokens') or [])
                         if t is not None),
                        key=lambda p: (p.begin, p.end))
        node = GNode(
            id=span['id'], var=meta.get('var') or '',
            concept=span.get('value') if span.get('value') is not None else '',
            attrs=sorted(list(meta.get('attrs') or []), key=lambda a: a.get('order') or 0),
            constant=meta.get('constant') is True, root=meta.get('root') is True,
            metadata=span.get('metadata'), pieces=pieces)
        nodes_by_id[span['id']] = node
        if node.constant:
            constants.append(node)
            continue
        s = sentence_of(pieces[0].begin) if pieces else None
        if s is not None:
            node.sentence = s.index
            s.nodes.append(node)

    for rel in relations:
        source = nodes_by_id.get(rel.get('source'))
        target = nodes_by_id.get(rel.get('target'))
        if source is None or target is None:
            continue
        edge = Edge(id=rel['id'], source=rel['source'], target=rel['target'],
                    role=rel.get('value') or '', order=_umr(rel.get('metadata')).get('order') or 0)
        source.out.append(edge)
        target.into.append(edge)
        if source.sentence is not None:
            sentences[source.sentence - 1].edges.append(edge)

    for rel in doc_relations:
        source = nodes_by_id.get(rel.get('source'))
        target = nodes_by_id.get(rel.get('target'))
        if source is None or target is None:
            continue
        meta = _umr(rel.get('metadata'))
        triple = Triple(id=rel['id'], source=rel['source'], target=rel['target'],
                        rel=rel.get('value') or '',
                        group=meta.get('group') or group_of(rel.get('value') or ''),
                        sentences=list(meta.get('sentences') or []))
        source.doc_out.append(triple)
        target.doc_in.append(triple)
        # The triple is written in the block of the LATER of its two sentences.
        later = max(source.sentence or 0, target.sentence or 0)
        if later > 0:
            sentences[later - 1].triples.append(triple)
        elif source.constant and target.constant:
            for n in triple.sentences:
                if 1 <= n <= len(sentences):
                    sentences[n - 1].triples.append(triple)

    for s in sentences:
        for node in s.nodes:
            node.alignment = _alignment_of(node, s.words)
        s.nodes.sort(key=lambda n: (n.pieces[0].begin if n.pieces else 0, n.var))
        s.edges.sort(key=lambda e: e.order)
        s.roots = _roots_of(s, nodes_by_id)

    return UmrDoc(id=raw['id'], name=raw.get('name') or '', text_id=text.get('id'), body=body,
                  sentences=sentences, constants=constants, nodes_by_id=nodes_by_id,
                  metadata=raw.get('metadata') or {}, version=raw.get('version'),
                  gloss=gloss_values(raw, project))


def _alignment_of(node: GNode, words: List[Word]) -> List[Tuple[int, int]]:
    """The 1-based inclusive word ranges a node's pieces cover. A zero-width
    piece covers nothing, so an unaligned node gives []."""
    ranges: List[Tuple[int, int]] = []
    for piece in node.pieces:
        covered = [w for w in words if _overlaps(piece.begin, piece.end, w.begin, w.end)]
        if covered:
            ranges.append((covered[0].index, covered[-1].index))
    return ranges


def _roots_of(sentence: Sentence, nodes_by_id: Dict[str, GNode]) -> List[GNode]:
    """The sentence's roots. A node marked as the root (the file's own, kept at
    import) is one whatever reaches it, since a released graph may cycle back
    into its root through more than ``:quote``. Otherwise: nodes no in-sentence
    edge reaches, cycle roles aside. A graph with neither still needs a root to
    write from, so the node that reaches the most others stands in."""
    def in_sentence(node_id: str) -> bool:
        node = nodes_by_id.get(node_id)
        return node is not None and node.sentence == sentence.index

    marked = [n for n in sentence.nodes if n.root]
    derived = [n for n in sentence.nodes
               if not n.root and not any(in_sentence(e.source) and e.role not in CYCLE_ROLES
                                         for e in n.into)]
    roots = marked + derived
    if roots or not sentence.nodes:
        return roots

    def reach(start: GNode) -> int:
        seen = {start.id}
        stack = [start]
        while stack:
            node = stack.pop()
            for e in node.out:
                if in_sentence(e.target) and e.target not in seen:
                    seen.add(e.target)
                    stack.append(nodes_by_id[e.target])
        return len(seen)

    best, best_reach = sentence.nodes[0], -1
    for node in sentence.nodes:
        r = reach(node)
        if r > best_reach:
            best, best_reach = node, r
    return [best]


# --- a node's attributes ------------------------------------------------------

def next_order(node: GNode) -> int:
    """The next free position among a node's children: attributes and edges
    share one order, the file's child order."""
    orders = [e.order for e in node.out] + [a.get('order') or 0 for a in node.attrs]
    return max(orders) + 1 if orders else 0


def place_attributes(node: GNode, attrs: List[dict]) -> List[dict]:
    """``attrs`` as the node should store them: one that was already there
    keeps its place among the node's children, and a new one goes after
    everything. The rule the editor writes by, so a graph written back keeps
    its child order.

    One reader, because the tool that sets a node's attributes by hand and the
    scope that sets one across a document have to place them the same way.
    """
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


def with_attribute(node: GNode, rel: str, value: str) -> List[dict]:
    """The node's attributes with ``rel`` set to ``value``, or removed where
    ``value`` is empty. Everything else keeps its value and its place."""
    attrs = [{'rel': a.get('rel'), 'value': a.get('value')} for a in node.attrs
             if a.get('rel') != rel]
    if value:
        attrs.append({'rel': rel, 'value': value})
    return place_attributes(node, attrs)


# --- the sentence as PENMAN --------------------------------------------------

def penman_nodes(doc: UmrDoc, sentence: Sentence) -> Dict[str, PNode]:
    """The stored graph as PENMAN nodes: a node's children are its attributes
    and its in-sentence edges, in stored order."""
    nodes: Dict[str, PNode] = {}
    for node in sentence.nodes:
        children: List[Child] = []
        for a in node.attrs:
            value = str(a.get('value') or '')
            children.append(Child(a.get('rel') or '',
                                  'string' if value.startswith('"') else 'atom',
                                  value, order=a.get('order') or 0))
        for e in node.out:
            target = doc.nodes_by_id.get(e.target)
            if target is None or target.sentence != sentence.index:
                continue
            children.append(Child(e.role, 'node', target.var, order=e.order))
        children.sort(key=lambda c: c.order)
        nodes[node.var] = PNode(var=node.var, concept=node.concept, children=children)
    return nodes


def penman_of(doc: UmrDoc, sentence: Sentence) -> str:
    """One sentence's graph as PENMAN, exactly as the app's text mode shows it:
    tree edges by first-visit depth-first walk in stored order, every other
    reference a bare variable."""
    root = sentence.roots[0].var if sentence.roots else None
    return graph_text(penman_nodes(doc, sentence), root)


def reachable_from_root(doc: UmrDoc, sentence: Sentence) -> set:
    """The concept span ids the sentence's first root reaches. The PENMAN text
    is the root's graph, so only what the root reaches is the text's to
    change: a fragment the text never showed stays."""
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


# --- addressing --------------------------------------------------------------

REF_RE = re.compile(r'^\s*s(\d+)(?:\.([A-Za-z][\w-]*))?\s*$')


def parse_ref(ref: str) -> Tuple[int, Optional[str]]:
    """``s3`` -> (3, None); ``s3.s3e`` -> (3, 's3e')."""
    m = REF_RE.match(ref or '')
    if not m:
        raise ValueError(f'Bad reference "{ref}": use s<n> for a sentence and s<n>.<variable> for '
                         f'a node in it, e.g. s3 or s3.s3e')
    return int(m.group(1)), m.group(2)


def node_ref(sentence: Sentence, node: GNode) -> str:
    return f's{sentence.index}.{node.var}'


def resolve(doc: UmrDoc, ref: str):
    """-> Sentence | GNode for a positional reference into ``doc``."""
    index, var = parse_ref(ref)
    if not 1 <= index <= len(doc.sentences):
        raise ValueError(f'{ref}: document "{doc.name}" has {len(doc.sentences)} sentences')
    s = doc.sentences[index - 1]
    if var is None:
        return s
    node = s.node(var)
    if node is None:
        known = ', '.join(n.var for n in s.nodes[:20]) or 'none'
        raise ValueError(f'{ref}: sentence s{index} has no node {var}. Its nodes: {known}')
    return node


# --- gloss lines --------------------------------------------------------------

#: The gloss headers a ``.umr`` file may carry, with the scope each reads at.
HEADERS = {
    'morphemes': ('Morphemes', 'morpheme', False),
    'morpheme-gloss': ('Morpheme Gloss', 'morpheme', True),
    'morpheme-category': ('Morpheme Category', 'morpheme', False),
    'word-gloss': ('Word Gloss', 'word', True),
    'pos': ('Part of Speech', 'word', False),
    'sentence-gloss': ('Sentence Gloss', 'sentence', True),
    'sentence': ('Sentence', 'sentence', False),
}

_NAMED = {'gloss': 'gloss|meaning', 'category': 'cat|pos|part|type|class'}


def propose_ilg(project: UmrProject) -> List[dict]:
    """A mapping proposed from the project's layers, the way the app proposes
    one: the morpheme layer as Morphemes, a morpheme-scoped field named like a
    gloss as Morpheme Gloss, and so on down, then whatever an import stored."""
    out: List[dict] = []
    if project.morpheme_layer_id:
        out.append({'header': 'morphemes', 'lang': None, 'source': 'morphemes'})
    for g in project.gloss_layers:
        header = None
        name = g.name or ''
        if g.scope == 'morpheme':
            if re.search(_NAMED['gloss'], name, re.I):
                header = 'morpheme-gloss'
            elif re.search(_NAMED['category'], name, re.I):
                header = 'morpheme-category'
        elif g.scope == 'word':
            if re.search(_NAMED['gloss'], name, re.I):
                header = 'word-gloss'
            elif re.search(r'pos|part|tag|class', name, re.I):
                header = 'pos'
        elif g.scope == 'sentence' and re.search(r'trans|gloss|free|meaning', name, re.I):
            header = 'sentence-gloss'
        if not header:
            continue
        out.append({'header': header, 'lang': (g.lang or 'und') if HEADERS[header][2] else None,
                    'source': f'layer:{g.id}'})
    out.append({'header': None, 'lang': None, 'source': 'stored'})
    return out


def resolve_ilg(project: UmrProject) -> List[dict]:
    """The project's mapping when it has one, else the proposal."""
    return project.ilg if project.ilg else propose_ilg(project)


def gloss_headers(project: UmrProject) -> List[str]:
    """The gloss lines a sentence is written with, under the names a .umr file
    gives them, for the prompt and the overview."""
    out = []
    for line in resolve_ilg(project):
        spec = HEADERS.get(line.get('header'))
        if spec and line.get('source') != 'stored':
            out.append(spec[0])
    return out


def gloss_values(raw: dict, project: UmrProject) -> Dict[str, Dict[str, str]]:
    """``{layer id: {first token id: value}}`` over the project's gloss layers:
    a span layer's value, read by the first token of each span, which is how
    the app reads one."""
    out: Dict[str, Dict[str, str]] = {}
    wanted = {g.id for g in project.gloss_layers}
    for text_layer in raw.get('text_layers') or []:
        for token_layer in text_layer.get('token_layers') or []:
            for span_layer in token_layer.get('span_layers') or []:
                if span_layer['id'] not in wanted:
                    continue
                values: Dict[str, str] = {}
                for span in span_layer.get('spans') or []:
                    first = (span.get('tokens') or [None])[0]
                    if first is not None and span.get('value') not in (None, ''):
                        values[first] = str(span['value'])
                out[span_layer['id']] = values
    return out


def ilg_lines(sentence: Sentence, project: UmrProject, values: Dict[str, Dict[str, str]],
              mapping: List[dict]) -> List[dict]:
    """The gloss lines of one sentence, in the mapping's order. Each is
    ``{header, key, lang, items}`` where ``items`` is what the file writes."""
    words = sentence.words
    morphemes_by_word = [[m for m in sentence.morphemes if w.begin <= m.begin and m.end <= w.end]
                         for w in words]
    by_id = {g.id: g for g in project.gloss_layers}
    produced = set()
    lines: List[dict] = []
    for entry in mapping:
        if entry.get('source') == 'stored':
            continue
        key = entry.get('header')
        spec = HEADERS.get(key)
        if not spec:
            continue
        header, _scope, takes_lang = spec
        base = {'header': header, 'key': key,
                'lang': (entry.get('lang') or 'und') if takes_lang else None}
        if entry['source'] == 'morphemes':
            lines.append({**base, 'items': [m.text or MISSING
                                            for group in morphemes_by_word for m in group]})
            produced.add(key)
            continue
        layer_id = str(entry['source']).replace('layer:', '', 1)
        g = by_id.get(layer_id)
        if g is None:
            continue
        value_of = values.get(layer_id) or {}
        if g.scope == 'morpheme':
            items = [value_of.get(m.id) or MISSING for group in morphemes_by_word for m in group]
        elif g.scope == 'word':
            items = [value_of.get(w.id) or MISSING for w in words]
        else:
            items = [part for part in (value_of.get(sentence.id) or '').split() if part]
            if not items:
                continue
        lines.append({**base, 'items': items})
        produced.add(key)

    if any(e.get('source') == 'stored' for e in mapping):
        for line in sentence.stored_ilg:
            if line.get('key') in HEADERS and line.get('key') in produced:
                continue
            lines.append(dict(line))
    return lines


# --- rendering ----------------------------------------------------------------

def render_sentence(doc: UmrDoc, sentence: Sentence, *, lines: Optional[List[dict]] = None,
                    graph: bool = True) -> str:
    """One sentence as the model reads it: the words with their numbers, the
    gloss lines, the graph as PENMAN, and any document-level triple written in
    this sentence's block."""
    out = [f'# sent_id = s{sentence.index}']
    if sentence.text:
        out.append(f'# text = {sentence.text}')
    out.append('Words: ' + ' '.join(f'{w.index}={w.text}' for w in sentence.words))
    for line in lines or []:
        label = line.get('header') or line.get('key') or ''
        lang = line.get('lang')
        out.append(f'{label}{f" ({lang})" if lang else ""}: ' + ' '.join(str(i) for i in line.get('items') or []))
    if graph:
        text = penman_of(doc, sentence)
        if text:
            out.append('Graph:')
            out.append(text)
            out.append('Alignment: ' + (_alignment_line(sentence) or '(nothing aligned)'))
        elif sentence.raw_graph:
            out.append('Graph: the file\'s graph could not be read and is kept as text:')
            out.append(sentence.raw_graph)
        else:
            out.append('Graph: none yet.')
    if sentence.triples:
        out.append('Document-level triples written here:')
        for t in sentence.triples:
            out.append(f'  ({_name_of(doc, t.source)} {t.rel} {_name_of(doc, t.target)})  [{t.group}]')
    return '\n'.join(out)


def _alignment_line(sentence: Sentence) -> str:
    parts = []
    for node in sentence.nodes:
        ranges = ','.join(f'{a}-{b}' for a, b in node.alignment) or '0-0'
        parts.append(f'{node.var}: {ranges}')
    return '  '.join(parts)


def _name_of(doc: UmrDoc, span_id: str) -> str:
    node = doc.nodes_by_id.get(span_id)
    return node.var if node is not None else span_id


def render_document(doc: UmrDoc, project: UmrProject, values: Dict[str, Dict[str, str]],
                    *, from_sentence: int = None, to_sentence: int = None,
                    indexes: Optional[List[int]] = None, budget: Optional[int] = None) -> str:
    """A document as the model reads it, either a range or an explicit list of
    sentence numbers. Sentences are rendered until the character budget is
    spent, and the header says which were shown and where to continue."""
    sentences = doc.sentences
    out = [f'Document "{doc.name}" ({len(sentences)} sentences, {doc.node_count} nodes)']
    for k in sorted(doc.metadata):
        if isinstance(doc.metadata[k], str) and doc.metadata[k]:
            out.append(f'# {k} = {doc.metadata[k]}')
    if not sentences:
        out.append('The document has no sentences yet: it has not been tokenized.')
        return '\n'.join(out)

    if indexes is not None:
        wanted = [i for i in indexes if 1 <= i <= len(sentences)]
        if not wanted:
            out.append('None of those sentences exist.')
            return '\n'.join(out)
    else:
        lo = max(1, from_sentence or 1)
        hi = min(len(sentences), to_sentence or len(sentences))
        wanted = list(range(lo, hi + 1))

    mapping = resolve_ilg(project)
    rendered: List[str] = []
    shown: List[int] = []
    used = sum(len(line) + 1 for line in out) + 200
    for i in wanted:
        s = sentences[i - 1]
        text = render_sentence(doc, s, lines=ilg_lines(s, project, values, mapping))
        if budget is not None and shown and used + len(text) + 1 > budget:
            break
        rendered.append(text)
        shown.append(i)
        used += len(text) + 1

    left = [i for i in wanted if i not in shown]
    if indexes is not None:
        head = 'Showing sentences ' + ', '.join(str(i) for i in shown) + '.'
        if left:
            head += (f' Sentences {", ".join(str(i) for i in left)} did not fit: ask for them in '
                     f'another call.')
    else:
        head = f'Showing sentences {shown[0]} to {shown[-1]}'
        if left:
            head += (f' of the {wanted[0]} to {wanted[-1]} asked for: the rest did not fit. '
                     f'Continue with from_sentence={left[0]}.')
        elif shown[0] > 1 or shown[-1] < len(sentences):
            head += '.'
        else:
            head = ''
    if head:
        out.append(head)
    for text in rendered:
        out.append('')
        out.append(text)
    return '\n'.join(out)


def render_document_graph(doc: UmrDoc) -> str:
    """Every document-level triple, by group, with the sentence each of its
    ends belongs to. A constant belongs to no sentence."""
    by_group: Dict[str, List[Triple]] = {g: [] for g in GROUPS}
    seen = set()
    for s in doc.sentences:
        for t in s.triples:
            if t.id in seen:
                continue
            seen.add(t.id)
            by_group.setdefault(t.group, []).append(t)
    out = [f'Document "{doc.name}": the document-level graph']
    total = sum(len(v) for v in by_group.values())
    if not total:
        out.append('No temporal, modal or coreference triples yet.')
        return '\n'.join(out)
    for group in GROUPS:
        rows = by_group.get(group) or []
        out.append('')
        out.append(f'{group} ({len(rows)}):')
        if not rows:
            out.append('  none')
        for t in rows:
            out.append(f'  ({_where(doc, t.source)} {t.rel} {_where(doc, t.target)})')
    if doc.constants:
        out.append('')
        out.append('Constants in use: ' + ', '.join(sorted(c.var for c in doc.constants)))
    return '\n'.join(out)


def _where(doc: UmrDoc, span_id: str) -> str:
    node = doc.nodes_by_id.get(span_id)
    if node is None:
        return span_id
    if node.constant:
        return node.var
    return f's{node.sentence}.{node.var}' if node.sentence else node.var
