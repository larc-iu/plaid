import { describe, it, expect } from 'vitest';
import { proposeEntryRole } from './entryRole.js';

// The role a field made by hand is given, and the rule the role backfill
// (B/scripts/backfill_entry_roles.py) applies once to existing fields: the two
// agree on these names.
describe('proposeEntryRole', () => {
  it('reads the name without its suffix, case, spaces, hyphens and underscores', () => {
    const names = [
      'gloss',
      'gloss (ru)',
      'definition (ru)',
      'pos',
      'Status',
      'Source (en)',
      'Plural',
      'Gloss (free)',
      'Part of speech',
      'part_of-speech',
      'Etymology',
      'Meaning',
      'status (x)',
      'POS',
      'glosses',
    ];
    expect(names.map(proposeEntryRole)).toEqual([
      'gloss',
      'gloss',
      'definition',
      'pos',
      'status',
      null,
      null,
      'gloss',
      'pos',
      'pos',
      null,
      null,
      'status',
      'pos',
      null,
    ]);
  });
});
