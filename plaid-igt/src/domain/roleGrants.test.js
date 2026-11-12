import { describe, it, expect } from 'vitest';
import { ROLE_OPTIONS } from './roleGrants.js';

// H1-8, Luke's ruling 2026-11-09: writers keep document delete, and the role
// list says so.
describe('the role hints', () => {
  it('say a writer deletes documents', () => {
    const writer = ROLE_OPTIONS.find((o) => o.value === 'writer');
    expect(writer.hint).toMatch(/deletes documents/);
  });

  // A writer of a vocabulary's project adds its entries and edits their
  // fields (SPEC 5.4, Luke's ruling 11.4).
  it('say a writer links vocabulary and adds its entries', () => {
    const writer = ROLE_OPTIONS.find((o) => o.value === 'writer');
    expect(writer.hint).toBe(
      'Also edits and deletes documents, links vocabulary and adds its entries.',
    );
  });
});
