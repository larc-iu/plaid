// composeText. The cases in fixtures/compose.json are shared with the Python
// client (tests/test_compose_text.py) and the core
// (plaid.util.compose-test), which made them, so the three compose a body and
// map its positions alike.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { composeText, cpLength } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'fixtures', 'compose.json'), 'utf8'));

test('every case composes as the core does', () => {
  for (const c of cases) {
    const { text, at } = composeText(c.input, c.cuts);
    assert.equal(text, c.text, JSON.stringify([c.input, c.cuts]));
    const positions = Array.from({ length: cpLength(c.input) + 1 }, (_, p) => at(p));
    assert.deepEqual(positions, c.at, JSON.stringify([c.input, c.cuts]));
  }
});

test('a composed text is itself, with every position kept', () => {
  const { text, at } = composeText('pʰá');
  assert.equal(text, 'pʰá');
  assert.equal(at(3), 3);
});

test('a token edge inside a character keeps it decomposed, so no token is left empty', () => {
  // morphemes "ka" [0, 2] and the tone [2, 3]
  const { text, at } = composeText('ka\u0301', [0, 2, 3]);
  assert.equal(text, 'ka\u0301');
  assert.deepEqual([at(0), at(2), at(3)], [0, 2, 3]);
  // with no edges known, the tone is left with no text
  const whole = composeText('ka\u0301');
  assert.equal(whole.text, 'k\u00e1');
  assert.equal(whole.at(2), whole.at(3));
});
