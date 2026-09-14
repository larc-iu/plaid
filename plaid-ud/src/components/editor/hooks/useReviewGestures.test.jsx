import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { useReviewGestures } from './useReviewGestures.js';

// Ctrl/Cmd+Enter writes and then hops, with a beat between the two so the mark
// going away is visible before the next cell scrolls in. Both halves of that
// are about ORDER, and the place they can go wrong is a second gesture arriving
// before the first has finished:
//
//   - a write that did not land must not hop, or a held-down sweep carries the
//     reader past every second word (a save already in flight makes the next
//     confirmTokens a no-op that returns false);
//   - a keystroke during the beat must flush it, or the character lands in the
//     cell being left rather than the one being moved to.
//
// A test that only reads where the caret ended up sees neither: the hop happens
// either way, and the beat resolves itself a moment later.

const MACHINE = { prov: 'inferred', provSource: 'service:stanza-parser' };

// Three words in one sentence, each with a machine lemma, so every one of them
// is a stop the gestures have something to do at.
const SENTENCES = [
  {
    id: 's1',
    tokens: ['w1', 'w2', 'w3'].map((id) => ({
      token: { id },
      lemma: { id: `${id}-lemma-span`, metadata: MACHINE },
      feats: [],
    })),
    relations: [],
  },
];

const Probe = ({ doc }) => {
  const onKeyDown = useReviewGestures({
    sentences: SENTENCES,
    doc,
    readOnly: false,
    visibleFields: { lemma: true },
    revealSentence: () => {},
  });
  return (
    <div onKeyDown={onKeyDown}>
      {SENTENCES.map((sentence) => (
        <div key={sentence.id} data-sentence-row={sentence.id}>
          {sentence.tokens.map((entry) => (
            <input key={entry.token.id} id={`${entry.token.id}-lemma`} data-orig="" />
          ))}
        </div>
      ))}
    </div>
  );
};

const cell = (view, tokenId) => view.container.querySelector(`#${tokenId}-lemma`);
const focusedId = () => document.activeElement?.id ?? null;
const press = (el, key, init) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
  });
});
afterEach(() => vi.useRealTimers());

describe('the accept gesture', () => {
  it('does not hop off a word whose write did not land', async () => {
    // The second confirm is the one a save already in flight turns down.
    const confirmTokens = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const doc = { writer: { reviewable: (meta) => !!meta?.prov }, confirmTokens };
    const view = await renderComponent(<Probe doc={doc} />);

    const first = cell(view, 'w1');
    await view.step(async () => first.focus());
    await view.step(async () => press(first, 'Enter', { ctrlKey: true }));
    await view.step(() => vi.advanceTimersByTime(250));
    expect(confirmTokens).toHaveBeenCalledWith(['w1']);
    expect(focusedId()).toBe('w2-lemma');

    // Second press, on the word the first one landed on. Nothing is written.
    await view.step(async () => press(cell(view, 'w2'), 'Enter', { ctrlKey: true }));
    await view.step(() => vi.advanceTimersByTime(250));
    expect(confirmTokens).toHaveBeenCalledWith(['w2']);
    expect(focusedId()).toBe('w2-lemma');
    await view.unmount();
  });

  it('a keystroke during the beat hops at once, so the character lands in the next cell', async () => {
    const confirmTokens = vi.fn(() => Promise.resolve(true));
    const doc = { writer: { reviewable: (meta) => !!meta?.prov }, confirmTokens };
    const view = await renderComponent(<Probe doc={doc} />);

    const first = cell(view, 'w1');
    await view.step(async () => first.focus());
    await view.step(async () => press(first, 'Enter', { ctrlKey: true }));
    // The write has landed and the beat is running: the caret has not moved yet.
    expect(focusedId()).toBe('w1-lemma');

    await view.step(async () => press(first, 'a'));
    // No timer has been advanced. The beat was flushed by the keystroke.
    expect(focusedId()).toBe('w2-lemma');

    // And it happened once, not again when the beat would have come due.
    await view.step(() => vi.advanceTimersByTime(250));
    expect(focusedId()).toBe('w2-lemma');
    await view.unmount();
  });
});
