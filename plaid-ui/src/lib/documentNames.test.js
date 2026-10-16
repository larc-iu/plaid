import { describe, expect, it } from 'vitest';
import { freeDocumentName, nameTakenMessage } from './documentNames.js';

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
