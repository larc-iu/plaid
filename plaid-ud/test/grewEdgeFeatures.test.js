import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAndCompile } from '../src/grew/index.js';
import { parse } from '../src/grew/parser.js';
import { labelMatches } from '../src/grew/rewrite/match.js';

// Grew's numbered edge features name a label's parts by position: in
// `nsubj:pass`, 1=nsubj and 2=pass (H3-6-2). The search compiler and the
// rewrite matcher must both read `2=pass` as "the second part is pass", not
// as a label that starts with "pass".

const LI = {
  sentenceTokenLayer: { id: 'SENT' },
  morphemeTokenLayer: { id: 'MORPH' },
  lemmaLayer: { id: 'LEMMA' },
  uposLayer: { id: 'UPOS' },
  xposLayer: { id: 'XPOS' },
  featuresLayer: { id: 'FEATS' },
  relationLayer: { id: 'REL' },
  enhancedRelationLayer: { id: 'EREL' },
};

const LABELS = ['nsubj', 'nsubj:pass', 'obl:tmod', 'obj', 'pass', 'acl:relcl:x'];

// What each label spelling finds among LABELS.
const CASES = [
  ['1=nsubj', ['nsubj', 'nsubj:pass']],
  ['2=pass', ['nsubj:pass']],
  ['2=tmod', ['obl:tmod']],
  ['2=nsubj', []],
  ['2=obj', []],
  ['1=nsubj, 2=pass', ['nsubj:pass']],
  ['2=pass, 1=nsubj', ['nsubj:pass']],
  ['3=x', ['acl:relcl:x']],
  ['1=acl, 3=x', ['acl:relcl:x']],
  ['1=nsubj, 1=obj', []],
];

const searchRegex = (spec) => {
  const { query } = parseAndCompile(`pattern { X -[${spec}]-> Y }`, LI);
  const rels = [];
  const walk = (cl) => {
    if (!Array.isArray(cl)) return;
    if (cl[0] === 'relation') rels.push(cl);
    if (cl[0] === 'not') cl.slice(1).forEach(walk);
    if (cl[0] === 'or') cl.slice(1).forEach((g) => g.forEach(walk));
  };
  query.where.forEach(walk);
  const regexes = new Set(rels.map((r) => r[2].value.regex));
  assert.equal(regexes.size, 1, spec);
  return new RegExp([...regexes][0]);
};

const ruleLabel = (spec) => parse(`pattern { X -[${spec}]-> Y }`).blocks[0].items[0].label;

for (const [spec, want] of CASES) {
  test(`search: -[${spec}]-> finds ${want.join(', ') || 'nothing'}`, () => {
    const rx = searchRegex(spec);
    assert.deepEqual(
      LABELS.filter((l) => rx.test(l)),
      want,
    );
  });
  test(`rewrite: -[${spec}]-> matches ${want.join(', ') || 'nothing'}`, () => {
    const label = ruleLabel(spec);
    assert.deepEqual(
      LABELS.filter((l) => labelMatches(label, l)),
      want,
    );
  });
}

test('feature 0 names no part of a label: refused by both', () => {
  assert.throws(() => parseAndCompile('pattern { X -[0=nsubj]-> Y }', LI), {
    name: 'GrewUnsupportedError',
  });
  assert.throws(() => labelMatches(ruleLabel('0=nsubj'), 'nsubj'), {
    name: 'GrewUnsupportedError',
  });
});
