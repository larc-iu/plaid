// The readers in domain/udConfig.js. Uses Node's built-in test runner: run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readStoredTokenizerLocale,
  readTokenizerLocale,
  hasUdFlag,
} from '../src/domain/udConfig.js';

const layer = (tokenizerLocale) => ({ config: { ud: { tokenizerLocale } } });
const project = (language) => ({ config: { ud: { language } } });

test("the text layer's own locale wins over the project's language", () => {
  assert.equal(readTokenizerLocale(layer('zh-Hans'), project('zh')), 'zh-Hans');
});

test("the project's language stands in, then und", () => {
  assert.equal(readTokenizerLocale(layer(''), project(' ja ')), 'ja');
  assert.equal(readTokenizerLocale(null, project('th')), 'th');
  assert.equal(readTokenizerLocale(null, null), 'und');
  assert.equal(readTokenizerLocale({ config: {} }, project('')), 'und');
});

test('the stored locale alone reads as empty when unset', () => {
  assert.equal(readStoredTokenizerLocale(layer('de')), 'de');
  assert.equal(readStoredTokenizerLocale(null), '');
});

test('a flag is set only by true', () => {
  assert.equal(hasUdFlag({ ud: { lemma: true } }, 'lemma'), true);
  assert.equal(hasUdFlag({ ud: { lemma: 'true' } }, 'lemma'), false);
  assert.equal(hasUdFlag(null, 'lemma'), false);
});
