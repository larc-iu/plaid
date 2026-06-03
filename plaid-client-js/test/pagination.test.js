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
// Pass `{ isBatching: true }` to simulate the client being inside a batch.
function makeFakeClient(pages, { isBatching = false } = {}) {
  let i = 0;
  return {
    calls: [],
    isBatching,
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

test('listAll returns [] for an empty envelope', async () => {
  const client = makeFakeClient([{ entries: [], nextCursor: null }]);

  const all = await listAll(client, '/api/v1/things');

  assert.deepEqual(all, []);
  assert.equal(client.calls.length, 1);
});

test('listAll throws when the client is in batch mode (no request made)', async () => {
  // Auto-pagination follows cursors across multiple requests, which a batch
  // cannot do, so listAll must fail loudly before issuing any request.
  const client = makeFakeClient([], { isBatching: true });

  await assert.rejects(
    () => listAll(client, '/api/v1/things'),
    /Cannot auto-paginate \/api\/v1\/things inside a batch/,
  );
  assert.equal(client.calls.length, 0, 'no request was queued');
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

test('iterPages throws when the client is in batch mode (on first iteration)', async () => {
  const client = makeFakeClient([], { isBatching: true });

  await assert.rejects(async () => {
    // The throw surfaces on the first iteration of the async generator.
    for await (const _page of iterPages(client, '/api/v1/things')) {
      // unreachable
    }
  }, /Cannot auto-paginate \/api\/v1\/things inside a batch/);
  assert.equal(client.calls.length, 0, 'no request was queued');
});

test('listPage still issues a single request in batch mode (does not throw)', async () => {
  // listPage is a single request and CAN batch; it must keep working — the
  // request layer returns the {batched:true} sentinel, which listPage passes
  // straight through.
  const client = makeFakeClient([{ batched: true }], { isBatching: true });

  const result = await listPage(client, '/api/v1/things');

  assert.deepEqual(result, { batched: true });
  assert.equal(client.calls.length, 1, 'exactly one request queued');
});
