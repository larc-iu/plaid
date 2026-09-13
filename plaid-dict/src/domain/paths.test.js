import { describe, it, expect } from 'vitest';
import { dictionaryAddress, dictionaryPath, formPath } from './paths.js';

describe('paths', () => {
  it('encodes a form so two spellings never collide', () => {
    expect(formPath('sena', 'ọkọ')).toBe('/sena/%E1%BB%8Dk%E1%BB%8D');
    expect(dictionaryPath('sena')).toBe('/sena');
  });

  it('writes an address someone can type, hash and all', () => {
    // The index printed the bare path beside each dictionary, so a
    // lexicographer copying it into an email sent people to the index. Routes
    // live in the fragment, so the `#` is part of the address.
    const address = dictionaryAddress('sena');
    expect(address.endsWith('#/sena')).toBe(true);
    expect(address.startsWith(import.meta.env.BASE_URL)).toBe(true);
  });
});
