import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftNotice } from '../src/domain/draftNotice.js';

test("a service's own notice is passed through, words and severity", () => {
  assert.deepEqual(
    draftNotice({
      drafted: 0,
      skipped: 3,
      notice: {
        level: 'warning',
        title: 'Document not modified',
        message: "All 3 sentences already have graphs. Enable 'Overwrite existing graphs'.",
      },
    }),
    {
      level: 'warning',
      title: 'Document not modified',
      message: "All 3 sentences already have graphs. Enable 'Overwrite existing graphs'.",
    },
  );
});

test('an unknown severity is a warning, never a success', () => {
  const notice = draftNotice({ notice: { level: 'info', title: 'Drafted' } });
  assert.equal(notice.level, 'warning');
  assert.equal(notice.message, undefined);
});

test('counts are the fallback for a service that declares no notice', () => {
  assert.deepEqual(draftNotice({ drafted: 2 }), {
    level: 'success',
    title: 'Drafted 2 sentences',
    message: undefined,
  });
  assert.deepEqual(draftNotice({ drafted: 1, skipped: 1, failed: 2 }), {
    level: 'success',
    title: 'Drafted 1 sentence',
    message: 'Skipped 1 sentence that already had a graph. Failed 2 sentences.',
  });
});

test('a run that drafted nothing warns and says what happened instead', () => {
  assert.deepEqual(draftNotice({ drafted: 0, skipped: 4 }), {
    level: 'warning',
    title: 'Nothing drafted',
    message: 'Skipped 4 sentences that already had a graph.',
  });
  assert.deepEqual(draftNotice({ drafted: 0, failed: 1 }), {
    level: 'warning',
    title: 'Nothing drafted',
    message: 'Failed 1 sentence.',
  });
});

test('a summary with nothing in it never congratulates anyone', () => {
  const notice = draftNotice(undefined);
  assert.equal(notice.level, 'warning');
  assert.equal(notice.title, 'Nothing drafted');
  assert.equal(notice.message, 'The service reported no changes to this document.');
});
