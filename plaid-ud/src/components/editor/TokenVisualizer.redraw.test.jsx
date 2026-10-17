import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// REV8-APPS note: opening a token's panel drew every badge again, 600 ms a
// hover on a 10,000-word document. The badges are drawn again only when what
// they show changes. Each badge asks `stableKey` for its key once per drawing,
// so the count of those calls is the count of badges drawn.

vi.mock('../../utils/feedback.jsx', () => ({ notifyError: vi.fn() }));
const keys = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@ui/domain/pendingIds.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    stableKey: (id) => {
      keys.calls += 1;
      return real.stableKey(id);
    },
  };
});

const { TokenVisualizer } = await import('./TokenVisualizer.jsx');

const N = 200;
const TEXT = Array.from({ length: N }, (_, i) => `w${i}`).join(' ');
const words = [];
for (let i = 0, at = 0; i < N; i++) {
  const len = `w${i}`.length;
  words.push({ id: `t${i}`, begin: at, end: at + len });
  at += len + 1;
}

const hover = (view, el) =>
  view.step(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    await new Promise((r) => setTimeout(r, 200));
  });

describe('the badges', () => {
  it('are not drawn again when a panel opens or closes, and act on their token', async () => {
    const onSentenceToggle = vi.fn();
    const onOpenInAnnotate = vi.fn();
    const view = await renderComponent(
      <TokenVisualizer
        text={TEXT}
        originalText={TEXT}
        sentenceTokens={[{ id: 's1', begin: 0, end: TEXT.length }]}
        wordTokens={words}
        morphemeTokens={[]}
        onWordDelete={vi.fn()}
        onSetWordMorphemes={vi.fn()}
        onSentenceToggle={onSentenceToggle}
        onOpenInAnnotate={onOpenInAnnotate}
      />,
    );
    const badges = all(view.container, '[data-word-id]');
    expect(badges).toHaveLength(N);
    const drawn = keys.calls;
    await hover(view, badges[7]);
    expect(document.querySelector('[data-token-panel]')?.textContent).toContain('w7');
    await hover(view, badges[9]);
    expect(document.querySelector('[data-token-panel]')?.textContent).toContain('w9');
    // The panel's own key, once a panel, and nothing for the badges.
    expect(keys.calls - drawn).toBeLessThan(N / 10);
    // A click on a badge toggles its token's sentence start, and Alt+click
    // hands its sentence over to Annotate.
    await view.step(async () => badges[3].click());
    expect(onSentenceToggle).toHaveBeenCalledWith(words[3].begin);
    await view.step(async () =>
      badges[4].dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true })),
    );
    expect(onOpenInAnnotate).toHaveBeenCalledWith('s1');
    expect(onSentenceToggle).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
