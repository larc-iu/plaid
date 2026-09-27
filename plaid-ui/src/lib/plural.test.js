import { describe, expect, it } from 'vitest';
import { plural } from './plural.js';

describe('plural', () => {
  it('adds s, or ies after a consonant and y', () => {
    expect(plural(2, 'project')).toBe('projects');
    expect(plural(2, 'entry')).toBe('entries');
    expect(plural(2, 'vocabulary')).toBe('vocabularies');
    expect(plural(2, 'day')).toBe('days');
    expect(plural(1, 'entry')).toBe('entry');
  });

  it('takes an irregular plural from the pair it is given', () => {
    expect(plural(1, ['person', 'people'])).toBe('person');
    expect(plural(0, ['person', 'people'])).toBe('people');
    expect(plural(3, ['address', 'addresses'])).toBe('addresses');
  });
});
