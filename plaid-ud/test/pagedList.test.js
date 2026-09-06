// The paging math behind every browsable list. Uses Node's built-in test
// runner — run `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pageSlice } from '../src/hooks/usePagedList.js';

const items = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('a page carries its slice and the range it covers', () => {
  const p = pageSlice(items(250), 1, 100);
  assert.equal(p.pageItems.length, 100);
  assert.equal(p.pageItems[0], 101);
  assert.equal(p.rangeStart, 101);
  assert.equal(p.rangeEnd, 200);
  assert.equal(p.pageCount, 3);
  assert.equal(p.total, 250);
});

test('the last page is short, and its range stops at the total', () => {
  const p = pageSlice(items(250), 2, 100);
  assert.equal(p.pageItems.length, 50);
  assert.equal(p.rangeStart, 201);
  assert.equal(p.rangeEnd, 250);
});

test('a page past the end falls back onto the last one', () => {
  // A list that shrinks under the reader (a delete, a narrowed search) must
  // land on real rows rather than render empty.
  const p = pageSlice(items(12), 9, 10);
  assert.equal(p.page, 1);
  assert.deepEqual(p.pageItems, [11, 12]);
  assert.equal(p.rangeStart, 11);
  assert.equal(p.rangeEnd, 12);
});

test('a negative page is clamped to the first', () => {
  const p = pageSlice(items(12), -3, 10);
  assert.equal(p.page, 0);
  assert.equal(p.pageItems[0], 1);
});

test('an empty list is one page with an empty range', () => {
  const p = pageSlice([], 0, 100);
  assert.deepEqual(p.pageItems, []);
  assert.equal(p.pageCount, 1);
  assert.equal(p.total, 0);
  assert.equal(p.rangeStart, 0);
  assert.equal(p.rangeEnd, 0);
});

test('a list that fits on one page reports a single page', () => {
  // What <ListPager> reads to decide it should not render at all.
  const p = pageSlice(items(100), 0, 100);
  assert.equal(p.pageCount, 1);
  assert.equal(p.rangeEnd, 100);
});
