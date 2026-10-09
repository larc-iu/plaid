import { afterEach, describe, expect, it } from 'vitest';
import { CellEngine } from './CellEngine.js';
import { hasUnsavedDraft } from '../../hooks/useUnsavedDraft.js';
import { pendingId, recordSettled } from '../pendingIds.js';

// The state machine alone: a fake reader, a fake drawn cell and a list of
// what was announced. No DOM, no network.

const engines = [];
afterEach(() => {
  for (const e of engines.splice(0)) e.clear();
});

// `stored` is the document: key -> value, a missing key a row that is gone.
// `shapes` is key -> what the value is typed for, and a change to it a re-cut.
function setup({ stored = {}, shapes = {}, views = {}, ...opts } = {}) {
  const heard = [];
  const engine = new CellEngine({
    read: (key) => stored[key],
    shape: (key) => shapes[key] ?? null,
    recut: (snapshot, key) =>
      snapshot != null && shapes[key] !== snapshot ? { unit: 'word', text: shapes[key] } : null,
    view: (key) => views[key] ?? null,
    announce: (event) => heard.push(event),
    ...opts,
  });
  engines.push(engine);
  return { engine, heard, stored, shapes, views };
}

// A drawn cell. `focused` and `typed` stand for the input.
function cellView({ focused = false, typed = null, takes = false } = {}) {
  const view = {
    focused: () => focused,
    typedSince: (value) => focused && typed != null && typed !== value,
    takeUp: (value) => {
      view.taken = value;
      return takes;
    },
    showStored: (value, opts) => view.shown.push([value, opts?.conflict ?? false]),
    update: () => (view.updates += 1),
    shown: [],
    updates: 0,
    taken: null,
  };
  return view;
}

const refused = (status = 409, readBack = true) => ({ landed: false, status, readBack });
// A 422 whose body names the rules the value breaks.
const violating = (readBack = true) => ({
  landed: false,
  status: 422,
  readBack,
  error: { status: 422, responseData: { error: 'x', violations: [{ constraint: 'value-set' }] } },
});

describe('a refused edit', () => {
  it('lands: nothing held', () => {
    const { engine } = setup({ stored: { k: 'dog' } });
    const t = engine.sending('k', { saved: '', typed: 'dog' });
    expect(engine.settle(t, { landed: true }).kind).toBe('landed');
    expect(engine.size).toBe(0);
  });

  it('with a later edit of the cell still out is superseded: nothing drawn, nothing said', () => {
    const { engine, heard } = setup({ stored: { k: '' } });
    const t1 = engine.sending('k', { saved: '', typed: 'a' });
    const t2 = engine.sending('k', { saved: 'a', typed: 'ab' });
    expect(engine.settle(t1, refused()).kind).toBe('superseded');
    expect(engine.size).toBe(0);
    expect(heard).toEqual([]);
    // The second is measured against the first one's base, not against `a`.
    expect(engine.settle(t2, refused()).kind).toBe('putBack');
    expect(engine.unsentOf('k')).toEqual({ typed: 'ab', saved: '' });
  });

  it('after the first of two landed, the second is measured against the first', () => {
    const { engine } = setup({ stored: { k: 'a' } });
    const t1 = engine.sending('k', { saved: '', typed: 'a' });
    const t2 = engine.sending('k', { saved: 'a', typed: 'ab' });
    expect(engine.settle(t1, { landed: true }).kind).toBe('landed');
    expect(engine.settle(t2, refused()).kind).toBe('putBack');
    expect(engine.unsentOf('k')).toEqual({ typed: 'ab', saved: 'a' });
  });

  it('measures the stored value as the server composed it the same as the value typed decomposed', () => {
    // dóg typed as o and a combining acute landed, and the server stored it composed
    const { engine, heard } = setup({ stored: { k: 'd\u00f3g' } });
    const t1 = engine.sending('k', { saved: '', typed: 'do\u0301g' });
    const t2 = engine.sending('k', { saved: 'do\u0301g', typed: 'do\u0301gs' });
    expect(engine.settle(t1, { landed: true }).kind).toBe('landed');
    expect(engine.settle(t2, refused()).kind).toBe('putBack');
    expect(heard.map((e) => e.kind)).toEqual(['keptInCell']);
    expect(engine.display('k', 'd\u00f3g')).toBe('do\u0301gs');
  });

  it('with newer typing in its focused cell records nothing', () => {
    const views = { k: cellView({ focused: true, typed: 'newer' }) };
    const { engine, heard } = setup({ stored: { k: 'theirs' }, views });
    const t = engine.sending('k', { saved: '', typed: 'mine' });
    expect(engine.settle(t, refused()).kind).toBe('typedSince');
    expect(engine.size).toBe(0);
    expect(heard).toEqual([]);
  });

  it('for a row that is gone is lost, and a 409 says so', () => {
    const { engine, heard } = setup({ stored: {} });
    const t = engine.sending('k', { saved: 'a', typed: 'b', field: 'Gloss' });
    expect(engine.settle(t, refused(409)).kind).toBe('gone');
    expect(heard).toEqual([{ kind: 'lost', key: 'k', typed: 'b', field: 'Gloss' }]);
    expect(engine.size).toBe(0);
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('for a row that is gone says nothing of its own for another status', () => {
    const { engine, heard } = setup({ stored: {} });
    const t = engine.sending('k', { saved: 'a', typed: 'b' });
    expect(engine.settle(t, refused(404)).kind).toBe('gone');
    expect(heard).toEqual([]);
  });

  // L2-IGT-MULTI-3: the document leaves a refusal for a deleted row to the
  // cell, as it leaves a conflict, so the cell says what was not saved.
  it('for a row deleted meanwhile (the 403 for an unknown id) is lost, and says so', () => {
    const gone = {
      landed: false,
      status: 403,
      readBack: true,
      error: { status: 403, method: 'PATCH', responseData: { unresolved: true } },
    };
    const lost = setup({ stored: {} });
    const t = lost.engine.sending('k', { saved: 'a', typed: 'b', field: 'Gloss' });
    expect(lost.engine.settle(t, gone).kind).toBe('gone');
    expect(lost.heard).toEqual([{ kind: 'lost', key: 'k', typed: 'b', field: 'Gloss' }]);
    // The cell is still drawn and reads as it did: what it wrote to is gone.
    const views = { k: cellView() };
    const same = setup({ stored: { k: 'a' }, views });
    const t2 = same.engine.sending('k', { saved: 'a', typed: 'b', field: 'Gloss' });
    expect(same.engine.settle(t2, gone).kind).toBe('dropped');
    expect(same.heard).toEqual([{ kind: 'lost', key: 'k', typed: 'b', field: 'Gloss' }]);
    expect(views.k.shown).toEqual([['a', false]]);
  });

  // L2-IGT-MULTI polish: a morpheme split refused, with a form typed into the
  // new morpheme's cell. The split's own refusal says so: the form, refused
  // unsent behind it on a row only the split made, adds no second toast.
  it('for a row only a refused edit made, refused unsent behind it, says nothing', () => {
    const made = pendingId();
    const key = `mf:${made}`;
    const { engine, heard } = setup({ stored: {} });
    const t = engine.sending(key, { saved: '', typed: 'r', field: 'Morpheme' });
    const unsent = {
      landed: false,
      status: 409,
      readBack: true,
      error: { status: 409, unsent: true },
    };
    expect(engine.settle(t, unsent).kind).toBe('gone');
    expect(heard).toEqual([]);
    // A row the server had, refused unsent the same way, is said.
    const t2 = engine.sending('mf:m-1', { saved: '', typed: 'r', field: 'Morpheme' });
    engine.settle(t2, unsent);
    expect(heard).toEqual([{ kind: 'lost', key: 'mf:m-1', typed: 'r', field: 'Morpheme' }]);
  });

  it('read back holding the typed value landed unheard: nothing put back', () => {
    const views = { k: cellView() };
    const { engine } = setup({ stored: { k: 'b' }, views });
    const t = engine.sending('k', { saved: 'a', typed: 'b' });
    expect(engine.settle(t, refused(502, true)).kind).toBe('landedUnheard');
    expect(engine.size).toBe(0);
    expect(views.k.shown).toEqual([['b', false]]);
  });

  it('not read back (out of step) and still showing the typed value is put back', () => {
    const { engine } = setup({ stored: { k: 'b' } });
    const t = engine.sending('k', { saved: 'a', typed: 'b' });
    expect(engine.settle(t, refused(500, false)).kind).toBe('putBack');
    expect(engine.unsentOf('k')).toEqual({ typed: 'b', saved: 'a' });
  });

  it('over a value someone else stored is a conflict, announced with its ids', () => {
    const views = { k: cellView() };
    const { engine, heard } = setup({
      stored: { k: 'theirs' },
      views,
      entityIds: () => ['span-now'],
    });
    const t = engine.sending('k', { saved: '', typed: 'mine', entityIds: ['span-then'] });
    // `since`, when the document the edit was made on was last changed, goes
    // with it for the toast's lookup of who (REV-R4-IGT R4-1).
    const d = engine.settle(t, { ...refused(), since: '2026-10-05T01:00:00Z' });
    expect(d).toMatchObject({ kind: 'conflict', typed: 'mine', stored: 'theirs', recut: null });
    expect(engine.conflictOf('k')).toEqual({ typed: 'mine', stored: 'theirs', recut: null });
    expect(views.k.shown).toEqual([['theirs', true]]);
    expect(heard).toEqual([
      {
        kind: 'conflict',
        key: 'k',
        typed: 'mine',
        stored: 'theirs',
        recut: null,
        entityIds: ['span-then', 'span-now'],
        since: '2026-10-05T01:00:00Z',
      },
    ]);
    // A conflict asks nothing before leaving the page.
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('whose word was re-cut meanwhile is a conflict with the word as it reads now', () => {
    const { engine, heard, shapes } = setup({ stored: { k: '' }, shapes: { k: 'sing' } });
    const t = engine.sending('k', { saved: '', typed: 'SING' });
    shapes.k = 'si';
    const d = engine.settle(t, refused());
    expect(d).toMatchObject({ kind: 'conflict', recut: { unit: 'word', text: 'si' } });
    expect(heard[0]).toMatchObject({ kind: 'conflict', recut: { unit: 'word', text: 'si' } });
  });

  it('refused for good (403, 404) is dropped and the cell shows what is stored', () => {
    for (const status of [403, 404]) {
      const views = { k: cellView() };
      const { engine, heard, shapes } = setup({ stored: { k: 'a' }, shapes: { k: 'w' }, views });
      const t = engine.sending('k', { saved: 'a', typed: 'b' });
      shapes.k = 'w2';
      expect(engine.settle(t, refused(status)).kind).toBe('dropped');
      expect(views.k.shown).toEqual([['a', false]]);
      expect(engine.size).toBe(0);
      expect(heard).toEqual([]);
    }
  });

  it('refused for good over a value someone else stored is still a conflict (a 403 read as changed)', () => {
    const { engine } = setup({ stored: { k: 'theirs' } });
    const t = engine.sending('k', { saved: 'a', typed: 'b' });
    expect(engine.settle(t, refused(403)).kind).toBe('conflict');
  });

  it('otherwise goes back into its focused cell when the cell takes it up', () => {
    const views = { k: cellView({ focused: true, takes: true }) };
    const { engine, heard } = setup({ stored: { k: 'a' }, views });
    const t = engine.sending('k', { saved: 'a', typed: 'b', field: 'Gloss' });
    expect(engine.settle(t, refused(409)).kind).toBe('takenUp');
    expect(views.k.taken).toEqual({ typed: 'b', saved: 'a' });
    expect(engine.putBackOf('k')).toBe('b');
    expect(engine.unsentOf('k')).toBe(null);
    expect(heard).toEqual([{ kind: 'keptInCell', key: 'k', field: 'Gloss' }]);
  });

  it('otherwise waits unsent, shows in its cell and asks before leaving', () => {
    const views = { k: cellView() };
    const { engine, heard } = setup({ stored: { k: 'a' }, views });
    const t = engine.sending('k', { saved: 'a', typed: 'b', what: 'Gloss of "dog"' });
    expect(engine.settle(t, refused(500)).kind).toBe('putBack');
    expect(heard).toEqual([]);
    expect(engine.display('k', 'a')).toBe('b');
    expect(engine.hasUnsent).toBe(true);
    expect(hasUnsavedDraft()).toBe('Gloss of "dog"');
    expect(views.k.updates).toBeGreaterThan(0);
  });

  it('names the cell in the leave question by `describe`, else generically', () => {
    const a = setup({ stored: { k: 'a' }, describe: () => 'LEMMA of sat' }).engine;
    a.settle(a.sending('k', { saved: 'a', typed: 'b' }), refused(500));
    expect(hasUnsavedDraft()).toBe('LEMMA of sat');
    a.clear();
    const b = setup({ stored: { k: 'a' } }).engine;
    b.settle(b.sending('k', { saved: 'a', typed: 'b' }), refused(500));
    expect(hasUnsavedDraft()).toBe('An annotation you have typed');
  });
});

describe('a value waiting unsent', () => {
  const waiting = (opts = {}) => {
    const s = setup({ stored: { k: 'a' }, shapes: { k: 'w' }, ...opts });
    s.engine.settle(s.engine.sending('k', { saved: 'a', typed: 'b' }), refused(500));
    return s;
  };

  it('is taken up by focus, which answers it, and stops asking', () => {
    const { engine } = waiting();
    expect(engine.focus('k')).toEqual({ typed: 'b', saved: 'a' });
    expect(engine.unsentOf('k')).toBe(null);
    expect(hasUnsavedDraft()).toBe(null);
    expect(engine.focus('k')).toBe(null);
  });

  it('goes back to wait when its cell goes away with focus in it', () => {
    const { engine } = waiting();
    const taken = engine.focus('k');
    engine.release('k', taken.typed, taken.saved);
    expect(engine.unsentOf('k')).toEqual({ typed: 'b', saved: 'a' });
    expect(hasUnsavedDraft()).not.toBe(null);
  });

  it('stays while the stored value is still the one it was typed over', () => {
    const { engine } = waiting();
    expect(engine.reconcile()).toBe(false);
    expect(engine.unsentOf('k')).toEqual({ typed: 'b', saved: 'a' });
  });

  it('turns into a conflict, announced at once, when the stored value moves on', () => {
    const { engine, stored, heard } = waiting();
    stored.k = 'c';
    expect(engine.reconcile()).toBe(true);
    expect(engine.unsentOf('k')).toBe(null);
    expect(engine.conflictOf('k')).toEqual({ typed: 'b', stored: 'c', recut: null });
    expect(heard.map((e) => e.kind)).toEqual(['conflict']);
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('turns into a conflict when its word is re-cut', () => {
    const { engine, shapes } = waiting();
    shapes.k = 'w2';
    engine.reconcile();
    expect(engine.conflictOf('k')).toEqual({
      typed: 'b',
      stored: 'a',
      recut: { unit: 'word', text: 'w2' },
    });
  });

  it('is let go, and its cell told, when stored becomes the typed value or its row goes', () => {
    for (const next of ['b', undefined]) {
      const views = { k: cellView() };
      const { engine, stored } = waiting({ views });
      const before = views.k.updates;
      stored.k = next;
      if (next === undefined) delete stored.k;
      engine.reconcile();
      expect(engine.size).toBe(0);
      expect(hasUnsavedDraft()).toBe(null);
      expect(views.k.updates).toBeGreaterThan(before);
      engine.clear();
    }
  });

  it('is let go by clear, and the question with it', () => {
    const { engine } = waiting();
    engine.clear();
    expect(engine.size).toBe(0);
    expect(hasUnsavedDraft()).toBe(null);
  });

  it('keeps the value the first edit was typed over when a second is put back behind it', () => {
    const { engine } = waiting();
    const taken = engine.focus('k');
    const t = engine.sending('k', { saved: taken.saved, typed: 'bb' });
    engine.settle(t, refused(500));
    expect(engine.unsentOf('k')).toEqual({ typed: 'bb', saved: 'a' });
  });

  it('holds one leave question per cell', () => {
    const { engine, stored } = waiting();
    stored.j = 'x';
    engine.settle(engine.sending('j', { saved: 'x', typed: 'y' }), refused(500));
    engine.settle(engine.sending('k', { saved: 'a', typed: 'c' }), refused(500));
    expect(engine.size).toBe(2);
    engine.focus('k');
    expect(hasUnsavedDraft()).not.toBe(null);
    engine.focus('j');
    expect(hasUnsavedDraft()).toBe(null);
  });
});

describe('a conflict', () => {
  const lost = (opts = {}) => {
    const s = setup({ stored: { k: 'theirs' }, ...opts });
    s.engine.settle(s.engine.sending('k', { saved: '', typed: 'mine' }), refused());
    return s;
  };

  it('shows what is stored at rest', () => {
    const { engine } = lost();
    expect(engine.display('k', 'theirs')).toBe('theirs');
  });

  it('is kept by keepYours, which answers the refused value', () => {
    const { engine } = lost();
    expect(engine.keepYours('k')).toBe('mine');
    expect(engine.conflictOf('k')).toBe(null);
    expect(engine.keepYours('k')).toBe(null);
  });

  it('is let go by dismiss', () => {
    const { engine } = lost();
    expect(engine.dismiss('k')).toBe(true);
    expect(engine.dismiss('k')).toBe(false);
    expect(engine.size).toBe(0);
  });

  it('stays until the stored value moves on again, or its row goes', () => {
    const { engine, stored } = lost();
    expect(engine.reconcile()).toBe(false);
    stored.k = 'third';
    expect(engine.reconcile()).toBe(true);
    expect(engine.conflictOf('k')).toBe(null);
    const second = lost();
    delete second.stored.k;
    second.engine.reconcile();
    expect(second.engine.conflictOf('k')).toBe(null);
  });

  it('is replaced by the next edit of the cell', () => {
    const { engine } = lost();
    engine.sending('k', { saved: 'theirs', typed: 'new' });
    expect(engine.conflictOf('k')).toBe(null);
  });

  it('holds nothing when the two values agree', () => {
    const { engine, heard } = setup({ stored: { k: 'x' } });
    engine.conflict('k', 'x', 'x');
    expect(engine.size).toBe(0);
    expect(heard).toEqual([]);
  });
});

describe('subscribers', () => {
  it('hear every change, and a quiet reconcile tells none of them', () => {
    const { engine, stored } = setup({ stored: { k: 'a' } });
    let heard = 0;
    const stop = engine.subscribe(() => (heard += 1));
    engine.settle(engine.sending('k', { saved: 'a', typed: 'b' }), refused(500));
    const afterPut = heard;
    expect(afterPut).toBeGreaterThan(0);
    stored.k = 'c';
    expect(engine.reconcile({ quiet: true })).toBe(true);
    expect(heard).toBe(afterPut);
    expect(engine.conflictOf('k')).not.toBe(null);
    engine.dismiss('k');
    expect(heard).toBe(afterPut + 1);
    stop();
    engine.conflict('k', 'x', 'y');
    expect(heard).toBe(afterPut + 1);
  });
});

describe('cell keys', () => {
  it('a pending id and the id the server gave it are one record', () => {
    const pending = pendingId();
    const doc = { [`ma:${pending}:Gloss`]: 'a' };
    const { engine } = setup({ read: (key) => doc[key] });
    const t = engine.sending(`ma:${pending}:Gloss`, { saved: 'a', typed: 'b' });
    // The server answered the create: the document holds the row by its id.
    recordSettled([[pending, 'server-1']]);
    doc['ma:server-1:Gloss'] = 'a';
    delete doc[`ma:${pending}:Gloss`];
    expect(engine.settle(t, refused(500)).kind).toBe('putBack');
    expect(engine.unsentOf('ma:server-1:Gloss')).toEqual({ typed: 'b', saved: 'a' });
    expect(engine.unsentOf(`ma:${pending}:Gloss`)).toEqual({ typed: 'b', saved: 'a' });
    expect(engine.reconcile()).toBe(false);
  });
});

describe('a value the layer refuses (422)', () => {
  it('is neither put back nor a conflict, and the cell shows what is stored', () => {
    for (const now of ['a', 'theirs']) {
      const views = { k: cellView() };
      const { engine, heard } = setup({ stored: { k: now }, views });
      const t = engine.sending('k', { saved: 'a', typed: 'OFF' });
      expect(engine.settle(t, violating()).kind).toBe('rejected');
      expect(engine.size).toBe(0);
      expect(heard).toEqual([]);
      expect(views.k.shown).toEqual([[now, false]]);
      expect(hasUnsavedDraft()).toBe(null);
      engine.clear();
    }
  });

  it('shows what it was typed over when the document was not read again', () => {
    const views = { k: cellView() };
    const { engine } = setup({ stored: { k: 'OFF' }, views });
    const t = engine.sending('k', { saved: 'a', typed: 'OFF' });
    expect(engine.settle(t, violating(false)).kind).toBe('rejected');
    expect(views.k.shown).toEqual([['a', false]]);
  });

  it('is only a 422 that names the rules: any other 422 is a failed write that keeps the value', () => {
    const { engine } = setup({ stored: { k: 'a' } });
    const t = engine.sending('k', { saved: 'a', typed: 'b' });
    const reused = {
      landed: false,
      status: 422,
      readBack: true,
      error: { status: 422, responseData: { error: 'idempotency-key-reused' } },
    };
    expect(engine.settle(t, reused).kind).toBe('putBack');
    expect(engine.unsentOf('k')).toEqual({ typed: 'b', saved: 'a' });
    engine.clear();
    const bare = engine.sending('k', { saved: 'a', typed: 'c' });
    expect(engine.settle(bare, refused(422)).kind).toBe('putBack');
  });
});

describe('a value taken up by focus (REV-cell-engine F3)', () => {
  const takenUp = (opts = {}) => {
    const s = setup({ stored: { k: 'a' }, ...opts });
    s.engine.settle(s.engine.sending('k', { saved: 'a', typed: 'b' }), refused(500));
    s.engine.focus('k');
    return s;
  };

  it('turns into a conflict when another value is stored under it, and the cell hears it', () => {
    const views = { k: cellView({ focused: true }) };
    const { engine, stored, heard } = takenUp({ views });
    stored.k = 'theirs';
    expect(engine.reconcile()).toBe(true);
    expect(engine.takenOf('k')).toBe(null);
    expect(engine.conflictOf('k')).toMatchObject({ typed: 'b', stored: 'theirs' });
    expect(views.k.shown.at(-1)).toEqual(['theirs', true]);
    expect(heard.map((e) => e.kind)).toEqual(['conflict']);
  });

  it('stays while the stored value is the one it was typed over', () => {
    const { engine } = takenUp();
    expect(engine.reconcile()).toBe(false);
    expect(engine.takenOf('k')).toEqual({ typed: 'b', saved: 'a' });
  });

  it('is let go when the cell is left or sends it', () => {
    const { engine, stored } = takenUp();
    expect(engine.leave('k')).toEqual({ typed: 'b', saved: 'a' });
    stored.k = 'theirs';
    expect(engine.reconcile()).toBe(false);
    const second = takenUp();
    second.engine.sending('k', { saved: 'a', typed: 'b' });
    expect(second.engine.takenOf('k')).toBe(null);
  });

  it('is recorded when a refusal puts a value back into its focused cell', () => {
    const views = { k: cellView({ focused: true, takes: true }) };
    const { engine } = setup({ stored: { k: 'a' }, views });
    engine.settle(engine.sending('k', { saved: 'a', typed: 'b' }), refused(409));
    expect(engine.takenOf('k')).toEqual({ typed: 'b', saved: 'a' });
  });
});

describe('views held back for the drawing (REV-cell-engine F1)', () => {
  it('reconcile({ deferViews: true }) tells the cells only at flushViews, and finds them then', () => {
    const early = cellView();
    const late = cellView();
    const views = { k: early };
    const { engine, stored } = setup({ stored: { k: 'a' }, views });
    engine.settle(engine.sending('k', { saved: 'a', typed: 'b' }), refused(500));
    stored.k = 'theirs';
    engine.reconcile({ quiet: true, deferViews: true });
    expect(engine.conflictOf('k')).not.toBe(null);
    const before = early.shown.length;
    views.k = late;
    engine.flushViews();
    expect(early.shown.length).toBe(before);
    expect(late.shown).toEqual([['theirs', true]]);
    engine.flushViews();
    expect(late.shown.length).toBe(1);
  });
});
