// Tokenizer for Grew "request" syntax (pattern/with/without/global blocks).
//
// Produces a flat token stream the recursive-descent parser consumes. Each token
// carries a 1-based {line, col} and the text of its source line, so both parse
// errors and (downstream) "unsupported feature" errors can point at a location.
//
// The grammar's punctuation is mostly single chars, but several multi-char
// operators must be matched greedily and BEFORE their prefixes:
//   ->>  (dominance)   -[  (edge-label open)   ->  (edge)
//   ><   (edge crossing)
//   <<   (precedence)  <>  (feature inequality)  <=  >=
// A leading '-' is also the sign of a negative number in `delta(X,Y) = -3`.
//
// Value literals come in three flavors: "double-quoted strings", OCaml-style
// `re"…"` regexes, and PCRE `/…/flags` regexes. Comments start with `%` (Grew
// convention) and run to end of line.

import { GrewParseError } from './errors.js';

export const TT = {
  IDENT: 'IDENT',
  STRING: 'STRING',
  REGEX: 'REGEX', // { pattern, flavor: 're'|'pcre', flags }
  NUMBER: 'NUMBER',
  LBRACE: 'LBRACE', RBRACE: 'RBRACE',
  LBRACK: 'LBRACK', RBRACK: 'RBRACK',
  LPAREN: 'LPAREN', RPAREN: 'RPAREN',
  COMMA: 'COMMA', SEMI: 'SEMI', COLON: 'COLON', DOT: 'DOT',
  STAR: 'STAR', BANG: 'BANG', DOLLAR: 'DOLLAR', PIPE: 'PIPE', CARET: 'CARET',
  EQ: 'EQ', NEQ: 'NEQ',
  LT: 'LT', LTLT: 'LTLT', LE: 'LE',
  GT: 'GT', GE: 'GE',
  CROSS: 'CROSS',
  ARROW: 'ARROW', DOMINATES: 'DOMINATES', EDGE_OPEN: 'EDGE_OPEN',
  EOF: 'EOF',
};

const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdentPart = (c) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c) => /[0-9]/.test(c);

export function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const srcLine = () => lines[line - 1] ?? '';
  const fail = (msg) => { throw new GrewParseError(msg, line, col, srcLine()); };

  const peek = (k = 0) => src[i + k];
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') { line += 1; col = 1; } else { col += 1; }
      i += 1;
    }
  };
  const push = (type, value, startLine, startCol) =>
    tokens.push({ type, value, line: startLine, col: startCol });

  const match = (s) => src.startsWith(s, i);

  while (i < src.length) {
    const c = src[i];

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }

    // Line comment
    if (c === '%') { while (i < src.length && src[i] !== '\n') advance(); continue; }

    const sl = line, sc = col;

    // Multi-char operators (greedy, longest first).
    if (match('->>')) { advance(3); push(TT.DOMINATES, '->>', sl, sc); continue; }
    if (match('-[')) { advance(2); push(TT.EDGE_OPEN, '-[', sl, sc); continue; }
    if (match('->')) { advance(2); push(TT.ARROW, '->', sl, sc); continue; }
    if (match('><')) { advance(2); push(TT.CROSS, '><', sl, sc); continue; }
    if (match('<<')) { advance(2); push(TT.LTLT, '<<', sl, sc); continue; }
    if (match('<>')) { advance(2); push(TT.NEQ, '<>', sl, sc); continue; }
    if (match('<=')) { advance(2); push(TT.LE, '<=', sl, sc); continue; }
    if (match('>=')) { advance(2); push(TT.GE, '>=', sl, sc); continue; }

    // Negative number: '-' immediately before a digit.
    if (c === '-' && isDigit(src[i + 1])) {
      advance(); // consume '-'
      let num = '-';
      while (i < src.length && isDigit(src[i])) { num += src[i]; advance(); }
      push(TT.NUMBER, num, sl, sc);
      continue;
    }
    if (c === '-') { fail("Unexpected '-' (expected '->', '->>', or '-[')"); }

    // PCRE regex /pattern/flags
    if (c === '/') {
      advance(); // consume '/'
      let pat = '';
      while (i < src.length && src[i] !== '/') {
        if (src[i] === '\\') { pat += src[i]; advance(); if (i < src.length) { pat += src[i]; advance(); } continue; }
        if (src[i] === '\n') fail('Unterminated /regex/');
        pat += src[i]; advance();
      }
      if (i >= src.length) fail('Unterminated /regex/');
      advance(); // closing '/'
      let flags = '';
      while (i < src.length && /[a-zA-Z]/.test(src[i])) { flags += src[i]; advance(); }
      push(TT.REGEX, { pattern: pat, flavor: 'pcre', flags }, sl, sc);
      continue;
    }

    // String literal
    if (c === '"') { tokens.push(lexString(sl, sc)); continue; }

    // Identifier / keyword, or `re"…"` regex.
    if (isIdentStart(c)) {
      let id = '';
      while (i < src.length && isIdentPart(src[i])) { id += src[i]; advance(); }
      if (id === 're' && src[i] === '"') {
        const strTok = lexString(sl, sc);
        push(TT.REGEX, { pattern: strTok.value, flavor: 're', flags: '' }, sl, sc);
        continue;
      }
      push(TT.IDENT, id, sl, sc);
      continue;
    }

    // Plain number
    if (isDigit(c)) {
      let num = '';
      while (i < src.length && isDigit(src[i])) { num += src[i]; advance(); }
      push(TT.NUMBER, num, sl, sc);
      continue;
    }

    // Single-char punctuation
    const single = {
      '{': TT.LBRACE, '}': TT.RBRACE, '[': TT.LBRACK, ']': TT.RBRACK,
      '(': TT.LPAREN, ')': TT.RPAREN, ',': TT.COMMA, ';': TT.SEMI,
      ':': TT.COLON, '.': TT.DOT, '*': TT.STAR, '!': TT.BANG,
      '$': TT.DOLLAR, '|': TT.PIPE, '^': TT.CARET, '=': TT.EQ,
      '<': TT.LT, '>': TT.GT,
    }[c];
    if (single) { advance(); push(single, c, sl, sc); continue; }

    fail(`Unexpected character '${c}'`);
  }

  tokens.push({ type: TT.EOF, value: null, line, col });
  return tokens;

  // --- helpers that need lexer state ---
  function lexString(sl, sc) {
    advance(); // opening quote
    let val = '';
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        advance();
        const e = src[i];
        if (e === undefined) fail('Unterminated string');
        val += (e === 'n') ? '\n' : (e === 't') ? '\t' : e;
        advance();
        continue;
      }
      if (src[i] === '\n') fail('Unterminated string');
      val += src[i]; advance();
    }
    if (i >= src.length) fail('Unterminated string');
    advance(); // closing quote
    return { type: TT.STRING, value: val, line: sl, col: sc };
  }
}
