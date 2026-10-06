// A private data write may name the version it was made from (`?version=`),
// so the server refuses it with 409 when another write landed since. The
// Python client's `user_data.put(..., version=)` sends the same.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function capture(answer) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push({ url: String(url), method: opts.method });
    return {
      ok: answer.status < 400,
      status: answer.status,
      statusText: "",
      headers: {
        get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null),
      },
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
    };
  };
  return { sent, restore: () => (globalThis.fetch = realFetch) };
}

test("put sends the version it was made from, and none when not given", async () => {
  const net = capture({ status: 200, body: { key: "k", "updated-at": "t", version: 3 } });
  try {
    const client = new PlaidClient("http://x", "tok");
    const answer = await client.userData.put("u", "a:b", { n: 1 }, { version: 2 });
    assert.equal(answer.version, 3);
    await client.userData.put("u", "a:b", { n: 1 }, { version: 0 });
    await client.userData.put("u", "a:b", { n: 1 });
    assert.deepEqual(
      net.sent.map((s) => s.url),
      [
        "http://x/api/v1/users/u/data/a%3Ab?version=2",
        "http://x/api/v1/users/u/data/a%3Ab?version=0",
        "http://x/api/v1/users/u/data/a%3Ab",
      ],
    );
  } finally {
    net.restore();
  }
});

test("a refused write carries the stored version", async () => {
  const net = capture({
    status: 409,
    body: { error: "version-mismatch", version: 5, "updated-at": "t" },
  });
  try {
    const client = new PlaidClient("http://x", "tok");
    await assert.rejects(client.userData.put("u", "k", {}, { version: 4 }), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.responseData.version, 5);
      return true;
    });
  } finally {
    net.restore();
  }
});
