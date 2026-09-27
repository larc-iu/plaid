// A batch over MAX_BATCH_OPS goes as consecutive requests (see submitBatch).
// These pin what each request carries and what the caller gets back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient, MAX_BATCH_OPS } from "../src/index.js";

const versionOf = (path) =>
  new URL(path, "http://x").searchParams.get("document-version");

// Answers each batch POST as the server does: one result per op, and each
// result's X-Document-Versions header says the version after that op (every
// op bumps the document once). Records the ops each request carried.
function stubBatchServer(start) {
  const requests = [];
  let version = start;
  globalThis.fetch = async (url, opts = {}) => {
    const ops = JSON.parse(opts.body);
    requests.push(ops);
    const results = ops.map(() => {
      version += 1;
      return {
        status: 200,
        headers: {
          "X-Document-Versions": JSON.stringify({ d1: version }),
          "Content-Type": "application/json",
        },
        body: { "token/id": "t1", "token/begin": 0, "document/version": version },
      };
    });
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => results,
    };
  };
  return requests;
}

test("a strict-mode batch past the cap claims, on each later request, the version the one before it left", async () => {
  const client = new PlaidClient("http://x", "tok");
  client.enterStrictMode("d1");
  client.documentVersions = { d1: 21 };
  const realFetch = globalThis.fetch;
  const requests = stubBatchServer(21);
  try {
    const b = client.batch();
    for (let i = 0; i < MAX_BATCH_OPS + 1; i += 1) {
      b.tokens.patchMetadata(`t${i}`, [{ op: "set", path: ["k"], value: i }]);
    }
    const results = await b.submit();
    assert.equal(results.length, MAX_BATCH_OPS + 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(requests.length, 2);
  assert.ok(requests[0].every((op) => versionOf(op.path) === "21"));
  // The first request bumped the document once per op, so the second must
  // claim what the first left, not what the document had at queue time.
  assert.deepEqual(
    requests[1].map((op) => versionOf(op.path)),
    [String(21 + MAX_BATCH_OPS)],
  );
  assert.equal(client.documentVersions.d1, 22 + MAX_BATCH_OPS);
});

test("a batch result keeps its status and headers as the server sent them, and only its body is recased", async () => {
  const client = new PlaidClient("http://x", "tok");
  const realFetch = globalThis.fetch;
  stubBatchServer(1);
  let results;
  try {
    const b = client.batch();
    b.tokens.delete("t1");
    results = await b.submit();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(Object.keys(results[0].headers).sort(), [
    "Content-Type",
    "X-Document-Versions",
  ]);
  assert.deepEqual(results[0].body, { id: "t1", begin: 0, version: 2 });
  assert.equal(results[0].status, 200);
});

test("a batch refused 401 calls onAuthError, as every other request does", async () => {
  const seen = [];
  const client = new PlaidClient("http://x", "tok", {
    onAuthError: (e) => seen.push(e.status),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    headers: { get: () => "application/json" },
    json: async () => ({ error: "Invalid token" }),
    text: async () => "",
  });
  try {
    const b = client.batch();
    b.tokens.delete("t1");
    await assert.rejects(b.submit(), (e) => e.status === 401);
    const b2 = client.batch();
    b2.tokens.delete("t2");
    await assert.rejects(b2.submit(), (e) => e.status === 401);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(seen, [401], "fired once per client, like makeRequest");
});
