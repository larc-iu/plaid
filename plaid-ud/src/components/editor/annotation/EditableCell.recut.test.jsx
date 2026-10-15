import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur, press } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';
import { testCells } from '../../../test/cells.js';
import { wordShapeOf, wordRecutOf } from './wordShape.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// A value refused because someone else split or joined its word meanwhile
// (REV-W-RESEND R-2, the ud twin of igt's). The token can keep its id, so the
// cell is still there, but the value was typed for a word that is not. It
// used to be put back and sent again on leaving the cell, which stored it on
// the other word. It is now a conflict: the cell shows what is stored, the
// refused value is under it, and leaving the cell sends nothing.

// The tokens around t1 ("sing") after b's change to `word`: split ("si"
// with a new token "ng" after it), joined with the next ("sing along"),
// respelled in place ("sinng"), or as it was.
const orderFor = (word) => {
  const t = (id, form) => ({ token: { id, begin: 0, end: [...form].length }, wordForm: form });
  const forms = {
    sing: [t('t0', 'we'), t('t1', 'sing'), t('t2', 'along')],
    si: [t('t0', 'we'), t('t1', 'si'), t('tn', 'ng'), t('t2', 'along')],
    'sing along': [t('t0', 'we'), t('t1', 'sing along')],
    sinng: [t('t0', 'we'), t('t1', 'sinng'), t('t2', 'along')],
  };
  return forms[word];
};

// The editor's shape and re-cut check (AnnotationEditor, wordShape.js), on
// the word t1.
const wordCells = (stored, shape, heard) =>
  testCells({
    read: (key) => stored.get(key),
    shape: () => wordShapeOf(orderFor(shape.word), 1),
    recut: (snapshot) => wordRecutOf(snapshot, orderFor(shape.word), 1),
    heard,
  });

const feedback = vi.hoisted(() => ({ notifyWarning: vi.fn(), notifyError: vi.fn() }));
vi.mock('../../../utils/feedback.jsx', () => feedback);

const stores = [];
afterEach(() => {
  for (const cells of stores.splice(0)) cells.clear();
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
      tabOrder={1}
      columnWidth={80}
    />
  </EditorSessionContext.Provider>
);

async function refusedAfter({ word }) {
  let answer;
  const onAnnotationUpdate = vi.fn(() => new Promise((r) => (answer = r)));
  const stored = new Map([['t1:lemma', 'sang']]);
  const shape = { word: 'sing' };
  const heard = [];
  const cells = wordCells(stored, shape, heard);
  stores.push(cells);
  const s = {
    isReadOnly: false,
    onAnnotationUpdate,
    cells,
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
  await view.step(async () => answer({ landed: false, status: 409, readBack: true }));
  onAnnotationUpdate.mockClear();
  return { view, input: all(view.container, 'input')[0], onAnnotationUpdate, heard };
}

describe('a value refused because its word was re-cut meanwhile', () => {
  for (const word of ['si', 'sing along']) {
    it(`shows what is stored with yours under it, and leaving sends nothing (${word})`, async () => {
      const { view, input, onAnnotationUpdate, heard } = await refusedAfter({ word });
      expect(input.value).toBe('sang');
      expect(view.container.querySelector('.editable-field-conflict')?.textContent).toBe(
        'Yours: sing · Esc to keep theirs',
      );
      expect(heard).toMatchObject([
        { key: 't1:lemma', stored: 'sang', typed: 'sing', recut: { unit: 'word', text: word } },
      ]);
      expect(hasUnsavedDraft()).toBe(null);
      await view.step(async () => focus(input));
      await view.step(async () => blur(input));
      expect(onAnnotationUpdate).not.toHaveBeenCalled();
      await view.unmount();
    });
  }

  // Luke, 2026-10-15: after a split or merge the refused value was typed for
  // a word that is gone. It stays under the cell to copy from, and Enter
  // does not write it.
  it('keeps nothing on Enter: the note stays and nothing is written', async () => {
    const { view, input, onAnnotationUpdate } = await refusedAfter({ word: 'si' });
    input.focus();
    await view.step(async () => focus(input));
    await view.step(async () => press(input, 'Enter'));
    expect(onAnnotationUpdate).not.toHaveBeenCalled();
    expect(view.container.querySelector('.editable-field-conflict')?.textContent).toBe(
      'Yours: sing · Esc to keep theirs',
    );
    await view.unmount();
  });

  // A word only respelled is the same word: the conflict is the plain one,
  // and Enter keeps the value typed for it (H16-UI-CORE-3).
  it('a respelled word is the plain conflict, and Enter keeps yours', async () => {
    const { view, input, onAnnotationUpdate, heard } = await refusedAfter({ word: 'sinng' });
    expect(input.value).toBe('sang');
    expect(view.container.querySelector('.editable-field-conflict')?.textContent).toBe(
      'Yours: sing · Enter to keep yours',
    );
    expect(heard).toMatchObject([{ recut: { unit: 'word', text: 'sinng', reshaped: false } }]);
    input.focus();
    await view.step(async () => focus(input));
    await view.step(async () => press(input, 'Enter'));
    expect(onAnnotationUpdate).toHaveBeenCalledTimes(1);
    expect(onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'sing');
    expect(view.container.querySelector('.editable-field-conflict')).toBeNull();
    await view.unmount();
  });

  it('is put back to be sent again when the word was not re-cut', async () => {
    const { view, input, heard } = await refusedAfter({ word: 'sing' });
    expect(heard).toEqual([]);
    expect(input.value).toBe('sing');
    await view.unmount();
  });
});

describe('a value put back while its cell was paged away', () => {
  it('turns into a conflict when a later read finds its word re-cut', () => {
    const stored = new Map([['t1:lemma', '']]);
    const shape = { word: 'sing' };
    const heard = [];
    const cells = wordCells(stored, shape, heard);
    stores.push(cells);
    const ticket = cells.sending('t1:lemma', { saved: '', typed: 'sing' });
    expect(cells.settle(ticket, { landed: false, status: 500 }).kind).toBe('putBack');
    shape.word = 'si';
    cells.reconcile();
    expect(cells.unsentOf('t1:lemma')).toBe(null);
    expect(cells.conflictOf('t1:lemma')).toMatchObject({ typed: 'sing', stored: '' });
    expect(heard).toMatchObject([{ stored: '', typed: 'sing', recut: { text: 'si' } }]);
  });
});
