// Strict mode stamps `?document-version=` on writes. On a batch it stamps the
// FIRST QUEUED write only, which gives the whole batch one OCC check.
//
// The bug this guards: the stamp used to be spent by any non-GET that reached
// the request layer while a batch was open, including a call that went over
// the wire on its own. `query` is a POST, and app chrome runs one while
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

test("a call that goes over the wire on its own does not spend the batch's stamp", async () => {
  const client = strictClient();
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  const b = client.batch();
  try {
    await b.query({ find: ["?t"], where: [] });
    await client.spans.update("s0", "ADJ");
    await b.spans.update("s1", "NOUN");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(sent.length, 2, "the query and the client's write went over the wire");
  assert.deepEqual(
    b.operations.map((op) => versionOf(op.path)),
    ["7"],
    "the queued write must carry the document version",
  );
  b.abort();
});

test("every queued write carries the stamp", async () => {
  // The server validates the first write whose route names a document and
  // skips the rest of that document's, so the bump a sub-op causes does not
  // refuse the next one. Stamping the first write alone was no check at all
  // whenever that write was one its route ignores, such as a vocabulary
  // entry's metadata.
  const client = strictClient();
  const b = client.batch();
  await b.spans.update("s1", "NOUN");
  await b.spans.update("s2", "VERB");
  await b.relations.delete("r1");
  assert.deepEqual(
    b.operations.map((op) => versionOf(op.path)),
    ["7", "7", "7"],
  );
  b.abort();
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
