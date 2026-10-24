// What a finished parse is allowed to claim (C8), worded here from the counts
// the service reports (R18). Uses Node's built-in test runner: run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseNotice } from '../src/domain/parseNotice.js';

test('a parse says how many sentences it parsed, one sentence singular', () => {
  assert.deepEqual(parseNotice({ parsedSentences: 3, skippedSentences: 0 }), {
    level: 'success',
    title: 'Parsed 3 sentences',
    message: undefined,
  });
  assert.equal(parseNotice({ parsedSentences: 1 }).title, 'Parsed 1 sentence');
});

test('the sentences kept for a person are named beside a parse', () => {
  assert.deepEqual(parseNotice({ parsedSentences: 2, skippedSentences: 1 }), {
    level: 'success',
    title: 'Parsed 2 sentences',
    message: 'Kept 1 sentence with a person’s annotations.',
  });
});

// The shape this exists for: a service reports a per-sentence skip in its
// counts, not by failing the request, so a run that touched nothing still comes
// back a success. Saying "Parsed!" over an untouched document is the bug.
test('a run that kept every sentence warns and names Overwrite', () => {
  assert.deepEqual(parseNotice({ parsedSentences: 0, skippedSentences: 12 }), {
    level: 'warning',
    title: 'Document not modified',
    message:
      'All 12 sentences have annotations a person made or verified. Turn on “Overwrite” to parse them.',
  });
  assert.equal(
    parseNotice({ parsedSentences: 0, skippedSentences: 1 }).message,
    '1 sentence has annotations a person made or verified. Turn on “Overwrite” to parse them.',
  );
});

test('a run with nothing to parse warns rather than congratulates', () => {
  for (const summary of [{ parsedSentences: 0, skippedSentences: 0 }, {}, null, undefined]) {
    const notice = parseNotice(summary);
    assert.equal(notice.level, 'warning', JSON.stringify(summary));
    assert.equal(notice.title, 'Nothing to parse');
  }
});

test('a document with no text says so', () => {
  assert.deepEqual(parseNotice({ parsedSentences: 0, skippedSentences: 0, reason: 'no-text' }), {
    level: 'warning',
    title: 'Nothing to parse',
    message: 'The document has no text.',
  });
});

test('a notice text a result carries is not shown: the words are the app’s', () => {
  const notice = parseNotice({
    parsedSentences: 0,
    notice: { level: 'success', title: 'Parsed', message: 'Parsed 12 sentences.' },
  });
  assert.equal(notice.level, 'warning');
  assert.equal(notice.title, 'Nothing to parse');
});

test('a count that is not a whole number is no count at all', () => {
  assert.equal(parseNotice({ parsedSentences: 'lots' }).level, 'warning');
  assert.equal(parseNotice({ parsedSentences: null }).level, 'warning');
  assert.equal(parseNotice({ parsedSentences: 1.5 }).level, 'warning');
});
