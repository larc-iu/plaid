import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ExampleCard, snapPastPinned } from './ExampleCard.jsx';

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

// FX9-HTMLEXPORT: a gloss on the card is set as the Analyze grid and the LaTeX
// export set it, each grammatical tag in small caps. The web page export draws
// this same card, and carries `.plaid-sc` wherever the markup uses it.
describe('ExampleCard glosses', () => {
  const sc = (root) => all(root, '.plaid-sc').map((s) => s.textContent);

  it('sets the tags of a word and a morpheme field in small caps, and nothing else', async () => {
    const r = await renderComponent(
      <ExampleCard
        c={{
          ...c,
          tiers: [
            { name: 'Latin', kind: 'orthography' },
            { name: 'Gloss', kind: 'word' },
            { name: 'Morphemes', kind: 'morphemes' },
            { name: 'MGloss', kind: 'morpheme' },
          ],
          words: [
            {
              index: 1,
              surface: 'Ali-di',
              seg: 'Ali-DI',
              lines: [
                { field: 'Latin', value: 'ALI' },
                { field: 'Gloss', value: 'Ali-ERG' },
                { field: 'MGloss', value: 'Ali-1SG.ERG' },
              ],
            },
          ],
        }}
        projectId="p1"
      />,
    );
    expect(sc(r.container)).toEqual(['ERG', '1SG', 'ERG']);
    await r.unmount();
  });

  it('sets the tags of a cited word drawn morpheme by morpheme', async () => {
    const r = await renderComponent(
      <ExampleCard
        c={{
          ...c,
          tiers: [{ name: 'MGloss', kind: 'morpheme' }],
          words: [
            {
              index: 1,
              surface: 'gam-ni',
              morphs: ['gam', 'ni'],
              joiners: ['-'],
              lines: [{ field: 'MGloss', value: 'fish-PL', parts: ['fish', 'PL'] }],
            },
          ],
          focus: [{ word: 1, morpheme: 2 }],
        }}
        projectId="p1"
      />,
    );
    expect(sc(r.container)).toEqual(['PL']);
    // Inside the cited morpheme's own highlight.
    expect(r.container.querySelector('span.rounded-sm .plaid-sc')?.textContent).toBe('PL');
    await r.unmount();
  });
});

// EXAMPLE-CARD: the centring cut the word under the labels' edge partway, and
// a sliver of it ("rth") showed beside them.
describe('snapPastPinned', () => {
  // Words 100px wide from 0, labels 60px, a 300px card over 1000px.
  const columns = Array.from({ length: 10 }, (_, i) => ({ left: i * 100, right: i * 100 + 100 }));
  const opts = { columns, viewport: 300, max: 700, pinned: 60 };

  it('hides or shows whole the word under the labels, whichever is nearer', () => {
    // At 250 the labels end at 310, ten pixels into the word at 300.
    expect(snapPastPinned(250, { ...opts, cited: { left: 400, right: 500 } })).toBe(240);
    // At 300 they end at 360: the word is hidden instead.
    expect(snapPastPinned(300, { ...opts, cited: { left: 400, right: 500 } })).toBe(340);
  });

  it('leaves the centring alone on a column edge, or when snapping would cut the cited words', () => {
    expect(snapPastPinned(240, { ...opts, cited: { left: 400, right: 500 } })).toBe(240);
    // Cited 320 to 560: 240 cuts its start under the labels and 340 its end.
    expect(snapPastPinned(250, { ...opts, cited: { left: 320, right: 545 } })).toBe(250);
  });

  it('snaps the free side next to the labels of a right-to-left table', () => {
    // Labels at the right: at 250 the free part ends at 490, in the word at 400.
    expect(snapPastPinned(250, { ...opts, rtl: true, cited: { left: 300, right: 380 } })).toBe(260);
  });
});
