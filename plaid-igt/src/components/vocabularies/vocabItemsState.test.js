import { describe, it, expect } from 'vitest';
import {
  NEW_ID,
  cleanMeta,
  emptyFieldOf,
  initialState,
  isDirty,
  metaEqual,
  reducer,
  seedKeyFor,
} from './vocabItemsState.js';
import { ANY_FIELD } from '@/domain/vocabItemFilter';

const run = (...actions) => actions.reduce(reducer, initialState);

describe('the draft', () => {
  it('is seeded from an entry and then edited', () => {
    const s = run(
      { type: 'draft/seed', seedKey: 'e1', form: 'kai', fields: { gloss: 'sun' } },
      { type: 'draft/form', form: 'kaii' },
    );
    expect(s.draft).toEqual({ seedKey: 'e1', form: 'kaii', fields: { gloss: 'sun' } });
  });

  it('resets to the stored values without forgetting its seed', () => {
    const s = run(
      { type: 'draft/seed', seedKey: 'e1', form: 'kai', fields: {} },
      { type: 'draft/form', form: 'x' },
      { type: 'draft/reset', form: 'kai', fields: {} },
    );
    expect(s.draft).toEqual({ seedKey: 'e1', form: 'kai', fields: {} });
  });

  it('unseeds so the next sync fills it again', () => {
    const s = run(
      { type: 'draft/seed', seedKey: 'e1', form: 'kai', fields: {} },
      { type: 'draft/unseed' },
    );
    expect(s.draft.seedKey).toBeUndefined();
    expect(s.draft.form).toBe('kai'); // the typing is not thrown away by the unseed itself
  });

  it('keys a new sense by its parent, so two new forms never share a seed', () => {
    expect(seedKeyFor(NEW_ID, null)).toBe(`${NEW_ID}|`);
    expect(seedKeyFor(NEW_ID, 'p1')).toBe(`${NEW_ID}|p1`);
    expect(seedKeyFor('e1', 'p1')).toBe('e1');
  });
});

describe('isDirty', () => {
  const item = { id: 'e1', form: 'kai', metadata: { gloss: 'sun', parent: 'p' } };
  it('ignores the structure the form does not edit', () => {
    expect(isDirty({ form: 'kai', fields: { gloss: 'sun' } }, item)).toBe(false);
  });
  it('notices a changed form, a changed field, and surrounding whitespace on neither', () => {
    expect(isDirty({ form: 'kai ', fields: { gloss: 'sun' } }, item)).toBe(false);
    expect(isDirty({ form: 'kaii', fields: { gloss: 'sun' } }, item)).toBe(true);
    expect(isDirty({ form: 'kai', fields: { gloss: 'moon' } }, item)).toBe(true);
    expect(isDirty({ form: 'kai', fields: { gloss: 'sun', note: '' } }, item)).toBe(false);
  });
  it('treats a new entry as dirty once anything is typed', () => {
    expect(isDirty({ form: '', fields: {} }, null)).toBe(false);
    expect(isDirty({ form: ' ', fields: { gloss: ' ' } }, null)).toBe(false);
    expect(isDirty({ form: 'a', fields: {} }, null)).toBe(true);
    expect(isDirty({ form: '', fields: { gloss: 'x' } }, null)).toBe(true);
  });
  it('compares metadata with blanks dropped and values as strings', () => {
    expect(cleanMeta({ a: '', b: null, c: ' x ' })).toEqual({ c: ' x ' });
    expect(metaEqual({ n: 1 }, { n: '1' })).toBe(true);
    expect(metaEqual({ n: 1, m: '' }, { n: 1 })).toBe(true);
    expect(metaEqual({ n: 1 }, { n: 2 })).toBe(false);
  });
});

describe('the scope', () => {
  it('drops the empty-only filter when the field changes', () => {
    const s = run(
      { type: 'scope/field', field: 'gloss' },
      { type: 'scope/toggleEmptyOnly' },
      { type: 'scope/field', field: 'pos' },
    );
    expect(s.scope).toMatchObject({ field: 'pos', emptyOnly: false });
  });
  it('drops the empty-only filter for good once nothing is empty', () => {
    // Deriving it from the count instead left the switch armed, so filling the
    // last empty value and then adding an entry snapped the list to that one.
    const s = run(
      { type: 'scope/field', field: 'gloss' },
      { type: 'scope/toggleEmptyOnly' },
      { type: 'scope/clearEmptyOnly' },
    );
    expect(s.scope).toMatchObject({ field: 'gloss', emptyOnly: false });
  });
  it('leaves the state alone when there is no empty-only filter to clear', () => {
    const before = run({ type: 'scope/field', field: 'gloss' });
    const after = run({ type: 'scope/field', field: 'gloss' }, { type: 'scope/clearEmptyOnly' });
    expect(after.scope).toEqual(before.scope);
  });
  it('toggles each filter on its own', () => {
    const s = run({ type: 'scope/toggleOffTagsetOnly' }, { type: 'scope/search', search: 'ka' });
    expect(s.scope).toEqual({
      search: 'ka',
      field: ANY_FIELD,
      emptyOnly: false,
      offTagsetOnly: true,
    });
  });
  it('names the field an empty-only filter can apply to', () => {
    expect(emptyFieldOf(ANY_FIELD)).toBeNull();
    expect(emptyFieldOf('form')).toBeNull();
    expect(emptyFieldOf('gloss')).toBe('gloss');
  });
});

describe('dialogs', () => {
  it('opens one at a time and closes back to none', () => {
    expect(run({ type: 'dialog/open', kind: 'bulk' }).dialog).toEqual({ kind: 'bulk' });
    expect(
      run({ type: 'dialog/open', kind: 'bulk' }, { type: 'dialog/open', kind: 'delete' }).dialog,
    ).toEqual({
      kind: 'delete',
    });
    expect(run({ type: 'dialog/open', kind: 'bulk' }, { type: 'dialog/close' }).dialog).toBeNull();
  });
  it('remembers where a discard was heading, and forgets it on close', () => {
    const asked = run({ type: 'dialog/askDiscard', target: { id: 'e2', parent: null } });
    expect(asked.dialog).toEqual({ kind: 'discard', target: { id: 'e2', parent: null } });
    expect(reducer(asked, { type: 'dialog/close' }).dialog).toBeNull();
  });
  it('closing with nothing open is a no-op that keeps the state identity', () => {
    expect(reducer(initialState, { type: 'dialog/close' })).toBe(initialState);
  });
});
