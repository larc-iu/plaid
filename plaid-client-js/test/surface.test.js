// Small surface points the two clients must share (PARITY 15).

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(sent, pages = [{ entries: [], "next-cursor": null }]) {
  let i = 0;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push({ url: String(url), method: opts.method || "GET" });
    const page = pages[Math.min(i++, pages.length - 1)];
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => page,
    };
  };
}

test("a query is a read, so it takes no audit message", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  try {
    await client.query({ find: ["?t"], where: [] }, "labelled");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].url.includes("audit-message"), sent[0].url);
});

test("a vocabulary's comments page like a project's", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent, [
    { entries: [{ id: "c1" }], "next-cursor": "k" },
    { entries: [{ id: "c2" }], "next-cursor": null },
  ]);
  const pages = [];
  try {
    for await (const page of client.comments.iterInVocabPages("v1", {
      entityId: "e1",
      pageSize: 1,
    })) {
      pages.push(page.map((c) => c.id));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(pages, [["c1"], ["c2"]]);
  const first = new URL(sent[0].url);
  assert.equal(first.pathname, "/api/v1/vocab-layers/v1/comments");
  assert.equal(first.searchParams.get("entity-id"), "e1");
  assert.equal(first.searchParams.get("limit"), "1");
  assert.equal(new URL(sent[1].url).searchParams.get("cursor"), "k");
});
