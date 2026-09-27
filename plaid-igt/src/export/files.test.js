import { describe, it, expect, vi } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { sanitizeFilename, dedupeFilenames, assembleZip } from './files.js';

// Every call fflate's async zip gets, how many files it was handed, and how
// many calls were running at once at most.
const zipCalls = vi.hoisted(() => ({ files: [], running: 0, most: 0 }));
vi.mock('fflate', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    zip: (data, opts, cb) => {
      zipCalls.files.push(Object.keys(data).length);
      zipCalls.running += 1;
      zipCalls.most = Math.max(zipCalls.most, zipCalls.running);
      return real.zip(data, opts, (err, out) => {
        zipCalls.running -= 1;
        cb(err, out);
      });
    },
  };
});

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
    expect(dedupeFilenames(['a.txt', 'b.txt', 'a.txt', 'a.txt'])).toEqual([
      'a.txt',
      'b.txt',
      'a (2).txt',
      'a (3).txt',
    ]);
  });
  it('appends for extensionless names', () => {
    expect(dedupeFilenames(['x', 'x'])).toEqual(['x', 'x (2)']);
  });
  it('never collides a generated suffix with a literal name', () => {
    expect(dedupeFilenames(['a.txt', 'a.txt', 'a (2).txt'])).toEqual([
      'a.txt',
      'a (2).txt',
      'a (2) (2).txt',
    ]);
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

describe('assembleZip, a file at a time', () => {
  // A fixed mtime, since a header records when it was written.
  const mtime = new Date('2026-01-02T03:04:05Z');
  const big = (seed) =>
    Array.from({ length: 30000 }, (_, i) => `{"n": ${i * seed}, "form": "ka${i % 97}"}`).join('\n');
  const files = () => [
    { path: 'project.json', data: '{"name": "Kitchen"}', opts: { mtime } },
    { path: 'documents/Story the dog.json', data: big(3), opts: { mtime } },
    { path: 'documents/Story 2 الكلب v2.json', data: big(7), opts: { mtime } },
    {
      path: 'media/a.wav',
      data: new Uint8Array(200000).map((_, i) => i % 251),
      opts: { level: 0, mtime },
    },
    { path: 'documents/empty.txt', data: '', opts: { mtime } },
    { path: 'vocabularies/v.tsv', data: 'form\tgloss\nka\tgo\n', opts: { mtime } },
  ];

  it('is byte for byte the archive fflate writes for all the files together', async () => {
    const ours = new Uint8Array(await (await assembleZip(files())).arrayBuffer());
    const whole = {};
    for (const f of files()) {
      const bytes = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data;
      whole[f.path] = [bytes, f.opts];
    }
    const theirs = zipSync(whole, { level: 6 });
    expect(ours.length).toBe(theirs.length);
    expect(Buffer.compare(Buffer.from(ours), Buffer.from(theirs))).toBe(0);
    const out = unzipSync(ours);
    expect(Object.keys(out)).toEqual(files().map((f) => f.path));
    expect(new TextDecoder().decode(out['documents/Story 2 الكلب v2.json'])).toBe(big(7));
  });

  // fflate deflates each file of 160 KB or more in a worker of its own, and
  // handed every file at once it starts them all: 400 documents were 400
  // workers and 5 to 7 GB.
  it('hands fflate one file at a time, four at most at once', async () => {
    zipCalls.files = [];
    zipCalls.most = 0;
    const many = Array.from({ length: 12 }, (_, i) => ({
      path: `documents/${i}.json`,
      data: 'x'.repeat(170000 + i),
    }));
    const out = unzipSync(new Uint8Array(await (await assembleZip(many)).arrayBuffer()));
    expect(Object.keys(out)).toEqual(many.map((f) => f.path));
    expect(zipCalls.files).toEqual(many.map(() => 1));
    expect(zipCalls.most).toBeLessThanOrEqual(4);
    expect(zipCalls.most).toBeGreaterThan(1);
  });

  it('an archive of nothing is the bare end record', async () => {
    const ours = new Uint8Array(await (await assembleZip([])).arrayBuffer());
    expect([...ours]).toEqual([...zipSync({})]);
  });
});
