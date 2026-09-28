// The name the app picks for a new node is ASCII (the owner's ruling of
// 2026-09-28): validate.py reads an accented variable in the sentence graph
// and not in the document-level block, so `s4é` failed its sentence's whole
// block at its first :modal or :before. A person may still type one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextVariable } from '../src/domain/sentenceGraph.js';

test('an accented first letter gives its base letter', () => {
  assert.equal(nextVariable(4, 'ébrio', new Set()), 's4e');
  assert.equal(nextVariable(4, 'Ñandú', new Set()), 's4n');
  assert.equal(nextVariable(4, 'çay', new Set(['s4c'])), 's4c2');
  // Precomposed or combining, the same.
  assert.equal(nextVariable(2, 'ébrio', new Set()), 's2e');
});

test('a letter with no ASCII base, or no letter, gives x', () => {
  assert.equal(nextVariable(10, 'αλήθεια', new Set()), 's10x');
  assert.equal(nextVariable(3, 'قال-01', new Set()), 's3x');
  assert.equal(nextVariable(3, 'ø', new Set()), 's3x');
  assert.equal(nextVariable(2, '-91', new Set()), 's2x');
  assert.equal(nextVariable(1, 'dog', new Set()), 's1d');
});
