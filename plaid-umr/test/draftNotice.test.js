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

test('a service that declares no notice is reported as that, not as a result', () => {
  // The counts used to be rebuilt into sentences here, which was the same
  // wording as the service's and had already drifted from it.
  for (const summary of [{ drafted: 2 }, { drafted: 0, skipped: 4 }, undefined]) {
    assert.deepEqual(draftNotice(summary), {
      level: 'warning',
      title: 'Draft finished',
      message: 'The service reported no summary.',
    });
  }
});
