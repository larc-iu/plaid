// The readers in domain/udConfig.js. Uses Node's built-in test runner: run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readStoredTokenizerLocale, hasUdFlag } from '../src/domain/udConfig.js';

const layer = (tokenizerLocale) => ({ config: { ud: { tokenizerLocale } } });

test('the stored locale alone reads as empty when unset', () => {
  assert.equal(readStoredTokenizerLocale(layer('de')), 'de');
  assert.equal(readStoredTokenizerLocale(null), '');
});

test('a flag is set only by true', () => {
  assert.equal(hasUdFlag({ ud: { lemma: true } }, 'lemma'), true);
  assert.equal(hasUdFlag({ ud: { lemma: 'true' } }, 'lemma'), false);
  assert.equal(hasUdFlag(null, 'lemma'), false);
});
