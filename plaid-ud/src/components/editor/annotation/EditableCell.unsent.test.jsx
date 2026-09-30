import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';
import { testCells } from '../../../test/cells.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// A value that was not saved (refused, or queued behind a refused edit and so
// never sent) comes back into its cell, stays there while the stored value is
// the one it was typed over, and is sent again when the annotator leaves the
// cell.

vi.mock('../../../utils/feedback.jsx', () => ({ notifyWarning: vi.fn() }));

// The document is what the cell was last drawn with (`cellWith`).
const session = (onAnnotationUpdate) => {
  const s = {
    isReadOnly: false,
    onAnnotationUpdate,
    now: '',
    vocab: {},
    validators: {},
    descriptions: {},
  };
  s.cells = testCells({ read: () => s.now });
  return s;
};

const cellWith = (s, value) => {
  s.now = value;
  return cellFor(s, value);
};
const cellFor = (s, value) => (
  <EditorSessionContext.Provider value={s}>
    <EditableCell
      value={value}
      tokenId="t1"
      tokenIndex={0}
      field="lemma"
      tokenForm="dogs"
      tabIndex={1}
      columnWidth={80}
    />
  </EditorSessionContext.Provider>
);

async function refused({ refetchFirst }) {
  let answer;
  const onAnnotationUpdate = vi.fn(() => new Promise((r) => (answer = r)));
  const s = session(onAnnotationUpdate);
  const view = await renderComponent(cellWith(s, ''));
  const input = all(view.container, 'input')[0];
  await view.step(async () => focus(input));
  await view.step(async () => type(input, 'wolf'));
  await view.step(async () => blur(input));
  // The optimistic patch shows it.
  await view.rerender(cellWith(s, 'wolf'));
  if (refetchFirst) await view.rerender(cellWith(s, ''));
  await view.step(async () => answer({ landed: false }));
  if (!refetchFirst) await view.rerender(cellWith(s, ''));
  return { ...view, s, input, onAnnotationUpdate };
}

describe('a value that was not saved', () => {
  for (const refetchFirst of [true, false]) {
    it(`comes back into its cell and is sent again on leaving (refetch ${refetchFirst ? 'before' : 'after'} the answer)`, async () => {
      const { input, rerender, step, s, onAnnotationUpdate, unmount } = await refused({
        refetchFirst,
      });
      expect(input.value).toBe('wolf');
      // A later render with the stored value unchanged keeps it.
      await rerender(cellWith(s, ''));
      expect(input.value).toBe('wolf');
      onAnnotationUpdate.mockImplementation(() => Promise.resolve({ landed: true }));
      await step(async () => focus(input));
      await step(async () => blur(input));
      expect(onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'wolf');
      expect(onAnnotationUpdate).toHaveBeenCalledTimes(2);
      await unmount();
    });
  }

  it('gives way when the stored value moves on', async () => {
    const { input, rerender, s, unmount } = await refused({ refetchFirst: true });
    expect(input.value).toBe('wolf');
    await rerender(cellWith(s, 'cat'));
    expect(input.value).toBe('cat');
    await unmount();
  });

  it('makes leaving ask while it sits in the cell, until the cell is taken up again', async () => {
    const { input, rerender, step, s, unmount } = await refused({ refetchFirst: true });
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    await rerender(cellWith(s, ''));
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    // Taken up again, leaving the cell sends it: nothing is left to ask about.
    await step(async () => focus(input));
    expect(hasUnsavedDraft()).toBe(null);
    // Drawn away while still focused (no blur), it goes back to wait.
    await unmount();
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    s.cells.clear();
  });

  it('stops asking when the stored value moves on, or the grid lets go', async () => {
    const first = await refused({ refetchFirst: true });
    await first.rerender(cellWith(first.s, 'cat'));
    expect(hasUnsavedDraft()).toBe(null);
    await first.unmount();
    const second = await refused({ refetchFirst: false });
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    await second.unmount();
    // The cell going is a page turned: the value waits for it.
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    second.s.cells.clear();
    expect(hasUnsavedDraft()).toBe(null);
  });
});

// The grid pages its sentences, so a cell holding a put-back value can be
// unmounted and drawn again, and a refusal can answer while its cell is away.
describe('a value that was not saved, on a page turned away from', () => {
  const drawAgain = async (s, value) => {
    const view = await renderComponent(cellWith(s, value));
    return { ...view, input: all(view.container, 'input')[0] };
  };

  it('still asks while away, and is back in its cell when the page is drawn again', async () => {
    const first = await refused({ refetchFirst: true });
    await first.unmount();
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    const again = await drawAgain(first.s, '');
    expect(again.input.value).toBe('wolf');
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    first.onAnnotationUpdate.mockImplementation(() => Promise.resolve({ landed: true }));
    await again.step(async () => focus(again.input));
    expect(hasUnsavedDraft()).toBe(null);
    await again.step(async () => blur(again.input));
    expect(first.onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'wolf');
    await again.unmount();
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('is kept when the refusal answers while the cell is away', async () => {
    let answer;
    const onAnnotationUpdate = vi.fn(() => new Promise((r) => (answer = r)));
    const s = session(onAnnotationUpdate);
    const view = await renderComponent(cellWith(s, ''));
    const input = all(view.container, 'input')[0];
    await view.step(async () => focus(input));
    await view.step(async () => type(input, 'wolf'));
    await view.step(async () => blur(input));
    await view.rerender(cellWith(s, 'wolf'));
    await view.unmount();
    answer({ landed: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    const again = await drawAgain(s, '');
    expect(again.input.value).toBe('wolf');
    await again.unmount();
    s.cells.clear();
  });

  it('gives way when the stored value moved on while away', async () => {
    const first = await refused({ refetchFirst: true });
    await first.unmount();
    const again = await drawAgain(first.s, 'cat');
    expect(again.input.value).toBe('cat');
    expect(hasUnsavedDraft()).toBe(null);
    await again.unmount();
  });
});

describe('closing the tab', () => {
  const closeAsks = () => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it('asks while a focused cell holds something typed, and not once it is left', async () => {
    const onAnnotationUpdate = vi.fn(() => Promise.resolve({ landed: true }));
    const s = session(onAnnotationUpdate);
    const view = await renderComponent(cellWith(s, 'dog'));
    const input = all(view.container, 'input')[0];
    await view.step(async () => focus(input));
    expect(closeAsks()).toBe(false);
    await view.step(async () => type(input, 'wolf'));
    expect(closeAsks()).toBe(true);
    await view.step(async () => blur(input));
    expect(onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'wolf');
    expect(closeAsks()).toBe(false);
    await view.unmount();
  });

  it('does not ask for a focused cell typed back to what is stored', async () => {
    const s = session(vi.fn(() => Promise.resolve({ landed: true })));
    const view = await renderComponent(cellWith(s, 'dog'));
    const input = all(view.container, 'input')[0];
    await view.step(async () => focus(input));
    await view.step(async () => type(input, 'dog'));
    expect(closeAsks()).toBe(false);
    await view.unmount();
  });

  it('asks while the cell holding a value that was not saved has focus, and not once it is sent', async () => {
    const { input, step, onAnnotationUpdate, unmount } = await refused({ refetchFirst: true });
    await step(async () => focus(input));
    expect(input.value).toBe('wolf');
    // Focused, the leave question stands down (leaving the cell sends the
    // value), but closing the tab would lose it.
    expect(hasUnsavedDraft()).toBe(null);
    expect(closeAsks()).toBe(true);
    // Typed back to the stored value, there is nothing left to lose.
    await step(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(closeAsks()).toBe(false);
    await step(async () => type(input, 'wolf'));
    expect(closeAsks()).toBe(true);
    onAnnotationUpdate.mockImplementation(() => Promise.resolve({ landed: true }));
    await step(async () => blur(input));
    expect(closeAsks()).toBe(false);
    await unmount();
    expect(closeAsks()).toBe(false);
  });
});
