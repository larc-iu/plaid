import { describe, it, expect } from 'vitest';
import { elanTally, replacedGoneLine } from './tally.js';

const zero = {
  imported: 0,
  redone: 0,
  copied: 0,
  skipped: 0,
  recordingsAdded: 0,
  recordingsUnused: 0,
};

// The toast said "Added 1 document." for a run that replaced one, while the
// panel said "0 added, 1 replaced". Both now read this line.
describe('elanTally', () => {
  it('counts a replaced document once, as replaced', () => {
    expect(elanTally({ ...zero, imported: 1, redone: 1 })).toBe('0 added, 1 replaced.');
  });

  it('says what was kept and where a recording went', () => {
    expect(elanTally({ ...zero, skipped: 1, recordingsAdded: 1 })).toBe(
      '0 added, 1 kept, a recording added to an existing document.',
    );
  });

  it('names the documents a failed run had already imported (REV-HFM-6)', () => {
    expect(elanTally({ ...zero, copied: 1, done: 1 })).toBe(
      '0 added, 1 added as a copy, 1 already imported.',
    );
  });

  it('lists every kind of result in order', () => {
    expect(
      elanTally({
        imported: 3,
        redone: 1,
        copied: 2,
        skipped: 1,
        recordingsAdded: 2,
        recordingsUnused: 1,
      }),
    ).toBe(
      '2 added, 2 added as copies, 1 kept, 1 replaced, 2 recordings added to existing documents, a recording not used.',
    );
  });
});

// REV-HFM-7: under Replace them, a run that fails after deleting the document
// it replaces says so plainly.
describe('replacedGoneLine', () => {
  it('names the deleted document and what Retry import does', () => {
    expect(replacedGoneLine('story-d')).toBe(
      '“story-d” was deleted before its replacement was written. Retry import makes it again.',
    );
  });
});
