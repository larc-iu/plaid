// Pure-fn tests for the vocabulary MODE and its refusals (utils/udVocabMode.js).
//
// The point of the module is that a closed list means something different in
// each of the three places: a plain tag is in the list or it is not, a DEPREL is
// governed by its BASE relation, and a feature is governed on both halves.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODES,
  readVocabMode,
  isClosed,
  readDescriptions,
  cleanDescriptions,
  allowsPlainValue,
  allowsDeprel,
  allowsFeature,
} from '../src/utils/udVocabMode.js';
import { UPOS_DESCRIPTIONS, DEPREL_DESCRIPTIONS } from '../src/utils/udVocabDescriptions.js';
import { UPOS_TAGS, UNIVERSAL_DEPRELS } from '../src/utils/udVocab.js';

const open = { ud: {} };
const closed = { ud: { vocabMode: 'closed' } };

test('a vocabulary is open until it says otherwise', () => {
  assert.equal(readVocabMode(undefined), MODES.OPEN);
  assert.equal(readVocabMode({}), MODES.OPEN);
  assert.equal(readVocabMode(open), MODES.OPEN);
  assert.equal(readVocabMode({ ud: { vocabMode: 'suggest' } }), MODES.OPEN);
  assert.equal(readVocabMode(closed), MODES.CLOSED);
  assert.equal(isClosed(closed), true);
  assert.equal(isClosed(open), false);
});

test('an open vocabulary allows anything, including nonsense', () => {
  assert.equal(allowsPlainValue('NOUN', UPOS_TAGS, open), true);
  assert.equal(allowsPlainValue('WIDGET', UPOS_TAGS, open), true);
  assert.equal(allowsDeprel('made:up', UNIVERSAL_DEPRELS, open), true);
  assert.equal(allowsFeature('Nope=Maybe', new Map(), open), true);
});

test('a closed plain list allows its values and an empty cell', () => {
  assert.equal(allowsPlainValue('NOUN', UPOS_TAGS, closed), true);
  assert.equal(allowsPlainValue('WIDGET', UPOS_TAGS, closed), false);
  // Clearing a cell is not annotating it, so an empty value is never refused.
  assert.equal(allowsPlainValue('', UPOS_TAGS, closed), true);
  assert.equal(allowsPlainValue(null, UPOS_TAGS, closed), true);
});

test('a closed DEPREL list governs the BASE relation, not the subtype', () => {
  assert.equal(allowsDeprel('nsubj', UNIVERSAL_DEPRELS, closed), true);
  // Subtypes are language-specific and open-ended by design: a project that
  // listed every one it used would be re-listing the language.
  assert.equal(allowsDeprel('nsubj:pass', UNIVERSAL_DEPRELS, closed), true);
  assert.equal(allowsDeprel('nsubj:outer:weird', UNIVERSAL_DEPRELS, closed), true);
  assert.equal(allowsDeprel('subjekt', UNIVERSAL_DEPRELS, closed), false);
  assert.equal(allowsDeprel('subjekt:pass', UNIVERSAL_DEPRELS, closed), false);
  // A project may list a subtype; the base is what is compared either way.
  assert.equal(allowsDeprel('obj:lvc', ['obj:lvc'], closed), true);
  assert.equal(allowsDeprel('obj', ['obj:lvc'], closed), true);
});

test('a closed feature inventory governs both halves', () => {
  const inventory = new Map([
    ['Number', ['Sing', 'Plur']],
    ['Gender', []], // declared, values left to the language
  ]);
  assert.equal(allowsFeature('Number=Sing', inventory, closed), true);
  assert.equal(allowsFeature('Number=Dual', inventory, closed), false);
  assert.equal(allowsFeature('Mood=Ind', inventory, closed), false);
  // An empty value list means the key exists and its values are not policed.
  assert.equal(allowsFeature('Gender=Anything', inventory, closed), true);
  // Malformed: no key, or no '=' at all.
  assert.equal(allowsFeature('=Sing', inventory, closed), false);
  assert.equal(allowsFeature('Number', inventory, closed), false);
  assert.equal(allowsFeature('', inventory, closed), true);
});

test('descriptions layer the project over the shipped defaults', () => {
  const shipped = { NOUN: 'default', VERB: 'default' };
  assert.deepEqual(readDescriptions(undefined, shipped), shipped);
  assert.deepEqual(readDescriptions({ ud: { vocabDescriptions: { NOUN: 'mine' } } }, shipped), {
    NOUN: 'mine',
    VERB: 'default',
  });
  // A non-object is ignored rather than trusted.
  assert.deepEqual(readDescriptions({ ud: { vocabDescriptions: ['x'] } }, shipped), shipped);
});

test('cleanDescriptions stores only what is worth storing', () => {
  assert.deepEqual(cleanDescriptions({ A: ' a ', B: '', C: '   ', D: 5 }), { A: 'a' });
  assert.deepEqual(cleanDescriptions(null), {});
});

test('every universal tag ships with a definition', () => {
  // The seed is only useful if it is complete: a picker showing a definition
  // for sixteen of seventeen tags reads as a bug on the seventeenth.
  for (const tag of UPOS_TAGS) assert.ok(UPOS_DESCRIPTIONS[tag], `no definition for ${tag}`);
  for (const rel of UNIVERSAL_DEPRELS)
    assert.ok(DEPREL_DESCRIPTIONS[rel], `no definition for ${rel}`);
  // And nothing is described that is not in the set.
  assert.deepEqual(
    Object.keys(DEPREL_DESCRIPTIONS).filter((r) => !UNIVERSAL_DEPRELS.includes(r)),
    [],
  );
  assert.deepEqual(
    Object.keys(UPOS_DESCRIPTIONS).filter((t) => !UPOS_TAGS.includes(t)),
    [],
  );
});
