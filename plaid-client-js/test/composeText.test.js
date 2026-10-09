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
    const { text, at } = composeText(c.input);
    assert.equal(text, c.text, JSON.stringify(c.input));
    const positions = Array.from({ length: cpLength(c.input) + 1 }, (_, p) => at(p));
    assert.deepEqual(positions, c.at, JSON.stringify(c.input));
  }
});

test('a composed text is itself, with every position kept', () => {
  const { text, at } = composeText('pʰá');
  assert.equal(text, 'pʰá');
  assert.equal(at(3), 3);
});
