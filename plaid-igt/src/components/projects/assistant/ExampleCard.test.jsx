import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ExampleCard } from './ExampleCard.jsx';

// A long sentence scrolls inside the card to the cited words, and the row
// labels (Gloss, POS…) scrolled off with the rest, so a reader saw values with
// nothing to say which line was which.

const c = {
  document: 'Text 1',
  documentId: 'd1',
  sentence: 3,
  sentenceId: 's-3',
  tiers: [{ name: 'Gloss', kind: 'word' }],
  words: [
    { index: 1, surface: 'Ali-di', lines: [{ field: 'Gloss', value: 'Ali-ERG' }] },
    { index: 2, surface: 'gam', lines: [{ field: 'Gloss', value: 'fish' }] },
  ],
  focus: [{ word: 2 }],
};

describe('ExampleCard', () => {
  it('keeps the row labels in view while the words scroll', async () => {
    const r = await renderComponent(<ExampleCard c={c} projectId="p1" />);
    const labels = all(r.container, 'th[scope="row"]');
    expect(labels.map((th) => th.textContent)).toEqual(['', 'Gloss']);
    for (const th of labels) {
      expect(th.className).toMatch(/\bsticky\b/);
      expect(th.className).toMatch(/\bstart-0\b/);
      // Opaque, or the words scrolling under it show through.
      expect(th.className).toMatch(/\bbg-card\b/);
    }
    await r.unmount();
  });
});

describe('ExampleCard scrolling', () => {
  // happy-dom lays nothing out, so the box is given a width and a content
  // width: a 900px sentence in a 300px card.
  const stub = (name, value) => {
    const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, name);
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    return () => {
      if (before) Object.defineProperty(HTMLElement.prototype, name, before);
      else delete HTMLElement.prototype[name];
    };
  };

  it('opens an RTL sentence with nothing cited at its start, which is the far right', async () => {
    const undo = [stub('scrollWidth', 900), stub('clientWidth', 300)];
    try {
      const rtl = {
        ...c,
        text: 'שלום עולם',
        words: [
          { index: 1, surface: 'שלום', lines: [{ field: 'Gloss', value: 'peace' }] },
          { index: 2, surface: 'עולם', lines: [{ field: 'Gloss', value: 'world' }] },
        ],
        focus: [],
      };
      const r = await renderComponent(<ExampleCard c={rtl} projectId="p1" />);
      expect(r.container.querySelector('table').getAttribute('dir')).toBe('rtl');
      expect(r.container.querySelector('.overflow-x-auto').scrollLeft).toBe(600);
      await r.unmount();
      // An LTR one stays at its start, the left.
      const l = await renderComponent(<ExampleCard c={{ ...c, focus: [] }} projectId="p1" />);
      expect(l.container.querySelector('.overflow-x-auto').scrollLeft).toBe(0);
      await l.unmount();
    } finally {
      undo.forEach((f) => f());
    }
  });

  it('caps a long pinned label and keeps the whole name as its tooltip', async () => {
    const long = 'Morpheme gloss in the contact language';
    const r = await renderComponent(
      <ExampleCard
        c={{
          ...c,
          tiers: [{ name: long, kind: 'word' }],
          words: c.words.map((w) => ({ ...w, lines: [{ field: long, value: 'x' }] })),
        }}
        projectId="p1"
      />,
    );
    const span = all(r.container, 'th[scope="row"] span').find((s) => s.textContent === long);
    expect(span.className).toMatch(/\btruncate\b/);
    expect(span.className).toMatch(/max-w-/);
    expect(span.getAttribute('title')).toBe(long);
    await r.unmount();
  });
});
