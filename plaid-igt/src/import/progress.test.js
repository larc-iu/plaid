import { describe, it, expect } from 'vitest';
import { documentProgress, documentFraction, documentLabel } from './progress.js';

const STEPS = ['Creating document', 'Creating text', 'Creating words'];

const collect = (index, total) => {
  const events = [];
  const progress = documentProgress({
    onProgress: (p) => events.push(p),
    doc: 'Doc',
    index,
    total,
    steps: STEPS,
  });
  for (const s of STEPS) progress(s);
  return events;
};

describe('documentProgress', () => {
  it('puts the document index on EVERY step, not just the first', () => {
    // The bug this exists to prevent: the engines emitted index only on the
    // "Starting" event, so the counter snapped back to 1/N on the next step.
    const events = collect(7, 20);
    expect(events.map((e) => e.index)).toEqual([7, 7, 7]);
    expect(events.map((e) => e.total)).toEqual([20, 20, 20]);
  });

  it('reports how far into the document each step is', () => {
    expect(collect(0, 1).map((e) => e.within)).toEqual([0, 1 / 3, 2 / 3]);
  });

  it('does not move for a step the list does not know', () => {
    const events = [];
    documentProgress({ onProgress: (p) => events.push(p), doc: 'D', steps: STEPS })('Elsewhere');
    expect(events[0].within).toBe(0);
  });

  it('is a no-op without an onProgress', () => {
    expect(() => documentProgress({ doc: 'D', steps: STEPS })('Creating text')).not.toThrow();
  });
});

describe('documentFraction', () => {
  it('advances across documents', () => {
    const at = (index) => documentFraction({ index, total: 4, within: 0 });
    expect([at(0), at(1), at(2), at(3)]).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('advances within a single long document, which would otherwise sit still', () => {
    const events = collect(0, 1);
    const fractions = events.map((e) => documentFraction(e));
    expect(fractions).toEqual([0, 1 / 3, 2 / 3]);
    expect(new Set(fractions).size).toBe(3);
  });

  it('falls back to the caller total, and never leaves 0..1', () => {
    expect(documentFraction({ index: 1 }, 4)).toBe(0.25);
    expect(documentFraction({ index: 9, total: 4 })).toBe(1);
    expect(documentFraction({}, 0)).toBe(0);
    expect(documentFraction(null)).toBe(0);
  });
});

describe('documentLabel', () => {
  it('counts the document being worked on, from one', () => {
    expect(documentLabel({ doc: 'Alpha', step: 'Creating text', index: 0, total: 78 })).toBe(
      'Alpha: Creating text (1/78)',
    );
    expect(documentLabel({ doc: 'Alpha', step: 'Creating text', index: 77, total: 78 })).toBe(
      'Alpha: Creating text (78/78)',
    );
  });

  it('copes with a missing step or total', () => {
    expect(documentLabel({ doc: 'Alpha', index: 0, total: 2 })).toBe('Alpha (1/2)');
    expect(documentLabel({ doc: 'Alpha' })).toBe('Alpha');
  });
});
