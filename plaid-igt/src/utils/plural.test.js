import { describe, it, expect } from 'vitest';
import { plural } from './plural.js';

describe('plural', () => {
  it('agrees with its count', () => {
    expect(plural(1, 'text')).toBe('1 text');
    expect(plural(0, 'text')).toBe('0 texts');
    expect(plural(2, 'entry', 'entries')).toBe('2 entries');
    expect(plural(1204, 'word')).toBe((1204).toLocaleString() + ' words');
  });
});
