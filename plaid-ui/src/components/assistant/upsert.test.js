import { describe, it, expect } from 'vitest';
import { upsert } from './jobs.js';

// The conversation list after one entry is written back. It is ordered by when
// each conversation was last written to, and the entry has to land in that
// order rather than at the top: opening a conversation re-reads its record and
// writes it back unchanged, so hoisting it reshuffled the list under the
// pointer that had just clicked a row.

const m = (id, updatedAt) => ({ id, updatedAt });
const list = [m('c3', '2026-03-01'), m('c2', '2026-02-01'), m('c1', '2026-01-01')];

describe('upsert', () => {
  it('leaves an entry where it was when its time has not changed', () => {
    expect(upsert(m('c1', '2026-01-01'))(list).map((x) => x.id)).toEqual(['c3', 'c2', 'c1']);
    expect(upsert(m('c2', '2026-02-01'))(list).map((x) => x.id)).toEqual(['c3', 'c2', 'c1']);
  });

  it('moves an entry to the top when a turn has just landed in it', () => {
    expect(upsert(m('c1', '2026-04-01'))(list).map((x) => x.id)).toEqual(['c1', 'c3', 'c2']);
  });

  it('replaces the entry rather than listing it twice', () => {
    const next = upsert({ id: 'c2', updatedAt: '2026-02-01', title: 'renamed' })(list);
    expect(next.filter((x) => x.id === 'c2')).toHaveLength(1);
    expect(next.find((x) => x.id === 'c2').title).toBe('renamed');
  });

  it('adds an entry the list has never seen', () => {
    expect(upsert(m('c4', '2026-02-15'))(list).map((x) => x.id)).toEqual(['c3', 'c4', 'c2', 'c1']);
  });
});
