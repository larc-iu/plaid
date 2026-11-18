import { describe, it, expect } from 'vitest';
import { allSkipped, documentCounts, documentSentencesText } from './jobText.js';

// What the job page says of a report's documents, by the worker's rows
// (job review 2026-11-18, lane JR2).
describe('a document with sentences too long for a job (D11)', () => {
  const tooLong = (n) =>
    Array.from({ length: n }, (_, i) => ({
      sentence: `s${i + 20}`,
      sentenceId: `t${i}`,
      reason: 'too-long',
    }));
  const failed = (n) =>
    Array.from({ length: n }, (_, i) => ({
      sentence: `s${i + 1}`,
      sentenceId: `f${i}`,
      reason: 'failed',
    }));

  it('counts them apart from the sentences worked, never subtracted from them', () => {
    const d = { state: 'done', done: 8, targets: 8, skipped: tooLong(2), counts: {} };
    expect(documentSentencesText(d)).toBe('8 of 8, 2 too long');
    expect(allSkipped(d)).toBe(false);
  });

  it('counts those past the list apart from the skipped ones past it', () => {
    const d = {
      state: 'done',
      done: 5,
      targets: 5,
      skipped: [...failed(2), ...tooLong(1)],
      counts: { skippedMore: 1, tooLongMore: 3 },
    };
    expect(documentSentencesText(d)).toBe('2 of 5, 3 skipped, 4 too long');
  });

  it('keeps a document whose every target was worked out of the skipped ones', () => {
    const d = { state: 'done', done: 3, targets: 3, skipped: tooLong(3), counts: {} };
    expect(allSkipped(d)).toBe(false);
    expect(documentCounts({ totals: { documentsDone: 1 }, documents: [d] })).toMatchObject({
      done: 1,
      skipped: 0,
    });
  });
});

describe('documents the plan left out (D22)', () => {
  it('are counted apart from those not reached', () => {
    const report = {
      totals: { documentsDone: 1, documentsNotReached: 2 },
      plan: { leftOut: [{ documentId: 'l1', name: 'L1' }] },
      documents: [
        { documentId: 'd1', state: 'done', done: 1, targets: 1 },
        { documentId: 'l1', state: 'not-reached', done: 0 },
        { documentId: 'n1', state: 'not-reached', done: 0 },
      ],
    };
    expect(documentCounts(report)).toMatchObject({ notReached: 1, leftOut: 1 });
  });
});
