"""
UMR drafting service: a language model writes the first draft of a graph.

Proposes a sentence-level UMR graph for every sentence of a document with any
chat model litellm can reach (OpenAI, Anthropic, Gemini, Ollama, vLLM, any
OpenAI-compatible server). The draft is not the annotation: everything it
writes is stamped machine-made, and the annotator corrects it on the canvas.
That is the whole point of the service. The Chinese UMR group measured a
drafted article going from 7-9 hours of annotation to under 3.

Per sentence the prompt carries the numbered words, whatever gloss lines the
project's own layers hold for them (IGT's morphemes, word- and
sentence-scoped fields), and the project's language. The system prompt is a
compact UMR reference: the role inventory, the attributes and their value
sets, the aspect lattice, the PENMAN shape and the alignment block.

The model answers with ONE PENMAN graph and an `# alignment:` block, which is
read here into the same storage the `.umr` importer writes: one node token per
contiguous anchor piece (the whole sentence when the concept is not overtly
realized), one concept span per node carrying
`metadata.umr = {var, attrs, root?}`, and one relation per edge carrying
`metadata.umr = {order}`. Variables are re-generated under the project's own
rule (`s{N}{initial}{counter}`, unique per document), so a model that invents
its own naming cannot collide with what is already stored.

The PENMAN reader here is this file's own (`parse_penman`), a port of the
app's `src/domain/format/penman.js`, rather than the `penman` PyPI package:
the app's grammar is the one `umrtools/validate.py` scans, the service needs
child ORDER (attributes and edges share one order space) and it must ship in
the release jar without adding a dependency.

    python services/umr_draft_llm.py --url http://localhost:8085 --model openai/gpt-4o-mini
    python services/umr_draft_llm.py --url ... --model ollama/llama3.1
    python services/umr_draft_llm.py --url ... --model openai/my-model --api-base http://gpu-box:8000/v1

Keys come from the provider's environment variable or --api-key.
Requirements (on top of plaid-client): litellm.
"""

import argparse
import contextlib
import re
from typing import Any, Dict, List, Optional

from plaid_client import (BaseService, TASKS, Param, ROLES, find_by_role,
                          stamp_inferred, service_source)
from plaid_client.service import check_unchanged, progress_heartbeat, requester_message
from plaid_client.workflows.llm import ChatModel, add_model_arguments, setup_service

DEFAULT_SERVICE_ID = 'umr-draft-llm'

#: The app's private config namespace. Substrate layers are found by their
#: cross-app `config.plaid.role`; the layers UMR owns carry a flag under this
#: one (src/utils/umrLayerUtils.js).
UMR_NAMESPACE = 'umr'

SUMMARY = """\
**Draft with a language model** writes a first UMR graph for each sentence of
the document: concepts, roles, attributes and word alignments, ready to be
corrected on the canvas.

Each sentence is sent with its numbered words and whatever gloss lines the
project already holds for them, plus the project's language. The model answers
with one PENMAN graph and an alignment block, which land as nodes, edges and
anchors.

- **Scope**: the whole document, or one sentence by its number.
- **Sentence**: which sentence to draft, when the scope is one sentence.
- **Overwrite existing graphs**: off by default, so a sentence that already
  has nodes is left alone and counted. Enable it to replace those graphs,
  discarding their nodes, edges and anchors.

Everything it writes is stamped machine-made and shows as unverified until a
person edits or confirms it.
"""

# The compact UMR reference the model works from: drawn from the schema tables
# in docs/umr/DIGEST.md, not from the full guidelines, which no prompt budget
# survives. Roles, attribute value sets and the aspect lattice are listed in
# full because an off-inventory value is a correction the annotator has to make
# by hand; everything else is named rather than enumerated.
SYSTEM_PROMPT = """\
You are an expert annotator of Uniform Meaning Representation (UMR). Given one
sentence with its numbered words, write that sentence's sentence-level graph.

GRAPH SHAPE. PENMAN notation: (variable / concept :role value :role value ...).
A value is a nested node, a bare variable defined elsewhere in the same graph
(re-entrancy), a quoted string, or an atom. One graph, one root, every variable
defined once. A concept is a lemma; an eventive concept carries a PropBank-style
sense number (say-01, run-02) and takes :ARG0 through :ARG5. Inverse roles
(:ARG0-of, :actor-of) put the argument at the head and keep the graph acyclic.

ROLES. Participant: :actor :co-actor :undergoer :theme :recipient :force :causer
:experiencer :stimulus :instrument :companion :material :source :place :start
:goal :affectee :cause :manner :reason :purpose :result :temporal :extent
:other-role. Non-participant: :direction :path :quant :degree :duration
:frequency :mod :topic :vocative :medium :possessor :part :group :age :example
:ord :list-item. Spatial: :size :color :configuration :orientation :anchor :axis.
Also :name (to a (n / name :op1 "..." :op2 "...")) and :wiki (a quoted Wikidata
id). Every role starts with a colon.

ATTRIBUTES take an atom, never a node. :aspect on every event, one of: habitual
generic imperfective state reversible-state irreversible-state point-state
inherent-state process atelic-process activity directed-activity
undirected-activity iterative perfective endeavor semelfactive
undirected-endeavor directed-endeavor performance inceptive
incremental-accomplishment nonincremental-accomplishment directed-achievement
reversible-directed-achievement irreversible-directed-achievement.
:modal-strength one of full-affirmative partial-affirmative neutral-affirmative
neutral-negative partial-negative full-negative. :polarity - or +. :mode
interrogative, imperative or expressive. :refer-person non-1st non-3rd 1st 2nd
3rd 1st-inclusive 1st-exclusive. :refer-number singular nonsingular paucal plural
dual trial. :degree downtoner or equal. :polite + or -. :quant a number.

ABSTRACT CONCEPTS where no word carries the meaning: person thing animal event
place temporal quantity; umr-unknown truth-value umr-choice umr-empty;
date-entity with :year :month :day :weekday :time; and the -91 rolesets
(identity-91, have-role-91, have-mod-91, have-quant-91, exist-91, have-place-91,
have-possession-91, say-91, publication-91), which are ordinary nodes with :ARGn
children.

OUTPUT. First the PENMAN graph. Then a line reading exactly `# alignment:`. Then
one line per variable in the graph, `variable: begin-end`, where begin and end
are 1-based inclusive indices into the numbered words, `0-0` for a concept no
word realizes, and comma-separated ranges for a discontiguous anchor. List every
variable of the graph exactly once. Write nothing else: no prose, no explanation,
no code fences, no other comment lines."""


# --- the PENMAN reader ----------------------------------------------------------
# A port of src/domain/format/penman.js: the grammar umrtools/validate.py scans,
# not a generic PENMAN one. Never raises; what it cannot read becomes an error.

#: Concepts, atoms and variables stop at whitespace, brackets, a colon or a
#: comment (validate.py:390).
_TOKEN = re.compile(r'[^\s():#]+')
#: The UMR variable convention, UFAL's regex (validate.py:142). The letter run
#: may be non-ASCII, so a plain [a-z] would be wrong; Python's `re` has no
#: `\p{Ll}`, so this takes any letter where the spec takes a lowercase one. It
#: only ever reads MORE tokens as node references, never fewer, and the service
#: re-generates every variable it writes, so the difference costs nothing.
_VARIABLE = re.compile(r'^s[0-9]+[^\W\d_]+[0-9]*$', re.UNICODE)
_VARIABLE_PREFIX = re.compile(r's[0-9]+[^\W\d_]+[0-9]*', re.UNICODE)
#: A relation label: a colon then letters, digits and hyphens (validate.py:391).
_RELATION = re.compile(r':[-A-Za-z0-9]+')
_STRING = re.compile(r'"(?:\\.|[^"\\])*"')
_DEFINITION = re.compile(r'\(\s*([^\s():#]+)\s*/')


def _mask_literals(text: str) -> str:
    """Blank strings and comments so the definition scan cannot mistake their
    contents for graph text. Lengths are preserved."""
    out = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '"':
            m = _STRING.match(text, i)
            length = len(m.group(0)) if m else len(text) - i
            out.append(' ' * length)
            i += length
        elif ch == '#':
            while i < len(text) and text[i] != '\n':
                out.append(' ')
                i += 1
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def _variable_from(token: str) -> str:
    m = _VARIABLE_PREFIX.match(token)
    return m.group(0) if m else token


class _Scanner:
    def __init__(self, text: str):
        self.text = text
        self.i = 0

    @property
    def done(self) -> bool:
        return self.i >= len(self.text)

    def peek(self) -> str:
        return self.text[self.i] if self.i < len(self.text) else ''

    def skip(self) -> None:
        while True:
            while not self.done and self.text[self.i].isspace():
                self.i += 1
            if self.peek() == '#':
                while not self.done and self.text[self.i] != '\n':
                    self.i += 1
                continue
            return

    def take(self, pattern) -> Optional[str]:
        m = pattern.match(self.text, self.i)
        if not m:
            return None
        self.i = m.end()
        return m.group(0)

    def rest(self) -> str:
        end = self.text.find('\n', self.i)
        return self.text[self.i:(len(self.text) if end == -1 else end)].strip()


def parse_penman(text: str) -> Dict[str, Any]:
    """Read PENMAN text into ``{root, nodes, errors}``.

    ``nodes`` maps a variable to ``{'var', 'concept', 'children'}`` in written
    order; each child is ``{'rel', 'kind', 'value'}`` with ``kind`` one of
    ``'node'`` (the value is the target variable), ``'string'`` (quotes kept)
    or ``'atom'``. Whether a bare token is a reference or an atom cannot be
    decided locally (a reference may point forward), so the text is scanned for
    definitions first.
    """
    source = text if isinstance(text, str) else ''
    errors: List[str] = []
    nodes: Dict[str, Any] = {}
    defined = {_variable_from(m.group(1)) for m in _DEFINITION.finditer(_mask_literals(source))}
    scanner = _Scanner(source)

    def read_value(children, rel):
        scanner.skip()
        ch = scanner.peek()
        if ch == '(':
            child = read_node()
            children.append({'rel': rel, 'kind': 'node', 'value': child})
            return
        if ch == '"':
            raw = scanner.take(_STRING)
            if raw is None:
                errors.append(f'Unterminated string: {scanner.rest()}')
                scanner.i = len(scanner.text)
                return
            children.append({'rel': rel, 'kind': 'string', 'value': raw})
            return
        token = scanner.take(_TOKEN)
        if token is None:
            errors.append(f"Expected a value after '{rel}', found "
                          f"'{scanner.rest() or 'end of graph'}'.")
            return
        if token in defined:
            children.append({'rel': rel, 'kind': 'node', 'value': token})
            return
        if _VARIABLE.match(token):
            errors.append(f"The node id '{token}' is unknown. No such node is defined.")
            children.append({'rel': rel, 'kind': 'node', 'value': token})
            return
        children.append({'rel': rel, 'kind': 'atom', 'value': token})

    def read_node():
        scanner.i += 1  # the '('
        scanner.skip()
        variable = scanner.take(_VARIABLE_PREFIX) or scanner.take(_TOKEN)
        if variable is None:
            errors.append(f"Expected a node variable, found '{scanner.rest()}'.")
            return None
        scanner.skip()
        if scanner.peek() == '/':
            scanner.i += 1
            scanner.skip()
        else:
            errors.append(f"Expected a slash and a concept after '{variable}'.")
        concept = None if scanner.peek() == ')' else scanner.take(_TOKEN)
        if concept is None:
            errors.append(f"Expected a concept for '{variable}'.")
        node = {'var': variable, 'concept': concept or '', 'children': []}
        if variable in nodes:
            errors.append(f"The node id '{variable}' is not unique.")
        else:
            nodes[variable] = node

        while True:
            scanner.skip()
            if scanner.done:
                errors.append(f"The graph ended without closing node '{variable}'.")
                return variable
            ch = scanner.peek()
            if ch == ')':
                scanner.i += 1
                return variable
            if ch == ':':
                rel = scanner.take(_RELATION)
                if rel is None:
                    errors.append(f"Expected a relation label, found '{scanner.rest()}'.")
                    scanner.i += 1
                    continue
                read_value(node['children'], rel)
                continue
            errors.append(f"Expected a relation or a closing bracket, found '{scanner.rest()}'.")
            if scanner.take(_TOKEN) is None:
                scanner.i += 1

    scanner.skip()
    if scanner.done:
        return {'root': None, 'nodes': nodes, 'errors': ['The reply carries no graph.']}
    if scanner.peek() != '(':
        return {'root': None, 'nodes': nodes,
                'errors': [f"Expected the root node's opening bracket, found '{scanner.rest()}'."]}
    root = read_node()
    scanner.skip()
    if not scanner.done:
        errors.append(f"Unexpected content after the last closing bracket: '{scanner.rest()}'.")
    return {'root': root, 'nodes': nodes, 'errors': errors}


#: One alignment line: a variable, an optional space, a colon, then ranges.
#: Spacing varies across released files (`s1p: 1-1`, `s1a :0-0`), and both parse.
_ALIGNMENT_LINE = re.compile(r'^\s*([^\s:]+)\s*:\s*(.+?)\s*$')
_RANGE = re.compile(r'^([0-9]+)-([0-9]+)$')


def parse_alignment(text: str) -> Dict[str, List[Any]]:
    """Read the alignment block into ``{variable: [(begin, end), ...]}``.

    ``0-0`` (not overtly realized) reads as an empty list, which is what an
    unaligned node is. A line that cannot be read is dropped: the node then
    falls back to unaligned, which the annotator fixes with one gesture, where
    refusing the whole sentence would throw away a usable graph.
    """
    out: Dict[str, List[Any]] = {}
    for line in (text or '').splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith('#'):
            continue
        m = _ALIGNMENT_LINE.match(stripped)
        if not m:
            continue
        variable, body = m.group(1), m.group(2)
        ranges = []
        for piece in body.split(','):
            r = _RANGE.match(piece.strip())
            if not r:
                ranges = []
                break
            begin, end = int(r.group(1)), int(r.group(2))
            if begin == 0 or end == 0 or end < begin:
                continue
            ranges.append((begin, end))
        out[variable] = ranges
    return out


_FENCE = re.compile(r'^\s*```[A-Za-z]*\s*$')
_ALIGNMENT_HEADER = re.compile(r'^\s*#\s*alignment\s*:?\s*$', re.IGNORECASE)


def split_reply(text: str):
    """The graph half and the alignment half of one reply.

    Code fences are dropped: a model that has been told not to write them still
    does, and a fence is the one piece of stray text worth forgiving rather
    than failing a sentence over.
    """
    lines = [line for line in (text or '').splitlines() if not _FENCE.match(line)]
    for i, line in enumerate(lines):
        if _ALIGNMENT_HEADER.match(line):
            return '\n'.join(lines[:i]), '\n'.join(lines[i + 1:])
    return '\n'.join(lines), ''


# --- the storage model ----------------------------------------------------------

def next_variable(sentence_index: int, concept: str, taken) -> str:
    """The project's variable rule (src/domain/sentenceGraph.js `nextVariable`):
    ``s{N}{concept's first letter}`` plus a counter until it is unused. A
    concept whose first character is not a lowercase letter falls back to `x`,
    which is why the Chinese data is full of `s1x35`."""
    first = str(concept or '')[:1].lower()
    letter = first if first.isalpha() and first.islower() else 'x'
    base = f's{sentence_index}{letter}'
    if base not in taken:
        return base
    n = 2
    while f'{base}{n}' in taken:
        n += 1
    return f'{base}{n}'


def anchor_pieces(ranges, words, sentence_extent):
    """The anchor tokens for one node: one piece per aligned word range, or one
    piece over the whole sentence when the concept is not overtly realized
    (which is how the importer stores a node aligned to no word: what says it
    is unaligned is its sentence record, not the anchor)."""
    pieces = []
    for begin, end in ranges or []:
        first = words[begin - 1] if 0 < begin <= len(words) else None
        last = words[end - 1] if 0 < end <= len(words) else None
        if first is None or last is None:
            continue
        pieces.append((first['begin'], last['end']))
    return pieces or [tuple(sentence_extent)]


def plan_sentence(graph, alignment, sentence, taken):
    """One sentence's draft as writes: ``(pieces, nodes, edges)``.

    ``pieces`` are token extents; a node names the pieces it takes by index and
    carries the `umr` half of its metadata; an edge names its endpoints by node
    index. Attributes and edges share ONE order space, the child's position in
    the PENMAN node, so the canvas and the exporter read them back in the order
    the model wrote them.
    """
    nodes_by_var = graph['nodes']
    order_of_var = list(nodes_by_var)
    index_of_var = {}
    variables = {}
    pieces = []
    nodes = []
    edges = []

    for var in order_of_var:
        variables[var] = next_variable(sentence['index'], nodes_by_var[var]['concept'], taken)
        taken.add(variables[var])

    for var in order_of_var:
        node = nodes_by_var[var]
        first_piece = len(pieces)
        unaligned_extent = (sentence['begin'], sentence['end'])
        extents = anchor_pieces(alignment.get(var), sentence['words'], unaligned_extent)
        pieces.extend(extents)
        attrs = []
        for order, child in enumerate(node['children']):
            if child['kind'] != 'node':
                attrs.append({'rel': child['rel'], 'value': child['value'], 'order': order})
        meta = {'var': variables[var], 'attrs': attrs}
        if var == graph['root']:
            meta['root'] = True
        # A node aligned to no word records its sentence, as the app does: the
        # record is what says so, and the anchor covers the whole sentence, so
        # an edit to the text around it resizes the anchor rather than taking
        # the node with it (plaid-umr src/domain/umrReconcile.js).
        if list(extents) == [unaligned_extent] and sentence.get('token_id'):
            meta['sentence'] = sentence['token_id']
        index_of_var[var] = len(nodes)
        nodes.append({'concept': node['concept'], 'meta': meta,
                      'piece_indexes': list(range(first_piece, len(pieces)))})

    for var in order_of_var:
        for order, child in enumerate(nodes_by_var[var]['children']):
            if child['kind'] != 'node':
                continue
            target = index_of_var.get(child['value'])
            if target is None:
                continue
            edges.append({'source': index_of_var[var], 'target': target,
                          'role': child['rel'], 'order': order})
    return pieces, nodes, edges


def validate_graph(graph) -> Optional[str]:
    """What is wrong with a parsed graph, in one line for the requester, or
    None. Everything here would otherwise land as an unreadable node the
    annotator has to find and delete."""
    if graph['errors']:
        return graph['errors'][0]
    if not graph['root'] or graph['root'] not in graph['nodes']:
        return 'The reply carries no graph.'
    for var, node in graph['nodes'].items():
        if not node['concept']:
            return f"The node {var} has no concept."
        for child in node['children']:
            if not str(child['rel']).startswith(':'):
                return f"The relation {child['rel']} on {var} does not start with a colon."
            if child['kind'] == 'node' and child['value'] not in graph['nodes']:
                return f"{var} {child['rel']} names {child['value']}, which no node defines."
    return None


# --- reading the document -------------------------------------------------------

def _flag(layer, flag) -> bool:
    return ((layer or {}).get('config') or {}).get(UMR_NAMESPACE, {}).get(flag) is True


def _find_flagged(layers, flag):
    for layer in layers or []:
        if _flag(layer, flag):
            return layer
    return None


def resolve_layers(document):
    """The layers this service reads and writes, by the same rules as
    `src/utils/umrLayerUtils.js`: the substrate by its cross-app
    `config.plaid.role`, everything UMR owns by its `config.umr` flag. Raises
    rather than guessing, so a mistagged project fails loudly."""
    text_layers = document.get('text_layers') or []
    text_layer = find_by_role(text_layers, ROLES.BASELINE) or (text_layers[0] if text_layers else None)
    if not text_layer:
        raise ValueError('The project has no baseline text layer.')
    token_layers = text_layer.get('token_layers') or []
    node_layer = _find_flagged(token_layers, 'nodes')
    concept_layer = _find_flagged((node_layer or {}).get('span_layers'), 'concepts')
    relation_layer = _find_flagged((concept_layer or {}).get('relation_layers'), 'relations')
    info = {
        'text_layer': text_layer,
        'text_id': (text_layer.get('text') or {}).get('id'),
        'body': (text_layer.get('text') or {}).get('body') or '',
        'sentence_layer': find_by_role(token_layers, ROLES.SENTENCE),
        'word_layer': find_by_role(token_layers, ROLES.WORD),
        'morpheme_layer': find_by_role(token_layers, ROLES.MORPHEME),
        'node_layer': node_layer,
        'concept_layer': concept_layer,
        'relation_layer': relation_layer,
    }
    missing = [name for name in ('sentence_layer', 'word_layer', 'node_layer',
                                'concept_layer', 'relation_layer') if not info[name]]
    if missing:
        raise ValueError('The document is not set up for UMR: it is missing the '
                         + ', '.join(name.replace('_', ' ') for name in missing) + '.')
    return info


def _cp_slice(body, begin, end):
    """The body between two CODE POINT offsets. Plaid's offsets are code points
    everywhere; Python strings are too, so this is a plain slice, named so the
    rule is visible."""
    return body[begin:end]


def gloss_layers_of(info):
    """Another app's annotation layers over the substrate, which the prompt can
    read as gloss lines: a span layer says its scope in `config.igt.scope`, and
    one that says nothing takes the scope of the token layer it hangs off
    (src/utils/umrLayerUtils.js). UMR's own layers are never gloss lines."""
    out = []
    for token_layer, default_scope in ((info['sentence_layer'], 'sentence'),
                                       (info['word_layer'], 'word'),
                                       (info['morpheme_layer'], 'morpheme')):
        for layer in (token_layer or {}).get('span_layers') or []:
            config = layer.get('config') or {}
            if config.get(UMR_NAMESPACE):
                continue
            declared = str((config.get('igt') or {}).get('scope') or '').lower()
            scope = 'word' if declared == 'token' else (declared or default_scope)
            values = {}
            for span in layer.get('spans') or []:
                tokens = span.get('tokens') or []
                value = span.get('value')
                if tokens and value not in (None, ''):
                    values[tokens[0]] = str(value)
            out.append({'name': layer.get('name') or 'Field', 'scope': scope, 'values': values})
    return out


def read_sentences(info):
    """The document's sentences, each with its words, its morphemes grouped
    under them, and the concept nodes already anchored in it. A CONSTANT
    (`metadata.umr.constant`) belongs to no sentence, which matters because its
    anchor is a zero-width token at offset 0 and would otherwise fall inside
    the first sentence."""
    body = info['body']
    sentence_tokens = sorted(info['sentence_layer'].get('tokens') or [],
                             key=lambda t: (t['begin'], t['end']))
    sentences = []
    for i, token in enumerate(sentence_tokens):
        sentences.append({'index': i + 1, 'token_id': token['id'],
                          'begin': token['begin'], 'end': token['end'],
                          'text': _cp_slice(body, token['begin'], token['end']).strip(),
                          'words': [], 'morphemes': [], 'nodes': []})

    def sentence_of(begin):
        for s in sentences:
            if s['begin'] <= begin < s['end']:
                return s
        return None

    for token in sorted(info['word_layer'].get('tokens') or [],
                        key=lambda t: (t['begin'], t['end'])):
        s = sentence_of(token['begin'])
        if not s:
            continue
        s['words'].append({'id': token['id'], 'index': len(s['words']) + 1,
                           'begin': token['begin'], 'end': token['end'],
                           'text': _cp_slice(body, token['begin'], token['end'])})
    for token in sorted((info['morpheme_layer'] or {}).get('tokens') or [],
                        key=lambda t: (t['begin'], t['end'], t.get('precedence') or 0)):
        s = sentence_of(token['begin'])
        if s:
            s['morphemes'].append({'id': token['id'], 'begin': token['begin'],
                                   'end': token['end']})

    node_tokens = {t['id']: t for t in (info['node_layer'].get('tokens') or [])}
    for span in info['concept_layer'].get('spans') or []:
        meta = (span.get('metadata') or {}).get(UMR_NAMESPACE) or {}
        if meta.get('constant') is True:
            continue
        pieces = sorted((node_tokens[i] for i in (span.get('tokens') or []) if i in node_tokens),
                        key=lambda t: t['begin'])
        s = sentence_of(pieces[0]['begin']) if pieces else None
        if s:
            s['nodes'].append({'id': span['id'], 'var': meta.get('var'),
                               'piece_ids': [p['id'] for p in pieces]})
    return sentences


def taken_variables(info):
    """Every variable the document already uses. Variables are unique per
    DOCUMENT, not per sentence, because the document graph cites an earlier
    sentence's nodes by name."""
    taken = set()
    for span in info['concept_layer'].get('spans') or []:
        var = ((span.get('metadata') or {}).get(UMR_NAMESPACE) or {}).get('var')
        if var:
            taken.add(var)
    return taken


# --- the prompt -----------------------------------------------------------------

def gloss_lines_for(sentence, layers):
    """The project's own annotation of this sentence, as `(name, text)` lines.

    Deliberately flat: each layer is named and its values are listed against
    the word numbers, rather than reproducing the `.umr` token block. The model
    needs to know what the words mean, not what an ILG line looks like."""
    lines = []
    for layer in layers:
        if layer['scope'] == 'sentence':
            value = layer['values'].get(sentence['token_id'])
            if value:
                lines.append((layer['name'], value))
            continue
        if layer['scope'] == 'word':
            items = [layer['values'].get(w['id']) for w in sentence['words']]
        else:
            items = []
            for w in sentence['words']:
                parts = [layer['values'].get(m['id']) or '_'
                         for m in sentence['morphemes']
                         if w['begin'] <= m['begin'] and m['end'] <= w['end']]
                items.append('-'.join(parts) if any(p != '_' for p in parts) else None)
        if not any(items):
            continue
        lines.append((layer['name'],
                      '  '.join(f'{i + 1} {item}' for i, item in enumerate(items) if item)))
    return lines


def build_user_prompt(sentence, gloss_lines, language) -> str:
    parts = []
    if language:
        parts.append(f'Language: {language}.')
    parts.append(f'Sentence {sentence["index"]}: {sentence["text"]}')
    numbered = '\n'.join(f'  {w["index"]} {w["text"]}' for w in sentence['words'])
    parts.append(f'Words (numbered):\n{numbered}')
    for name, text in gloss_lines:
        parts.append(f'{name}: {text}')
    parts.append(f'Write the UMR graph for sentence {sentence["index"]}, then its alignment.')
    return '\n\n'.join(parts)


# --- what the requester is told -------------------------------------------------

def build_draft_notice(drafted, skipped, failed, first_error=None):
    """The toast the editor shows when a run finishes. The service owns the
    wording and the severity; the editor maps `level` to a colour. A run that
    drafted nothing must not congratulate anyone."""
    def s(n):
        return '' if n == 1 else 's'

    tail = []
    if skipped:
        tail.append(f'Skipped {skipped} sentence{s(skipped)} that already had a graph.')
    if failed:
        tail.append(f'Failed {failed} sentence{s(failed)}'
                    + (f': {first_error}' if first_error else '.'))
    if drafted:
        return {'level': 'success', 'title': f'Drafted {drafted} sentence{s(drafted)}',
                'message': ' '.join(tail)}
    if skipped:
        subject = ('1 sentence already has a graph' if skipped == 1
                   else f'All {skipped} sentences already have graphs')
        return {'level': 'warning', 'title': 'Document not modified',
                'message': (f"{subject}. Enable 'Overwrite existing graphs' to draft over them."
                            + (f' Failed {failed} sentence{s(failed)}.' if failed else ''))}
    if failed:
        return {'level': 'warning', 'title': 'Nothing drafted',
                'message': f'Failed {failed} sentence{s(failed)}'
                           + (f': {first_error}' if first_error else '.')}
    return {'level': 'warning', 'title': 'Nothing to draft',
            'message': 'The document has no sentences in scope.'}


# --- progress -------------------------------------------------------------------

class DraftProgress:
    """A fixed percentage budget over the phases, so the bar moves for the same
    reason on every document:

        2-10    reading the document and the project
        10-85   drafting, one model call per sentence
        85-100  writing

    `report` is a CANCELLATION CHECKPOINT (ResponseHelper.progress raises), so
    every call in the write phase sits inside `critical()`.
    """

    READ, DRAFT, WRITE = (2, 10), (10, 85), (85, 100)

    def __init__(self, helper=None):
        self._helper = helper

    @staticmethod
    def _percent(phase, fraction):
        low, high = phase
        return int(low + (high - low) * min(max(fraction, 0.0), 1.0))

    def report(self, phase, fraction, message):
        if self._helper:
            self._helper.progress(self._percent(phase, fraction), message)

    def heartbeat(self, phase, fraction, message):
        """Keep saying `message` through one model call, which reports nothing
        of its own and can outlast a requester's patience with silence."""
        if not self._helper:
            return contextlib.nullcontext()
        return progress_heartbeat(self._helper, self._percent(phase, fraction), message)


# --- the service ----------------------------------------------------------------

class UmrDraftService(BaseService):
    """Drafts UMR graphs with a chat model, one call per sentence.

    Built on the shared BaseService SDK (client bootstrap, registration, the
    single-flight lock, the CLI loop). The model is an OPERATOR choice at
    launch, not a request parameter, so nobody can point the service at another
    endpoint with the operator's key.
    """

    def __init__(self):
        super().__init__(
            service_id=DEFAULT_SERVICE_ID,
            service_name='UMR drafting',
            description='Drafts a sentence-level UMR graph with a language model, for correction '
                        'on the canvas',
            tasks=[TASKS.DRAFT_GRAPH],
            summary=SUMMARY,
            parameters=[
                Param.enum('scope', 'Scope',
                           [('document', 'The whole document'), ('sentence', 'One sentence')],
                           default='document',
                           description='Draft every sentence, or one sentence by its number.'),
                Param.number('sentence', 'Sentence', default=1, min=1,
                             description='Which sentence to draft, when the scope is one sentence.'),
                Param.boolean('overwrite', 'Overwrite existing graphs', default=False,
                              description='Draft over sentences that already have nodes, '
                                          'discarding those graphs. When off, they are left '
                                          'untouched and counted.'),
            ],
        )
        self.model: Optional[ChatModel] = None

    # -- CLI --
    def add_arguments(self, parser: argparse.ArgumentParser) -> None:
        add_model_arguments(parser, default_service_id=DEFAULT_SERVICE_ID)

    def setup(self, args) -> None:
        setup_service(self, args)

    # -- request --
    def process_request(self, request_data: Dict[str, Any], response_helper) -> None:
        document_id = request_data.get('document_id')
        if not document_id:
            response_helper.error('Missing required parameter: documentId')
            return
        project_id = request_data.get('project_id')
        scope = (request_data.get('scope') or 'document').strip()
        overwrite = bool(request_data.get('overwrite', False))
        try:
            wanted = int(request_data.get('sentence') or 1)
        except (TypeError, ValueError):
            wanted = 1

        progress = DraftProgress(response_helper)
        progress.report(DraftProgress.READ, 0.0, 'Reading the document…')
        document = self.client.documents.get(document_id, include_body=True)
        read_version = document.get('version')
        info = resolve_layers(document)
        sentences = read_sentences(info)
        gloss_layers = gloss_layers_of(info)

        # The project's language, the one thing the prompt needs that the
        # document does not carry. Context only: a project that has not set one
        # is drafted without it rather than refused.
        language = ''
        if project_id:
            progress.report(DraftProgress.READ, 0.5, 'Reading the project…')
            try:
                project = self.client.projects.get(project_id)
                language = str(((project.get('config') or {}).get(UMR_NAMESPACE) or {})
                               .get('language') or '').strip()
            except Exception as exc:
                print(f'Could not read the project language: {exc}')

        in_scope = sentences
        if scope == 'sentence':
            in_scope = [s for s in sentences if s['index'] == wanted]
            if not in_scope:
                raise ValueError(f'The document has no sentence {wanted}.')
        targets = [s for s in in_scope if s['words'] and (overwrite or not s['nodes'])]
        skipped = len([s for s in in_scope if s['words'] and s['nodes']]) if not overwrite else 0
        progress.report(DraftProgress.READ, 1.0, 'Reading the document…')

        if not targets:
            notice = build_draft_notice(0, skipped, 0)
            response_helper.progress(100, notice['title'])
            response_helper.complete({'document_id': document_id, 'status': 'success',
                                      'sentences': len(sentences), 'drafted': 0,
                                      'skipped': skipped, 'failed': 0,
                                      'sentences_failed': [], 'notice': notice})
            return

        # One model call per sentence. A sentence the model fails is counted and
        # named; the rest of the document is still drafted, because a run that
        # threw away twenty good graphs over one bad reply would be worse than
        # useless on a long document.
        taken = taken_variables(info)
        if overwrite:
            # The graphs about to be replaced free their variables, so a redraft
            # of sentence 1 writes s1b again rather than s1b2.
            for s in targets:
                for node in s['nodes']:
                    taken.discard(node['var'])
        stamp_detail = {**self.model.describe()}
        if language:
            stamp_detail['language'] = language
        frag = stamp_inferred(service_source(self.service_id), detail=stamp_detail)

        plans = []
        failures = []
        total = len(targets)
        for n, sentence in enumerate(targets):
            message = f'Drafting sentence {sentence["index"]} ({n + 1} of {total})…'
            progress.report(DraftProgress.DRAFT, n / total, message)
            prompt = build_user_prompt(sentence, gloss_lines_for(sentence, gloss_layers), language)
            try:
                with progress.heartbeat(DraftProgress.DRAFT, n / total, message):
                    reply = self.model.complete(SYSTEM_PROMPT, prompt)
            except Exception as exc:
                # The provider's own error text is the operator's: it can carry
                # the endpoint, the request body and the key that was refused.
                print(f'Model call failed for sentence {sentence["index"]}: {exc}')
                failures.append({'sentence': sentence['index'],
                                 'reason': requester_message(exc, secrets=self.REQUEST_SECRETS)})
                continue
            if reply.truncated:
                # Half a graph is not a graph: a cut-off reply is a failure, not
                # a partial result to write.
                failures.append({'sentence': sentence['index'],
                                 'reason': 'the reply was cut off at the token limit'})
                continue
            graph_text, alignment_text = split_reply(reply.text)
            graph = parse_penman(graph_text)
            problem = validate_graph(graph)
            if problem:
                failures.append({'sentence': sentence['index'], 'reason': problem})
                continue
            pieces, nodes, edges = plan_sentence(graph, parse_alignment(alignment_text),
                                                 sentence, taken)
            plans.append({'sentence': sentence, 'pieces': pieces, 'nodes': nodes, 'edges': edges})

        print(self.model.usage_line())
        drafted = len(plans)
        first_error = failures[0]['reason'] if failures else None
        if not plans:
            notice = build_draft_notice(0, skipped, len(failures), first_error)
            response_helper.progress(100, notice['title'])
            response_helper.complete({'document_id': document_id, 'status': 'success',
                                      'sentences': len(sentences), 'drafted': 0,
                                      'skipped': skipped, 'failed': len(failures),
                                      'sentences_failed': failures, 'notice': notice})
            return

        # Everything from here must finish once begun: a stop that arrives while
        # the document is half written would leave anchors with no nodes. The
        # final report is inside the same block, so a checkpoint after the last
        # write cannot throw a finished run away and call it stopped.
        progress.report(DraftProgress.WRITE, 0.0, f'Writing {drafted} graphs…')
        doomed = [pid for plan in plans if overwrite
                  for node in plan['sentence']['nodes'] for pid in node['piece_ids']]
        with response_helper.critical():
            with self.client.operation(f'UMR draft ({drafted} sentences)'):
                with self.client.documents.locked(document_id):
                    # The plans were made from a read taken before the model
                    # ran. If the document has moved since, the ids they point
                    # at and the graphs they were allowed to replace are both
                    # out of date, so nothing is written.
                    check_unchanged(self.client, document_id, read_version)
                    self._write(info, plans, doomed, frag, progress)

            notice = build_draft_notice(drafted, skipped, len(failures), first_error)
            response_helper.progress(100, notice['title'])
            response_helper.complete({'document_id': document_id, 'status': 'success',
                                      'sentences': len(sentences), 'drafted': drafted,
                                      'skipped': skipped, 'failed': len(failures),
                                      'sentences_failed': failures, 'notice': notice})

    def _write(self, info, plans, doomed, frag, progress) -> None:
        """Anchors, then nodes, then edges: three passes, because an op cannot
        reference an id produced earlier in the same batch. The same order the
        `.umr` importer writes in (src/domain/umrImport.js)."""
        if doomed:
            progress.report(DraftProgress.WRITE, 0.1,
                            f'Clearing {len(doomed)} anchors…')
            # The anchors cascade: their concept spans go, and with them the
            # edges and document-level triples that hung off those spans.
            self.client.tokens.bulk_delete(doomed)

        piece_ops = []
        for plan in plans:
            plan['piece_base'] = len(piece_ops)
            piece_ops.extend({'token_layer_id': info['node_layer']['id'],
                              'text': info['text_id'], 'begin': begin, 'end': end}
                             for begin, end in plan['pieces'])
        progress.report(DraftProgress.WRITE, 0.3, f'Writing {len(piece_ops)} anchors…')
        piece_ids = self.client.tokens.bulk_create(piece_ops)['ids'] if piece_ops else []
        if len(piece_ids) != len(piece_ops):
            raise RuntimeError(f'The server returned {len(piece_ids)} anchor ids for '
                               f'{len(piece_ops)} anchors.')

        span_ops = []
        for plan in plans:
            plan['node_base'] = len(span_ops)
            base = plan['piece_base']
            for node in plan['nodes']:
                span_ops.append({
                    'span_layer_id': info['concept_layer']['id'],
                    'tokens': [piece_ids[base + i] for i in node['piece_indexes']],
                    'value': node['concept'],
                    # The provenance stamp is flat and the app's own half sits
                    # beside it under its namespace, exactly as the importer
                    # and the canvas write it.
                    'metadata': {**frag, UMR_NAMESPACE: node['meta']},
                })
        progress.report(DraftProgress.WRITE, 0.6, f'Writing {len(span_ops)} nodes…')
        span_ids = self.client.spans.bulk_create(span_ops)['ids'] if span_ops else []
        if len(span_ids) != len(span_ops):
            raise RuntimeError(f'The server returned {len(span_ids)} node ids for '
                               f'{len(span_ops)} nodes.')

        edge_ops = []
        for plan in plans:
            base = plan['node_base']
            for edge in plan['edges']:
                edge_ops.append({
                    'relation_layer_id': info['relation_layer']['id'],
                    'source': span_ids[base + edge['source']],
                    'target': span_ids[base + edge['target']],
                    'value': edge['role'],
                    'metadata': {**frag, UMR_NAMESPACE: {'order': edge['order']}},
                })
        if edge_ops:
            progress.report(DraftProgress.WRITE, 0.9, f'Writing {len(edge_ops)} relations…')
            self.client.relations.bulk_create(edge_ops)


def main():
    UmrDraftService().run()


if __name__ == '__main__':
    # CLI (handled by BaseService.run):
    #   python umr_draft_llm.py --model openai/gpt-4o-mini            → every accessible project
    #   python umr_draft_llm.py --model ... PROJECT_ID                → one project
    #   --url URL                                                     → Plaid API URL (default :8080)
    main()
