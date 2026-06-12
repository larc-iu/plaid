import { describe, it, expect } from 'vitest';
import { unzipSync } from 'fflate';
import { sanitizeFilename, dedupeFilenames, assembleZip } from './files.js';

describe('sanitizeFilename', () => {
  it('strips path separators and reserved characters', () => {
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
  });
  it('keeps unicode, spaces, and hyphens', () => {
    expect(sanitizeFilename('Лезги текст — copy-2')).toBe('Лезги текст — copy-2');
  });
  it('trims leading/trailing dots and falls back when empty', () => {
    expect(sanitizeFilename('..hidden..')).toBe('hidden');
    expect(sanitizeFilename('///')).toBe('untitled');
    expect(sanitizeFilename(null)).toBe('untitled');
  });
  it('caps length by code points, never stranding a surrogate half', () => {
    expect(sanitizeFilename('x'.repeat(300)).length).toBe(120);
    const astral = sanitizeFilename('𝕒'.repeat(130));
    expect([...astral].length).toBe(120);
    expect(astral.isWellFormed()).toBe(true);
  });
});

describe('dedupeFilenames', () => {
  it('numbers duplicates before the extension', () => {
    expect(dedupeFilenames(['a.txt', 'b.txt', 'a.txt', 'a.txt']))
      .toEqual(['a.txt', 'b.txt', 'a (2).txt', 'a (3).txt']);
  });
  it('appends for extensionless names', () => {
    expect(dedupeFilenames(['x', 'x'])).toEqual(['x', 'x (2)']);
  });
  it('never collides a generated suffix with a literal name', () => {
    expect(dedupeFilenames(['a.txt', 'a.txt', 'a (2).txt']))
      .toEqual(['a.txt', 'a (2).txt', 'a (2) (2).txt']);
  });
});

describe('assembleZip', () => {
  it('zips string and binary entries round-trippably', async () => {
    const blob = await assembleZip([
      { path: 'documents/a.txt', data: 'héllo' },
      { path: 'vocabularies/v.tsv', data: new Uint8Array([1, 2, 3]) },
    ]);
    const out = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(out).sort()).toEqual(['documents/a.txt', 'vocabularies/v.tsv']);
    expect(new TextDecoder().decode(out['documents/a.txt'])).toBe('héllo');
    expect([...out['vocabularies/v.tsv']]).toEqual([1, 2, 3]);
  });
});
