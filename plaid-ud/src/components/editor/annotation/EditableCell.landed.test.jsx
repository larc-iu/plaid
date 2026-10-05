import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';
import { testCells } from '../../../test/cells.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { notifyError, notifyWarning } from '../../../utils/feedback.jsx';

// An edit whose answer was lost on the way back, but which landed. The
// refetch after it reads the typed value, which is stored: nothing is put
// back, nothing is asked on leaving, and a later edit refused for another
// reason is not taken for another annotator's change (REV-F-UD-CELL R4 and
// REV-F-IGT D2). And a conflict that is not the cell's own says the value is
// kept in its cell.

vi.mock('../../../utils/feedback.jsx', () => ({ notifyWarning: vi.fn(), notifyError: vi.fn() }));

const stores = [];
beforeEach(() => {
  vi.mocked(notifyWarning).mockClear();
  vi.mocked(notifyError).mockClear();
});
afterEach(() => {
  for (const cells of stores.splice(0)) cells.clear();
});

const cellWith = (s, value) => (
  <EditorSessionContext.Provider value={s}>
    <EditableCell
      value={value}
      tokenId="t1"
      tokenIndex={0}
      field="lemma"
      tokenForm="mat"
      tabOrder={1}
      columnWidth={80}
    />
  </EditorSessionContext.Provider>
);

const noteOf = (view) => view.container.querySelector('.editable-field-conflict');

async function setup() {
  const answers = [];
  const onAnnotationUpdate = vi.fn(() => new Promise((r) => answers.push(r)));
  const stored = new Map([['t1:lemma', 'mat']]);
  const heard = [];
  const cells = testCells({
    read: (key) => stored.get(key),
    heard,
    warn: notifyWarning,
    error: notifyError,
  });
  stores.push(cells);
  const s = {
    isReadOnly: false,
    onAnnotationUpdate,
    cells,
    vocab: {},
    validators: {},
    descriptions: {},
  };
  const view = await renderComponent(cellWith(s, 'mat'));
  const input = all(view.container, 'input')[0];
  const edit = async (text) => {
    await view.step(async () => focus(input));
    await view.step(async () => type(input, text));
    await view.step(async () => blur(input));
    stored.set('t1:lemma', text);
    await view.rerender(cellWith(s, text));
  };
  // The server's value now, and the grid showing it.
  const refetched = async (value) => {
    stored.set('t1:lemma', value);
    await view.rerender(cellWith(s, value));
  };
  const answer = async (i, ok) => view.step(async () => answers[i](ok));
  return { view, input, heard, edit, refetched, answer };
}

const lost = { landed: false, status: 0, error: new Error('lost'), readBack: true };

describe('an edit that landed with its answer lost', () => {
  it('is not put back, and nothing is asked on leaving', async () => {
    const run = await setup();
    await run.edit('matA');
    await run.refetched('matA');
    await run.answer(0, lost);
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.value).toBe('matA');
    expect(hasUnsavedDraft()).toBe(null);
    await run.view.unmount();
  });

  it('then a later edit refused for another reason is put back, not a conflict', async () => {
    const run = await setup();
    await run.edit('matA');
    await run.refetched('matA');
    await run.answer(0, lost);
    await run.edit('matB');
    await run.refetched('matA');
    await run.answer(1, { landed: false, status: 500, error: new Error('boom'), readBack: true });
    expect(run.heard).toEqual([]);
    expect(noteOf(run.view)).toBe(null);
    expect(notifyWarning).not.toHaveBeenCalled();
    expect(run.input.value).toBe('matB');
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    await run.view.unmount();
  });

  it('without a refetch that landed, is still put back', async () => {
    const run = await setup();
    await run.edit('matA');
    await run.answer(0, { ...lost, readBack: false });
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    await run.view.unmount();
  });
});

describe('a conflict that is not the cell’s own', () => {
  it('says the value is kept in its cell, not to redo the edit', async () => {
    const run = await setup();
    await run.edit('matA');
    await run.refetched('mat');
    await run.answer(0, { landed: false, status: 409, error: new Error('409'), readBack: true });
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.value).toBe('matA');
    expect(notifyError).toHaveBeenCalledWith(
      'Changed elsewhere. Your value is in its cell, not saved.',
      'Failed to update lemma',
    );
    await run.view.unmount();
  });
});
