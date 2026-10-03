import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConlluDocument } from '../src/domain/ConlluDocument.js';
import { rawDocFromConllu } from './helpers/rawDoc.js';
import { parse } from '../src/grew/parser.js';
import { parseAndCompile } from '../src/grew/index.js';
import { quickPattern } from '../src/grew/quickSearch.js';
import { refinePattern } from '../src/components/search/refine.js';
import { graphFromSentence } from '../src/grew/rewrite/graph.js';
import { findMatches } from '../src/grew/rewrite/match.js';
import { serverRegExp } from './helpers/serverRegex.js';

// The search compiler and the local rewrite matcher read one Grew pattern
// alike on FEATS: the words a search finds are the words a rule rewrites.
// The compiled query is evaluated here over the sentence's own spans (the
// FEATS layer holds one `Key=Value` span per feature, or a whole bundle where
// an old import wrote one), the regexes with JS's engine, which reads every
// construct these patterns use (anchors, lookahead, lookbehind, classes) as
// Java does once helpers/serverRegex.js has read the translator's \z.

const CONLLU = [
  '# text = the dog saw a cat sings',
  '1\tthe\tthe\tDET\t_\tDefinite=Def|PronType=Art\t2\tdet\t_\t_',
  '2\tdog\tdog\tNOUN\tNN\tNumber=Sing\t3\tnsubj\t_\t_',
  '3\tsaw\tsee\tVERB\tVBD\tTense=Past\t0\troot\t_\t_',
  '4\ta\ta\tDET\t_\tDefinite=Ind\t5\tdet\t_\t_',
  '5\tcat\tcat\tNOUN\tNN\tNumber=Plur\t3\tobj\t_\t_',
  '6\tsings\tsing\tVERB\t_\t_\t3\tconj\t_\t_',
].join('\n');

const doc = new ConlluDocument({ raw: rawDocFromConllu(CONLLU) });
const LI = doc.layerInfo;
const plain = doc.sentences[0];

// The same sentence as Saraiki stores it: one span holding a whole bundle.
const bundled = {
  ...plain,
  tokens: plain.tokens.map((entry, i) =>
    i === 1
      ? {
          ...entry,
          feats: [{ id: 'bundle-1', tokens: [entry.token.id], value: 'Gender=Fem|Number=Sing' }],
        }
      : entry,
  ),
};

const spansOf = (entry, layer) => {
  if (layer === LI.featuresLayer.id) return entry.feats.map((f) => f.value);
  for (const col of ['upos', 'xpos', 'lemma']) {
    if (layer === LI[`${col}Layer`].id) return entry[col] ? [entry[col].value] : [];
  }
  throw new Error(`no such layer in this test: ${layer}`);
};

const valueOk = (actual, c) => {
  if (actual == null) return false;
  if (c === undefined) return true;
  if (typeof c === 'string') return actual === c;
  if (Array.isArray(c)) return c.includes(actual);
  if (c.regex !== undefined) return serverRegExp(c.regex, c.flags).test(actual);
  throw new Error(`no such value constraint in this test: ${JSON.stringify(c)}`);
};

// Does one word satisfy a clause list over node X? Spans are matched to the
// word through their `covers` clause, `not` negates its group, `or` takes any.
function holds(list, entry) {
  const coveringX = new Set(
    list.filter((c) => c[0] === 'covers' && c[2] === '?n_X').map((c) => c[1]),
  );
  return list.every((c) => {
    if (c[0] === 'span') {
      if (!coveringX.has(c[1])) throw new Error(`span not on X: ${JSON.stringify(c)}`);
      return spansOf(entry, c[2].layer).some((v) => valueOk(v, c[2].value));
    }
    if (c[0] === 'not') return !holds(c.slice(1), entry);
    if (c[0] === 'or') return c.slice(1).some((g) => holds(g, entry));
    if (['token', 'within', 'covers'].includes(c[0])) return true;
    throw new Error(`no such clause in this test: ${JSON.stringify(c)}`);
  });
}

const serverForms = (pattern, row) => {
  const { query } = parseAndCompile(pattern, LI);
  return row.tokens.filter((e) => holds(query.where, e)).map((e) => e.tokenForm);
};

const localForms = (pattern, row) => {
  const g = graphFromSentence(row);
  // The root anchor is a node of the local graph alone (rewrite/graph.js), no
  // word, so it is not one of the words compared.
  return findMatches(parse(pattern), g)
    .map((m) => g.nodes.get(m.nodes.get('X')))
    .filter((n) => !n.anchor)
    .map((n) => n.form);
};

const agree = (pattern, row, expected) => {
  const server = serverForms(pattern, row);
  assert.deepEqual(server, localForms(pattern, row), `${pattern}: search and rewrite differ`);
  assert.deepEqual(server, expected, pattern);
};

test('FEATS as a whole: search finds what a rule matches, on one span per feature', () => {
  agree('pattern { X [FEATS=re"Number=Sing"] }', plain, ['dog']);
  agree('pattern { X [FEATS=re"Number"] }', plain, ['dog', 'cat']);
  agree('pattern { X [FEATS=re"^Def"] }', plain, ['the', 'a']);
  agree('pattern { X [FEATS=/sing/i] }', plain, ['dog']);
  agree('pattern { X [FEATS="Number=Sing"] }', plain, ['dog']);
  agree('pattern { X [FEATS="Number=Sing"|"Tense=Past"] }', plain, ['dog', 'saw']);
  agree('pattern { X [FEATS<>"Number=Sing"] }', plain, ['the', 'saw', 'a', 'cat']);
  agree('pattern { X [FEATS] }', plain, ['the', 'dog', 'saw', 'a', 'cat']);
  agree('pattern { X [!FEATS] }', plain, ['sings']);
  agree('pattern { X [upos=NOUN, feats=re"Plur"] }', plain, ['cat']);
  agree('pattern { X [] } without { X [FEATS=re"Def"] }', plain, ['dog', 'saw', 'cat', 'sings']);
});

test('FEATS as a whole on a bundle span, as Saraiki stores its features', () => {
  agree('pattern { X [FEATS=re"Number=Sing"] }', bundled, ['dog']);
  agree('pattern { X [FEATS="Gender=Fem|Number=Sing"] }', bundled, ['dog']);
  agree('pattern { X [FEATS="Number=Sing"] }', bundled, []);
  agree('pattern { X [FEATS] }', bundled, ['the', 'dog', 'saw', 'a', 'cat']);
});

test('the quick search on Features finds the words, in every match type', () => {
  const quick = (match, text) => quickPattern('feats', match, text).replace('W [', 'X [');
  agree(quick('contains', 'Number=Sing'), plain, ['dog']);
  agree(quick('contains', 'Number'), plain, ['dog', 'cat']);
  agree(quick('exact', 'Number=Sing'), plain, ['dog']);
  agree(quick('regex', 'Sing|Past'), plain, ['dog', 'saw']);
  agree(quick('contains', 'Number=Sing'), bundled, ['dog']);
  agree(quick('exact', 'Gender=Fem|Number=Sing'), bundled, ['dog']);
});

test('narrowing from a FEATS count row finds the row, bare key or not', () => {
  // A bare key narrows on that key, a bundle on the whole span.
  agree(refinePattern('pattern { X [upos=NOUN] }', 'X', 'FEATS', 'Number=Plur'), plain, ['cat']);
  const row = 'Gender=Fem|Number=Sing';
  const narrowed = refinePattern('pattern { X [] }', 'X', 'FEATS', row);
  agree(narrowed, bundled, ['dog']);
  const odd = {
    ...plain,
    tokens: plain.tokens.map((e, i) =>
      i === 0 ? { ...e, feats: [{ id: 'o', tokens: [e.token.id], value: 'Odd.Key=1' }] } : e,
    ),
  };
  agree(refinePattern('pattern { X [] }', 'X', 'FEATS', 'Odd.Key=1'), odd, ['the']);
});

test('counting by FEATS groups every feature span of the matched words', () => {
  const { query } = parseAndCompile('pattern { X [upos=NOUN] }', LI, {
    countBy: { node: 'X', field: 'FEATS' },
  });
  const group = query.where.find((c) => c[0] === 'span' && c[2].layer === LI.featuresLayer.id);
  const values = plain.tokens
    .filter((e) => e.upos?.value === 'NOUN')
    .flatMap((e) => e.feats.map((f) => f.value))
    .filter((v) => valueOk(v, group[2].value));
  assert.deepEqual(values, ['Number=Sing', 'Number=Plur']);
});

test('FEATS has no reading where it would name one feature', () => {
  assert.throws(
    () => parseAndCompile('pattern { X [FEATS]; Y [FEATS]; X.FEATS = Y.FEATS }', LI),
    /FEATS/,
  );
  const g = graphFromSentence(plain);
  assert.throws(
    () => findMatches(parse('pattern { X [FEATS]; Y [FEATS]; X.FEATS = Y.FEATS }'), g),
    /FEATS/,
  );
});

// H23-SEARCH-2: a user's anchors mean the start and end of the VALUE, as the
// local matcher reads them, and a regex is a search inside the value.
test('a FEATS value regex reads anchors and substrings as the local matcher does', () => {
  agree('pattern { X [Number=re"^S"] }', plain, ['dog']);
  agree('pattern { X [Number=re"^P|^S"] }', plain, ['dog', 'cat']);
  agree('pattern { X [Number=re"g$"] }', plain, ['dog']);
  agree('pattern { X [Number=re"^Sing$"] }', plain, ['dog']);
  agree('pattern { X [Number=re"in"] }', plain, ['dog']);
  agree('pattern { X [Number=re"ur"] }', plain, ['cat']);
  agree('pattern { X [Number=re"(?:^|x)P"] }', plain, ['cat']);
  agree('pattern { X [Definite=re"[^I]nd"] }', plain, []);
  agree('pattern { X [Definite=re"[^D]e"] }', plain, []);
  agree('pattern { X [Definite=re"^[^D]"] }', plain, ['a']);
  agree('pattern { X [Number=/\\^S/] }', plain, []);
  agree('pattern { X [Number=/^s/i] }', plain, ['dog']);
  agree('pattern { X [] } without { X [Number=re"^S"] }', plain, [
    'the',
    'saw',
    'a',
    'cat',
    'sings',
  ]);
});
