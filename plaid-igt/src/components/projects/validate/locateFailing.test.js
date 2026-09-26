import { describe, it, expect } from 'vitest';
import { listedCount, locateFailing } from './locateFailing.js';
import { GLOSS_DOMAIN, MIXED, hitsClient } from './cellReadingFixture.js';

const g = { kind: 'span', tagset: MIXED, domain: GLOSS_DOMAIN };
const project = { id: 'p-1', vocabs: [] };

describe('locateFailing', () => {
  it('counts the occurrences it looked at and let pass', async () => {
    const res = await locateFailing(hitsClient(), project, null, g, 'sbj:3.pfv');
    expect(res.passed).toBe(1);
    expect(listedCount(res)).toBe(2);
  });
});

describe('listedCount', () => {
  const group = (docHits, capped = false) => ({ docHits, capped, rows: [] });
  it('is the listed hits when every document was loaded in full', () => {
    expect(listedCount({ passed: 0, remainingDocs: 0, groups: [group(2), group(1)] })).toBe(3);
    expect(listedCount({ passed: 4, remainingDocs: 0, groups: [] })).toBe(0);
  });
  it('is null when some are not listed, or nothing was judged', () => {
    expect(listedCount({ passed: 0, remainingDocs: 1, groups: [group(2)] })).toBeNull();
    expect(listedCount({ passed: 0, remainingDocs: 0, groups: [group(2, true)] })).toBeNull();
    expect(listedCount({ remainingDocs: 0, groups: [group(2)] })).toBeNull();
    expect(listedCount({ failed: true, groups: [] })).toBeNull();
    expect(listedCount(undefined)).toBeNull();
  });
});
