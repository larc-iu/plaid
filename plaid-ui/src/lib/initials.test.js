import { describe, it, expect } from 'vitest';
import { initials } from './initials.js';

describe('initials', () => {
  it('takes the first and last word of a name', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Ada B. C. Lovelace')).toBe('AL');
    expect(initials('Ada')).toBe('A');
  });

  it('drops the domain of a display name that is still an email address', () => {
    // Everyone at one institution would otherwise read the same two letters.
    expect(initials('ada@iu.edu')).toBe('A');
    expect(initials('ada.lovelace@iu.edu')).toBe('AL');
    expect(initials('ada_lovelace@iu.edu')).toBe('AL');
    expect(initials('ada-lovelace@iu.edu')).toBe('AL');
  });

  it('says nothing it cannot read', () => {
    expect(initials('')).toBe('?');
    expect(initials(null)).toBe('?');
    expect(initials('@iu.edu')).toBe('?');
  });
});
