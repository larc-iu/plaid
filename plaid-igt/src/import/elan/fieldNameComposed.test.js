import { describe, it, expect } from 'vitest';
import { defaultFieldName } from './buildDocuments.js';

// A tier name from a file written decomposed names the field the project
// stores composed, so the import writes into that field rather than asking
// to make a second one beside it.
describe('the field a tier writes to', () => {
  it('is named composed, whatever spelling the file uses', () => {
    expect(defaultFieldName({ baseName: 'Traducción' })).toBe('Traducción');
    expect(defaultFieldName({ baseName: 'Gloss' })).toBe('Gloss');
  });
});
