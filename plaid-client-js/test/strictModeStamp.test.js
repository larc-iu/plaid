// Strict mode stamps `?document-version=` on writes. Inside a batch it stamps
// the FIRST QUEUED write only, which gives the whole batch one OCC check.
//
// The bug this guards: the stamp block runs above the batch branch and used to
// mark the batch stamped for any non-GET that reached it, including a call
// carrying `bypassBatch`. `query` is a POST, and app chrome runs one while
// someone else's batch is open, so the batch's one stamp was spent on a route
// that does not check it and the first real write went out unguarded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(record) {
  globalThis.fetch = async (url, opts = {}) => {
    record.push({ url: String(url), method: opts.method || "GET" });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => ({ entries: [], "next-cursor": null }),
      text: async () => "{}",
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

function strictClient() {
  const client = new PlaidClient("http://x", "tok");
  client.enterStrictMode("d1");
  client.documentVersions = { d1: 7 };
  return client;
}

const versionOf = (path) =>
  new URL(path, "http://x").searchParams.get("document-version");

test("a bypassing call does not spend the batch's stamp", async () => {
  const client = strictClient();
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();
  let queued;
  try {
    await client.query({ find: ["?t"], where: [] });
    await client.spans.update("s1", "NOUN");
  } finally {
    queued = [...client.batchOperations];
    client.abortBatch();
    globalThis.fetch = realFetch;
  }

  assert.equal(sent.length, 1, "the query went over the wire on its own");
  assert.deepEqual(
    queued.map((op) => versionOf(op.path)),
    ["7"],
    "the first queued write must carry the document version",
  );
});

test("the first queued write takes the stamp and the rest go without", async () => {
  const client = strictClient();
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();
  let queued;
  try {
    await client.spans.update("s1", "NOUN");
    await client.spans.update("s2", "VERB");
    await client.relations.delete("r1");
  } finally {
    queued = [...client.batchOperations];
    client.abortBatch();
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(
    queued.map((op) => versionOf(op.path)),
    ["7", null, null],
  );
});

test("a write outside a batch always carries the stamp", async () => {
  const client = strictClient();
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  try {
    await client.spans.update("s1", "NOUN");
    await client.spans.update("s2", "VERB");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(
    sent.map((req) => versionOf(req.url)),
    ["7", "7"],
  );
});
