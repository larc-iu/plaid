// A layer rule's remedy runs at the end of a batch, after its last operation,
// and moves the version of the document it repaired once more. No operation's
// answer holds that version, only the batch's own X-Document-Versions header.
// A strict-mode client that missed it had its next write refused with a 409
// (a sentence split that deleted a relation crossing the new boundary, then a
// second split).

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

const versionOf = (path) =>
  new URL(path, "http://x").searchParams.get("document-version");

function stubServer(outer, sent) {
  globalThis.fetch = async (url, opts = {}) => {
    const ops = JSON.parse(opts.body);
    sent.push(ops);
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k) =>
          k === "X-Document-Versions" ? JSON.stringify(outer) : k === "content-type" ? "application/json" : null,
      },
      json: async () =>
        ops.map(() => ({
          status: 200,
          headers: { "X-Document-Versions": JSON.stringify({ d1: 21 }) },
          body: { "token/id": "t1" },
        })),
    };
  };
}

test("a batch's own versions header, read after its operations', is the version the next write claims", async () => {
  const client = new PlaidClient("http://x", "tok");
  client.enterStrictMode("d1");
  client.documentVersions = { d1: 20 };
  const realFetch = globalThis.fetch;
  const sent = [];
  stubServer({ d1: 22 }, sent);
  try {
    await client.batched((b) => {
      b.tokens.split("s1", 11);
    });
    assert.equal(client.documentVersions.d1, 22);
    await client.batched((b) => {
      b.tokens.split("s2", 19);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(versionOf(sent[0][0].path), "20");
  assert.equal(versionOf(sent[1][0].path), "22");
});
