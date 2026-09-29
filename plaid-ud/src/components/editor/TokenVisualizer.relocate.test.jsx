import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A token with no text in the body it is measured from (V3 H3-4). A Text
// Editor save that lengthened the text froze the tab: the search for the
// token's text, '', found it everywhere and never ended.

vi.mock('../../utils/feedback.jsx', () => ({ notifyError: vi.fn() }));

const { TokenVisualizer } = await import('./TokenVisualizer.jsx');

describe('the Token Visualization while the text is edited', () => {
  it('draws a token that lies past the end of the body it came from as invalid', async () => {
    const view = await renderComponent(
      <TokenVisualizer
        text="The dog ran home ."
        originalText="The dog ran ."
        sentenceTokens={[{ id: 's1', begin: 0, end: 18 }]}
        wordTokens={[
          { id: 'w1', begin: 0, end: 3 },
          { id: 'w2', begin: 14, end: 18 },
        ]}
      />,
    );
    expect(all(view.container, '[data-mwt]').length).toBeGreaterThan(0);
    await view.unmount();
  });
});
