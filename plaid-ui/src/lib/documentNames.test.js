import { describe, expect, it } from 'vitest';
import { foldDocumentName, freeDocumentName, nameTakenMessage } from './documentNames.js';

describe('freeDocumentName', () => {
  it('keeps a free name', () => {
    expect(freeDocumentName('Story', [])).toBe('Story');
    expect(freeDocumentName('Story', ['Other'])).toBe('Story');
  });

  it('takes the first free numbered name, as core does', () => {
    expect(freeDocumentName('Story', ['Story'])).toBe('Story (2)');
    expect(freeDocumentName('Story', ['Story', 'Story (2)', 'Story (3)'])).toBe('Story (4)');
    expect(freeDocumentName('Story', ['Story', 'Story (3)'])).toBe('Story (2)');
  });

  it('compares names composed, as the server stores them', () => {
    expect(freeDocumentName('Kafe\u0301', ['Kaf\u00e9'])).toBe('Kaf\u00e9 (2)');
  });

  it('skips a name taken but for case, as core does', () => {
    expect(freeDocumentName('story', ['Story'])).toBe('story (2)');
    expect(freeDocumentName('Story', ['STORY', 'story (2)'])).toBe('Story (3)');
    expect(freeDocumentName('Straße', ['STRASSE'])).toBe('Straße (2)');
    expect(freeDocumentName('σοφος', ['ΣΟΦΟΣ'])).toBe('σοφος (2)');
  });
});

describe('foldDocumentName', () => {
  it("is Python's str.casefold, composed, as core folds names", () => {
    expect(foldDocumentName('kır')).toBe('k\u0131r');
    expect(foldDocumentName('KIR')).toBe('kir');
    expect(foldDocumentName('Ꭰꭰ')).toBe('\u13a0\u13a0');
    expect(foldDocumentName('ﬃ')).toBe('ffi');
    expect(foldDocumentName('İstanbul')).toBe('i\u0307stanbul');
    expect(foldDocumentName('ᾼ')).toBe('\u03b1\u03b9');
    expect(foldDocumentName('ΣΑΣ')).toBe('\u03c3\u03b1\u03c3');
    expect(foldDocumentName('Kafe\u0301')).toBe('kaf\u00e9');
  });

  it('keeps dotless i apart from i, as core does', () => {
    expect(freeDocumentName('kir', ['kır'])).toBe('kir');
    expect(freeDocumentName('KIR', ['kir'])).toBe('KIR (2)');
  });
});

describe('nameTakenMessage', () => {
  const refusal = (data, status = 422) => ({ status, responseData: data, message: 'x' });

  it("is core's message for its refusal of a taken name", () => {
    const said = 'A document named “Story” already exists in this project.';
    expect(nameTakenMessage(refusal({ error: said, 'name-taken': 'Story' }))).toBe(said);
  });

  it('is null for any other refusal', () => {
    expect(nameTakenMessage(refusal({ error: 'Not allowed' }))).toBeNull();
    expect(nameTakenMessage(refusal({ error: 'x', 'name-taken': 'S' }, 409))).toBeNull();
    expect(nameTakenMessage(null)).toBeNull();
  });
});
