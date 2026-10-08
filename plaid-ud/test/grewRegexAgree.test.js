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
import { lex, TT } from '../src/grew/lexer.js';
import { regexLiteral } from '../src/grew/literals.js';
import { quickPattern } from '../src/grew/quickSearch.js';

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
  agree(String.raw`pattern { X [lemma=re"^\p{L}+$"] }`, ['حضرت', 'къа', 'Дом']);
  agree(String.raw`pattern { X [lemma=/^\p{L}+$/] }`, ['حضرت', 'къа', 'Дом']);
  agree(String.raw`pattern { X [upos=PROPN] } without { X [lemma=re"^\p{L}+$"] }`, []);
  agree(String.raw`pattern { X [] } without { X [lemma=re"^\p{L}+$"] }`, ['13', 'a_b', 'x-y']);
  // \w and \d read any script, as every Plaid regex box reads them.
  agree(String.raw`pattern { X [lemma=re"^\w+$"] }`, ['حضرت', '13', 'къа', 'Дом', 'a_b']);
  agree(String.raw`pattern { X [lemma=re"\W"] }`, ['x-y']);
  agree(String.raw`pattern { X [lemma=re"^\d+$"] }`, ['13']);
  agree(String.raw`pattern { X [lemma=re"\by"] }`, ['x-y']);
  agree(String.raw`pattern { X [lemma=re"\bъ"] }`, []);
  // The `i` flag and (?i) fold case in any script.
  agree('pattern { X [lemma=/^дом$/i] }', ['Дом']);
  agree('pattern { X [lemma=re"(?i)^КЪ"] }', ['къа']);
  agree('pattern { X [lemma=re"^КЪ"] }', []);
  // A script reads the same on both sides, by any name Java takes.
  agree(String.raw`pattern { X [lemma=re"^\p{IsArabic}+$"] }`, ['حضرت']);
  agree(String.raw`pattern { X [lemma=re"\p{sc=Cyrillic}"] }`, ['къа', 'Дом']);
  agree(String.raw`pattern { X [lemma=re"^\P{IsCyrl}+$"] }`, ['حضرت', '13', 'a_b', 'x-y']);
});

// H10-SCRIPTS-5: the server reads a pattern and a value in NFC, so a lemma
// stored decomposed is found by the pattern typed composed, and the rewrite
// has to match it too.
test('a rewrite matches a lemma stored decomposed for a pattern typed composed', () => {
  const nfd = new ConlluDocument({
    raw: rawDocFromConllu(
      [
        '# text = kitab x',
        '1\tkitab\tp\u02b0a\u0301\tNOUN\t_\t_\t0\troot\t_\t_',
        '2\tx\tp\u02b0a\tX\t_\t_\t1\tdep\t_\t_',
      ].join('\n'),
    ),
  });
  const g = graphFromSentence(nfd.sentences[0]);
  const forms = (pattern) =>
    findMatches(parse(pattern), g)
      .map((m) => g.nodes.get(m.nodes.get('X')))
      .filter((n) => !n.anchor)
      .map((n) => n.form);
  assert.deepEqual(forms('pattern { X [lemma=re"p\u02b0\u00e1"] }'), ['kitab']);
  assert.deepEqual(forms('pattern { X [lemma=re"a$"] }'), ['x']);
});

test('a regex the two engines would read apart is refused where it is written', () => {
  for (const text of [
    String.raw`pattern { X [lemma=re"\p{InArabic}"] }`,
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

// L3-UD-LIVE-1: a `re"…"` regex is raw, so the spellings the guide gives mean
// what it says when typed as they are. Before, the lexer read `\w` as a string
// escape and kept `w`: `re"\w"` looked for the letter w, `re"\."` for any
// character, and `re"\p{IsArabic}"` was refused.
test('re"…" keeps its backslashes as typed and reads like /…/', () => {
  agree(String.raw`pattern { X [lemma=re"^\w+$"] }`, ['حضرت', '13', 'къа', 'Дом', 'a_b']);
  agree(String.raw`pattern { X [lemma=re"\d"] }`, ['13']);
  agree(String.raw`pattern { X [lemma=re"^\p{IsArabic}+$"] }`, ['حضرت']);
  agree(String.raw`pattern { X [lemma=re"\-"] }`, ['x-y']);
  agree(String.raw`pattern { X [lemma=re"^\S+\s*$"] }`, ['حضرت', '13', 'къа', 'Дом', 'a_b', 'x-y']);
  for (const [re, slash] of [
    [String.raw`re"^\w+$"`, String.raw`/^\w+$/`],
    [String.raw`re"\."`, String.raw`/\./`],
    [String.raw`re"\p{IsArabic}"`, String.raw`/\p{IsArabic}/`],
    [String.raw`re"a\\"`, String.raw`/a\\/`],
    [String.raw`re"\b\d{2}\b"`, String.raw`/\b\d{2}\b/`],
  ]) {
    const a = searchFinds(`pattern { X [lemma=${re}] }`);
    const b = searchFinds(`pattern { X [lemma=${slash}] }`);
    assert.deepEqual(a, b, `${re} and ${slash} differ`);
    assert.deepEqual(
      parseAndCompile(`pattern { X [lemma=${re}] }`, LI).query.where,
      parseAndCompile(`pattern { X [lemma=${slash}] }`, LI).query.where,
      `${re} and ${slash} compile apart`,
    );
  }
  // `\.` is a full stop and nothing else, so a rule for full stops cannot
  // retag every one-letter word.
  agree(String.raw`pattern { X [lemma=re"^\.$"] }`, []);
  // `\"` is a quote inside the regex.
  assert.equal(lex(String.raw`re"say \"hi\""`)[0].value.pattern, 'say "hi"');
});

// The regex as the lexer gives it back: an escaped quote reads as the quote
// and a newline as `\n`, both of which the regex reader takes the same way.
const quoteRead = (r) =>
  r.replace(/\\(.)|\n/gs, (m, c) => (c === '"' ? c : m === '\n' ? '\\n' : m));

test('every writer of re"…" writes a regex the lexer reads back as the same regex', () => {
  const regexes = [
    String.raw`^\w+$`,
    String.raw`\p{IsArabic}`,
    String.raw`a\.b`,
    'say "hi"',
    String.raw`say \"hi\"`,
    String.raw`a\\`,
    String.raw`a\\"`,
    'two\nlines',
    'tab\there',
    String.raw`[\]"]`,
    '',
  ];
  for (const r of regexes) {
    const src = regexLiteral(r);
    const back = lex(src)[0].value.pattern;
    assert.equal(back, quoteRead(r), `${JSON.stringify(r)} wrote ${src}`);
  }
  // A lone backslash at the end becomes the regex for a backslash.
  assert.equal(lex(regexLiteral('a\\'))[0].value.pattern, String.raw`a\\`);
  // The quick lookup's `matches` and `contains` go through it.
  for (const r of regexes.filter(Boolean)) {
    const p = quickPattern('lemma', 'regex', r);
    const read = lex(p).find((t) => t.type === TT.REGEX).value.pattern;
    assert.equal(read, quoteRead(r.trim()), p);
    assert.doesNotThrow(() => parse(p), p);
  }
});
