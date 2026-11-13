// What one audit entry changed, row by row. What each read sends is in
// fixtures/requests.json. Here: what the answer becomes. Each image is an
// entity as a document read serves it, so it is recased as one, its metadata
// left as it was written.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stub(pages) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    sent.push(new URL(String(url)));
    const body = pages[sent.length - 1];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { sent, restore: () => (globalThis.fetch = real) };
}

const row = {
  kind: "vocab-link",
  id: "l1",
  document: "d1",
  before: {
    "vocab-link/id": "l1",
    "vocab-link/vocab-item": { "vocab-item/id": "i1", "vocab-item/layer": "v1", "vocab-item/form": "kai" },
    "vocab-link/tokens": ["t1"],
    metadata: { "prov-source": "human", provConfirmed: true },
  },
  "changed-since": false,
  "changed-between": true,
};

test("an entry's rows are recased as a document read's entities", async () => {
  const { restore } = stub([{ entries: [row], "next-cursor": null }]);
  try {
    const [got] = await new PlaidClient("http://x", "tok").audit.changes("e1");
    assert.deepEqual(got, {
      kind: "vocab-link",
      id: "l1",
      document: "d1",
      before: {
        id: "l1",
        vocabItem: { id: "i1", layer: "v1", form: "kai" },
        tokens: ["t1"],
        metadata: { "prov-source": "human", provConfirmed: true },
      },
      changedSince: false,
      changedBetween: true,
    });
  } finally {
    restore();
  }
});

test("changes follows every page, changesPage reads one", async () => {
  const { sent, restore } = stub([
    { entries: [row], "next-cursor": "c1" },
    { entries: [{ ...row, id: "l2" }], "next-cursor": null },
    { entries: [row], "next-cursor": "c1" },
  ]);
  try {
    const client = new PlaidClient("http://x", "tok");
    assert.deepEqual(
      (await client.audit.changes("e1")).map((r) => r.id),
      ["l1", "l2"],
    );
    assert.equal(sent[1].searchParams.get("cursor"), "c1");
    const page = await client.audit.changesPage("e1", { limit: 1 });
    assert.equal(page.nextCursor, "c1");
    assert.equal(page.entries.length, 1);
  } finally {
    restore();
  }
});
