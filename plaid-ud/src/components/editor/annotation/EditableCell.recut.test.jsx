import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';
import { UnsentValues } from './unsentValues.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// A value refused because someone else split or joined its word meanwhile
// (REV-W-RESEND R-2, the ud twin of igt's). The token can keep its id, so the
// cell is still there, but the value was typed for a word that is not. It
// used to be put back and sent again on leaving the cell, which stored it on
// the other word. It is now a conflict: the cell shows what is stored, the
// refused value is under it, and leaving the cell sends nothing.

const feedback = vi.hoisted(() => ({ notifyWarning: vi.fn(), notifyError: vi.fn() }));
vi.mock('../../../utils/feedback.jsx', () => feedback);

const stores = [];
afterEach(() => {
  for (const unsent of stores.splice(0)) unsent.clear();
  feedback.notifyError.mockReset();
});

const cellWith = (s, value) => (
  <EditorSessionContext.Provider value={s}>
    <EditableCell
      value={value}
      tokenId="t1"
      tokenIndex={0}
      field="lemma"
      tokenForm="sing"
      tabIndex={1}
      columnWidth={80}
    />
  </EditorSessionContext.Provider>
);

async function refusedAfter({ word }) {
  let answer;
  const onAnnotationUpdate = vi.fn(() => new Promise((r) => (answer = r)));
  const stored = new Map([['t1:lemma', 'sang']]);
  const shape = { word: 'sing' };
  const onConflict = vi.fn();
  const unsent = new UnsentValues((tokenId, field) => stored.get(`${tokenId}:${field}`), {
    onConflict,
    tokenShape: () => ({ key: shape.word, text: shape.word }),
  });
  stores.push(unsent);
  const s = {
    isReadOnly: false,
    onAnnotationUpdate,
    unsent,
    vocab: {},
    validators: {},
    descriptions: {},
  };
  const view = await renderComponent(cellWith(s, 'sang'));
  const input = all(view.container, 'input')[0];
  await view.step(async () => focus(input));
  await view.step(async () => type(input, 'sing'));
  await view.step(async () => blur(input));
  stored.set('t1:lemma', 'sing');
  await view.rerender(cellWith(s, 'sing'));
  // The refetch: b re-cut the word, and the lemma is as it was.
  shape.word = word;
  stored.set('t1:lemma', 'sang');
  await view.rerender(cellWith(s, 'sang'));
  await view.step(async () => answer({ refused: true, status: 409, readBack: true }));
  onAnnotationUpdate.mockClear();
  return { view, input: all(view.container, 'input')[0], onAnnotationUpdate, onConflict };
}

describe('a value refused because its word was re-cut meanwhile', () => {
  for (const word of ['si', 'sing along']) {
    it(`shows what is stored with yours under it, and leaving sends nothing (${word})`, async () => {
      const { view, input, onAnnotationUpdate, onConflict } = await refusedAfter({ word });
      expect(input.value).toBe('sang');
      expect(view.container.querySelector('.editable-field-conflict')?.textContent).toBe(
        'Yours: sing · Enter to keep yours',
      );
      expect(onConflict).toHaveBeenCalledWith('t1', 'lemma', 'sang', 'sing', word);
      expect(hasUnsavedDraft()).toBe(null);
      await view.step(async () => focus(input));
      await view.step(async () => blur(input));
      expect(onAnnotationUpdate).not.toHaveBeenCalled();
      await view.unmount();
    });
  }

  it('is put back to be sent again when the word was not re-cut', async () => {
    const { view, input, onConflict } = await refusedAfter({ word: 'sing' });
    expect(onConflict).not.toHaveBeenCalled();
    expect(input.value).toBe('sing');
    await view.unmount();
  });
});

describe('a value put back while its cell was paged away', () => {
  it('turns into a conflict when a later read finds its word re-cut', () => {
    const stored = new Map([['t1:lemma', '']]);
    const shape = { word: 'sing' };
    const onConflict = vi.fn();
    const unsent = new UnsentValues((tokenId, field) => stored.get(`${tokenId}:${field}`), {
      onConflict,
      tokenShape: () => ({ key: shape.word, text: shape.word }),
    });
    stores.push(unsent);
    expect(unsent.put('t1', 'lemma', 'sing', '')).toBe('put');
    shape.word = 'si';
    unsent.prune();
    expect(unsent.get('t1', 'lemma')).toBe(null);
    expect(unsent.conflictOf('t1', 'lemma')).toEqual({ typed: 'sing', stored: '' });
    expect(onConflict).toHaveBeenCalledWith('t1', 'lemma', '', 'sing', 'si');
  });
});
