import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';
import { testCells } from '../../../test/cells.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// One annotator edits a cell twice while the first edit is still on its way,
// and the first is refused (the network, a server error, a lost answer). The
// refetch after the refusal shows the second edit again on top of what the
// server has (DocumentModel `_showUnsent`), so the grid's stored value is the
// annotator's own later value. That is not someone else's change: no note, no
// toast, and nothing that Enter could write back over their own newer value.

vi.mock('../../../utils/feedback.jsx', () => ({ notifyWarning: vi.fn() }));

const stores = [];
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

async function twoEdits() {
  const answers = [];
  const onAnnotationUpdate = vi.fn(() => new Promise((r) => answers.push(r)));
  const stored = new Map([['t1:lemma', 'mat']]);
  const heard = [];
  const cells = testCells({ read: (key) => stored.get(key), heard });
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
  await edit('matA');
  await edit('matB');
  expect(onAnnotationUpdate).toHaveBeenCalledTimes(2);
  // The server's value now, and the grid showing it.
  const refetched = async (value) => {
    stored.set('t1:lemma', value);
    await view.rerender(cellWith(s, value));
  };
  const answer = async (i, ok) => view.step(async () => answers[i](ok));
  return { view, input, onAnnotationUpdate, heard, refetched, answer };
}

describe('two edits of one cell by one annotator, the first refused', () => {
  it('the second still going: no note, no toast, the cell shows the second', async () => {
    const run = await twoEdits();
    // The refetch shows the second edit again on top of the stored `mat`.
    await run.refetched('matB');
    await run.answer(0, { landed: false });
    expect(run.heard).toEqual([]);
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.value).toBe('matB');
    await run.answer(1, { landed: true });
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.value).toBe('matB');
    await run.view.unmount();
  });

  it('both refused with nothing changed on the server: the second comes back, unsaved', async () => {
    const run = await twoEdits();
    await run.refetched('matB');
    await run.answer(0, { landed: false });
    await run.refetched('mat');
    await run.answer(1, { landed: false });
    expect(run.heard).toEqual([]);
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.value).toBe('matB');
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    await run.view.unmount();
  });

  it('the first stored and the second refused: the second comes back, unsaved', async () => {
    const run = await twoEdits();
    await run.answer(0, { landed: true });
    await run.refetched('matA');
    await run.answer(1, { landed: false });
    expect(run.heard).toEqual([]);
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.value).toBe('matB');
    await run.view.unmount();
  });

  it('both refused over another annotator’s value: the note holds the newer of the two', async () => {
    const run = await twoEdits();
    await run.refetched('matX');
    await run.answer(0, { landed: false });
    await run.answer(1, { landed: false });
    expect(noteOf(run.view)?.textContent).toBe('Yours: matB · Enter to keep yours');
    expect(run.input.value).toBe('matX');
    expect(run.heard.length).toBe(1);
    await run.view.unmount();
  });
});

// The note is chrome under a data cell. A screen reader arriving in the cell
// hears it with the cell, and it hangs from the cell's start edge in the
// sentence's direction, the value inside it keeping its own.
describe('the note under a cell that lost a conflict', () => {
  it('describes the cell and takes the sentence’s direction for where it hangs', async () => {
    const run = await twoEdits();
    await run.refetched('matX');
    await run.answer(0, { landed: false });
    await run.answer(1, { landed: false });
    const note = noteOf(run.view);
    expect(note.id).toBeTruthy();
    expect(run.input.getAttribute('aria-describedby')).toBe(note.id);
    // No `dir` of its own: its logical inset resolves in the sentence's.
    expect(note.hasAttribute('dir')).toBe(false);
    expect(note.querySelector('bdi')?.textContent).toBe('matB');
    await run.view.unmount();
  });
});
