import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';

// A value that was not saved (refused, or queued behind a refused edit and so
// never sent) comes back into its cell, stays there while the stored value is
// the one it was typed over, and is sent again when the annotator leaves the
// cell.

vi.mock('../../../utils/feedback.jsx', () => ({ notifyWarning: vi.fn() }));

const session = (onAnnotationUpdate) => ({
  isReadOnly: false,
  onAnnotationUpdate,
  vocab: {},
  validators: {},
  descriptions: {},
});

const cellWith = (s, value) => (
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
  await view.step(async () => answer(false));
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
      onAnnotationUpdate.mockImplementation(() => Promise.resolve(true));
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
});
