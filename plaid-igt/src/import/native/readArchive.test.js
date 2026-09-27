import { describe, it, expect } from 'vitest';
import { zipSync } from 'fflate';
import { readNativeArchive, ArchiveError } from './readArchive.js';

const enc = new TextEncoder();
const zipOf = (entries) =>
  zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([p, v]) => [p, typeof v === 'string' ? enc.encode(v) : v]),
    ),
  );

const MANIFEST = {
  format: 'plaid-igt',
  formatVersion: 1,
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
      'documents/A.json': '{"id":"d1"}',
    });
    expect(readNativeArchive(bytes).documents[0].mediaBytes).toBeNull();
  });

  it('refuses an entry that is not UTF-8, naming it', () => {
    // "café" in Windows-1252: 0xE9 is not UTF-8.
    const vocab = new Uint8Array([...enc.encode('{"id":"v1","name":"caf'), 0xe9, 0x22, 0x7d]);
    const bytes = zipOf({
      'project.json': JSON.stringify(MANIFEST),
      'vocabularies/Lex.json': vocab,
      'documents/A.json': '{"id":"d1"}',
    });
    expect(() => readNativeArchive(bytes)).toThrow(ArchiveError);
    expect(() => readNativeArchive(bytes)).toThrow('vocabularies/Lex.json is not UTF-8.');
  });

  it('refuses two vocabularies with one name', () => {
    const manifest = {
      ...MANIFEST,
      vocabularies: [
        { id: 'v1', name: 'Lex', file: 'vocabularies/Lex.json' },
        { id: 'v2', name: 'Lex', file: 'vocabularies/Lex (2).json' },
      ],
    };
    const bytes = zipOf({
      'project.json': JSON.stringify(manifest),
      'vocabularies/Lex.json': '{}',
      'vocabularies/Lex (2).json': '{}',
      'documents/A.json': '{}',
    });
    expect(() => readNativeArchive(bytes)).toThrow(/Two vocabularies are named "Lex"/);
  });

  // A resume finds what an earlier run made by the archive's document id, so
  // two documents sharing one, or one without any, would be taken for each
  // other: a finished one imported twice, a half-made one deleted twice.
  it('refuses a document with no id, and two documents with one id', () => {
    const manifest = {
      ...MANIFEST,
      documents: [
        { id: 'd1', name: 'A', file: 'documents/A.json' },
        { id: 'd2', name: 'B', file: 'documents/B.json' },
      ],
    };
    const archive = (a, b) =>
      zipOf({
        'project.json': JSON.stringify(manifest),
        'vocabularies/Lex.json': '{}',
        'documents/A.json': JSON.stringify(a),
        'documents/B.json': JSON.stringify(b),
      });
    expect(() => readNativeArchive(archive({ id: 'd1' }, { id: 'd1' }))).toThrow(
      'Two documents in the archive have the id "d1".',
    );
    expect(() => readNativeArchive(archive({ id: 'd1' }, { name: 'B' }))).toThrow(
      'The document in documents/B.json has no id.',
    );
    expect(() => readNativeArchive(archive({ id: 'd1' }, { id: '' }))).toThrow(ArchiveError);
    // A resume marks a document with its id as a string, so 7 and "7" are one.
    expect(() => readNativeArchive(archive({ id: 7 }, { id: '7' }))).toThrow(
      'Two documents in the archive have the id "7".',
    );
    expect(readNativeArchive(archive({ id: 'd1' }, { id: 'd2' })).documents).toHaveLength(2);
  });

  it('rejects non-zips, foreign zips, and unsupported versions', () => {
    expect(() => readNativeArchive(new Uint8Array([1, 2, 3]))).toThrow(ArchiveError);
    expect(() => readNativeArchive(zipOf({ 'x.txt': 'hi' }))).toThrow(
      /project\.json file is missing/,
    );
    expect(() => readNativeArchive(zipOf({ 'project.json': '{"format":"other"}' }))).toThrow(
      /Unrecognized format/,
    );
    expect(() =>
      readNativeArchive(zipOf({ 'project.json': '{"format":"plaid-igt","formatVersion":2}' })),
    ).toThrow(/Unsupported formatVersion 2/);
    expect(() => readNativeArchive(zipOf({ 'project.json': JSON.stringify(MANIFEST) }))).toThrow(
      /entry missing: vocabularies\/Lex\.json/,
    );
  });
});
