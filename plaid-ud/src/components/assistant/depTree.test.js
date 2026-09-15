import { describe, it, expect } from 'vitest';
import { arcs, cited, layout, measure } from './depTree.js';

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

describe('cited', () => {
  const placed = (focus) =>
    measure(rows.filter((r) => !r.token).map((r) => ({ ...r, focus: focus.includes(r.id) })));

  it('keeps the relation of each marked word, which is the arc ending there', () => {
    const words = placed(['3']);
    const kept = cited(words, arcs(words));
    expect(kept.map((a) => a.deprel)).toEqual(['det']);
  });

  it('draws the whole tree when the citation marked no word', () => {
    const words = placed([]);
    expect(cited(words, arcs(words))).toHaveLength(4);
  });

  it('draws the whole tree rather than an empty box when the marked words have no relation', () => {
    const words = measure([
      { id: '1', form: 'x', head: '0', deprel: 'root', focus: false },
      { id: '2', form: 'y', head: '', deprel: '', focus: true },
    ]);
    expect(cited(words, arcs(words))).toHaveLength(1);
  });
});

// The height of an arc's flat run, off its path data.
const runY = (a) => Number(a.d.match(/Q [-\d.]+ ([-\d.]+)/)[1]);

describe('stacking', () => {
  it('draws an arc above the one it encloses', () => {
    // "a" and "el" both hang off "mar", so obl (Vamos → mar) encloses both.
    const out = layout(rows, { maxHeight: 150, all: true });
    const at = (deprel) => out.arcs.find((a) => a.deprel === deprel);
    expect(runY(at('obl'))).toBeLessThan(runY(at('case')));
    expect(runY(at('obl'))).toBeLessThan(runY(at('det')));
  });

  it('keeps a label between its own arc and the one above it', () => {
    const out = layout(rows, { maxHeight: 150, all: true });
    for (const a of out.arcs) {
      if (a.root) continue;
      expect(a.labelY).toBeLessThan(runY(a));
      expect(a.labelY).toBeGreaterThan(0);
    }
  });

  it('compresses the stack into a shallow panel rather than drawing outside it', () => {
    const deep = layout(rows, { maxHeight: 60, all: true });
    expect(deep.height).toBeLessThanOrEqual(60);
    for (const a of deep.arcs) {
      if (a.root) continue;
      expect(runY(a)).toBeGreaterThanOrEqual(0);
    }
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

  it('draws only the cited relations, and counts what it left out', () => {
    const marked = rows.map((r) => ({ ...r, focus: r.id === '3' }));
    const out = layout(marked, { maxHeight: 150 });
    expect(out.arcs.map((a) => a.deprel)).toEqual(['det']);
    expect(out.hidden).toBe(3);
    // Every word stays: a partial tree is the whole sentence with some arcs
    // over it, not a shorter sentence.
    expect(out.words.map((w) => w.form)).toEqual(['Vamos', 'a', 'el', 'mar']);
  });

  it('draws the rest when the reader asks, and still offers to narrow again', () => {
    const marked = rows.map((r) => ({ ...r, focus: r.id === '3' }));
    const out = layout(marked, { maxHeight: 150, all: true });
    expect(out.arcs).toHaveLength(4);
    expect(out.hidden).toBe(3);
  });

  it('is shorter when it draws fewer arcs, which is the point of it', () => {
    const marked = rows.map((r) => ({ ...r, focus: r.id === '3' }));
    expect(layout(marked).height).toBeLessThan(layout(marked, { all: true }).height);
  });

  it('survives a sentence with no tree at all', () => {
    const out = layout([{ id: '1', form: 'x', head: '', deprel: '', token: false }]);
    expect(out.arcs).toEqual([]);
    expect(out.height).toBeGreaterThan(0);
    expect(out.width).toBeGreaterThan(0);
  });
});

// The editor's tree gets this free: it measures DOM boxes the flex container
// has already flipped. This one places its words by character count, so it is
// the one renderer in either app that has to mirror itself.
describe('an RTL sentence', () => {
  // "قرأ الولد الكتاب": read.PST the.boy the.book.
  const arabic = [
    { id: '1', form: 'قرأ', head: '0', deprel: 'root', token: false },
    { id: '2', form: 'الولد', head: '1', deprel: 'nsubj', token: false },
    { id: '3', form: 'الكتاب', head: '1', deprel: 'obj', token: false },
  ];

  it('puts the first word on the right', () => {
    const out = layout(arabic);
    expect(out.direction).toBe('rtl');
    const xs = out.words.map((w) => w.x);
    expect(xs[0]).toBeGreaterThan(xs[1]);
    expect(xs[1]).toBeGreaterThan(xs[2]);
  });

  it('keeps every word inside the box it reports', () => {
    const out = layout(arabic);
    for (const w of out.words) {
      expect(w.left).toBeGreaterThanOrEqual(0);
      expect(w.left + w.width).toBeLessThanOrEqual(out.width);
    }
  });

  it('draws the same arcs, ending at the same words', () => {
    // Mirroring is positions only. What an arc MEANS is an index pair, and a
    // dependency still ends at its dependent.
    const out = layout(arabic, { all: true });
    expect(out.arcs.map((a) => a.deprel).sort()).toEqual(['nsubj', 'obj', 'root']);
    for (const a of out.arcs) expect(a.tipX).toBe(out.words[a.to].x);
  });

  it('leaves a Latin sentence where it was', () => {
    const out = layout(rows);
    expect(out.direction).toBe('ltr');
    const xs = out.words.map((w) => w.x);
    expect(xs[0]).toBeLessThan(xs[1]);
  });

  it('lets a caller that knows say so', () => {
    // A transliterated corpus: Latin forms, laid out the way the language reads.
    expect(layout(rows, { direction: 'rtl' }).words[0].x).toBeGreaterThan(
      layout(rows, { direction: 'rtl' }).words[1].x,
    );
  });
});
