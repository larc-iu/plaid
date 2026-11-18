import { describe, it, expect } from 'vitest';
import {
  allSkipped,
  documentCounts,
  documentSentencesText,
  pieceEndLines,
  planParts,
  serverEndLine,
  skippedText,
} from './jobText.js';

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

describe('a piece ended by a repeat stop (REV-JR1-6)', () => {
  it('says the model repeated itself, whether its work was written or not', () => {
    expect(pieceEndLines({ ended: 'repeating', counts: { changes: 2 } })).toEqual([
      'Model repeated itself: written as staged.',
    ]);
    expect(pieceEndLines({ ended: 'repeating', counts: { changes: 0 } })).toEqual([
      'Model repeated itself: what it had staged was not written.',
    ]);
    expect(pieceEndLines({ ended: 'budget', counts: { changes: 1 } })).toEqual([
      'Steps used up: written as staged.',
    ]);
  });
});

// S1-2: a call the model's provider refused is never an answer too long.
describe('a sentence failed by a refusal of the model', () => {
  it('says the model refused it', () => {
    expect(skippedText({ reason: 'failed', kind: 'refused' })).toBe('Failed: refused by the model');
    expect(pieceEndLines({ failed: 'refused' })).toEqual(['Failed: refused by the model.']);
  });
});

// JOIN18 (REV-G4-1): the Plan line's search is drawn in a <bdi>, never with
// invisible isolate characters in its text.
describe('the Plan line', () => {
  it('isolates the search as a part, its text holding no isolate character', () => {
    const plan = {
      pieces: 'sentences',
      search: { said: 'word form "שלום"', sentences: 33, documents: 24 },
      fillsNames: ['Gloss'],
    };
    const parts = planParts(plan);
    expect(parts).toEqual([
      'Worked in stretches of sentences, only the sentences matching ',
      { isolate: ['word form "שלום"'] },
      ': 33 sentences in 24 documents. Fills: Gloss.',
    ]);
    expect(JSON.stringify(parts)).not.toMatch(/[⁦-⁩]/);
    expect(planParts({ by: 'none', reason: 'failed' })).toHaveLength(1);
  });

  // S2-2: a one-step plan over some of the job's documents never says "all".
  it('says how many documents a one-step plan named when it named fewer than all', () => {
    expect(planParts({ pieces: 'selection', documentsNamed: 2, fillsNames: ['Gloss'] })).toEqual([
      'Worked on 2 documents in one part. Fills: Gloss.',
    ]);
    expect(planParts({ pieces: 'selection', documentsNamed: 1, fillsNames: ['Gloss'] })).toEqual([
      'Worked on 1 document in one part. Fills: Gloss.',
    ]);
    expect(planParts({ pieces: 'selection', fillsNames: ['Gloss'] })).toEqual([
      'Worked on all the documents at once. Fills: Gloss.',
    ]);
  });
});

// REV-SJ1-10: every end the server writes the report of from the rows.
describe('the line of a job the server ended', () => {
  const core = (over) => ({ report: { totals: { changes: 0 }, ...over } });
  it('says what ended it, and that the counts may be short when History holds its writes', () => {
    const hedge = ' The counts are what its worker recorded before it stopped.';
    expect(serverEndLine({ ...core({ stopped: 'without-worker' }), wrote: true })).toBe(
      `Stopped with no worker running.${hedge}`,
    );
    expect(serverEndLine({ ...core({ stopped: 'without-worker' }), wrote: false })).toBe(
      'Stopped with no worker running.',
    );
    for (const reason of ['worker-lost', 'starter-access']) {
      expect(serverEndLine({ ...core({ stopped: null }), reason, wrote: true })).toBe(hedge.trim());
    }
  });
  it('adds nothing to a reason that already says what ended the job, when the job wrote nothing', () => {
    for (const reason of ['worker-lost', 'starter-access']) {
      expect(serverEndLine({ report: { stopped: null }, reason, wrote: false })).toBe(null);
    }
  });
  it('says nothing of a report its worker wrote', () => {
    expect(serverEndLine({ report: { notice: null, stopped: null }, wrote: true })).toBe(null);
    expect(
      serverEndLine({
        report: { notice: null, stopped: null },
        reason: 'starter-access',
        wrote: true,
      }),
    ).toBe(null);
    expect(serverEndLine({ report: { stopped: null }, state: 'done', wrote: true })).toBe(null);
    expect(serverEndLine({ report: null })).toBe(null);
  });
});
