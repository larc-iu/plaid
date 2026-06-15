import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lex, TT } from '../src/grew/lexer.js';

const types = (s) => lex(s).map(t => t.type).filter(t => t !== TT.EOF);
const toks = (s) => lex(s).filter(t => t.type !== TT.EOF);

test('lexes block keywords and braces as idents + punctuation', () => {
  assert.deepEqual(types('pattern { X }'), [TT.IDENT, TT.LBRACE, TT.IDENT, TT.RBRACE]);
});

test('greedy multi-char operators win over prefixes', () => {
  assert.deepEqual(types('X ->> Y'), [TT.IDENT, TT.DOMINATES, TT.IDENT]);
  assert.deepEqual(types('X -> Y'), [TT.IDENT, TT.ARROW, TT.IDENT]);
  assert.deepEqual(types('X -[a]-> Y'),
    [TT.IDENT, TT.EDGE_OPEN, TT.IDENT, TT.RBRACK, TT.ARROW, TT.IDENT]);
  assert.deepEqual(types('e1 >< e2'), [TT.IDENT, TT.CROSS, TT.IDENT]);
  assert.deepEqual(types('X << Y'), [TT.IDENT, TT.LTLT, TT.IDENT]);
  assert.deepEqual(types('Tense <> Fut'), [TT.IDENT, TT.NEQ, TT.IDENT]);
  assert.deepEqual(types('a <= b >= c'), [TT.IDENT, TT.LE, TT.IDENT, TT.GE, TT.IDENT]);
});

test('negative numbers vs arrows', () => {
  assert.deepEqual(toks('delta(X,Y) = -3').filter(t => t.type === TT.NUMBER).map(t => t.value), ['-3']);
});

test('string, re-regex, pcre-regex literals', () => {
  const ts = toks('lemma="être" a=re"^b.*" b=/x/i');
  const strs = ts.filter(t => t.type === TT.STRING).map(t => t.value);
  const res = ts.filter(t => t.type === TT.REGEX).map(t => t.value);
  assert.deepEqual(strs, ['être']);
  assert.deepEqual(res, [
    { pattern: '^b.*', flavor: 're', flags: '' },
    { pattern: 'x', flavor: 'pcre', flags: 'i' },
  ]);
});

test('dollar (non-injective) and bang (undefined) and dot path', () => {
  assert.deepEqual(types('B$'), [TT.IDENT, TT.DOLLAR]);
  assert.deepEqual(types('!Person'), [TT.BANG, TT.IDENT]);
  assert.deepEqual(types('X.lemma'), [TT.IDENT, TT.DOT, TT.IDENT]);
});

test('comments and line/col tracking', () => {
  const ts = toks('pattern {\n  X % comment\n}');
  assert.equal(ts[0].line, 1);
  const x = ts.find(t => t.value === 'X');
  assert.equal(x.line, 2);
  assert.equal(x.col, 3);
});

test('unterminated string fails with a location', () => {
  assert.throws(() => lex('a="oops'), (e) => e.name === 'GrewParseError' && e.line === 1);
});
