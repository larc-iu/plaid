import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tokenizeNotice } from '../src/domain/tokenizeNotice.js';

test('a tokenize that found no text or no words says so', () => {
  assert.deepEqual(tokenizeNotice({ tokensCreated: 0, reason: 'no-text' }), {
    level: 'warning',
    title: 'Nothing to tokenize',
    message: 'The document has no text.',
  });
  assert.equal(tokenizeNotice({ reason: 'no-words' }).message, 'No words found in the text.');
});

test('any other tokenize gets the fixed copy', () => {
  assert.equal(tokenizeNotice({ tokensCreated: 4 }), null);
  assert.equal(tokenizeNotice(undefined), null);
});
