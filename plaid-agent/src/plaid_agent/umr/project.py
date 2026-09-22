"""The UMR project and document, as the assistant's tools see them.

The storage model itself — which layer is which, how a document reads back as
sentence graphs, what PENMAN means and how a variable is minted — is
``plaid_client.workflows.umr``, which the two bundled UMR services read through
as well. What is here is what only the assistant needs: the project it carries
between turns (its guidelines and its gloss-line mapping), positional
addressing, and rendering a document the way the model reads it.

**Addressing is positional.** ``s3`` is the third sentence and ``s3.s3e`` the
node whose variable is ``s3e`` in it, so the model handles a variable it read
in a graph and never an id.
"""

import re
from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Tuple

from plaid_client.workflows.umr import (
    COREF_RELATIONS, CYCLE_ROLES, DOC_CONSTANTS, Edge, GROUPS, GlossLayer,  # noqa: F401
    MISSING, Morpheme, Piece, Triple, UMR_NAMESPACE as UMR, UmrLayers, Word,  # noqa: F401
    alignment_of, gloss_values, group_of, next_order, penman_nodes, penman_of,  # noqa: F401
    place_attributes, project_language, read_document, reachable_from_root,  # noqa: F401
    resolve_layers, roots_of, umr_config, with_attribute)  # noqa: F401
# A GRAPH node, kept apart from a PENMAN node by name because both appear in
# the same modules here.
from plaid_client.workflows.umr import Node as GNode, Sentence, UmrDocument as UmrDoc

from ..core.guidelines import Guideline, load as load_guidelines
from ..core.project import find_layer  # noqa: F401  (re-exported for the tools)


# --- project ----------------------------------------------------------------

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
    layers: Optional[UmrLayers] = None
    gloss_layers: List[GlossLayer] = dc_field(default_factory=list)
    ilg: Optional[List[dict]] = None
    guidelines: List[Guideline] = dc_field(default_factory=list)

    def read_layer_ids(self) -> List[str]:
        """The layers a document read has to carry, for ``?layers=``. A project
        may hold layers this app never parses (UD's columns where the two share
        a project), and a layer carries its content only when it is named."""
        return self.layers.read_layer_ids()


def load_project(client, project_id: str) -> UmrProject:
    raw = client.projects.get(project_id)
    guidelines = load_guidelines(client, project_id)
    layers = resolve_layers(raw)
    ilg = umr_config(raw).get('ilg')
    return UmrProject(
        id=raw['id'], name=raw.get('name') or '', language=project_language(raw),
        text_layer_id=layers.text_layer['id'], sentence_layer_id=layers.sentence_layer['id'],
        word_layer_id=layers.word_layer['id'], morpheme_layer_id=layers.morpheme_layer_id,
        node_layer_id=layers.node_layer['id'], concept_layer_id=layers.concept_layer['id'],
        relation_layer_id=layers.relation_layer['id'],
        document_graph_layer_id=layers.document_graph_layer['id'],
        layers=layers, gloss_layers=layers.gloss_layers,
        ilg=list(ilg) if isinstance(ilg, list) else None, guidelines=guidelines)


# --- document ---------------------------------------------------------------

def load_document(client, project: UmrProject, document_id: str) -> UmrDoc:
    raw = client.documents.get(document_id, include_body=True, layers=project.read_layer_ids())
    return parse_document(raw, project)


def parse_document(raw: dict, project: UmrProject) -> UmrDoc:
    """A document response as a graph, with the project's gloss values beside
    it. The layers are resolved from the response rather than taken from the
    project, because a read names the layers it wants and the response carries
    content for those only."""
    layers = resolve_layers(raw)
    return read_document(raw, layers, gloss=gloss_values(raw, layers))


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
