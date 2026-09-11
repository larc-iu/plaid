// The paging math behind every browsable list in all three apps. Ported from
// plaid-ud when its own copy of the hook was retired for this one.
import { describe, it, expect } from 'vitest';
import { pageSlice } from './usePagedList.js';

const items = (n) => Array.from({ length: n }, (_, i) => i + 1);

describe('pageSlice', () => {
  it('carries a page slice and the range it covers', () => {
    const p = pageSlice(items(250), 1, 100);
    expect(p.pageItems).toHaveLength(100);
    expect(p.pageItems[0]).toBe(101);
    expect(p.rangeStart).toBe(101);
    expect(p.rangeEnd).toBe(200);
    expect(p.pageCount).toBe(3);
    expect(p.total).toBe(250);
  });

  it('stops the last page at the total', () => {
    const p = pageSlice(items(250), 2, 100);
    expect(p.pageItems).toHaveLength(50);
    expect(p.rangeStart).toBe(201);
    expect(p.rangeEnd).toBe(250);
  });

  it('falls back onto the last page when asked for one past the end', () => {
    // A list that shrinks under the reader (a delete, a narrowed search) must
    // land on real rows rather than render empty.
    const p = pageSlice(items(12), 9, 10);
    expect(p.page).toBe(1);
    expect(p.pageItems).toEqual([11, 12]);
    expect(p.rangeStart).toBe(11);
    expect(p.rangeEnd).toBe(12);
  });

  it('clamps a negative page to the first', () => {
    const p = pageSlice(items(12), -3, 10);
    expect(p.page).toBe(0);
    expect(p.pageItems[0]).toBe(1);
  });

  it('reports an empty list as one page with an empty range', () => {
    const p = pageSlice([], 0, 100);
    expect(p.pageItems).toEqual([]);
    expect(p.pageCount).toBe(1);
    expect(p.total).toBe(0);
    expect(p.rangeStart).toBe(0);
    expect(p.rangeEnd).toBe(0);
  });

  it('reports a single page for a list that fits on one', () => {
    // What <ListPager> reads to decide it should not render at all.
    const p = pageSlice(items(100), 0, 100);
    expect(p.pageCount).toBe(1);
    expect(p.rangeEnd).toBe(100);
  });
});
