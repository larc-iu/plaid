import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// The badges are plain spans and one hover panel serves them all, anchored to
// the badge it opened from. A popover around each badge cost seconds on a
// 21,000-word document. Hovering still opens the panel of the token under the
// pointer, with that token's words, and its buttons act on that token.

vi.mock('../../utils/feedback.jsx', () => ({ notifyError: vi.fn() }));

const { TokenVisualizer } = await import('./TokenVisualizer.jsx');

const TEXT = 'The dog del 😀x';
const words = [
  { id: 'w1', begin: 0, end: 3 },
  { id: 'w2', begin: 4, end: 7 },
  { id: 'w3', begin: 8, end: 11 },
  { id: 'w4', begin: 12, end: 14 },
];
const morphemes = [
  { id: 'm1', begin: 0, end: 3, precedence: 0 },
  { id: 'm2', begin: 4, end: 7, precedence: 0 },
  { id: 'm3a', begin: 8, end: 11, precedence: 0 },
  { id: 'm3b', begin: 8, end: 11, precedence: 1 },
  { id: 'm4', begin: 12, end: 14, precedence: 0 },
];

const hover = (view, el) =>
  view.step(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    await new Promise((r) => setTimeout(r, 200));
  });
const panel = () => document.querySelector('[data-token-panel]');

describe('the token panel', () => {
  it('opens on the hovered token, follows the pointer, and acts on its token', async () => {
    const onWordDelete = vi.fn();
    const view = await renderComponent(
      <TokenVisualizer
        text={TEXT}
        originalText={TEXT}
        sentenceTokens={[{ id: 's1', begin: 0, end: 14 }]}
        wordTokens={words}
        morphemeTokens={morphemes}
        morphemeForms={
          new Map([
            ['m3a', 'de'],
            ['m3b', 'el'],
          ])
        }
        onWordDelete={onWordDelete}
        onSetWordMorphemes={vi.fn()}
        onSentenceToggle={vi.fn()}
      />,
    );
    const badges = all(view.container, '[data-mwt]');
    expect(badges.map((b) => b.textContent)).toEqual(['The', 'dog', 'del', '😀x']);
    expect(badges.map((b) => b.getAttribute('data-mwt'))).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
    expect(panel()).toBeNull();

    await hover(view, badges[1]);
    expect(panel()?.textContent).toContain('dog');
    expect(panel()?.textContent).toContain('[4–7]');

    await hover(view, badges[2]);
    expect(panel()?.textContent).toContain('multi-word token');
    expect(all(panel(), 'input').map((i) => i.value)).toEqual(['de', 'el']);

    // Code points, not UTF-16 units: the emoji is one character.
    await hover(view, badges[3]);
    expect(all(panel(), 'input').map((i) => i.value)).toEqual(['😀x']);
    expect(panel()?.textContent).toContain('[12–14]');

    const del = all(panel(), 'button').find((b) => b.textContent.includes('Delete'));
    await view.step(async () => del.click());
    expect(onWordDelete).toHaveBeenCalledWith('w4');
    expect(panel()).toBeNull();
    await view.unmount();
  });

  it('stays open on its token when the token moves into another sentence', async () => {
    // The panel's own switch splits the sentence at its token, which draws
    // that token's badge again inside a new sentence block.
    const props = {
      text: TEXT,
      originalText: TEXT,
      wordTokens: words,
      morphemeTokens: morphemes,
      onSentenceToggle: vi.fn(),
      onWordDelete: vi.fn(),
    };
    const view = await renderComponent(
      <TokenVisualizer {...props} sentenceTokens={[{ id: 's1', begin: 0, end: 14 }]} />,
    );
    await hover(view, all(view.container, '[data-mwt]')[1]);
    expect(panel()?.textContent).toContain('dog');

    const split = [
      { id: 's1', begin: 0, end: 4 },
      { id: 's2', begin: 4, end: 14 },
    ];
    await view.rerender(<TokenVisualizer {...props} sentenceTokens={split} />);
    expect(all(view.container, '[data-sentence-block]').length).toBe(2);
    expect(panel()?.textContent).toContain('dog');
    expect(panel()?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');

    // And back: merged again, still open on the same token.
    await view.rerender(
      <TokenVisualizer {...props} sentenceTokens={[{ id: 's1', begin: 0, end: 14 }]} />,
    );
    expect(panel()?.textContent).toContain('dog');
    await view.unmount();
  });

  it('closes when its token is gone', async () => {
    const props = {
      text: TEXT,
      originalText: TEXT,
      sentenceTokens: [{ id: 's1', begin: 0, end: 14 }],
      morphemeTokens: morphemes,
      onWordDelete: vi.fn(),
    };
    const view = await renderComponent(<TokenVisualizer {...props} wordTokens={words} />);
    await hover(view, all(view.container, '[data-mwt]')[1]);
    expect(panel()).not.toBeNull();
    await view.rerender(
      <TokenVisualizer {...props} wordTokens={words.filter((w) => w.id !== 'w2')} />,
    );
    expect(panel()).toBeNull();
    // Another token opens as usual.
    await hover(view, all(view.container, '[data-mwt]')[0]);
    expect(panel()?.textContent).toContain('The');
    await view.unmount();
  });

  it('opens no panel while the text has unsaved edits', async () => {
    const view = await renderComponent(
      <TokenVisualizer
        text="The big dog"
        originalText="The dog"
        sentenceTokens={[{ id: 's1', begin: 0, end: 7 }]}
        wordTokens={words.slice(0, 2)}
        morphemeTokens={morphemes.slice(0, 2)}
        onWordDelete={vi.fn()}
      />,
    );
    const badges = all(view.container, '[data-mwt]');
    // The relocated preview: "dog" moved past the inserted word.
    expect(badges.map((b) => b.textContent)).toEqual(['The', 'dog']);
    await hover(view, badges[1]);
    expect(panel()).toBeNull();
    await view.unmount();
  });
});
