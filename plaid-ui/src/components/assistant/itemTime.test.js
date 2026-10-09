import { describe, it, expect } from 'vitest';
import { itemTime } from './itemTime.js';

// Every conversation item carries when it was written (`createdAt`), so a
// reader of the record can date each turn. The service stamps what it writes,
// and the page dates an item it shows before the record has it (a message just
// sent, an answer the record could not take) the same way.

const ISO_MS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

describe('an item the page shows', () => {
  it('is dated as the service dates its own', () => {
    expect(itemTime(new Date(Date.UTC(2026, 9, 6, 1, 2, 3, 4)))).toBe('2026-10-06T01:02:03.004Z');
    expect(itemTime()).toMatch(ISO_MS);
  });
});
