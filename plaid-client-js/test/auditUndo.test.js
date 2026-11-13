// Undo one audit entry. What each call sends is in fixtures/requests.json.
// Here: what the answer becomes, recased as every answer is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stub(body) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: new URL(String(url)), method: opts.method });
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
