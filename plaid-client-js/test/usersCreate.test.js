// users.create leaves out a display name it was not given, so core gives the
// user the local part of the email. The Python twin (users.create with no
// display_name) sends the same body.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

async function bodiesOf(fn) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 201,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => "{}",
    };
  };
  try {
    await fn(new PlaidClient("http://x", "tok"));
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

test("create without a display name leaves it out", async () => {
  const sent = await bodiesOf((c) =>
    c.users.create("ana@example.com", "pw", false),
  );
  assert.deepEqual(sent, [
    { email: "ana@example.com", password: "pw", "is-admin": false },
  ]);
});

test("create with a display name sends it", async () => {
  const sent = await bodiesOf((c) =>
    c.users.create("ana@example.com", "pw", false, "Ana"),
  );
  assert.deepEqual(sent, [
    {
      email: "ana@example.com",
      password: "pw",
      "is-admin": false,
      "display-name": "Ana",
    },
  ]);
});
