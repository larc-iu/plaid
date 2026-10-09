import { describe, it, expect } from 'vitest';
import { isEmail } from './email.js';

// The server's rule (plaid.sql.user/assert-valid-email!): one @, a dot in the
// domain, and no space, control or format character inside, once those at
// either end are trimmed.
describe('isEmail', () => {
  it('takes an address in any script, with invisible characters at its ends', () => {
    expect(isEmail('m\u00fcller@b\u00fccher.de')).toBe(true);
    expect(isEmail('\ufeffbom@x.com\u00a0')).toBe(true);
    expect(isEmail('\u200bzw@x.com')).toBe(true);
  });

  it('refuses an invisible character inside, as the server does', () => {
    for (const s of [
      'a\u200bb@x.com',
      'a\u00a0b@x.com',
      'ab@x\u2068.com',
      'ab@x.c\u00adom',
      'a b@x.com',
    ]) {
      expect(isEmail(s)).toBe(false);
    }
  });
});
