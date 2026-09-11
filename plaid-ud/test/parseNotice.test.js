// What a finished parse is allowed to claim (C8). Uses Node's built-in test
// runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseNotice } from '../src/domain/parseNotice.js';

test("the service's own notice is used verbatim", () => {
  const notice = parseNotice({
    notice: { level: 'success', title: 'Parsed', message: 'Parsed 12 of 12 sentences.' },
  });
  assert.deepEqual(notice, {
    level: 'success',
    title: 'Parsed',
    message: 'Parsed 12 of 12 sentences.',
  });
});

test('a notice that is not a success is a warning, whatever it calls itself', () => {
  assert.equal(
    parseNotice({ notice: { level: 'warning', message: 'Nothing to do.' } }).level,
    'warning',
  );
  assert.equal(
    parseNotice({ notice: { level: 'info', message: 'Nothing to do.' } }).level,
    'warning',
  );
  assert.equal(parseNotice({ notice: { message: 'Nothing to do.' } }).level, 'warning');
});

test('without a notice the counts speak, and one sentence is singular', () => {
  assert.deepEqual(parseNotice({ parsedSentences: 3 }), {
    level: 'success',
    title: undefined,
    message: 'Parsed 3 sentences.',
  });
  assert.equal(parseNotice({ parsedSentences: 1 }).message, 'Parsed 1 sentence.');
});

// The shape this exists for: a service reports a per-sentence skip in its
// counts, not by failing the request, so a run that touched nothing still comes
// back a success. Saying "Parsed!" over an untouched document is the bug.
test('a run that parsed nothing warns rather than congratulates', () => {
  for (const summary of [
    { parsedSentences: 0, skippedSentences: 12 },
    { parsedSentences: 0 },
    {},
    null,
    undefined,
  ]) {
    const notice = parseNotice(summary);
    assert.equal(notice.level, 'warning', JSON.stringify(summary));
    assert.equal(notice.title, 'Nothing to parse');
  }
});

test('a count that is not a number is no count at all', () => {
  assert.equal(parseNotice({ parsedSentences: 'lots' }).level, 'warning');
  assert.equal(parseNotice({ parsedSentences: null }).level, 'warning');
});
