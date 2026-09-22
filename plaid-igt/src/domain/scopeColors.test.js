import { describe, it, expect } from 'vitest';
import { SCOPE_TINTS, scopeBadgeClass, scopeTextClass } from './scopeColors.js';

// Colour means scope. Six screens drew that table from memory, so one of them
// being a shade off was a matter of time, and a badge in the wrong colour
// says the wrong thing about the annotation under it.

describe('scope colours', () => {
  it('answers to a scope however it is written', () => {
    expect(scopeBadgeClass('Word')).toBe(scopeBadgeClass('word'));
    expect(scopeTextClass('Morpheme')).toBe(scopeTextClass('morpheme'));
  });

  it('wears nothing for a scope it does not know', () => {
    expect(scopeBadgeClass('Orthography')).toBe('');
    expect(scopeBadgeClass(null)).toBe('');
    expect(scopeTextClass(undefined)).toBe('');
  });

  it('gives the badge and the text the same colour', () => {
    for (const [scope, tint] of Object.entries(SCOPE_TINTS)) {
      expect(scopeBadgeClass(scope)).toBe(`border-transparent bg-${tint}-100 text-${tint}-700`);
      expect(scopeTextClass(scope)).toBe(`text-${tint}-700`);
    }
  });

  it('gives no two scopes the same colour', () => {
    const tints = Object.values(SCOPE_TINTS);
    expect(new Set(tints).size).toBe(tints.length);
  });
});
