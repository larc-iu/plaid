// vocabLayers.delete: a dry run sends dry-run=true and answers what the delete
// would remove, and the refusal while projects the caller does not maintain
// link the vocabulary keeps core's count on the error (SEAM-2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(status, body) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init?.method });
    return {
      ok: status < 300,
      status,
      statusText: status === 409 ? "Conflict" : "OK",
      headers: {
        get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null),
      },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { seen, restore: () => (globalThis.fetch = real) };
}

test("a dry run asks with dry-run=true and answers the counts", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  const { seen, restore } = stubFetch(200, { projects: 2, links: 14 });
  try {
    const res = await client.vocabLayers.delete("v1", undefined, { dryRun: true });
    assert.deepEqual(res, { projects: 2, links: 14 });
  } finally {
    restore();
  }
  assert.equal(seen[0].method, "DELETE");
  assert.equal(new URL(seen[0].url).searchParams.get("dry-run"), "true");
});

test("a refusal carries the number of other projects and its sentence", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  const body = { error: "3 other projects use this vocabulary.", "other-projects": 3 };
  const { restore } = stubFetch(409, body);
  try {
    await assert.rejects(client.vocabLayers.delete("v1"), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.responseData["other-projects"], 3);
      assert.match(err.message, /3 other projects use this vocabulary\./);
      return true;
    });
  } finally {
    restore();
  }
});
