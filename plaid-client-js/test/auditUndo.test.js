// Undo one audit entry. What each call sends is in fixtures/requests.json.
// Here: what the answer becomes, recased as every answer is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stub(body) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: new URL(String(url)), method: opts.method, headers: new Headers(opts.headers) });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { sent, restore: () => (globalThis.fetch = real) };
}

const counts = { inserted: 0, updated: 1, deleted: 2 };

test("an undo's summary is recased, its skipped rows with the row each names", async () => {
  const { sent, restore } = stub({
    entry: "e1",
    "dry-run": false,
    undone: { documents: counts, "vocab-links": counts, "vocab-items": counts },
    total: 3,
    rows: 5,
    skipped: [
      { kind: "token", id: "t1", document: "d1", reason: "built-on", by: { kind: "span", id: "s1" } },
      { kind: "vocab-item", id: "i1", "vocab-layer": "v1", reason: "needs", needs: { kind: "vocab-layer", id: "v1" } },
    ],
    "skipped-count": 2,
    "not-undone": [{ "op-type": "span-layer/update", count: 1 }],
    operation: "o1",
  });
  try {
    const got = await new PlaidClient("http://x", "tok").audit.undo("e1");
    assert.equal(sent[0].method, "POST");
    assert.deepEqual(got, {
      entry: "e1",
      dryRun: false,
      undone: { documents: counts, vocabLinks: counts, vocabItems: counts },
      total: 3,
      rows: 5,
      skipped: [
        { kind: "token", id: "t1", document: "d1", reason: "built-on", by: { kind: "span", id: "s1" } },
        { kind: "vocab-item", id: "i1", vocabLayer: "v1", reason: "needs", needs: { kind: "vocab-layer", id: "v1" } },
      ],
      skippedCount: 2,
      notUndone: [{ opType: "span-layer/update", count: 1 }],
      operation: "o1",
    });
  } finally {
    restore();
  }
});

// An undo holds the write lock for its whole run, as a batch does, and may
// take longer than one request's timeout. It goes out under an
// Idempotency-Key, a key of its own for the dry run and for the real call,
// so a lost answer is sent again and the stored answer comes back, and it
// waits as long as a batch.
test("an undo goes out keyed, a key each, and waits as long as a batch", async () => {
  const { sent, restore } = stub({ entry: "e1", total: 0, skipped: [] });
  const realTimeout = AbortSignal.timeout;
  const waits = [];
  AbortSignal.timeout = (ms) => {
    waits.push(ms);
    return realTimeout.call(AbortSignal, ms);
  };
  try {
    const client = new PlaidClient("http://x", "tok", { timeout: 30000, batchTimeout: 180000 });
    await client.audit.undo("e1", { dryRun: true, documentId: "d1" });
    await client.audit.undo("e1");
    assert.equal(sent.length, 2);
    const keys = sent.map((s) => s.headers.get("Idempotency-Key"));
    assert.ok(keys[0] && keys[1]);
    assert.notEqual(keys[0], keys[1]);
    assert.deepEqual(waits, [180000, 180000]);
  } finally {
    AbortSignal.timeout = realTimeout;
    restore();
  }
});

test("an undo whose answer was lost is sent again under its key", async () => {
  const real = globalThis.fetch;
  const keys = [];
  globalThis.fetch = async (url, opts) => {
    keys.push(new Headers(opts.headers).get("Idempotency-Key"));
    if (keys.length === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ entry: "e1", total: 3, operation: "o1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const client = new PlaidClient("http://x", "tok", { retryDelaysMs: [0, 0, 0] });
    const got = await client.audit.undo("e1", { documentId: "d1" });
    assert.equal(got.operation, "o1");
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  } finally {
    globalThis.fetch = real;
  }
});

// An undo is an entry of its own. Sent while the page has a logical operation
// open, it does not join it: no group stamp, and a key that is not one of the
// operation's.
test("an undo never joins an open logical operation", async () => {
  const { sent, restore } = stub({ entry: "e1", total: 1, operation: "o1" });
  try {
    const client = new PlaidClient("http://x", "tok");
    await client.withOperation("Edit", async () => {
      await client.audit.undo("e1", { documentId: "d1" });
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url.searchParams.has("group-id"), false);
    assert.ok(sent[0].headers.get("Idempotency-Key"));
  } finally {
    restore();
  }
});
