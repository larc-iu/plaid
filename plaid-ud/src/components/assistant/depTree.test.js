import { describe, it, expect } from 'vitest';
import { arcHeight, arcs, layout, measure } from './depTree.js';

// s1: "Vamos al mar ." with al a multi-word token over words 2 and 3.
const rows = [
  { id: '1', form: 'Vamos', head: '0', deprel: 'root', token: false },
  { id: '2-3', form: 'al', head: '', deprel: '', token: true },
  { id: '2', form: 'a', head: '4', deprel: 'case', token: false },
  { id: '3', form: 'el', head: '4', deprel: 'det', token: false },
  { id: '4', form: 'mar', head: '1', deprel: 'obl', token: false },
];

describe('arcs', () => {
  it('leaves the multi-word token line out: it is not a word of the tree', () => {
    const placed = measure(rows.filter((r) => !r.token));
    expect(placed.map((w) => w.form)).toEqual(['Vamos', 'a', 'el', 'mar']);
  });

  it('makes the root a stalk and the rest spans between words', () => {
    const placed = measure(rows.filter((r) => !r.token));
    const out = arcs(placed);
    expect(out.find((a) => a.root)).toMatchObject({ to: 0, deprel: 'root' });
    expect(
      out
        .filter((a) => !a.root)
        .map((a) => a.deprel)
        .sort(),
    ).toEqual(['case', 'det', 'obl']);
  });

  it('draws nothing for a head that points at no word', () => {
    const placed = measure([{ id: '1', form: 'x', head: '9', deprel: 'dep' }]);
    expect(arcs(placed)).toEqual([]);
  });

  it('draws nothing for a word with no head, which is most of a new document', () => {
    const placed = measure([
      { id: '1', form: 'x', head: '', deprel: '' },
      { id: '2', form: 'y', head: '_', deprel: '' },
    ]);
    expect(arcs(placed)).toEqual([]);
  });
});

describe('arcHeight', () => {
  it('rises with distance and never exceeds the budget', () => {
    expect(arcHeight(1, 100)).toBeLessThan(arcHeight(5, 100));
    expect(arcHeight(40, 100)).toBeLessThanOrEqual(100);
  });

  it('is zero for no distance, so a self-reference draws no hump', () => {
    expect(arcHeight(0, 100)).toBe(0);
  });
});

describe('layout', () => {
  it('puts every arc inside the box it reports', () => {
    const out = layout(rows, { maxHeight: 150 });
    expect(out.height).toBeLessThanOrEqual(150);
    for (const a of out.arcs) {
      const ys = [...a.d.matchAll(/[-\d.]+ ([-\d.]+)/g)].map((m) => Number(m[1]));
      for (const y of ys) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(out.height);
      }
    }
  });

  it('keeps the words on the baseline it reports', () => {
    const out = layout(rows);
    expect(out.baseY).toBeLessThan(out.height);
    expect(out.baseY).toBeGreaterThan(0);
  });

  it('survives a sentence with no tree at all', () => {
    const out = layout([{ id: '1', form: 'x', head: '', deprel: '', token: false }]);
    expect(out.arcs).toEqual([]);
    expect(out.height).toBeGreaterThan(0);
    expect(out.width).toBeGreaterThan(0);
  });
});
