/**
 * Regression tests for the cursor-pagination helpers.
 *
 * The auto-cursor-follow loop in `listAll` is exactly what caused a prior
 * production revert (silent truncation at page 1), so these tests prove the
 * full set is returned across multiple pages, that the cursor is threaded, and
 * that the safety guards behave.
 *
 * Uses Node's built-in test runner — no new dependencies. Run with `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listAll, listPage, iterPages } from '../src/pagination.js';

// A fake client whose `_request` returns scripted envelopes in sequence. It
// records every call so we can assert the cursor was threaded correctly.
function makeFakeClient(pages) {
  let i = 0;
  return {
    calls: [],
    async _request(method, path, options = {}) {
      const cursor = options.queryParams ? options.queryParams.cursor : undefined;
      this.calls.push({ method, path, cursor });
      if (i >= pages.length) {
        throw new Error(`unexpected extra request (call #${this.calls.length})`);
      }
      return pages[i++];
    },
  };
}

// The canonical 3-page envelope sequence used across the happy-path tests.
function threePageSequence() {
  return [
    { entries: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' },
    { entries: [{ id: 'c' }, { id: 'd' }], nextCursor: 'c2' },
    { entries: [{ id: 'e' }], nextCursor: null },
  ];
}

test('listAll returns the full set across 3 pages, threading the cursor', async () => {
  const client = makeFakeClient(threePageSequence());

  const all = await listAll(client, '/api/v1/things');

  assert.deepEqual(
    all.map((x) => x.id),
    ['a', 'b', 'c', 'd', 'e'],
    'all 5 entries returned in order',
  );
  assert.equal(client.calls.length, 3, 'exactly 3 requests made');
  assert.deepEqual(
    // The first page carries no cursor (buildQueryParams drops null/undefined),
    // so it arrives as `undefined`; subsequent pages thread the prior cursor.
    client.calls.map((c) => c.cursor),
    [undefined, 'c1', 'c2'],
    'cursor threaded across pages (first page sends no cursor)',
  );
});

test('listAll throws when the cursor does not advance', async () => {
  // Buggy server: same non-null cursor forever.
  const client = makeFakeClient([
    { entries: [{ id: 'a' }], nextCursor: 'stuck' },
    { entries: [{ id: 'b' }], nextCursor: 'stuck' },
  ]);

  await assert.rejects(
    () => listAll(client, '/api/v1/things'),
    /did not advance/,
  );
});

// Every collection endpoint answers with the envelope, so a bare array is a
// broken endpoint. Absorbing it as a terminal full page is how a listing gets
// silently truncated, which is what caused the pagination revert once already.
test('listAll rejects a bare array, naming the endpoint', async () => {
  const client = makeFakeClient([[{ id: 'a' }, { id: 'b' }]]);

  await assert.rejects(
    () => listAll(client, '/api/v1/things'),
    /GET \/api\/v1\/things did not return a paginated envelope/,
  );
});

test('iterPages rejects a bare array, naming the endpoint', async () => {
  const client = makeFakeClient([[{ id: 'a' }]]);

  await assert.rejects(async () => {
    // eslint-disable-next-line no-unused-vars
    for await (const _page of iterPages(client, '/api/v1/things')) break;
  }, /GET \/api\/v1\/things did not return a paginated envelope/);
});

test('listAll returns [] for an empty envelope', async () => {
  const client = makeFakeClient([{ entries: [], nextCursor: null }]);

  const all = await listAll(client, '/api/v1/things');

  assert.deepEqual(all, []);
  assert.equal(client.calls.length, 1);
});

test('iterPages yields each non-empty page in order', async () => {
  const client = makeFakeClient(threePageSequence());

  const pages = [];
  for await (const page of iterPages(client, '/api/v1/things')) {
    pages.push(page.map((x) => x.id));
  }

  assert.deepEqual(pages, [['a', 'b'], ['c', 'd'], ['e']]);
});

test('iterPages suppresses a trailing empty page', async () => {
  // Collection size is an exact multiple of the page size: a final full page
  // with a non-null cursor, then an empty page with a null cursor.
  const client = makeFakeClient([
    { entries: [{ id: 'a' }, { id: 'b' }], nextCursor: 'c1' },
    { entries: [], nextCursor: null },
  ]);

  const pages = [];
  for await (const page of iterPages(client, '/api/v1/things')) {
    pages.push(page.map((x) => x.id));
  }

  assert.deepEqual(pages, [['a', 'b']], 'the trailing empty page is not yielded');
  assert.equal(client.calls.length, 2, 'but the cursor was still followed');
});

