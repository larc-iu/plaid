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

  // REV8-CORE-5: core composes by Unicode 15, where Tulu-Tigalari and Kirat
  // Rai are not yet encoded, and this browser by Unicode 16, which composes
  // \u{113C2}\u{113C2} to \u{113C5}. Core takes both as two names, and so
  // does the fold.
  it("composes by core's Unicode version", () => {
    expect(foldDocumentName('x\u{113c2}\u{113c2}')).toBe('x\u{113c2}\u{113c2}');
    expect(foldDocumentName('x\u{113c5}')).toBe('x\u{113c5}');
    expect(freeDocumentName('x\u{113c5}', ['x\u{113c2}\u{113c2}'])).toBe('x\u{113c5}');
    expect(foldDocumentName('\u{16d67}\u{16d67}')).toBe('\u{16d67}\u{16d67}');
    // A letter core knows still composes beside one it does not.
    expect(foldDocumentName('E\u0301\u{113c2}e\u0301')).toBe('\u00e9\u{113c2}\u00e9');
    expect(foldDocumentName('a\u{113c2}\u0323\u0301')).toBe('a\u{113c2}\u0323\u0301');
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
