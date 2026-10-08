// A user id is an email address, stored trimmed and lowercased. The client
// sends it that way from login, invite redemption and account creation, and
// exports the rule for apps that compare a typed address with an id. The
// Python twin (tests/test_user_id_case.py) sends the same bodies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient, normalizeUserId } from "../src/index.js";

async function bodiesOf(fn) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push(JSON.parse(opts.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ token: "t" }),
      text: async () => '{"token":"t"}',
    };
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

test("normalizeUserId trims and lowercases", () => {
  assert.equal(normalizeUserId("  Ana@Example.ORG "), "ana@example.org");
  assert.equal(normalizeUserId(undefined), undefined);
});

test("login sends the lowercased id", async () => {
  const sent = await bodiesOf(() =>
    PlaidClient.login("http://x", " Ana@Example.org", "pw"),
  );
  assert.deepEqual(sent, [{ "user-id": "ana@example.org", password: "pw" }]);
});

test("a signup redemption sends the lowercased email", async () => {
  const sent = await bodiesOf(() =>
    PlaidClient.redeemInvite("http://x", "CODE", {
      email: "ANA@example.org ",
      password: "pw",
    }),
  );
  assert.deepEqual(sent, [
    { code: "CODE", email: "ana@example.org", password: "pw" },
  ]);
});

test("a reset redemption still sends no email", async () => {
  const sent = await bodiesOf(() =>
    PlaidClient.redeemInvite("http://x", "CODE", { password: "pw" }),
  );
  assert.deepEqual(sent, [{ code: "CODE", password: "pw" }]);
});

test("users.create sends the lowercased email", async () => {
  const sent = await bodiesOf(() =>
    new PlaidClient("http://x", "tok").users.create("Ana@Example.org", "pw", false),
  );
  assert.deepEqual(sent, [
    { email: "ana@example.org", password: "pw", "is-admin": false },
  ]);
});
