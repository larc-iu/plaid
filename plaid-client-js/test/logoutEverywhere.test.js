// auth.logoutEverywhere ends every sign-in of the user on every device
// (POST /logout). It is a signal on the user's sign-ins, not project data: it
// goes over the wire even when made on a batch, and never joins an operation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stub(sent) {
  globalThis.fetch = async (url, opts = {}) => {
    sent.push({
      url: String(url),
      method: opts.method,
      auth: opts.headers?.Authorization,
    });
    return {
      ok: true,
      status: 204,
      headers: { get: () => null },
      json: async () => {
        throw new SyntaxError("no body");
      },
      text: async () => "",
    };
  };
}

test("logoutEverywhere posts /logout with this client's sign-in", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stub(sent);
  try {
    await client.auth.logoutEverywhere();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent, [
    { url: "http://x/api/v1/logout", method: "POST", auth: "Bearer tok" },
  ]);
});

test("logoutEverywhere made on a batch or inside an operation goes out at once, unstamped", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stub(sent);
  try {
    client.beginOperation("Tidy");
    const b = client.batch();
    await b.auth.logoutEverywhere();
    assert.equal(b.operations.length, 0);
    b.abort();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://x/api/v1/logout");
  assert.equal(client.operationGroup.written, false);
});
