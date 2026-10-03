import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parse, parseGrs } from '../src/grew/parser.js';
import { parseAndCompile } from '../src/grew/index.js';
import { GrewParseError } from '../src/grew/errors.js';
import { graphFromSentence } from '../src/grew/rewrite/graph.js';
import { findMatches } from '../src/grew/rewrite/match.js';
import { serverRegExp } from './helpers/serverRegex.js';

// H35-CORE-1: a Grew rewrite decides its matches locally, after the server
// search found the documents. Both read a person's regex through one
// translator (src/grew/userRegex.js), so a rule matches exactly the words the
// search finds. Before, the local matcher compiled the pattern as typed, with
// no `u` flag: `\p{L}` matched nothing, a positive clause never held, and a
// `without` never blocked, so a rewrite wrote to every word the search had
// left out.

const CONLLU = [
  '# text = حضرت 13 къа Дом a_b x-y',
  '1\tحضرت\tحضرت\tPROPN\t_\t_\t0\troot\t_\t_',
  '2\t13\t13\tNUM\t_\t_\t1\tnummod\t_\t_',
  '3\tкъа\tкъа\tNOUN\t_\t_\t1\tobj\t_\t_',
  '4\tДом\tДом\tPROPN\t_\t_\t1\tobl\t_\t_',
  '5\ta_b\ta_b\tX\t_\t_\t1\tdep\t_\t_',
  '6\tx-y\tx-y\tX\t_\t_\t1\tdep\t_\t_',
].join('\n');

const doc = new ConlluDocument({ raw: rawDocFromConllu(CONLLU) });
const LI = doc.layerInfo;
const row = doc.sentences[0];

const spansOf = (entry, layer) => {
  for (const col of ['upos', 'xpos', 'lemma']) {
    if (layer === LI[`${col}Layer`].id) return entry[col]?.value ? [entry[col].value] : [];
  }
  throw new Error(`no such layer in this test: ${layer}`);
};

const valueOk = (actual, c) => {
  if (c === undefined) return true;
  if (typeof c === 'string') return actual === c;
  if (Array.isArray(c)) return c.includes(actual);
  if (c.regex !== undefined) return serverRegExp(c.regex, c.flags).test(actual);
  throw new Error(`no such value constraint in this test: ${JSON.stringify(c)}`);
};

// The compiled query over one word, as the server would read it.
function holds(list, entry) {
  return list.every((c) => {
    if (c[0] === 'span') return spansOf(entry, c[2].layer).some((v) => valueOk(v, c[2].value));
    if (c[0] === 'not') return !holds(c.slice(1), entry);
    if (c[0] === 'or') return c.slice(1).some((g) => holds(g, entry));
    if (['token', 'within', 'covers'].includes(c[0])) return true;
    throw new Error(`no such clause in this test: ${JSON.stringify(c)}`);
  });
}

const searchFinds = (pattern) => {
  const { query } = parseAndCompile(pattern, LI);
  return row.tokens.filter((e) => holds(query.where, e)).map((e) => e.tokenForm);
};

const rewriteMatches = (pattern) => {
  const g = graphFromSentence(row);
  return findMatches(parse(pattern), g)
    .map((m) => g.nodes.get(m.nodes.get('X')))
    .filter((n) => !n.anchor)
    .map((n) => n.form);
};

const agree = (pattern, expected) => {
  const found = searchFinds(pattern);
  assert.deepEqual(rewriteMatches(pattern), found, `${pattern}: search and rewrite differ`);
  assert.deepEqual(found, expected, pattern);
};

test('a rewrite matches the words the search finds, regex for regex', () => {
  agree(String.raw`pattern { X [lemma=re"^\\p{L}+$"] }`, ['حضرت', 'къа', 'Дом']);
  agree(String.raw`pattern { X [lemma=/^\p{L}+$/] }`, ['حضرت', 'къа', 'Дом']);
  agree(String.raw`pattern { X [upos=PROPN] } without { X [lemma=re"^\\p{L}+$"] }`, []);
  agree(String.raw`pattern { X [] } without { X [lemma=re"^\\p{L}+$"] }`, ['13', 'a_b', 'x-y']);
  // \w and \d read any script, as every Plaid regex box reads them.
  agree(String.raw`pattern { X [lemma=re"^\\w+$"] }`, ['حضرت', '13', 'къа', 'Дом', 'a_b']);
  agree(String.raw`pattern { X [lemma=re"\\W"] }`, ['x-y']);
  agree(String.raw`pattern { X [lemma=re"^\\d+$"] }`, ['13']);
  agree(String.raw`pattern { X [lemma=re"\\by"] }`, ['x-y']);
  agree(String.raw`pattern { X [lemma=re"\\bъ"] }`, []);
  // The `i` flag and (?i) fold case in any script.
  agree('pattern { X [lemma=/^дом$/i] }', ['Дом']);
  agree('pattern { X [lemma=re"(?i)^КЪ"] }', ['къа']);
  agree('pattern { X [lemma=re"^КЪ"] }', []);
  // A script reads the same on both sides, by any name Java takes.
  agree(String.raw`pattern { X [lemma=re"^\\p{IsArabic}+$"] }`, ['حضرت']);
  agree(String.raw`pattern { X [lemma=re"\\p{sc=Cyrillic}"] }`, ['къа', 'Дом']);
  agree(String.raw`pattern { X [lemma=re"^\\P{IsCyrl}+$"] }`, ['حضرت', '13', 'a_b', 'x-y']);
});

test('a regex the two engines would read apart is refused where it is written', () => {
  for (const text of [
    String.raw`pattern { X [lemma=re"\\p{InArabic}"] }`,
    'pattern { X [lemma=re"a++"] }',
    'pattern { X [lemma=re".*{.*"] }',
  ]) {
    assert.throws(() => parse(text), GrewParseError, text);
  }
  assert.throws(
    () => parseGrs('pattern { X [lemma=re"a++"] } commands { X.Probe = Yes }'),
    GrewParseError,
  );
  // On an edge label too.
  assert.throws(() => parse('pattern { X -[re"a++"]-> Y }'), GrewParseError);
});

// REV-FX3-UD R6: a label pattern opening with `E:` is matched after the
// prefix, so that is what is read, and its error carries the label's caret.
test('an edge label regex is read after its E: prefix where it is written', () => {
  for (const [text, col] of [
    ['pattern { X -[re"^E:*"]-> Y }', 15],
    ['pattern { X -[re"E:+"]-> Y }', 15],
    ['pattern { X -[re"^E:{2}"]-> Y }', 15],
  ]) {
    assert.throws(
      () => parse(text),
      (e) =>
        e instanceof GrewParseError &&
        e.col === col &&
        e.message.startsWith('After the E: prefix, nothing to repeat before'),
      text,
    );
  }
  assert.throws(
    () => parseGrs('rule r { pattern { e: X -[re"^E:*"]-> Y } commands { del_edge e } }'),
    (e) => e instanceof GrewParseError && e.message.startsWith('After the E: prefix'),
  );
  // What reads well after the prefix, and a plain pattern, still parse.
  parse('pattern { X -[re"^E:nsubj"]-> Y }');
  parse('pattern { X -[re"^nsubj:*"]-> Y }');
  parse('pattern { X -[re"E:obl:.*"]-> Y }');
});
