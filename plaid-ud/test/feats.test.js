// The one reading of a FEATS pair, which the cell, the document's features
// write and the CoNLL-U import all share. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFeature, featureRefusal } from '../src/utils/feats.js';

test('a well-formed pair reads as its two halves', () => {
  assert.deepEqual(normalizeFeature('Gender=Masc'), {
    key: 'Gender',
    value: 'Masc',
    pair: 'Gender=Masc',
  });
});

// The bug this file exists for: the cell trimmed the pair's two ends and the
// document keyed its write on the untrimmed name, so `Gender =Fem` was filed
// under `Gender ` and the word came out with two genders.
test('both halves are trimmed, so a stray space cannot make a second name', () => {
  assert.equal(normalizeFeature('Gender =Fem').key, 'Gender');
  assert.equal(normalizeFeature('Gender= Fem').value, 'Fem');
  assert.equal(normalizeFeature('  Gender = Fem  ').pair, 'Gender=Fem');
  assert.equal(normalizeFeature('\tGender\t=\tFem\n').pair, 'Gender=Fem');
});

test('a pair with no complete half is not a pair', () => {
  assert.equal(normalizeFeature('Gender'), null);
  assert.equal(normalizeFeature('Gender='), null);
  assert.equal(normalizeFeature('Gender=   '), null);
  assert.equal(normalizeFeature('=Fem'), null);
  assert.equal(normalizeFeature('   =Fem'), null);
  assert.equal(normalizeFeature(''), null);
  assert.equal(normalizeFeature(null), null);
  assert.equal(normalizeFeature(undefined), null);
});

// The value half keeps its own '=' so a feature whose value contains one
// survives the trip.
test('only the first = splits the pair', () => {
  assert.deepEqual(normalizeFeature('Typo=a=b'), { key: 'Typo', value: 'a=b', pair: 'Typo=a=b' });
});

// CoNLL-U: fields other than FORM, LEMMA and MISC must not contain space
// characters, so a space left inside either half after trimming is a pair the
// FEATS column could not spell.
test('a space inside a half is refused, and a clean pair is not', () => {
  assert.equal(featureRefusal('Gender=Fem'), null);
  assert.equal(featureRefusal(normalizeFeature('Gender = Fem').pair), null);
  assert.match(featureRefusal('Gender=Fem Masc'), /spaces/);
  assert.match(featureRefusal('Noun Type=Prop'), /spaces/);
});
