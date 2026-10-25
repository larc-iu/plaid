import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOrthographyKey, orthographyKey, orthographyName } from './igtConfig.js';

// A word's spelling in an orthography is stored under a token-metadata key
// that every importer, the derive reader, the editor and the archive have to
// agree on. igtConfig.js spells it once, and nothing else in src does.

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sources = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.isFile() && /\.(m?js|jsx)$/.test(e.name) ? [full] : [];
  });

// Tests and fixtures spell the stored shape on purpose: they say what is
// stored, not how the app builds it.
const isTestFile = (rel) =>
  /\.(test|spec)\.(m?js|jsx)$/.test(rel) ||
  rel.startsWith('test/') ||
  rel === 'export/testFixtures.js';

const ALLOWED = new Set([
  'domain/igtConfig.js',
  // Held by lanes still running when this gate landed (BH-4a, BH-3). Each
  // goes to orthographyKey and leaves this list when they are done.
  'components/projects/settings/OrthographiesSettings.jsx',
  'domain/mutations/tokens.js',
]);

describe('the orthography key', () => {
  it('round-trips a name', () => {
    expect(orthographyName(orthographyKey('Old spelling'))).toBe('Old spelling');
    expect(isOrthographyKey(orthographyKey('IPA'))).toBe(true);
    expect(isOrthographyKey('IPA')).toBe(false);
    expect(isOrthographyKey(undefined)).toBe(false);
  });

  it('is spelled only in igtConfig.js', () => {
    const hits = sources(src)
      .map((file) => path.relative(src, file).split(path.sep).join('/'))
      .filter((rel) => !isTestFile(rel) && !ALLOWED.has(rel))
      .flatMap((rel) =>
        fs
          .readFileSync(path.join(src, rel), 'utf8')
          .split('\n')
          .map((line, i) => (line.includes('orthog:') ? `${rel}:${i + 1}` : null))
          .filter(Boolean),
      );
    expect(hits).toEqual([]);
  });
});
