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
