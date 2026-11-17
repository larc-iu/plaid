import { describe, it, expect } from 'vitest';
import { changedUnderSave } from './metadataPatch';

// H15-1: an entry save from a form read before someone else's save of the
// same field is refused, and a save of other fields is not.
describe('changedUnderSave', () => {
  const loaded = { form: 'perro', metadata: { gloss: 'dog', pos: 'n' } };

  it('is true when another save changed a field this save changes', () => {
    const next = { form: 'perro', metadata: { gloss: 'canine', pos: 'n' } };
    const now = { form: 'perro', metadata: { gloss: 'hound', pos: 'n' } };
    expect(changedUnderSave(loaded, next, now)).toEqual({ key: 'gloss', value: 'hound' });
  });

  it('is false when the other save changed another field', () => {
    const next = { form: 'perro', metadata: { gloss: 'canine', pos: 'n' } };
    const now = { form: 'perro', metadata: { gloss: 'dog', pos: 'v' } };
    expect(changedUnderSave(loaded, next, now)).toBeNull();
  });

  it('is false when the server already holds what this save writes (a resend)', () => {
    const next = { form: 'perro', metadata: { gloss: 'canine', pos: 'n' } };
    expect(changedUnderSave(loaded, next, next)).toBeNull();
  });

  it('counts a removed key and the form', () => {
    expect(
      changedUnderSave(
        loaded,
        { form: 'perro', metadata: { pos: 'n' } },
        { form: 'perro', metadata: { gloss: 'hound', pos: 'n' } },
      ),
    ).toEqual({ key: 'gloss', value: 'hound' });
    expect(
      changedUnderSave(
        loaded,
        { form: 'perra', metadata: loaded.metadata },
        { form: 'perrito', metadata: loaded.metadata },
      ),
    ).toEqual({ key: 'form', value: 'perrito' });
    expect(
      changedUnderSave(
        loaded,
        { form: 'perro', metadata: { gloss: 'dog', pos: 'n' } },
        { form: 'perrito', metadata: loaded.metadata },
      ),
    ).toBeNull();
  });

  it('compares lists by value', () => {
    const l = { form: 'a', metadata: { seeAlso: ['x', 'y'] } };
    expect(
      changedUnderSave(l, { form: 'a', metadata: { seeAlso: ['x'] } }, structuredClone(l)),
    ).toBeNull();
  });
});

// REV-HFV-R2-2: the refusal names the field by its label on the form, at a
// sentence's start.
describe('changedElsewhereText', () => {
  it('names the field by its label, capitalised, and the form as Form', async () => {
    const { changedElsewhereText } = await import('./metadataPatch');
    const labelOf = (k) => ({ gloss: 'gloss (en)', seeAlso: 'See also' })[k] ?? k;
    expect(changedElsewhereText({ key: 'gloss', value: 'hound' }, labelOf)).toBe(
      'Gloss (en) was changed elsewhere to “hound”. Save again to keep yours.',
    );
    expect(changedElsewhereText({ key: 'seeAlso', value: ['x'] }, labelOf)).toBe(
      'See also was changed elsewhere. Save again to keep yours.',
    );
    expect(changedElsewhereText({ key: 'form', value: 'perrito' })).toBe(
      'Form was changed elsewhere to “perrito”. Save again to keep yours.',
    );
  });
});
