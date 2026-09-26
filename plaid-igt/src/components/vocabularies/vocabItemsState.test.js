import { describe, it, expect } from 'vitest';
import {
  NEW_ID,
  cleanMeta,
  emptyFieldOf,
  initialState,
  isDirty,
  hasTyped,
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
    expect(s.draft).toEqual({
      seedKey: 'e1',
      seedForm: 'kai',
      form: 'kaii',
      fields: { gloss: 'sun' },
    });
  });

  it('resets to the stored values without forgetting its seed', () => {
    const s = run(
      { type: 'draft/seed', seedKey: 'e1', form: 'kai', fields: {} },
      { type: 'draft/form', form: 'x' },
      { type: 'draft/reset', form: 'kai', fields: {} },
    );
    expect(s.draft).toEqual({ seedKey: 'e1', seedForm: 'kai', form: 'kai', fields: {} });
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

// A field used to hold only a string, and an entry's `umr` object (its UMR
// roleset, written on the entry form) is one that does not. String(obj) is
// "[object Object]" whatever is inside, so comparing that way called every
// roleset edit clean and the Save button stayed grey.
describe('a field holding an object', () => {
  const withRoleset = (roleset) => ({ gloss: 'go away', umr: { roleset } });

  it('sees a change inside it', () => {
    expect(metaEqual(withRoleset('leave-02'), withRoleset('leave-11'))).toBe(false);
    expect(
      isDirty(
        { form: 'leave', fields: withRoleset('leave-11') },
        { form: 'leave', metadata: withRoleset('leave-02') },
      ),
    ).toBe(true);
  });

  it('calls two equal ones equal, whatever order their keys are in', () => {
    expect(
      metaEqual(
        { umr: { roleset: 'a', args: { ARG0: 'x' } } },
        { umr: { args: { ARG0: 'x' }, roleset: 'a' } },
      ),
    ).toBe(true);
  });

  it('still compares plain fields by their text', () => {
    expect(metaEqual({ gloss: 'dog' }, { gloss: 'dog' })).toBe(true);
    expect(metaEqual({ gloss: 'dog' }, { gloss: 'cat' })).toBe(false);
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
  it('lets a new sense seeded with its headword form be saved as it stands', () => {
    const seeded = run({ type: 'draft/seed', seedKey: 'new|p', form: 'kai', fields: {} }).draft;
    expect(isDirty(seeded, null)).toBe(true);
  });
});

describe('hasTyped', () => {
  it('counts nothing typed into a new sense until its headword form is changed', () => {
    const seeded = run({ type: 'draft/seed', seedKey: 'new|p', form: 'kai', fields: {} }).draft;
    expect(hasTyped(seeded, null)).toBe(false);
    expect(hasTyped({ ...seeded, form: ' kai ' }, null)).toBe(false);
    expect(hasTyped({ ...seeded, form: 'kaii' }, null)).toBe(true);
    expect(hasTyped({ ...seeded, form: '' }, null)).toBe(true);
    expect(hasTyped({ ...seeded, fields: { gloss: 'sun' } }, null)).toBe(true);
  });
  it('counts anything in a new headword', () => {
    const blank = run({ type: 'draft/seed', seedKey: 'new|', form: '', fields: {} }).draft;
    expect(hasTyped(blank, null)).toBe(false);
    expect(hasTyped({ ...blank, form: 'a' }, null)).toBe(true);
  });
  it('agrees with isDirty for an existing entry', () => {
    const item = { form: 'kai', metadata: { gloss: 'sun' } };
    for (const draft of [
      { seedForm: 'kai', form: 'kai', fields: { gloss: 'sun' } },
      { seedForm: 'kai', form: 'kaii', fields: { gloss: 'sun' } },
      { seedForm: 'kai', form: 'kai', fields: { gloss: 'moon' } },
    ]) {
      expect(hasTyped(draft, item)).toBe(isDirty(draft, item));
    }
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
  it('closing with nothing open is a no-op that keeps the state identity', () => {
    expect(reducer(initialState, { type: 'dialog/close' })).toBe(initialState);
  });
});
