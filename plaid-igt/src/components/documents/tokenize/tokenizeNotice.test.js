import { describe, expect, it } from 'vitest';

import { tokenizeNotice } from './tokenizeNotice.js';

describe('tokenizeNotice', () => {
  it('says a tokenize that found no text or no words did nothing', () => {
    expect(tokenizeNotice({ tokensCreated: 0, reason: 'no-text' })).toEqual({
      level: 'warning',
      title: 'Nothing to tokenize',
      message: 'The document has no text.',
    });
    expect(tokenizeNotice({ reason: 'no-words' }).message).toBe('No words found in the text.');
  });

  it('leaves any other tokenize to the fixed copy', () => {
    expect(tokenizeNotice({ tokensCreated: 4 })).toBe(null);
    expect(tokenizeNotice(undefined)).toBe(null);
  });
});
