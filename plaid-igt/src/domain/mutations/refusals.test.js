import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIgtDoc } from '../test-helpers.js';

// A guard's refusal goes through the base's `refuse`, which says it every
// time. `setError` says a standing message once, so the same gesture refused
// twice in a row was answered the first time only (B5-5).
const HERE = dirname(fileURLToPath(import.meta.url));

describe('a mutation guard refuses through refuse()', () => {
  it('says the same refusal twice in a row', async () => {
    const doc = makeIgtDoc();
    const said = [];
    doc.onError = (message) => said.push(message);
    expect(await doc.deleteMorpheme('no-such-morpheme')).toBe(false);
    expect(await doc.deleteMorpheme('no-such-morpheme')).toBe(false);
    expect(said).toEqual(['Morpheme not found', 'Morpheme not found']);
  });

  it('no mutation calls setError', () => {
    const sources = [
      ...readdirSync(HERE)
        .filter((name) => name.endsWith('.js') && !name.includes('.test.'))
        .map((name) => join(HERE, name)),
      join(HERE, '..', 'IgtDocument.js'),
    ];
    const callers = sources.filter((path) => /this\.setError\(/.test(readFileSync(path, 'utf8')));
    expect(callers).toEqual([]);
  });
});
