import { describe, it, expect } from 'vitest';
import { changedUnderSave } from './metadataPatch';

// H15-1: an entry save from a form read before someone else's save of the
// same field is refused, and a save of other fields is not.
describe('changedUnderSave', () => {
  const loaded = { form: 'perro', metadata: { gloss: 'dog', pos: 'n' } };

  it('is true when another save changed a field this save changes', () => {
    const next = { form: 'perro', metadata: { gloss: 'canine', pos: 'n' } };
    const now = { form: 'perro', metadata: { gloss: 'hound', pos: 'n' } };
    expect(changedUnderSave(loaded, next, now)).toBe(true);
  });

  it('is false when the other save changed another field', () => {
    const next = { form: 'perro', metadata: { gloss: 'canine', pos: 'n' } };
    const now = { form: 'perro', metadata: { gloss: 'dog', pos: 'v' } };
    expect(changedUnderSave(loaded, next, now)).toBe(false);
  });

  it('is false when the server already holds what this save writes (a resend)', () => {
    const next = { form: 'perro', metadata: { gloss: 'canine', pos: 'n' } };
    expect(changedUnderSave(loaded, next, next)).toBe(false);
  });

  it('counts a removed key and the form', () => {
    expect(
      changedUnderSave(
        loaded,
        { form: 'perro', metadata: { pos: 'n' } },
        { form: 'perro', metadata: { gloss: 'hound', pos: 'n' } },
      ),
    ).toBe(true);
    expect(
      changedUnderSave(
        loaded,
        { form: 'perra', metadata: loaded.metadata },
        { form: 'perrito', metadata: loaded.metadata },
      ),
    ).toBe(true);
    expect(
      changedUnderSave(
        loaded,
        { form: 'perro', metadata: { gloss: 'dog', pos: 'n' } },
        { form: 'perrito', metadata: loaded.metadata },
      ),
    ).toBe(false);
  });

  it('compares lists by value', () => {
    const l = { form: 'a', metadata: { seeAlso: ['x', 'y'] } };
    expect(
      changedUnderSave(l, { form: 'a', metadata: { seeAlso: ['x'] } }, structuredClone(l)),
    ).toBe(false);
  });
});
