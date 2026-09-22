// Pure-fn tests for the quick search (grew/quickSearch.js).
//
// It writes a GREW PATTERN rather than QL, on purpose: there is then one
// compiler, one set of warnings, one residue of unsupported things, and the box
// hands its pattern to the Grew box so a quick search is the first draft of a
// real one. So the test that matters is that everything it writes PARSES AND
// COMPILES: a pattern the compiler rejects would be a dead end with no error
// the user could act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quickPattern, QUICK_FIELDS, MATCH_TYPES } from '../src/grew/quickSearch.js';
import { parseAndCompile } from '../src/grew/index.js';
import { parse } from '../src/grew/parser.js';

const LAYERS = {
  morphemeTokenLayer: { id: 'M' },
  sentenceTokenLayer: { id: 'S' },
  lemmaLayer: { id: 'LEM' },
  uposLayer: { id: 'UP' },
  xposLayer: { id: 'XP' },
  featuresLayer: { id: 'FE' },
  relationLayer: { id: 'REL' },
  isConfigured: true,
};

test('nothing to search for yields no pattern', () => {
  assert.equal(quickPattern('lemma', 'contains', ''), null);
  assert.equal(quickPattern('lemma', 'contains', '   '), null);
  assert.equal(quickPattern('lemma', 'contains', null), null);
});

test('every field and match type compiles', () => {
  // `root` as well as `dog`: it is the one label whose head is not a word, so
  // it is the one needle that can meet a refusal the other five fields never
  // see. A run with `dog` alone left the quick box answering a plain search
  // for `root` with Grew advice about a pattern the reader never typed.
  for (const needle of ['dog', 'root']) {
    for (const field of QUICK_FIELDS) {
      for (const match of MATCH_TYPES) {
        const pattern = quickPattern(field.value, match.value, needle);
        assert.ok(pattern, `${field.value}/${match.value} wrote nothing`);
        assert.doesNotThrow(
          () => parseAndCompile(pattern, LAYERS, { projectId: 'p' }),
          `${field.value}/${match.value} on ${needle} wrote a pattern the compiler rejects: ${pattern}`,
        );
      }
    }
  }
});

test('contains is a LITERAL substring, not a regex the user did not write', () => {
  // Someone typing `dog.` wants a full stop, not "dog followed by anything".
  assert.equal(quickPattern('lemma', 'contains', 'a.b'), 'pattern { W [lemma=re"a\\\\.b"] }');
  // `matches` passes the regex through untouched.
  assert.equal(quickPattern('lemma', 'regex', 'a.b'), 'pattern { W [lemma=re"a.b"] }');
  assert.equal(quickPattern('lemma', 'exact', 'a.b'), 'pattern { W [lemma="a.b"] }');
});

test('a quote in the text cannot break out of the literal', () => {
  const pattern = quickPattern('lemma', 'exact', 'say "hi"');
  assert.ok(pattern.includes('\\"hi\\"'), pattern);
  assert.doesNotThrow(() => parseAndCompile(pattern, LAYERS, { projectId: 'p' }));
});

test('a relation search finds the DEPENDENT, which is the word to land on', () => {
  assert.equal(quickPattern('deprel', 'exact', 'nsubj'), 'pattern { * -[nsubj|E:nsubj]-> W }');
  // The label goes in the ARC. `e.label = re"subj"` on a named edge looks
  // right and is not: the compiler reads `e.something` as a feature of a NODE
  // called e, so it searches for a FEATS span reading `label=subj` on a word:
  // no error, no warning, no matches. Found by running one.
  assert.equal(quickPattern('deprel', 'contains', 'subj'), 'pattern { * -[re"subj"]-> W }');
  assert.equal(quickPattern('deprel', 'regex', '^nsubj'), 'pattern { * -[re"^nsubj"]-> W }');
});

test('a relation search actually compiles to a RELATION constraint', () => {
  // The bug this catches is silent: a pattern that parses, compiles, and
  // matches nothing. Assert the compiled query constrains the relation's own
  // value rather than some span's.
  for (const match of ['exact', 'contains', 'regex']) {
    const pattern = quickPattern('deprel', match, 'nsubj');
    const { query } = parseAndCompile(pattern, LAYERS, { projectId: 'p' });
    const relation = query.where.find((c) => c[0] === 'relation');
    assert.ok(relation, `${match} compiled no relation clause`);
    assert.ok(
      relation[2].value !== undefined,
      `${match} compiled a relation with no value constraint`,
    );
  }
});

test('a deprel label that is not bare-safe still produces a pattern that parses', () => {
  // An arc label is written BARE in Grew, so this is the one field a quick
  // search cannot escape what it was handed. Typing two words emitted
  // `-[a b]->` and answered with a Grew syntax error about a pattern the
  // reader never wrote.
  for (const label of ['a b', 'nsubj]', '"', 'a.b', 'nsubj]-> X; Y [upos=NOUN']) {
    const pattern = quickPattern('deprel', 'exact', label);
    parse(pattern); // throws if the label leaked into the syntax
    const { query } = parseAndCompile(pattern, LAYERS, { projectId: 'p' });
    const relation = query.where.find((c) => c[0] === 'relation');
    assert.ok(relation?.[2]?.value !== undefined, `${label} compiled no value constraint`);
  }
});

test('an exact deprel search stays exact when it takes the regex route', () => {
  // The fallback has to mean the same thing, so it is anchored: `nsubj` must
  // not start matching `xnsubjy`.
  const pattern = quickPattern('deprel', 'exact', 'a b');
  assert.match(pattern, /\^a b\$/);
});

test('the common labels keep the bare form', () => {
  assert.equal(quickPattern('deprel', 'exact', 'nsubj'), 'pattern { * -[nsubj|E:nsubj]-> W }');
  assert.equal(
    quickPattern('deprel', 'exact', 'obl:tmod'),
    'pattern { * -[obl:tmod|E:obl:tmod]-> W }',
  );
});

test('a search for root compiles, and asks nothing of the head', () => {
  // A root's head is the sentence anchor, which is no word. A named head is
  // bound to a word, so `H -[root|E:root]-> W` is refused with advice about a
  // pattern the reader never typed, and `H -[re"root"]-> W` compiles, matches
  // nothing (H and W are bound injectively, and the server stores a root as a
  // loop on its own word) and says so nowhere.
  for (const [match, needle, expected] of [
    ['exact', 'root', 'pattern { * -[root|E:root]-> W }'],
    ['contains', 'root', 'pattern { * -[re"root"]-> W }'],
    ['regex', '^root$', 'pattern { * -[re"^root$"]-> W }'],
  ]) {
    const pattern = quickPattern('deprel', match, needle);
    assert.equal(pattern, expected);
    const { query, partialDocs } = parseAndCompile(pattern, LAYERS, { projectId: 'p' });
    const relation = query.where.find((c) => c[0] === 'relation');
    assert.ok(relation?.[2]?.value !== undefined, `${match} compiled no value constraint`);
    // No source constraint: the head is free, so the self-loop the server
    // stores a root as is a match rather than a near miss.
    assert.equal(relation[2].source, undefined, `${match} constrained the head`);
    // And nothing is left for a caller to compensate for: `partialDocs` is the
    // flag the rewrite runner reads to fall back to every document, and only
    // it reads it.
    assert.equal(partialDocs, false, `${match} left the search partial`);
  }
});

test('a FEATS search looks in the whole Key=Value, as the spans store it', () => {
  assert.equal(
    quickPattern('feats', 'contains', 'Number=Sing'),
    'pattern { W [FEATS=re"Number=Sing"] }',
  );
});
