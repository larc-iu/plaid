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

// The undo's dry run, and each attempt a misfit ends, roll back inside the
// undo's own transaction. A keyed write runs inside an outer one that commits
// with its stored answer, which would keep what they rolled back: a dry run
// sent with a key wrote the undo. So it goes out with none, and no batch can
// carry it.
test("an undo goes out with no Idempotency-Key, dry or not", async () => {
  const { sent, restore } = stub({ entry: "e1", total: 0, skipped: [] });
  try {
    const client = new PlaidClient("http://x", "tok");
    await client.audit.undo("e1", { dryRun: true, documentId: "d1" });
    await client.audit.undo("e1");
    assert.equal(sent.length, 2);
    for (const s of sent) assert.equal(s.headers.get("Idempotency-Key"), null);
  } finally {
    restore();
  }
});
