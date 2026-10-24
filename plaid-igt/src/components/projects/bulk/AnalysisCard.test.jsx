import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { AnalysisCard } from './AnalysisCard.jsx';

// The card joins the morphemes as the grid does: by the type each goes by,
// which for a linked morpheme is its entry's (R2), not one it holds.

describe('AnalysisCard', () => {
  it('joins a linked morpheme by the type its entry gives it', async () => {
    const analysis = {
      word: { vocabItemId: null, fields: {} },
      morphemes: [
        { form: 'ka', morphType: null, goesBy: 'stem', vocabItemId: null, fields: {} },
        { form: 'ri', morphType: null, goesBy: 'enclitic', vocabItemId: 'i-ri', fields: {} },
      ],
    };
    const view = await renderComponent(
      <AnalysisCard
        word="kari"
        analysis={analysis}
        rows={{ wordFields: [], morphFields: [], hasMorphemes: true, hasVocabs: false }}
      />,
    );
    const joiners = [...view.container.querySelectorAll('.igt-morph-joiner')].map(
      (n) => n.textContent,
    );
    expect(joiners).toEqual(['=']);
    await view.unmount();
  });
});
