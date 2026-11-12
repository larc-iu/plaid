// vocabLayers.delete: a dry run sends dry-run=true and answers the links the
// delete would remove, and the refusal while another project borrows the
// vocabulary keeps core's count on the error. The same as plaid-client-py's
// tests/test_vocab_delete.py.

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

test("a dry run asks with dry-run=true and answers the links", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  const { seen, restore } = stubFetch(200, { links: 14 });
  try {
    const res = await client.vocabLayers.delete("v1", undefined, { dryRun: true });
    assert.deepEqual(res, { links: 14 });
  } finally {
    restore();
  }
  assert.equal(seen[0].method, "DELETE");
  const query = new URL(seen[0].url).searchParams;
  assert.equal(query.get("dry-run"), "true");
  assert.deepEqual([...query.keys()], ["dry-run"]);
});

test("a delete takes no project to keep", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  const { seen, restore } = stubFetch(204, null);
  try {
    await client.vocabLayers.delete("v1", undefined, { onlyInProject: "p1" });
  } finally {
    restore();
  }
  assert.equal(new URL(seen[0].url).searchParams.get("only-in-project"), null);
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
