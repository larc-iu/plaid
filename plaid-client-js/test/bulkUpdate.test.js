// spans/relations/tokens bulkUpdate: one PATCH to the /bulk path, and the
// versions of EVERY document the update touched come back in
// X-Document-Versions. A bulk update may reach several documents of one
// project, and a client that learned only the first one's version writes the
// rest with a stale one, which strict mode then refuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(versions) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) => {
          const name = String(n).toLowerCase();
          if (name === "content-type") return "application/json";
          if (name === "x-document-versions") return JSON.stringify(versions);
          return null;
        },
      },
      json: async () => ({ count: 2 }),
      text: async () => "",
    };
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("a span bulk update is one PATCH carrying the entries as sent", async () => {
  // The metadata ops pass through verbatim: keys inside a value are user data
  // and are never re-cased.
  const ops = [
    { op: "set", path: ["prov"], value: "inferred" },
    { op: "set", path: ["provDetail", "valueProbs"], value: { someLabel: 0.9 } },
  ];
  const client = new PlaidClient("http://plaid.test", "tok");
  const { calls, restore } = stubFetch({ d1: 8 });
  try {
    const result = await client.spans.bulkUpdate([
      { id: "s1", value: "NOUN", metadata: ops },
      { id: "s2", value: null },
    ]);
    assert.deepEqual(result, { count: 2 });
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PATCH");
  assert.ok(calls[0].url.endsWith("/api/v1/spans/bulk"), calls[0].url);
  assert.deepEqual(calls[0].body, [
    { id: "s1", value: "NOUN", metadata: ops },
    { id: "s2", value: null },
  ]);
});

test("every document in the header is learned, not just the first", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  const { restore } = stubFetch({ d1: 8, d2: 3 });
  try {
    await client.spans.bulkUpdate([
      { id: "s1", value: "X" },
      { id: "s2", value: "Y" },
    ]);
  } finally {
    restore();
  }
  assert.deepEqual(client.documentVersions, { d1: 8, d2: 3 });
});

test("relations and tokens take the same round trip", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  const { calls, restore } = stubFetch({ d1: 9, d2: 4 });
  try {
    await client.relations.bulkUpdate([{ id: "r1", value: "nsubj" }]);
    await client.tokens.bulkUpdate([
      { id: "t1", metadata: [{ op: "set", path: ["form"], value: "cd" }] },
    ]);
  } finally {
    restore();
  }
  assert.ok(calls[0].url.endsWith("/api/v1/relations/bulk"), calls[0].url);
  assert.equal(calls[0].method, "PATCH");
  assert.ok(calls[1].url.endsWith("/api/v1/tokens/bulk"), calls[1].url);
  assert.equal(calls[1].method, "PATCH");
  assert.deepEqual(client.documentVersions, { d1: 9, d2: 4 });
});
