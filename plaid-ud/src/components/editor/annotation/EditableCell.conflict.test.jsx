import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur, press } from '../../../test/keyboard.js';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';
import { UnsentValues } from './unsentValues.js';
import { hasUnsavedDraft } from '@ui/hooks/useUnsavedDraft.js';
import { writeCell } from './conflictNotice.js';

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

// The grid's stored values, which the fix may read through `UnsentValues`
// (the same reader `prune` gets). `undefined` for a token no longer there.
// Every store a test makes is let go of after it, so no test's leave question
// is read by the next.
const stores = [];
const made = (unsent) => {
  stores.push(unsent);
  return unsent;
};
afterEach(() => {
  for (const unsent of stores.splice(0)) unsent.clear();
  feedback.notifyError.mockReset();
});

const makeSession = (onAnnotationUpdate, stored) => ({
  isReadOnly: false,
  onAnnotationUpdate,
  unsent: made(new UnsentValues((tokenId, field) => stored.get(`${tokenId}:${field}`))),
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
  refusal = false,
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
  onAnnotationUpdate.mockImplementation(() => Promise.resolve(true));
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
        run.s.unsent.clear();
      });
    }

    it(`${c.field}: back in the cell before the answer, leaving it does not write it over theirs`, async () => {
      const run = await lostTo({ ...c, refocused: true });
      showsTheirs(run, c);
      // Already focused: leaving is the blur.
      await run.view.step(async () => blur(run.input));
      expect(run.onAnnotationUpdate).toHaveBeenCalledTimes(1);
      await run.view.unmount();
      run.s.unsent.clear();
    });

    it(`${c.field}: paged away when the answer comes, leaving it once drawn again does not write it`, async () => {
      const run = await lostTo({ ...c, away: true });
      showsTheirs(run, c);
      await leaveSendsNothing(run);
      await run.view.unmount();
      run.s.unsent.clear();
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
    const unsent = made(
      new UnsentValues(() => 'sitB', { onConflict: (...args) => heard.push(args) }),
    );
    unsent.put('t1', 'lemma', 'sitC', 'sit');
    expect(heard).toEqual([['t1', 'lemma', 'sitB', 'sitC']]);
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
    run.s.unsent.clear();
  });

  // V3-a: the grid lets go of what waits on its next save. A cell that still
  // shows something other than what is stored must still count as unsaved.
  it('never shows a value other than the stored one with nothing counted as unsaved', async () => {
    for (const order of ['refetch-first', 'answer-first']) {
      const run = await lostTo({ ...CASES[0], order });
      // The grid's prune on the next save anywhere in the document.
      await run.view.step(async () =>
        run.s.unsent.prune((tokenId, field) => run.stored.get(`${tokenId}:${field}`)),
      );
      const shown = run.input.value;
      if (shown !== 'sitB') expect(hasUnsavedDraft()).not.toBe(null);
      await run.view.unmount();
      run.s.unsent.clear();
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
        refusal: { refused: true, status },
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
      refusal: { refused: true, status: 403 },
    });
    expect(run.input.value).toBe('the');
    expect(hasUnsavedDraft()).toBe(null);
    await run.view.unmount();
  });

  it('still turns into a conflict when someone else changed the cell (a 403 read as changed)', async () => {
    const run = await lostTo({ ...CASES[0], refusal: { refused: true, status: 403 } });
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
    run.s.unsent.clear();
  });
});

// The same rule held by the grid's store itself, for every way in.
describe('UnsentValues and the value stored now', () => {
  const store = (stored) =>
    made(new UnsentValues((tokenId, field) => stored[`${tokenId}:${field}`]));

  it('holds nothing put back over a value someone else has since stored', () => {
    const unsent = store({ 't1:lemma': 'sitB' });
    unsent.put('t1', 'lemma', 'sitC', 'sit');
    expect(unsent.get('t1', 'lemma')).toBe(null);
    expect(hasUnsavedDraft()).toBe(null);
    unsent.clear();
  });

  it('holds nothing put back for a token that is gone', () => {
    const unsent = store({});
    unsent.put('t1', 'lemma', 'sitC', 'sit');
    expect(unsent.get('t1', 'lemma')).toBe(null);
    expect(hasUnsavedDraft()).toBe(null);
    unsent.clear();
  });

  it('holds a value put back while the stored value is still the one it was typed over', () => {
    const unsent = store({ 't1:lemma': 'sit' });
    unsent.put('t1', 'lemma', 'sitC', 'sit');
    expect(unsent.get('t1', 'lemma')).toEqual({ typed: 'sitC', saved: 'sit' });
    unsent.clear();
  });

  it('tells a drawn cell when the grid lets go of its value', () => {
    const unsent = store({ 't1:lemma': 'sit' });
    const heard = [];
    unsent.listen('t1', 'lemma', (put) => {
      heard.push(put);
      return false;
    });
    unsent.put('t1', 'lemma', 'sitC', 'sit');
    unsent.prune(() => 'sitB');
    expect(unsent.get('t1', 'lemma')).toBe(null);
    // The cell heard the put, and then that it was let go.
    expect(heard.length).toBe(2);
    unsent.clear();
  });
});

// The document leaves a conflict (409) on a cell write to the cell, so there
// is one toast, not the document's "Redo your edit" beside the cell's own.
describe('the toast for a refused cell edit', () => {
  const conflict409 = { refused: true, status: 409, error: { status: 409 } };

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
      'Changed elsewhere. Your value is kept in its cell, and leaving the cell sends it again.',
      'Failed to update lemma',
    );
    await run.view.unmount();
  });
});

describe('writeCell', () => {
  const fakeDoc = (answer, cause) => {
    const doc = {
      scoped: false,
      errorCause: cause,
      handlesConflicts(fn) {
        this.scoped = true;
        try {
          return fn();
        } finally {
          this.scoped = false;
        }
      },
      updateAnnotation: vi.fn(function () {
        // The write is queued inside the scope.
        expect(doc.scoped).toBe(true);
        return Promise.resolve(answer);
      }),
    };
    return doc;
  };

  it('writes inside handlesConflicts and answers what the write did', async () => {
    const doc = fakeDoc(true);
    expect(await writeCell(doc, 't1', 'lemma', 'wolf')).toBe(true);
    expect(doc.updateAnnotation).toHaveBeenCalledWith('t1', 'lemma', 'wolf');
  });

  it('answers a refusal with its status and error', async () => {
    const err = new Error('HTTP 409 Document version mismatch');
    const doc = fakeDoc(false, err);
    expect(await writeCell(doc, 't1', 'lemma', 'wolf')).toEqual({
      refused: true,
      status: 409,
      error: err,
      readBack: true,
    });
  });

  it('says when the refetch after a refusal was given up', async () => {
    const err = new Error('HTTP 500');
    const doc = fakeDoc(false, err);
    doc.outOfStep = true;
    expect((await writeCell(doc, 't1', 'lemma', 'wolf')).readBack).toBe(false);
  });
});
