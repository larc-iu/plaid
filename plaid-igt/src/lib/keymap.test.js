import { describe, it, expect } from 'vitest';
import { createKeymap } from '@ui/lib/keymap.js';
import { KEY_ACTIONS, KEY_GROUPS } from './keymap.js';

describe('the shortcut table', () => {
  // A default that collides with another would make one of the two dead, and
  // the settings screen would refuse to let anyone restore it.
  it('has no two defaults that would hear the same chord', () => {
    const km = createKeymap(KEY_ACTIONS);
    const clashes = [];
    for (const a of km.actions) {
      if (a.fixed) continue;
      for (const chord of a.keys) {
        const found = km.check(a.id, chord);
        if (found) clashes.push(`${a.id} ${chord}: ${found.problem} ${found.with?.id ?? ''}`);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('puts every rebindable action in a group the settings screen draws', () => {
    const groups = new Set(KEY_GROUPS.map((g) => g.id));
    const stray = KEY_ACTIONS.filter((a) => !a.fixed && !groups.has(a.group)).map((a) => a.id);
    expect(stray).toEqual([]);
  });
});
