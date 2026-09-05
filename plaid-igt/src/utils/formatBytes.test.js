import { describe, it, expect } from 'vitest';
import { formatBytes } from './formatBytes.js';

describe('formatBytes', () => {
  it('counts small sizes in bytes', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(999)).toBe('999 bytes');
  });

  it('shows one decimal under ten units and none above', () => {
    expect(formatBytes(1000)).toBe('1.0 KB');
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(12345678)).toBe('12 MB');
    expect(formatBytes(2.5e9)).toBe('2.5 GB');
  });

  it('is empty for nonsense', () => {
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(NaN)).toBe('');
    expect(formatBytes(undefined)).toBe('');
  });
});
