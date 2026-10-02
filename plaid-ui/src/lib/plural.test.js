import { describe, expect, it } from 'vitest';
import { countOf, plural } from './plural.js';

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

// R2-DEBT-APPS-21: one count-and-noun helper for every app, localized.
describe('countOf', () => {
  it('writes the count for the locale and the noun to agree', () => {
    expect(countOf(1, 'word')).toBe('1 word');
    expect(countOf(1204, 'word')).toBe(`${(1204).toLocaleString()} words`);
    expect(countOf(2, 'entry')).toBe('2 entries');
    expect(countOf(2, 'person', 'people')).toBe('2 people');
    expect(countOf(1, 'person', 'people')).toBe('1 person');
  });
});
