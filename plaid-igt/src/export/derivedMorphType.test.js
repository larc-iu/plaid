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

describe('exporters read the derived morph type', () => {
  it('no exporter reads metadata.morphType', () => {
    const hits = readdirSync(here)
      .filter((f) => f.endsWith('.js') && !f.includes('.test.') && !LEFT_OUT.has(f))
      .flatMap((f) =>
        readFileSync(join(here, f), 'utf8')
          .split('\n')
          .map((line, i) => [f, i + 1, line])
          .filter(([, , line]) => STORED.test(line) && !/^\s*\/\//.test(line)),
      )
      .map(([f, n]) => `${f}:${n}`);
    expect(hits).toEqual([]);
  });
});
