import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur, press } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';
import { testCells } from '../../../test/cells.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';

// An edit refused because someone else changed the same cell first (a 409 on
// a stale document, V3 H3-1, V1-S2, H6-5). The refetch that follows the
// refusal brings the other annotator's value. Whatever the loser then sees,
// leaving the cell must not write the refused value over the winner's: the
// winner's edit was never on the loser's screen, so that write undoes it
// unseen.
//
// Every path V3 found: LEMMA, UPOS and XPOS (the three columns EditableCell
// draws), a cell that was empty before (XPOS, a create refused), the refetch
// landing before or after the refusal's answer, the annotator back in the
// cell before the answer (the focused path), the cell paged away when the
// answer comes, the word gone (replaced by a parse), and the grid letting
// go of the value on its next save while the cell still shows it (V3-a).

const feedback = vi.hoisted(() => ({ notifyWarning: vi.fn(), notifyError: vi.fn() }));
vi.mock('../../../utils/feedback.jsx', () => feedback);

const VOCAB = { upos: ['NOUN', 'VERB', 'ADV', 'PROPN'], xpos: ['NNB', 'NNC', 'NN'] };

// The grid's stored values, which the cell engine reads (`undefined` for a
// token no longer there). Every engine a test makes is let go of after it, so
// no test's leave question is read by the next.
const stores = [];
const made = (cells) => {
  stores.push(cells);
  return cells;
};
afterEach(() => {
  for (const cells of stores.splice(0)) cells.clear();
  feedback.notifyError.mockReset();
  feedback.notifyWarning.mockReset();
});

const makeSession = (onAnnotationUpdate, stored) => ({
  isReadOnly: false,
  onAnnotationUpdate,
  cells: made(
    testCells({
      read: (key) => stored.get(key),
      warn: feedback.notifyWarning,
      error: feedback.notifyError,
    }),
  ),
  vocab: VOCAB,
  validators: {},
  descriptions: {},
});

const cellWith = (s, field, value) => (
  <EditorSessionContext.Provider value={s}>
    <EditableCell
      value={value}
      tokenId="t1"
      tokenIndex={0}
      field={field}
      tokenForm="sat"
      tabIndex={1}
      columnWidth={80}
    />
  </EditorSessionContext.Provider>
);

const inputOf = (view) => all(view.container, 'input')[0];

/**
 * The loser types `typed` over `before` and leaves the cell. The winner's
 * `winner` is stored meanwhile. The loser's write is refused.
 *
 * `order`: 'refetch-first' (DocumentModel's order: the refetch has swapped the
 * document before the write resolves false) or 'answer-first' (the refetch
 * waits for writes queued behind the refused one).
 * `refocused`: the loser went back into the cell before the answer came.
 * `away`: the cell is paged away when the answer comes.
 * `gone`: the word is gone after the refetch (a parse replaced it).
 */
async function lostTo({
  field,
  before,
  typed,
  winner,
  order = 'refetch-first',
  refocused = false,
  away = false,
  gone = false,
  refusal = { landed: false },
  refetches = true,
}) {
  let answer;
  const onAnnotationUpdate = vi.fn(() => new Promise((r) => (answer = r)));
  const stored = new Map([[`t1:${field}`, before]]);
  const s = makeSession(onAnnotationUpdate, stored);
  let view = await renderComponent(cellWith(s, field, before));
  let input = inputOf(view);
  await view.step(async () => focus(input));
  await view.step(async () => type(input, typed));
  await view.step(async () => blur(input));
  expect(onAnnotationUpdate).toHaveBeenCalledWith('t1', field, typed);
  // The optimistic patch shows it.
  stored.set(`t1:${field}`, typed);
  await view.rerender(cellWith(s, field, typed));
  if (refocused) await view.step(async () => focus(input));

  const refetch = async () => {
    if (gone) stored.delete(`t1:${field}`);
    else stored.set(`t1:${field}`, winner);
    if (view && !gone) await view.rerender(cellWith(s, field, winner));
  };
  if (away || gone) {
    await view.unmount();
    view = null;
  }
  if (order === 'refetch-first') await refetch();
  if (view) await view.step(async () => answer(refusal));
  else {
    answer(refusal);
    await new Promise((r) => setTimeout(r, 0));
  }
  if (order === 'answer-first' && refetches) await refetch();

  if (!view && !gone) {
    view = await renderComponent(cellWith(s, field, winner));
    input = inputOf(view);
  }
  onAnnotationUpdate.mockImplementation(() => Promise.resolve({ landed: true }));
  return { view, input, s, stored, onAnnotationUpdate };
}

// What Luke ruled (Q1): the cell shows the stored value, the refused one is
// under it, and it asks nothing before leaving the page.
const noteOf = (view) => view.container.querySelector('.editable-field-conflict');
function showsTheirs({ view, input }, { typed, winner }) {
  expect(input.value).toBe(winner);
  expect(input.classList.contains('editable-field--conflict')).toBe(true);
  expect(noteOf(view)?.textContent).toBe(`Yours: ${typed} · Enter to keep yours`);
  expect(hasUnsavedDraft()).toBe(null);
}

// Leaving the cell (Tab, Enter and a click elsewhere all blur it) sends
// nothing over the winner.
async function leaveSendsNothing({ view, input, onAnnotationUpdate }) {
  await view.step(async () => focus(input));
  await view.step(async () => blur(input));
  expect(onAnnotationUpdate).toHaveBeenCalledTimes(1);
}

const CASES = [
  { field: 'lemma', before: 'sit', typed: 'sitC', winner: 'sitB' },
  { field: 'upos', before: 'NOUN', typed: 'ADV', winner: 'PROPN' },
  { field: 'xpos', before: '', typed: 'NNC', winner: 'NNB' },
];

describe('an edit refused because someone else changed the cell first', () => {
  for (const c of CASES) {
    for (const order of ['refetch-first', 'answer-first']) {
      it(`${c.field}: leaving the cell does not write it over theirs (${order})`, async () => {
        const run = await lostTo({ ...c, order });
        showsTheirs(run, c);
        await leaveSendsNothing(run);
        // Leaving without a word keeps the note.
        expect(noteOf(run.view)).not.toBe(null);
        await run.view.unmount();
        run.s.cells.clear();
      });
    }

    it(`${c.field}: back in the cell before the answer, leaving it does not write it over theirs`, async () => {
      const run = await lostTo({ ...c, refocused: true });
      showsTheirs(run, c);
      // Already focused: leaving is the blur.
      await run.view.step(async () => blur(run.input));
      expect(run.onAnnotationUpdate).toHaveBeenCalledTimes(1);
      await run.view.unmount();
      run.s.cells.clear();
    });

    it(`${c.field}: paged away when the answer comes, leaving it once drawn again does not write it`, async () => {
      const run = await lostTo({ ...c, away: true });
      showsTheirs(run, c);
      await leaveSendsNothing(run);
      await run.view.unmount();
      run.s.cells.clear();
    });
  }

  for (const c of CASES) {
    it(`${c.field}: Enter in the cell keeps yours`, async () => {
      const run = await lostTo(c);
      run.input.focus();
      await run.view.step(async () => focus(run.input));
      await run.view.step(async () => press(run.input, 'Enter'));
      expect(run.onAnnotationUpdate).toHaveBeenCalledTimes(2);
      expect(run.onAnnotationUpdate).toHaveBeenLastCalledWith('t1', c.field, c.typed);
      expect(noteOf(run.view)).toBe(null);
      await run.view.unmount();
    });
  }

  it('Enter keeps yours, and a third change before it lands brings the note back', async () => {
    const run = await lostTo(CASES[0]);
    let answer;
    run.onAnnotationUpdate.mockImplementation(() => new Promise((r) => (answer = r)));
    run.input.focus();
    await run.view.step(async () => focus(run.input));
    await run.view.step(async () => press(run.input, 'Enter'));
    expect(run.onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'sitC');
    run.stored.set('t1:lemma', 'sitA');
    await run.view.rerender(cellWith(run.s, 'lemma', 'sitA'));
    await run.view.step(async () => answer({ landed: false, status: 409, readBack: true }));
    expect(run.input.value).toBe('sitA');
    expect(noteOf(run.view)?.textContent).toBe('Yours: sitC · Enter to keep yours');
    await run.view.unmount();
  });

  it('Escape lets yours go', async () => {
    const run = await lostTo(CASES[0]);
    run.input.focus();
    await run.view.step(async () => focus(run.input));
    await run.view.step(async () => press(run.input, 'Escape'));
    await run.view.step(async () => blur(run.input));
    expect(run.onAnnotationUpdate).toHaveBeenCalledTimes(1);
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.value).toBe('sitB');
    await run.view.unmount();
  });

  it('a new value typed over theirs is sent as typed, and the note goes', async () => {
    const run = await lostTo(CASES[0]);
    await run.view.step(async () => focus(run.input));
    await run.view.step(async () => type(run.input, 'sat'));
    await run.view.step(async () => blur(run.input));
    expect(run.onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'sat');
    expect(noteOf(run.view)).toBe(null);
    await run.view.unmount();
  });

  // Unified with plaid-igt: the first keystroke lets the note go.
  it('the note goes at the first keystroke typed over theirs', async () => {
    const run = await lostTo(CASES[0]);
    await run.view.step(async () => focus(run.input));
    await run.view.step(async () => type(run.input, 's'));
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.classList.contains('editable-field--conflict')).toBe(false);
    await run.view.unmount();
  });

  // Unified with plaid-igt: newer text typed into the focused cell when the
  // refusal of the older edit lands wins, silently, and leaving sends it.
  it('newer typing in the focused cell when the refusal lands wins, with no note', async () => {
    let answer;
    const onAnnotationUpdate = vi.fn(() => new Promise((r) => (answer = r)));
    const stored = new Map([['t1:lemma', 'sit']]);
    const s = makeSession(onAnnotationUpdate, stored);
    const view = await renderComponent(cellWith(s, 'lemma', 'sit'));
    const input = inputOf(view);
    await view.step(async () => focus(input));
    await view.step(async () => type(input, 'sitC'));
    await view.step(async () => blur(input));
    stored.set('t1:lemma', 'sitC');
    await view.rerender(cellWith(s, 'lemma', 'sitC'));
    await view.step(async () => focus(input));
    await view.step(async () => type(input, 'sitD'));
    stored.set('t1:lemma', 'sitB');
    await view.rerender(cellWith(s, 'lemma', 'sitB'));
    await view.step(async () => answer({ landed: false, status: 409, readBack: true }));
    expect(noteOf(view)).toBe(null);
    expect(input.value).toBe('sitD');
    expect(feedback.notifyWarning).not.toHaveBeenCalled();
    onAnnotationUpdate.mockImplementation(() => Promise.resolve({ landed: true }));
    await view.step(async () => blur(input));
    expect(onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'sitD');
    await view.unmount();
  });

  it('the note goes when the stored value moves on again', async () => {
    const run = await lostTo(CASES[0]);
    run.stored.set('t1:lemma', 'sitD');
    await run.view.rerender(cellWith(run.s, 'lemma', 'sitD'));
    expect(run.input.value).toBe('sitD');
    expect(noteOf(run.view)).toBe(null);
    await run.view.unmount();
  });

  it('names the change to whoever listens for conflicts', async () => {
    const heard = [];
    const cells = made(testCells({ read: () => 'sitB', heard }));
    const ticket = cells.sending('t1:lemma', { saved: 'sit', typed: 'sitC' });
    cells.settle(ticket, { landed: false, status: 409, readBack: true });
    expect(heard).toMatchObject([{ key: 't1:lemma', stored: 'sitB', typed: 'sitC', recut: null }]);
  });

  // Unified with plaid-igt: a 409 for a word that is gone names what was lost.
  it('says what was not saved when its word is gone', async () => {
    await lostTo({
      ...CASES[0],
      gone: true,
      refusal: { landed: false, status: 409, readBack: true },
    });
    expect(feedback.notifyError).toHaveBeenCalledWith('Not saved: sitC', 'Changed elsewhere');
  });

  it('does not leave a question about leaving for a word that is gone', async () => {
    await lostTo({ ...CASES[0], gone: true });
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('does not leave a question about leaving once the cell shows theirs', async () => {
    const run = await lostTo({ ...CASES[0], away: true });
    expect(run.input.value).toBe('sitB');
    expect(hasUnsavedDraft()).toBe(null);
    await run.view.unmount();
    run.s.cells.clear();
  });

  // V3-a: the grid lets go of what waits on its next save. A cell that still
  // shows something other than what is stored must still count as unsaved.
  it('never shows a value other than the stored one with nothing counted as unsaved', async () => {
    for (const order of ['refetch-first', 'answer-first']) {
      const run = await lostTo({ ...CASES[0], order });
      // The grid's prune on the next save anywhere in the document.
      await run.view.step(async () => run.s.cells.reconcile());
      const shown = run.input.value;
      if (shown !== 'sitB') expect(hasUnsavedDraft()).not.toBe(null);
      await run.view.unmount();
      run.s.cells.clear();
    }
  });
});

// H6-5: a refusal that sending again cannot mend (no longer a writer, the
// project gone) puts nothing back, whatever the cell showed.
describe('an edit refused for good', () => {
  for (const status of [403, 404]) {
    it(`is not put back after a ${status}`, async () => {
      const run = await lostTo({
        field: 'lemma',
        before: 'the',
        typed: 'THE',
        winner: 'the',
        refusal: { landed: false, status },
      });
      expect(run.input.value).toBe('the');
      expect(hasUnsavedDraft()).toBe(null);
      await leaveSendsNothing(run);
      await run.view.unmount();
    });
  }

  it('shows what it was typed over when the refetch is refused too (the project gone)', async () => {
    const run = await lostTo({
      field: 'lemma',
      before: 'the',
      typed: 'THE',
      winner: 'the',
      order: 'answer-first',
      refetches: false,
      refusal: { landed: false, status: 403 },
    });
    expect(run.input.value).toBe('the');
    expect(hasUnsavedDraft()).toBe(null);
    await run.view.unmount();
  });

  it('still turns into a conflict when someone else changed the cell (a 403 read as changed)', async () => {
    const run = await lostTo({ ...CASES[0], refusal: { landed: false, status: 403 } });
    showsTheirs(run, CASES[0]);
    await run.view.unmount();
  });
});

// The put-back that must keep working: a refusal that was not someone else's
// edit of this cell (the network, or a conflict elsewhere in the document)
// leaves the stored value where it was, and the typed value comes back.
describe('an edit refused with the cell unchanged on the server', () => {
  it('comes back into its cell, counts as unsaved, and is sent again on leaving', async () => {
    const run = await lostTo({ field: 'lemma', before: 'sit', typed: 'sitC', winner: 'sit' });
    expect(run.input.value).toBe('sitC');
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
    await run.view.step(async () => focus(run.input));
    await run.view.step(async () => blur(run.input));
    expect(run.onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'sitC');
    await run.view.unmount();
    run.s.cells.clear();
  });
});

// The document leaves a conflict (409) on a cell write to the cell, so there
// is one toast, not the document's "Redo your edit" beside the cell's own.
describe('the toast for a refused cell edit', () => {
  const conflict409 = { landed: false, status: 409, error: { status: 409 } };

  it("is the cell's alone when the cell lost to another user", async () => {
    const run = await lostTo({ ...CASES[0], refusal: conflict409 });
    showsTheirs(run, CASES[0]);
    expect(feedback.notifyError).not.toHaveBeenCalled();
    await run.view.unmount();
  });

  it('says the value is kept when the conflict was elsewhere in the document', async () => {
    const run = await lostTo({
      field: 'lemma',
      before: 'sit',
      typed: 'sitC',
      winner: 'sit',
      refusal: conflict409,
    });
    expect(run.input.value).toBe('sitC');
    expect(feedback.notifyError).toHaveBeenCalledTimes(1);
    expect(feedback.notifyError).toHaveBeenCalledWith(
      'Changed elsewhere. Your value is in its cell, not saved.',
      'Failed to update lemma',
    );
    await run.view.unmount();
  });
});

// REV-cell-engine F2: a focused cell nobody typed in follows the stored value,
// so leaving it writes nothing back over the new one.
describe('a focused cell nobody typed in, when the stored value moves', () => {
  it('shows the new value, and leaving sends nothing', async () => {
    const onAnnotationUpdate = vi.fn(() => Promise.resolve({ landed: true }));
    const stored = new Map([['t1:lemma', 'sit']]);
    const s = makeSession(onAnnotationUpdate, stored);
    const view = await renderComponent(cellWith(s, 'lemma', 'sit'));
    const input = inputOf(view);
    await view.step(async () => focus(input));
    stored.set('t1:lemma', 'sitZ');
    await view.rerender(cellWith(s, 'lemma', 'sitZ'));
    expect(input.value).toBe('sitZ');
    await view.step(async () => blur(input));
    expect(onAnnotationUpdate).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('after a conflict let go by a third change, shows that change and sends nothing', async () => {
    const run = await lostTo(CASES[0]);
    run.onAnnotationUpdate.mockClear();
    await run.view.step(async () => focus(run.input));
    run.stored.set('t1:lemma', 'sitZ');
    await run.view.rerender(cellWith(run.s, 'lemma', 'sitZ'));
    expect(noteOf(run.view)).toBe(null);
    expect(run.input.value).toBe('sitZ');
    await run.view.step(async () => blur(run.input));
    expect(run.onAnnotationUpdate).not.toHaveBeenCalled();
    await run.view.unmount();
  });

  it('keeps what was typed in it', async () => {
    const onAnnotationUpdate = vi.fn(() => Promise.resolve({ landed: true }));
    const stored = new Map([['t1:lemma', 'sit']]);
    const s = makeSession(onAnnotationUpdate, stored);
    const view = await renderComponent(cellWith(s, 'lemma', 'sit'));
    const input = inputOf(view);
    await view.step(async () => focus(input));
    await view.step(async () => type(input, 'sat'));
    stored.set('t1:lemma', 'sitZ');
    await view.rerender(cellWith(s, 'lemma', 'sitZ'));
    expect(input.value).toBe('sat');
    await view.step(async () => blur(input));
    expect(onAnnotationUpdate).toHaveBeenLastCalledWith('t1', 'lemma', 'sat');
    await view.unmount();
  });
});
