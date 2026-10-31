import { describe, it, expect } from 'vitest';
import { cellKeyParts } from './cellReader.js';

// The one parser of a grid cell key. A row id may be `virtual:<word>`, and a
// field name is whatever a maintainer typed, colons included.
describe('cellKeyParts', () => {
  it('reads a kind, a row and a field', () => {
    expect(cellKeyParts('ma:m-1:Gloss')).toEqual({ kind: 'ma', row: 'm-1', field: 'Gloss' });
  });

  it("reads a virtual morpheme's id whole", () => {
    expect(cellKeyParts('ma:virtual:w-3:Gloss')).toEqual({
      kind: 'ma',
      row: 'virtual:w-3',
      field: 'Gloss',
    });
    expect(cellKeyParts('mf:virtual:w-3')).toEqual({ kind: 'mf', row: 'virtual:w-3', field: '' });
  });

  it('keeps a colon in a field name', () => {
    expect(cellKeyParts('wa:w-1:Note: free')).toEqual({
      kind: 'wa',
      row: 'w-1',
      field: 'Note: free',
    });
  });

  it('reads no row from a key that is not one', () => {
    expect(cellKeyParts(undefined)).toEqual({ kind: '', row: '', field: '' });
  });
});
