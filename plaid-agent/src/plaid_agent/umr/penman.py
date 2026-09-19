"""PENMAN notation, ported from plaid-umr's ``src/domain/format/penman.js``.

A sentence graph is written the way the UMR validator scans it, not the way a
generic PENMAN library would: a node is ``(variable / concept)`` followed by
any number of ``:relation value`` children, where a value is a child node, a
bare variable (re-entrancy), a quoted string or an atom.

Whether a bare token is a node reference or an atom cannot be decided locally,
because a reference may point forward. So the text is scanned once for
``( var /`` definitions before it is parsed, and the parser consults that set.
A token shaped like a variable that was never defined is still read as a
reference, so the caller sees the dangling edge rather than a silent atom.

This is a PORT, not an adaptation: the app writes a graph back to the same
sites it read it from, and the assistant's diff compares its own serialization
against the app's. Two readings of one text would show up as phantom changes
on a plan card.
"""

from dataclasses import dataclass, field as dc_field
from typing import Any, Dict, List, Optional, Set, Tuple

import regex as re

# Concepts, atoms and variables all stop at whitespace, brackets, a colon or
# the start of a comment.
TOKEN = re.compile(r'[^\s():#]+')

# The UMR variable convention, UFAL's own. The letter run may be non-ASCII, so
# the Unicode property escape is load-bearing.
VARIABLE = re.compile(r'^s[0-9]+\p{Ll}+[0-9]*$')

# The same, unanchored at the end: released files write ``(s6t/ thing)`` with
# no space, and the validator reads the variable off the front just like this.
VARIABLE_PREFIX = re.compile(r's[0-9]+\p{Ll}+[0-9]*')

RELATION = re.compile(r':[-A-Za-z0-9]+')
STRING = re.compile(r'"(?:\\.|[^"\\])*"')

NODE = 'node'
ATOM = 'atom'
STRING_KIND = 'string'


def is_variable(token: str) -> bool:
    """Whether a token has the shape of a UMR variable."""
    return bool(VARIABLE.match(token or ''))


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


def _variable_from(token: str) -> str:
    m = VARIABLE_PREFIX.match(token or '')
    return m.group(0) if m else token


def _defined_variables(masked: str) -> Set[str]:
    return {_variable_from(m.group(1)) for m in re.finditer(r'\(\s*([^\s():#]+)\s*/', masked)}


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

    def rest(self) -> str:
        end = self.text.find('\n', self.i)
        return self.text[self.i:end if end != -1 else len(self.text)].strip()


def parse_penman(text: str) -> Graph:
    """Parse PENMAN text into a graph. Never raises: everything it cannot read
    becomes an entry in ``errors``."""
    graph = Graph()
    source = text if isinstance(text, str) else ''
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
        token = sc.take(TOKEN)
        if token is None:
            fail(f"Expected a value after '{rel}', found '{sc.rest() or 'end of graph'}'.", at)
            return
        if token in defined:
            children.append(Child(rel, NODE, token, inline=False))
            return
        if is_variable(token):
            fail(f"The node id (variable) '{token}' is unknown. No such node is defined.", at)
            children.append(Child(rel, NODE, token, inline=False))
            return
        children.append(Child(rel, ATOM, token))

    def read_node() -> Optional[str]:
        open_at = sc.here()
        sc.advance(1)  # the '('
        sc.skip()
        variable = sc.take(VARIABLE_PREFIX) or sc.take(TOKEN)
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
            fail(f"The node id (variable) '{variable}' is not unique.", open_at)
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
    """The next free variable for a concept in a sentence, by the standard
    rule: ``s`` + the sentence number + the concept's first letter (``x`` when
    that is not a lowercase letter) + a counter from 2 on."""
    first = (str(concept or '')[:1]).lower()
    letter = first if re.match(r'\p{Ll}', first or '') else 'x'
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
