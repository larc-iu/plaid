// Discovery says who runs each connected service and whether it would take the
// caller's requests, recased like every other key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

test("discoverServices hands back runnerName, runByYou and servesYou", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => [
      {
        "service-id": "igt:assistant",
        "service-name": "Assistant",
        description: "",
        extras: { delegation: true },
        online: true,
        "runner-name": "Ana",
        "run-by-you": false,
        "serves-you": true,
      },
    ],
  });
  let found;
  try {
    found = await new PlaidClient("http://x", "tok").messages.discoverServices("p1");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(found[0].runnerName, "Ana");
  assert.equal(found[0].runByYou, false);
  assert.equal(found[0].servesYou, true);
});
