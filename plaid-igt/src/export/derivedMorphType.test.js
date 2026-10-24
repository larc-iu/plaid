import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The exporters read a morpheme's derived type (`m.morphType`, which
// plaid-ui's morphemeMorphType already took from the entry or the token's own
// known type), never the stored `metadata.morphType` beside it: the stored one
// only lets through a type the derived view refused (R2-RULES-9). The native
// archive writer serializes the stored token on purpose, so it is left out.
const here = dirname(fileURLToPath(import.meta.url));
const STORED = /\bmetadata\??\.morphType\b/;
const LEFT_OUT = new Set(['nativeJson.js']);

const storedReads = (dir, leftOut) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.includes('.test.') && !leftOut.has(f))
    .flatMap((f) =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .map((line, i) => [f, i + 1, line])
        .filter(([, , line]) => STORED.test(line) && !/^\s*\/\//.test(line)),
    )
    .map(([f, n]) => `${f}:${n}`);

// The domain modules that read it on purpose: derive.js is the derived view
// itself, analysisMemory.js records the stored type as the analysis held it,
// and the rest read an ENTRY's own type (precedent.js's query, the entry
// tree, the vocabulary Replace). The mutations are the stored value's writers
// and live in a folder of their own, which this does not read.
const DOMAIN_LEFT_OUT = new Set([
  'derive.js',
  'analysisMemory.js',
  'precedent.js',
  'vocabDictionary.js',
  'vocabReplace.js',
]);

describe('exporters read the derived morph type', () => {
  it('no exporter reads metadata.morphType', () => {
    expect(storedReads(here, LEFT_OUT)).toEqual([]);
  });

  it('no domain module the copy formats and exports share reads it either (R4-5-4)', () => {
    expect(storedReads(join(here, '..', 'domain'), DOMAIN_LEFT_OUT)).toEqual([]);
  });
});
