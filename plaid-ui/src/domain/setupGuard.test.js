import { describe, it, expect, vi, afterEach } from 'vitest';

import { NOT_SET_UP, notSetUp } from './setupGuard.js';

describe('notSetUp', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the one on-screen sentence and names the missing piece only in the console', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shown = notSetUp('Morpheme layer not configured');
    expect(shown).toBe(NOT_SET_UP);
    expect(shown).not.toMatch(/layer|Morpheme/);
    expect(log).toHaveBeenCalledWith('Project setup incomplete: Morpheme layer not configured');
  });
});
