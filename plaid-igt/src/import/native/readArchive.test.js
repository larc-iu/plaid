import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { readNativeArchive, ArchiveError } from './readArchive.js';

const enc = new TextEncoder();
const zipOf = (entries) => zipSync(Object.fromEntries(
  Object.entries(entries).map(([p, v]) => [p, typeof v === 'string' ? enc.encode(v) : v])));

const MANIFEST = {
  format: 'plaid-igt', formatVersion: 1,
  vocabularies: [{ id: 'v1', name: 'Lex', file: 'vocabularies/Lex.json' }],
  documents: [{ id: 'd1', name: 'A', file: 'documents/A.json', mediaFile: 'media/A.wav' }],
};

describe('readNativeArchive', () => {
  it('reads manifest, vocabularies, documents, and media bytes', () => {
    const bytes = zipOf({
      'project.json': JSON.stringify(MANIFEST),
      'vocabularies/Lex.json': JSON.stringify({ id: 'v1', items: [] }),
      'documents/A.json': JSON.stringify({ id: 'd1', sentences: [] }),
      'media/A.wav': new Uint8Array([7, 8]),
    });
    const archive = readNativeArchive(bytes);
    expect(archive.manifest.formatVersion).toBe(1);
    expect(archive.vocabularies[0].data).toEqual({ id: 'v1', items: [] });
    expect(archive.documents[0].data).toEqual({ id: 'd1', sentences: [] });
    expect([...archive.documents[0].mediaBytes]).toEqual([7, 8]);
  });

  it('tolerates a missing media entry (null bytes)', () => {
    const bytes = zipOf({
      'project.json': JSON.stringify(MANIFEST),
      'vocabularies/Lex.json': '{}',
      'documents/A.json': '{}',
    });
    expect(readNativeArchive(bytes).documents[0].mediaBytes).toBeNull();
  });

  it('rejects non-zips, foreign zips, and unsupported versions', () => {
    expect(() => readNativeArchive(new Uint8Array([1, 2, 3]))).toThrow(ArchiveError);
    expect(() => readNativeArchive(zipOf({ 'x.txt': 'hi' }))).toThrow(/project\.json is missing/);
    expect(() => readNativeArchive(zipOf({ 'project.json': '{"format":"other"}' }))).toThrow(/Unrecognized format/);
    expect(() => readNativeArchive(zipOf({ 'project.json': '{"format":"plaid-igt","formatVersion":2}' })))
      .toThrow(/Unsupported formatVersion 2/);
    expect(() => readNativeArchive(zipOf({ 'project.json': JSON.stringify(MANIFEST) })))
      .toThrow(/entry missing: vocabularies\/Lex\.json/);
  });
});
