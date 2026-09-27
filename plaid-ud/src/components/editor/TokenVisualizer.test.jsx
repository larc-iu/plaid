import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The Token Visualization is a data surface, so it follows the rule the
// annotation grid follows: LAYOUT takes the document's direction, a VALUE
// takes its own. An Arabic sentence's badges ran left to right under a text
// box that showed the same words right to left.

vi.mock('../../utils/feedback.jsx', () => ({ notifyError: vi.fn() }));

const { TokenVisualizer } = await import('./TokenVisualizer.jsx');

// "قرأ الولد": read.PST the.boy.
const TEXT = 'قرأ الولد';
const words = [
  { id: 'w1', begin: 0, end: 3 },
  { id: 'w2', begin: 4, end: 9 },
];
const sentences = [{ id: 's1', begin: 0, end: 9 }];

const mount = (props) =>
  renderComponent(
    <TokenVisualizer
      text={TEXT}
      originalText={TEXT}
      sentenceTokens={sentences}
      wordTokens={words}
      {...props}
    />,
  );

describe('the Token Visualization', () => {
  it('lays the badges out in the document direction, each badge on its own', async () => {
    const view = await mount({ textDirection: 'rtl' });
    const box = view.container.querySelector('[dir="rtl"]');
    expect(box).not.toBeNull();
    const badges = all(box, '[data-mwt]');
    expect(badges.map((b) => b.textContent)).toEqual(['قرأ', 'الولد']);
    expect(badges.every((b) => b.getAttribute('dir') === 'auto')).toBe(true);
    // The help line under the badges is chrome, outside the mirrored block.
    expect(box.contains(view.container.querySelector('p'))).toBe(false);
    await view.unmount();
  });

  it('mirrors the untokenized text too', async () => {
    const view = await mount({ textDirection: 'rtl', wordTokens: [] });
    const box = view.container.querySelector('[dir="rtl"]');
    expect(box?.textContent).toBe(TEXT);
    await view.unmount();
  });

  it('stays left to right for a left-to-right document', async () => {
    const view = await mount({
      text: 'The dog',
      originalText: 'The dog',
      wordTokens: [
        { id: 'w1', begin: 0, end: 3 },
        { id: 'w2', begin: 4, end: 7 },
      ],
      sentenceTokens: [{ id: 's1', begin: 0, end: 7 }],
      textDirection: 'ltr',
    });
    expect(view.container.querySelector('[dir="rtl"]')).toBeNull();
    expect(view.container.querySelector('[dir="ltr"]')).not.toBeNull();
    await view.unmount();
  });

  it('keeps the stale-token count left to right inside a mirrored block', async () => {
    // "3 tokens no longer match" in an RTL paragraph moves its full stop to
    // the left. The line is chrome, not the document's text.
    const view = await mount({ textDirection: 'rtl', text: 'xyz', originalText: TEXT });
    const note = all(view.container, 'p').find((p) => p.textContent.includes('no longer match'));
    expect(note?.getAttribute('dir')).toBe('ltr');
    await view.unmount();
  });
});
