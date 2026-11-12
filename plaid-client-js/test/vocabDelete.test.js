// vocabLayers.delete: the refusal while another project borrows the
// vocabulary keeps core's count on the error (what a delete would remove:
// destructiveReads.test.js). The same as plaid-client-py's
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

test("a delete takes no project to keep: the option throws and nothing is sent", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  const { seen, restore } = stubFetch(204, null);
  try {
    assert.throws(() => client.vocabLayers.delete("v1", undefined, { onlyInProject: "p1" }), TypeError);
  } finally {
    restore();
  }
  assert.equal(seen.length, 0);
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
