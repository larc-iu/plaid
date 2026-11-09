import { describe, it, expect } from 'vitest';
import { ROLE_OPTIONS } from './roleGrants.js';

// H1-8, Luke's ruling 2026-11-09: writers keep document delete, and the role
// list says so.
describe('the role hints', () => {
  it('say a writer deletes documents', () => {
    const writer = ROLE_OPTIONS.find((o) => o.value === 'writer');
    expect(writer.hint).toMatch(/deletes documents/);
  });
});
