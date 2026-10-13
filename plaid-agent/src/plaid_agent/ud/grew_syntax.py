"""Reading a Grew request: the lexer, the request parser and the one reading
of an edge label.

A port of plaid-ud's ``src/grew/lexer.js``, the request half of
``src/grew/parser.js`` and ``src/grew/edgeLabel.js``, so that a pattern the
assistant runs is read exactly as the Search tab reads it.
``tests/test_grew_mirror.py`` runs both over the same patterns and compares
what they compile to and how they refuse. The AST is the same plain dicts
with the same keys (plaid-ud's ``src/grew/ast.js`` documents them).

What is left out is the rewriting half: ``parseGrs``, rules, commands,
strategies and lexicons. A request that holds one of their keywords is
refused by the request grammar itself, as in the Search tab, and the lexer
still reads every token the rewriting grammar has, so a stray ``==>`` gets the
same error in both places.

A regex is read here, where its line is known, with the server's reading of
it (:mod:`plaid_agent.core.java_regex`, the twin of plaid-ui's
``javaRegex.js``), so one neither engine can read stops with a caret.
"""

import re
from typing import Any, Dict, List, Optional

from ..core.java_regex import PatternError, translate


# --- errors ------------------------------------------------------------------

class GrewError(Exception):
    """What is wrong with a request, as opposed to with the server."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class GrewParseError(GrewError):
    """Not valid Grew. Carries a 1-based line and column and the source line."""

    def __init__(self, message: str, line: Optional[int] = None, col: Optional[int] = None,
                 source_line: Optional[str] = None):
        super().__init__(message)
        self.line = line
        self.col = col
        self.source_line = source_line


class GrewUnsupportedError(GrewError):
    """Valid Grew that the compiler cannot express in Plaid's query language.
    ``feature`` names the construct."""

    def __init__(self, feature: str, message: Optional[str] = None, line: Optional[int] = None):
        super().__init__(message or f'Unsupported Grew feature: {feature}')
        self.feature = feature
        self.line = line


# --- regexes -----------------------------------------------------------------

def normalize_flags(flags: Optional[str]) -> str:
    """Plaid supports only the case-insensitive flag. Anything else is dropped."""
    return 'i' if flags and 'i' in flags else ''


def regex_error(v: Dict[str, Any]) -> Optional[str]:
    """Why a regex value cannot be read the server's way, or None."""
    try:
        translate(str(v['pattern']), case_insensitive=normalize_flags(v.get('flags')) == 'i')
    except PatternError as e:
        return str(e)
    return None


def server_regex(v: Dict[str, Any]) -> str:
    """The pattern for a query's ``{regex}``. It carries its own case folding,
    so it goes with no flags."""
    try:
        return translate(str(v['pattern']),
                         case_insensitive=normalize_flags(v.get('flags')) == 'i').server
    except PatternError as e:
        raise GrewUnsupportedError('regex', str(e)) from None


# --- edge labels -------------------------------------------------------------
#
# Which graph an edge label speaks of. A plain label is the tree's, an `E:`
# label the enhanced graph's extra edges, and an unlabelled edge either.

ENHANCED_PREFIX = 'E:'
ANY = {'type': 'any'}


def is_enhanced_label(label: Any) -> bool:
    return str(label if label is not None else '').startswith(ENHANCED_PREFIX)


def bare_label(label: Any) -> str:
    """The label as the server stores it, without the prefix."""
    if is_enhanced_label(label):
        return str(label)[len(ENHANCED_PREFIX):]
    return str(label if label is not None else '')


def compact_label(value: Any, enhanced: bool) -> str:
    """The label as Grew writes it."""
    v = '' if value is None else str(value)
    return ENHANCED_PREFIX + v if enhanced else v


def split_label(label: Optional[Dict[str, Any]]) -> Dict[str, Optional[Dict[str, Any]]]:
    """A Label AST as one test per graph: ``{basic, enhanced}``, each a Label
    with no prefix left in it, or None where it can match nothing on that side."""
    if not label or label['type'] == 'any':
        return {'basic': ANY, 'enhanced': ANY}

    if label['type'] == 'list':
        basic = [x for x in label['labels'] if not is_enhanced_label(x)]
        enhanced = [bare_label(x) for x in label['labels'] if is_enhanced_label(x)]

        def side(labels):
            if labels:
                return {'type': 'list', 'labels': labels, 'negated': label['negated']}
            # Nothing named on this side: a negation excludes nothing here, and
            # a plain list asks for nothing here.
            return ANY if label['negated'] else None
        return {'basic': side(basic), 'enhanced': side(enhanced)}

    if label['type'] == 'regex':
        pattern = label['pattern']
        anchored = pattern.startswith('^')
        rest = pattern[1:] if anchored else pattern
        if rest.startswith(ENHANCED_PREFIX):
            cut = ('^' if anchored else '') + rest[len(ENHANCED_PREFIX):]
            return {'basic': None, 'enhanced': {**label, 'pattern': cut}}
        return {'basic': label, 'enhanced': None if anchored else label}

    if label['type'] == 'features':
        mark = [f for f in label['feats'] if f['key'] == 'enhanced']
        feats = [f for f in label['feats'] if f['key'] != 'enhanced']
        rest = {'type': 'features', 'feats': feats} if feats else ANY
        basic = enhanced = True
        for f in mark:
            if f.get('neg'):
                enhanced = False
            else:
                basic = False
                # `yes` is the only value the feature ever holds.
                if f.get('val') != 'yes':
                    enhanced = False
        return {'basic': rest if basic else None, 'enhanced': rest if enhanced else None}

    return {'basic': label, 'enhanced': None}


# --- lexer -------------------------------------------------------------------

IDENT, STRING, REGEX, NUMBER, EOF, LEXICON = 'IDENT', 'STRING', 'REGEX', 'NUMBER', 'EOF', 'LEXICON'

# Longest first, so a multi-character operator wins over its prefixes.
MULTI = [('->>', 'DOMINATES'), ('-[', 'EDGE_OPEN'), ('->', 'ARROW'), ('><', 'CROSS'),
         ('<<', 'LTLT'), ('>>', 'GTGT'), ('<>', 'NEQ'), ('<=', 'LE'), ('>=', 'GE'),
         ('==>', 'SHIFT'), ('=[', 'SHIFT_OPEN'), (']=>', 'SHIFT_CLOSE'), (':<', 'BEFORE'),
         (':>', 'AFTER')]
SINGLE = {'{': 'LBRACE', '}': 'RBRACE', '[': 'LBRACK', ']': 'RBRACK', '(': 'LPAREN',
          ')': 'RPAREN', ',': 'COMMA', ';': 'SEMI', ':': 'COLON', '.': 'DOT', '*': 'STAR',
          '!': 'BANG', '$': 'DOLLAR', '|': 'PIPE', '^': 'CARET', '=': 'EQ', '<': 'LT',
          '>': 'GT', '+': 'PLUS'}

_IDENT_START = re.compile(r'[A-Za-z_]')
_IDENT_PART = re.compile(r'[A-Za-z0-9_]')
_DIGIT = re.compile(r'[0-9]')
_FLAG = re.compile(r'[a-zA-Z]')


def _is(rx, c: Optional[str]) -> bool:
    return c is not None and rx.fullmatch(c) is not None


def lex(src: str) -> List[Dict[str, Any]]:
    """The token stream, each token ``{type, value, line, col}``. A column
    counts UTF-16 units, as the Search tab's does."""
    lines = src.split('\n')
    tokens: List[Dict[str, Any]] = []
    n = len(src)
    st = {'i': 0, 'line': 1, 'col': 1}

    def at(k: int = 0) -> Optional[str]:
        j = st['i'] + k
        return src[j] if 0 <= j < n else None

    def fail(msg: str):
        line = st['line']
        raise GrewParseError(msg, line, st['col'], lines[line - 1] if line - 1 < len(lines) else '')

    def advance(k: int = 1) -> None:
        for _ in range(k):
            c = at()
            if c == '\n':
                st['line'] += 1
                st['col'] = 1
            else:
                st['col'] += 2 if c is not None and ord(c) > 0xFFFF else 1
            st['i'] += 1

    def push(type_: str, value: Any, line: int, col: int) -> None:
        tokens.append({'type': type_, 'value': value, 'line': line, 'col': col})

    def lex_string(line: int, col: int, raw: bool = False) -> Dict[str, Any]:
        advance()  # the opening quote
        val = ''
        while st['i'] < n and at() != '"':
            if at() == '\\':
                advance()
                e = at()
                if e is None:
                    fail('Unterminated string')
                if raw:
                    val += e if e == '"' else '\\' + e
                else:
                    val += '\n' if e == 'n' else '\t' if e == 't' else e
                advance()
                continue
            if at() == '\n':
                fail('Unterminated string')
            val += at()
            advance()
        if st['i'] >= n:
            fail('Unterminated string')
        advance()  # the closing quote
        return {'type': STRING, 'value': val, 'line': line, 'col': col}

    while st['i'] < n:
        c = at()
        if c in (' ', '\t', '\r', '\n'):
            advance()
            continue
        if c == '%':
            while st['i'] < n and at() != '\n':
                advance()
            continue
        if c == '#':
            # An inline lexicon, `#BEGIN name` through `#END`, kept raw. Only a
            # rewriting rule reads one, so a request refuses it in the parser.
            sl, sc = st['line'], st['col']
            if not src.startswith('#BEGIN', st['i']):
                fail("Unexpected '#' (a lexicon starts with '#BEGIN name')")
            advance(6)
            while at() in (' ', '\t'):
                advance()
            name = ''
            while st['i'] < n and _is(_IDENT_PART, at()):
                name += at()
                advance()
            if not name:
                fail('Expected a lexicon name after #BEGIN')
            while st['i'] < n and at() != '\n':
                advance()
            advance()
            body_line = st['line']
            end_at = src.find('#END', st['i'])
            if end_at == -1:
                fail('Unterminated lexicon (#BEGIN without #END)')
            body = src[st['i']:end_at]
            advance(end_at - st['i'] + 4)
            push(LEXICON, {'name': name, 'body': body, 'bodyLine': body_line}, sl, sc)
            continue

        sl, sc = st['line'], st['col']
        op = next(((text, t) for text, t in MULTI if src.startswith(text, st['i'])), None)
        if op:
            advance(len(op[0]))
            push(op[1], op[0], sl, sc)
            continue

        if c == '-' and _is(_DIGIT, at(1)):
            advance()
            num = '-'
            while st['i'] < n and _is(_DIGIT, at()):
                num += at()
                advance()
            push(NUMBER, num, sl, sc)
            continue
        if c == '-':
            fail("Unexpected '-' (expected '->', '->>', or '-[')")

        if c == '/':
            advance()
            pat = ''
            while st['i'] < n and at() != '/':
                if at() == '\\':
                    pat += at()
                    advance()
                    if st['i'] < n:
                        pat += at()
                        advance()
                    continue
                if at() == '\n':
                    fail('Unterminated /regex/')
                pat += at()
                advance()
            if st['i'] >= n:
                fail('Unterminated /regex/')
            advance()
            flags = ''
            while st['i'] < n and _is(_FLAG, at()):
                flags += at()
                advance()
            push(REGEX, {'pattern': pat, 'flavor': 'pcre', 'flags': flags}, sl, sc)
            continue

        if c == '"':
            tokens.append(lex_string(sl, sc))
            continue

        if _is(_IDENT_START, c):
            ident = ''
            while st['i'] < n and _is(_IDENT_PART, at()):
                ident += at()
                advance()
            if ident == 're' and at() == '"':
                tok = lex_string(sl, sc, True)
                push(REGEX, {'pattern': tok['value'], 'flavor': 're', 'flags': ''}, sl, sc)
                continue
            push(IDENT, ident, sl, sc)
            continue

        if _is(_DIGIT, c):
            num = ''
            while st['i'] < n and _is(_DIGIT, at()):
                num += at()
                advance()
            push(NUMBER, num, sl, sc)
            continue

        if c in SINGLE:
            advance()
            push(SINGLE[c], c, sl, sc)
            continue

        fail(f"Unexpected character '{c}'")

    push(EOF, None, st['line'], st['col'])
    return tokens


# --- parser ------------------------------------------------------------------

BLOCK_TYPES = ('pattern', 'with', 'without', 'global')
GRS_KEYWORDS = ('rule', 'strat', 'commands', 'package', 'include', 'import')
_DIST_OPS = {'EQ': '=', 'LT': '<', 'LE': '<=', 'GT': '>', 'GE': '>='}


def _describe(tok: Dict[str, Any]) -> str:
    t = tok['type']
    if t == EOF:
        return 'end of input'
    if t == STRING:
        return f'string "{tok["value"]}"'
    if t == REGEX:
        return 'a regex literal'
    if t in (IDENT, NUMBER):
        return f"'{tok['value']}'"
    return f"'{tok['value'] if tok['value'] is not None else t}'"


def _lower_first(message: str) -> str:
    """The first letter lowered when a lowercase one follows it, so a message
    reads on after a prefix."""
    return re.sub(r'^[A-Z](?=[a-z])', lambda m: m.group(0).lower(), message)


class _Parser:
    def __init__(self, src: str):
        self.src = src
        self.tokens = lex(src)
        self.pos = 0
        self.non_injective: Dict[str, None] = {}

    # --- cursor ---

    def peek(self, k: int = 0) -> Dict[str, Any]:
        return self.tokens[min(self.pos + k, len(self.tokens) - 1)]

    def at(self, type_: str, k: int = 0) -> bool:
        return self.peek(k)['type'] == type_

    def at_kw(self, word: str, k: int = 0) -> bool:
        return self.at(IDENT, k) and self.peek(k)['value'] == word

    def next(self) -> Dict[str, Any]:
        tok = self.tokens[self.pos]
        self.pos += 1
        return tok

    def fail(self, msg: str, tok: Optional[Dict[str, Any]] = None):
        tok = tok or self.peek()
        lines = self.src.split('\n')
        line = tok['line']
        raise GrewParseError(msg, line, tok['col'], lines[line - 1] if line - 1 < len(lines) else '')

    def expect(self, type_: str, what: Optional[str] = None) -> Dict[str, Any]:
        if not self.at(type_):
            self.fail(f'Expected {what or type_} but found {_describe(self.peek())}')
        return self.next()

    # --- request ---

    def request(self) -> Dict[str, Any]:
        blocks = []
        while not self.at(EOF):
            if self.at(IDENT) and self.peek()['value'] in GRS_KEYWORDS:
                self.fail(f'`{self.peek()["value"]}` is a rewriting keyword. A search takes only '
                          'pattern blocks.')
            blocks.append(self.block())
        if not blocks:
            self.fail('Empty query. Expected a `pattern { … }` block.')
        return {'blocks': blocks, 'nonInjective': list(self.non_injective)}

    def block(self) -> Dict[str, Any]:
        if not self.at(IDENT) or self.peek()['value'] not in BLOCK_TYPES:
            self.fail('Expected a block keyword: pattern, with, without, or global')
        kw = self.next()
        self.expect('LBRACE', "'{'")
        items = []
        while not self.at('RBRACE') and not self.at(EOF):
            items.append(self.global_item() if kw['value'] == 'global' else self.clause())
            while self.at('SEMI'):
                self.next()
        self.expect('RBRACE', "'}'")
        return {'type': kw['value'], 'items': items, 'line': kw['line']}

    # --- pattern, with and without clauses ---

    def clause(self) -> Dict[str, Any]:
        if self.at(IDENT) and self.peek()['value'] in ('delta', 'length') and self.at('LPAREN', 1):
            return self.dist()
        if self.at('STAR'):
            self.next()
            return self.edge_rest(None, {'wild': True})

        id_tok = self.expect(IDENT, 'a node/edge identifier')
        ident = id_tok['value']
        if self.at('COLON'):
            self.next()
            return self.edge_rest(ident, self.ref())
        # The non-injective mark on a bare reference (`X$ -> Y`).
        if self.at('DOLLAR') and not self.at('LBRACK', 1):
            self.next()
            self.non_injective[ident] = None

        t = self.peek()['type']
        if t == 'DOLLAR':
            self.next()
            self.non_injective[ident] = None
            return self.node_decl(ident, id_tok['line'])
        if t == 'LBRACK':
            return self.node_decl(ident, id_tok['line'])
        if t == 'DOT':
            return self.node_dot(ident, id_tok['line'])
        if t in ('LT', 'LTLT', 'GT', 'GTGT'):
            return self.order(ident)
        if t in ('ARROW', 'DOMINATES', 'EDGE_OPEN'):
            return self.edge_rest(None, {'wild': False, 'id': ident})
        if t == 'CROSS':
            self.next()
            right = self.expect(IDENT, 'an edge identifier')['value']
            return {'kind': 'cross', 'left': ident, 'right': right, 'line': id_tok['line']}
        # A bare node declaration, `X` with no feature structure.
        return {'kind': 'node', 'id': ident, 'alts': [[]], 'line': id_tok['line']}

    def ref(self) -> Dict[str, Any]:
        if self.at('STAR'):
            self.next()
            return {'wild': True}
        ident = self.expect(IDENT, 'a node identifier')['value']
        if self.at('DOLLAR'):
            self.next()
            self.non_injective[ident] = None
        return {'wild': False, 'id': ident}

    def node_decl(self, ident: str, line: int) -> Dict[str, Any]:
        alts = [self.feature_struct()]
        while self.at('PIPE'):
            self.next()
            alts.append(self.feature_struct())
        return {'kind': 'node', 'id': ident, 'alts': alts, 'line': line}

    def feature_struct(self) -> List[Dict[str, Any]]:
        self.expect('LBRACK', "'['")
        items = []
        if not self.at('RBRACK'):
            items.append(self.feat_item())
            while self.at('COMMA'):
                self.next()
                items.append(self.feat_item())
        self.expect('RBRACK', "']'")
        return items

    def feat_item(self) -> Dict[str, Any]:
        if self.at('BANG'):
            self.next()
            name = self.expect(IDENT, 'a feature name')['value']
            return {'name': name, 'op': 'undefined', 'value': None}
        name = self.expect(IDENT, 'a feature name')['value']
        if self.at('EQ'):
            self.next()
            return {'name': name, 'op': '=', 'value': self.value_expr()}
        if self.at('NEQ'):
            self.next()
            return {'name': name, 'op': '<>', 'value': self.value_expr()}
        return {'name': name, 'op': 'defined', 'value': None}

    def regex(self) -> Dict[str, Any]:
        tok = self.peek()
        r = self.next()['value']
        value = {'type': 'regex', 'pattern': r['pattern'], 'flavor': r['flavor'], 'flags': r['flags']}
        error = regex_error(value)
        if error:
            self.fail(error, tok)
        return value

    def label_regex(self) -> Dict[str, Any]:
        # A label regex opening with `E:` is matched after the prefix, so that
        # is what is read, and its error carries the label's caret.
        tok = self.peek()
        value = self.regex()
        enhanced = split_label(value)['enhanced']
        if enhanced and enhanced is not value:
            error = regex_error(enhanced)
            if error:
                self.fail(f'After the E: prefix, {_lower_first(error)}', tok)
        return value

    def value_expr(self) -> Dict[str, Any]:
        items = [self.value_atom()]
        while self.at('PIPE'):
            self.next()
            items.append(self.value_atom())
        return items[0] if len(items) == 1 else {'type': 'disj', 'items': items}

    def value_atom(self) -> Dict[str, Any]:
        if self.at('STAR'):
            self.next()
            return {'type': 'any'}
        if self.at(STRING):
            return {'type': 'lit', 'value': self.next()['value']}
        if self.at(REGEX):
            return self.regex()
        if self.at(IDENT) and self.at('DOT', 1):
            # `lex.field`, a lexicon reference, which only a rule can use.
            lex_name = self.next()['value']
            self.next()
            return {'type': 'lexref', 'lex': lex_name,
                    'field': self.expect(IDENT, 'a lexicon field')['value']}
        if self.at(IDENT) or self.at(NUMBER):
            return {'type': 'lit', 'value': self.next()['value']}
        self.fail(f'Expected a value but found {_describe(self.peek())}')

    def node_dot(self, ident: str, line: int) -> Dict[str, Any]:
        self.expect('DOT', "'.'")
        feat = self.expect(IDENT, 'a feature name')['value']
        if self.at('NEQ'):
            op = '<>'
            self.next()
        else:
            self.expect('EQ', "'=' or '<>'")
            op = '='
        if self.at(IDENT) and self.at('DOT', 1):
            rnode = self.next()['value']
            self.next()
            rfeat = self.expect(IDENT, 'a feature name')['value']
            return {'kind': 'featcmp', 'left': {'node': ident, 'feat': feat}, 'op': op,
                    'right': {'node': rnode, 'feat': rfeat}, 'line': line}
        return {'kind': 'nodefeat', 'node': ident, 'feat': feat, 'op': op,
                'value': self.value_expr(), 'line': line}

    def order(self, ident: str) -> Dict[str, Any]:
        # `X > Y` and `X >> Y` are `Y < X` and `Y << X`.
        tok = self.next()
        op = '<<' if tok['type'] in ('LTLT', 'GTGT') else '<'
        other = self.expect(IDENT, 'a node identifier')['value']
        if tok['type'] in ('GT', 'GTGT'):
            return {'kind': 'order', 'op': op, 'left': other, 'right': ident}
        return {'kind': 'order', 'op': op, 'left': ident, 'right': other}

    def edge_rest(self, edge_id: Optional[str], src: Dict[str, Any]) -> Dict[str, Any]:
        label = {'type': 'any'}
        if self.at('EDGE_OPEN'):
            self.next()
            label = self.label_expr()
            self.expect('RBRACK', "']'")
        if self.at('ARROW'):
            self.next()
            transitive = False
        elif self.at('DOMINATES'):
            self.next()
            transitive = True
        else:
            self.fail(f"Expected '->' or '->>' but found {_describe(self.peek())}")
        tgt = self.ref()
        if transitive:
            return {'kind': 'dominates', 'id': edge_id, 'left': src, 'right': tgt, 'label': label}
        return {'kind': 'edge', 'id': edge_id, 'src': src, 'tgt': tgt, 'label': label}

    def label_expr(self) -> Dict[str, Any]:
        if self.at(REGEX):
            return self.label_regex()
        negated = False
        if self.at('CARET'):
            self.next()
            negated = True
        # The edge-feature form: `1=nsubj, 2=pass, !deep`.
        looks_feature = self.at('BANG') or ((self.at(IDENT) or self.at(NUMBER)) and self.at('EQ', 1))
        if not negated and looks_feature:
            feats = []
            while True:
                if self.at('BANG'):
                    self.next()
                    feats.append({'key': self.expect(IDENT, 'a feature name')['value'], 'neg': True})
                else:
                    key = self.next()['value']
                    self.expect('EQ', "'='")
                    feats.append({'key': key, 'val': self.label_atom()})
                if not self.at('COMMA'):
                    break
                self.next()
            return {'type': 'features', 'feats': feats}
        labels = [self.label_atom()]
        while self.at('PIPE'):
            self.next()
            labels.append(self.label_atom())
        return {'type': 'list', 'labels': labels, 'negated': negated}

    def label_atom(self) -> str:
        # A subtype (`nsubj:pass`) lexes as IDENT COLON IDENT.
        if self.at(STRING):
            return self.next()['value']
        s = str(self.expect(IDENT, 'an edge label')['value'])
        while self.at('COLON'):
            self.next()
            s += ':' + self.expect(IDENT, 'a label subtype')['value']
        return s

    def dist(self) -> Dict[str, Any]:
        fn = self.next()['value']
        self.expect('LPAREN', "'('")
        a = self.expect(IDENT, 'a node identifier')['value']
        self.expect('COMMA', "','")
        b = self.expect(IDENT, 'a node identifier')['value']
        self.expect('RPAREN', "')'")
        op_tok = self.next()
        op = _DIST_OPS.get(op_tok['type'])
        if not op:
            self.fail(f'Expected a comparison operator after {fn}(…)', op_tok)
        n_tok = self.expect(NUMBER, 'a number')
        return {'kind': 'dist', 'fn': fn, 'a': a, 'b': b, 'op': op, 'n': int(n_tok['value'])}

    # --- global items ---

    def global_item(self) -> Dict[str, Any]:
        # An optional `meta.` or `global.` prefix.
        if self.at(IDENT) and self.peek()['value'] in ('meta', 'global') and self.at('DOT', 1):
            self.next()
            self.next()
        if self.at('BANG'):
            self.next()
            key = self.expect(IDENT, 'a metadata key')['value']
            return {'kind': 'globalmeta', 'key': key, 'op': 'undefined', 'value': None}
        id_tok = self.expect(IDENT, 'a global constraint')
        if id_tok['value'].startswith('is_') and not self.at('EQ') and not self.at('NEQ'):
            return {'kind': 'globalflag', 'name': id_tok['value'], 'line': id_tok['line']}
        if self.at('NEQ'):
            op = '<>'
            self.next()
        else:
            self.expect('EQ', "'=' or '<>'")
            op = '='
        return {'kind': 'globalmeta', 'key': id_tok['value'], 'op': op,
                'value': self.value_expr(), 'line': id_tok['line']}


def parse(src: str) -> Dict[str, Any]:
    """A Grew request as an AST: ``{blocks, nonInjective}``. Raises
    :class:`GrewParseError`."""
    return _Parser(src).request()
