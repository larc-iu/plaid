"""PENMAN notation, the grammar the UMR validator scans.

A sentence graph is written the way ``umrtools/validate.py`` reads it, not the
way a generic PENMAN library would: a node is ``(variable / concept)`` followed
by any number of ``:relation value`` children, where a value is a child node, a
bare variable (re-entrancy), a quoted string or an atom.

Whether a bare token is a node reference or an atom cannot be decided locally,
because a reference may point forward. So the text is scanned once for
``( var /`` definitions before it is parsed, and the parser consults that set.
A token shaped like a variable that was never defined is still read as a
reference, so the caller sees the dangling edge rather than a silent atom.

This is the Python side of ``plaid-umr/src/domain/format/penman.js``, and it is
a PORT rather than an adaptation: a writer writes a graph back to the sites it
read it from, and a diff compares its own serialization against the app's. Two
readings of one text would show up as phantom changes.
``plaid-agent/tests/test_penman_mirror.py`` holds the two sides together.
"""

import re
import unicodedata
from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Set, Tuple

from .inventory import LIST_ITEM_ATTRIBUTES, list_item_problem

# Concepts, atoms and variables all stop at whitespace, brackets, a colon or
# the start of a comment (validate.py:390).
TOKEN = re.compile(r'[^\s():#]+')

#: A time of day, the one value that holds a colon (validate.py:393 reads
#: ``23:45`` as a number). Only in a value: a concept still stops at the colon.
TIME = re.compile(r'[0-9]+:[0-9]+(?![^\s()#])')

#: The front of the UMR variable convention, UFAL's own (validate.py:142):
#: ``s`` then digits. The letter run after it is matched by hand, because the
#: spec's ``\p{Ll}`` is a Unicode general category and Python's ``re`` has no
#: property escapes. See ``variable_length``.
_VARIABLE_HEAD = re.compile(r's[0-9]+')

RELATION = re.compile(r':[-A-Za-z0-9]+')
STRING = re.compile(r'"(?:\\.|[^"\\])*"')

NODE = 'node'
ATOM = 'atom'
STRING_KIND = 'string'


def is_lower_letter(ch: str) -> bool:
    """Unicode general category Ll, which is what the spec's ``\\p{Ll}`` and the
    app's own regex mean. ``str.islower`` is wider (it takes the Other_Lowercase
    characters too), so the category is read directly."""
    return len(ch) == 1 and unicodedata.category(ch) == 'Ll'


def variable_length(text: str, pos: int = 0) -> int:
    """How many characters at ``pos`` form a UMR variable, or 0.

    ``s`` + digits + at least one lowercase letter + optional digits, which is
    UFAL's ``^s[0-9]+\\p{Ll}+[0-9]*$``. Released files write ``(s6t/ thing)``
    with no space before the slash, and the validator reads the variable off the
    front just like this, so the match is a PREFIX and the caller decides
    whether the whole token had to be one.
    """
    source = text or ''
    m = _VARIABLE_HEAD.match(source, pos)
    if not m:
        return 0
    i = m.end()
    letters = 0
    while i < len(source) and is_lower_letter(source[i]):
        i += 1
        letters += 1
    if not letters:
        return 0
    while i < len(source) and '0' <= source[i] <= '9':
        i += 1
    return i - pos


def is_variable(token: str) -> bool:
    """Whether a token is, in whole, a UMR variable."""
    text = token or ''
    return bool(text) and variable_length(text) == len(text)


def variable_from(token: str) -> str:
    """The variable at the front of a token, or the token. ``s6t/`` is ``s6t``."""
    length = variable_length(token or '')
    return (token or '')[:length] if length else token


# What a concept or a bare value cannot hold: what ends a TOKEN, and a quote,
# which starts a string. Written anyway, the value reads back as something
# else (`big dog` as `big`, a line break and `:ARG0 (...)` as an extra node).
# U+FEFF is whitespace to the app's reader (JavaScript's \s) and not to
# Python's, so it is named.
_NOT_IN_TOKEN = re.compile(r'[\s\ufeff():#"]')


def concept_problem(concept) -> Optional[str]:
    """Why ``concept`` cannot be written as PENMAN, or None when it can. The
    app's ``conceptProblem``, which every editor path asks."""
    text = concept if isinstance(concept, str) else ''
    if not text:
        return 'A node needs a concept.'
    if _NOT_IN_TOKEN.search(text):
        return f'A concept cannot hold spaces, brackets, colons, quotes or #: {text}'
    return None


def relation_form_problem(relation) -> Optional[str]:
    """Why ``relation`` cannot be written as a PENMAN relation, or None when it
    can: a colon, then letters, digits and hyphens only. The app's
    ``relationProblem`` (its form half), except that the colon is required,
    since a stored relation is written exactly as it is."""
    text = relation if isinstance(relation, str) else ''
    if re.fullmatch(r':[-A-Za-z0-9]+', text):
        return None
    bare = text.strip()[1:] if text.strip().startswith(':') else text.strip()
    if not bare:
        return 'A relation needs a name after its colon.'
    return f'A relation holds letters, digits and hyphens only, after a colon: {text}'


def attr_value_problem(value) -> Optional[str]:
    """Why ``value`` cannot be written as an attribute's value, or None when it
    can. A quoted string may hold anything but a line break (the .umr file is
    split by line before PENMAN reads it); a bare atom stops where a token
    stops. The app's ``attrValueProblem``."""
    text = str(value if value is not None else '').strip()
    if not text:
        return 'An attribute needs a value.'
    if text.startswith('"'):
        m = STRING.match(text)
        if not m or m.group(0) != text:
            return f'A quoted value needs its closing quote: {text}'
        if '\n' in text or '\r' in text:
            return f'A value cannot hold a line break: {text}'
        return None
    if '"' in text:
        return f'A value holds a quote only around the whole of it: {text}'
    if TIME.fullmatch(text):
        return None
    if _NOT_IN_TOKEN.search(text):
        return f'A value cannot hold spaces, brackets, colons or #, unless it is quoted: {text}'
    if is_variable(text):
        # Read back as a reference to a node, not as the value.
        return f'A value cannot be a variable, unless it is quoted: {text}'
    return None


# The bare values validate.py reads (validate.py:393-398): an atom of
# lowercase letters, digits, `+` and `-`, or a number with a decimal point or
# a time's colon. An atom with a capital or an underscore is read and reported.
_GRAMMAR_ATOM = re.compile(r'[-+a-z0-9]+')
_GRAMMAR_NUMBER = re.compile(r'[0-9]+(?:[.:][0-9]+)?')
_GRAMMAR_UPPER_ATOM = re.compile(r'[-+a-z0-9A-Z_]+')


def value_grammar_problem(value, rel: Optional[str] = None) -> Optional[Dict[str, str]]:
    """Why validate.py cannot read ``value``, an attribute's value as it is
    stored (a string with its quotes, else a bare value), as ``{'code',
    'message'}`` with its test id, or None when it reads it. A string holds no
    quote and no line break and is not empty; a bare value is an atom of
    lowercase letters, digits, ``+`` and ``-``, or a number, and does not start
    like a variable (validate.py reads ``s1x-b`` as ``s1x``). What is NEW is
    refused with this (ruled 2026-09-28), and an imported value is only
    reported. The app's ``valueGrammarProblem`` in ``format/validate.js``, held
    to it by ``plaid-agent/tests/test_penman_mirror.py``."""
    text = str(value if value is not None else '')
    of = f" of '{rel}'" if rel else ''
    if text.startswith('"'):
        m = re.fullmatch(r'"([\s\S]*)"', text)
        if not m:
            return None  # An unclosed string is the export's refusal.
        inner = m.group(1)
        if re.search('[\r\n\u2028\u2029]', inner):
            return {'code': 'invalid-line',
                    'message': f'The string value{of} runs over more than one line.'}
        if not inner:
            return {'code': 'missing-node-definition',
                    'message': f'The string value{of} is empty.'}
        if '"' in inner:
            return {'code': 'invalid-sentence-level',
                    'message': f'The string value{of} holds a quote: {text}'}
        return None
    front = variable_length(text)
    if front:
        return {'code': 'invalid-sentence-level',
                'message': f"The value '{text}'{of} is read as the variable "
                           f"'{text[:front]}'. Quote it."}
    if _GRAMMAR_ATOM.fullmatch(text) or _GRAMMAR_NUMBER.fullmatch(text):
        # A list item's value is a whole number or a quoted label.
        listed = list_item_problem(rel, text) if rel in LIST_ITEM_ATTRIBUTES else None
        return {'code': 'unexpected-value', 'message': listed} if listed else None
    if _GRAMMAR_UPPER_ATOM.fullmatch(text):
        return {'code': 'value-wrong-chars',
                'message': f"The value '{text}'{of} holds a capital letter or an underscore."}
    return {'code': 'missing-node-definition',
            'message': f"The value '{text}'{of} is not a number or a word of lowercase "
                       f"letters, digits, + and -."}


def variable_form_problem(variable) -> Optional[str]:
    """Why ``variable`` cannot be written and read back as itself, or None when
    it can. Any token will do (a released file may break the convention), but
    not a slash, and not one whose front reads as a conventional variable with
    the rest left over (``s1x2y``). The app's ``variableFormProblem``."""
    text = variable if isinstance(variable, str) else ''
    if not text:
        return 'A node needs a variable.'
    front = variable_length(text)
    if _NOT_IN_TOKEN.search(text) or '/' in text or (front and front != len(text)):
        return f'A variable cannot be written as it is: {text}'
    return None


#: What the export calls a sentence's document-level block
#: (``UmrDocument.js`` ``DOC_GRAPH_VARIABLE``), so a node called that is a
#: second definition of it.
DOC_GRAPH_VARIABLE = re.compile(r's[0-9]+s0')


def new_variable_problem(variable, sentence_index: Optional[int], taken) -> Optional[str]:
    """Why ``variable`` cannot name a NEW node of sentence ``sentence_index``,
    or None when it can. The app's ``UmrDocument._newVariableProblem``, which
    its canvas and text mode ask of every new node and rename: a new name
    follows the convention, names its own sentence, is not a sentence's
    document graph (``s2s0``) and is not already in use anywhere in the
    document (``taken``), since a variable is unique per document. A stored
    name that breaks the rule is kept (``variable_form_problem`` is the check
    for those)."""
    text = variable if isinstance(variable, str) else ''
    if not is_variable(text):
        return f'{text} is not a variable: s, the sentence number, letters, a number.'
    n = int(_VARIABLE_HEAD.match(text).group()[1:])
    if sentence_index is not None and n != sentence_index:
        return f'{text} names sentence {n}, and the node is in sentence {sentence_index}.'
    if DOC_GRAPH_VARIABLE.fullmatch(text):
        return f"{text} names the sentence's document graph."
    if text in taken:
        return f'{text} is already in use.'
    return None


@dataclass
class Child:
    rel: str
    kind: str          # 'node', 'atom' or 'string'
    value: str         # the target variable, or the literal
    inline: bool = False
    order: int = 0


@dataclass
class Node:
    var: str
    concept: str
    children: List[Child] = dc_field(default_factory=list)


@dataclass
class ParseError:
    message: str
    line: int
    col: int


@dataclass
class Graph:
    root: Optional[str] = None
    nodes: Dict[str, Node] = dc_field(default_factory=dict)
    errors: List[ParseError] = dc_field(default_factory=list)


def _mask_literals(text: str) -> str:
    """Blank out strings and comments so neither is mistaken for graph text
    while the definition set is collected. Newlines survive, so positions still
    line up."""
    out: List[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == '"':
            m = STRING.match(text, i)
            length = len(m.group(0)) if m else n - i
            out.append(' ' * length)
            i += length
        elif ch == '#':
            while i < n and text[i] != '\n':
                out.append(' ')
                i += 1
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def _defined_variables(masked: str) -> Set[str]:
    return {variable_from(m.group(1)) for m in re.finditer(r'\(\s*([^\s():#]+)\s*/', masked)}


class _Scanner:
    def __init__(self, text: str):
        self.text = text
        self.i = 0
        self.line = 1
        self.col = 1

    @property
    def done(self) -> bool:
        return self.i >= len(self.text)

    def peek(self) -> str:
        return self.text[self.i] if self.i < len(self.text) else ''

    def advance(self, n: int) -> None:
        for _ in range(n):
            if self.i < len(self.text) and self.text[self.i] == '\n':
                self.line += 1
                self.col = 1
            else:
                self.col += 1
            self.i += 1

    def skip(self) -> None:
        """Whitespace and comments are the same thing to the grammar."""
        while True:
            while not self.done and self.peek().isspace():
                self.advance(1)
            if self.peek() == '#':
                while not self.done and self.peek() != '\n':
                    self.advance(1)
                continue
            return

    def here(self) -> Tuple[int, int]:
        return self.line, self.col

    def take(self, pattern) -> Optional[str]:
        m = pattern.match(self.text, self.i)
        if not m:
            return None
        self.advance(len(m.group(0)))
        return m.group(0)

    def take_variable(self) -> Optional[str]:
        length = variable_length(self.text, self.i)
        if not length:
            return None
        found = self.text[self.i:self.i + length]
        self.advance(length)
        return found

    def rest(self) -> str:
        end = self.text.find('\n', self.i)
        return self.text[self.i:end if end != -1 else len(self.text)].strip()


def parse_penman(text: str) -> Graph:
    """Parse PENMAN text into a graph. Never raises: everything it cannot read
    becomes an entry in ``errors``."""
    graph = Graph()
    # The format requires NFC of the whole file, and the app's reader
    # normalizes too, so `e` plus a combining accent reads as one letter.
    source = unicodedata.normalize('NFC', text) if isinstance(text, str) else ''
    defined = _defined_variables(_mask_literals(source))
    sc = _Scanner(source)

    def fail(message: str, at: Tuple[int, int]) -> None:
        graph.errors.append(ParseError(message, at[0], at[1]))

    def read_value(children: List[Child], rel: str) -> None:
        sc.skip()
        at = sc.here()
        ch = sc.peek()
        if ch == '(':
            child = read_node()
            children.append(Child(rel, NODE, child or '', inline=True))
            return
        if ch == '"':
            raw = sc.take(STRING)
            if raw is None:
                fail(f'Unterminated string: {sc.rest()}', at)
                sc.advance(len(sc.text) - sc.i)
                return
            children.append(Child(rel, STRING_KIND, raw))
            return
        token = sc.take(TIME) or sc.take(TOKEN)
        if token is None:
            fail(f"Expected a value after '{rel}', found '{sc.rest() or 'end of graph'}'.", at)
            return
        if token in defined:
            children.append(Child(rel, NODE, token, inline=False))
            return
        if is_variable(token):
            fail(f"Variable '{token}' is not defined.", at)
            children.append(Child(rel, NODE, token, inline=False))
            return
        children.append(Child(rel, ATOM, token))

    def read_node() -> Optional[str]:
        open_at = sc.here()
        sc.advance(1)  # the '('
        sc.skip()
        variable = sc.take_variable() or sc.take(TOKEN)
        if variable is None:
            fail(f"Expected a node variable id, found '{sc.rest()}'.", sc.here())
            return None
        sc.skip()
        if sc.peek() == '/':
            sc.advance(1)
            sc.skip()
        else:
            fail(f"Expected slash and concept string after '{variable}'.", sc.here())
        concept = None if sc.peek() == ')' else sc.take(TOKEN)
        if concept is None:
            fail(f"Expected a concept string for '{variable}'.", sc.here())
        node = Node(var=variable, concept=concept or '')
        if variable in graph.nodes:
            fail(f"Variable '{variable}' is used twice.", open_at)
        else:
            graph.nodes[variable] = node

        while True:
            sc.skip()
            if sc.done:
                fail(f"Graph ended without closing node '{variable}'.", sc.here())
                return variable
            ch = sc.peek()
            if ch == ')':
                sc.advance(1)
                return variable
            if ch == ':':
                at = sc.here()
                rel = sc.take(RELATION)
                if rel is None:
                    fail(f"Expected a relation label, found '{sc.rest()}'.", at)
                    sc.advance(1)
                    continue
                read_value(node.children, rel)
                continue
            # Anything else here is junk: report it once and step past the
            # whole token so the rest of the graph is still read.
            fail(f"Expected a relation or a closing bracket, found '{sc.rest()}'.", sc.here())
            if sc.take(TOKEN) is None:
                sc.advance(1)

    sc.skip()
    if sc.done:
        return graph
    if sc.peek() != '(':
        fail(f"Expected the opening bracket of the root node, found '{sc.rest()}'.", sc.here())
        return graph
    root = read_node()
    sc.skip()
    if not sc.done:
        fail(f"Unexpected content after the topmost closing bracket: '{sc.rest()}'.", sc.here())
    graph.root = root
    for node in graph.nodes.values():
        for i, child in enumerate(node.children):
            child.order = i
    return graph


def _walk(graph: Graph, visit) -> None:
    """Depth-first pre-order over child order, descending into a node the first
    time an edge reaches it. Iterative, so a pathological graph cannot blow the
    stack."""
    root, nodes = graph.root, graph.nodes
    if not root or root not in nodes:
        return
    seen = {root}
    stack = [[root, 0]]
    while stack:
        frame = stack[-1]
        node = nodes.get(frame[0])
        if node is None or frame[1] >= len(node.children):
            stack.pop()
            continue
        index = frame[1]
        frame[1] += 1
        child = node.children[index]
        if child.kind != NODE:
            continue
        already = child.value in seen
        visit(frame[0], index, child, already)
        if not already and child.value in nodes:
            seen.add(child.value)
            stack.append([child.value, 0])


def tree_edges(graph: Graph) -> Set[Tuple[str, int]]:
    """The edges at which each node is written out, by first visit."""
    first: Dict[str, Tuple[str, int]] = {}

    def visit(parent, index, child, already):
        if already or child.value in first:
            return
        first[child.value] = (parent, index)

    _walk(graph, visit)
    return set(first.values())


def _expansion_sites(graph: Graph) -> Set[Tuple[str, int]]:
    """Where each node is written out when the graph carries ``inline`` marks:
    the marked edge wins, so a graph that came from a file is written back at
    the same sites."""
    marked: Dict[str, Tuple[str, int]] = {}
    first: Dict[str, Tuple[str, int]] = {}
    any_marked = [False]

    def visit(parent, index, child, already):
        if child.inline:
            any_marked[0] = True
            marked.setdefault(child.value, (parent, index))
        if not already:
            first.setdefault(child.value, (parent, index))

    _walk(graph, visit)
    if not any_marked[0]:
        return set(first.values())
    return {marked.get(target, key) for target, key in first.items()}


def serialize_penman(graph: Optional[Graph], indent: int = 4) -> str:
    """A graph back as PENMAN, in the shape the UFAL spec shows: the root on
    the first line, every child on its own line, four spaces per level, and
    closing brackets accumulating at the end of a subtree's last line."""
    if graph is None or not graph.root or graph.root not in graph.nodes:
        return ''
    sites = _expansion_sites(graph)
    written = {graph.root}

    def pad(depth: int) -> str:
        return ' ' * (indent * depth)

    def lines(variable: str, depth: int) -> List[str]:
        node = graph.nodes[variable]
        out = [f'{pad(depth)}({variable} / {node.concept}']
        for index, child in enumerate(node.children):
            child_pad = pad(depth + 1)
            expand = (child.kind == NODE and child.value in graph.nodes
                      and child.value not in written and (variable, index) in sites)
            if expand:
                written.add(child.value)
                sub = lines(child.value, depth + 1)
                sub[0] = f'{child_pad}{child.rel} {sub[0][len(child_pad):]}'
                out.extend(sub)
            else:
                out.append(f'{child_pad}{child.rel} {child.value}')
        out[-1] += ')'
        return out

    return '\n'.join(lines(graph.root, 0))


def next_variable(sentence_index: int, concept: str, taken) -> str:
    """The next free variable for a concept in a sentence, by the standard rule
    (``sentenceGraph.js`` ``nextVariable``): ``s`` + the sentence number + the
    concept's first letter + a counter from 2 on. A variable is unique per
    DOCUMENT, not per sentence, because the document graph cites an earlier
    sentence's nodes by name, so ``taken`` is the document's.

    The letter is always one of a to z (ruled 2026-09-28): an accented letter
    gives its base letter (``ébrio`` gives ``s4e``), anything else ``x``.
    validate.py reads an accented variable only in the sentence graph, so the
    first document-level relation on ``s4é`` failed its sentence's block. A
    person may still type one: only a name picked by itself is held to ASCII.
    Held to the app's by ``plaid-agent/tests/test_penman_mirror.py``."""
    first = unicodedata.normalize('NFD', str(concept or '')[:1].lower())[:1]
    letter = first if re.fullmatch('[a-z]', first) else 'x'
    base = f's{sentence_index}{letter}'
    if base not in taken:
        return base
    n = 2
    while True:
        candidate = f'{base}{n}'
        if candidate not in taken:
            return candidate
        n += 1


def graph_text(nodes: Dict[str, Node], root: Optional[str]) -> str:
    """Serialize a set of nodes from a root, marking the tree edges first (the
    same rule the canvas and the exporter use)."""
    if not root or root not in nodes:
        return ''
    graph = Graph(root=root, nodes=nodes)
    for child in (c for node in nodes.values() for c in node.children):
        child.inline = False
    for parent, index in tree_edges(graph):
        nodes[parent].children[index].inline = True
    return serialize_penman(graph)


def parse_attribute_line(line: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    """``":aspect state :polarity -"`` as attribute dicts, plus what could not
    be read. The syntax is PENMAN's own, so the line is parsed as the children
    of a throwaway node rather than by a second reader of the same grammar."""
    text = (line or '').strip()
    if not text:
        return [], []
    graph = parse_penman(f'(s0x / x {text})')
    node = graph.nodes.get('s0x')
    problems = [e.message for e in graph.errors]
    attrs: List[Dict[str, Any]] = []
    for order, child in enumerate(node.children if node else []):
        if child.kind == NODE:
            problems.append(f'{child.rel} names a node, and an attribute takes a plain value.')
            continue
        attrs.append({'rel': child.rel, 'value': child.value, 'order': order})
    return attrs, problems
