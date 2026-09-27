import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { APPS, repoRoot } from '../test/apps.js';

// Every file an importer reads as text goes through textFile.js, so a UTF-16
// file is decoded or refused before anything is written. A second decoder in
// an importer is that check left off one path. Listed here: the decoders that
// read something other than a picked file of a person's own text.
const ALLOWED = new Map([
  // The native archive is written by the export itself, always UTF-8 JSON.
  ['plaid-igt/src/import/native/readArchive.js', 'own archive'],
  // An assistant attachment, not an import: a strict UTF-8 read of its own.
  ['plaid-ui/src/components/assistant/attachments.js', 'attachment'],
]);

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' ? [] : sources(full);
    return e.isFile() && /\.jsx?$/.test(e.name) && !/\.test\.jsx?$/.test(e.name) ? [full] : [];
  });

// A text read of a file: FileReader, a decoder, or Blob.text() on a name that
// holds a file (a fetch response's .text() is not a file).
const READ = /readAsText\(|new TextDecoder\(|\b(file|f|picked|blob)\.text\(\)/;

describe('importers read text through textFile.js', () => {
  it('has no other text read of a file in any app or in the package', () => {
    const root = repoRoot();
    const dirs = [...APPS.map((a) => a.dir), 'plaid-ui'].map((d) => path.join(root, d, 'src'));
    const found = dirs
      .flatMap(sources)
      .map((f) => path.relative(root, f).split(path.sep).join('/'))
      .filter((rel) => rel !== 'plaid-ui/src/lib/textFile.js' && !ALLOWED.has(rel))
      .flatMap((rel) =>
        fs
          .readFileSync(path.join(root, rel), 'utf8')
          .split('\n')
          .map((line, i) => [line, i])
          .filter(([line]) => READ.test(line) && !/^\s*(\/\/|\/?\*)/.test(line))
          .map(([, i]) => `${rel}:${i + 1}`),
      );
    expect(found).toEqual([]);
  });
});
