// A config write that names the value it read is a compare-and-set:
// `?if-unchanged=true` with the body `{expected, value}`. The server's side is
// plaid-core's config-compare-and-set-test, and the request each bundle sends
// is in fixtures/requests.json. This is the case JSON cannot hold: a batch
// queues the op exactly as it would go out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

test("an expected key that is present but undefined means the key was absent", () => {
  const b = new PlaidClient("http://localhost:0", "dummy-token").batch();
  b.projects.setConfig("P1", "igt", "languages", { object: "Lezgian" }, undefined, {
    expected: undefined,
  });
  const [op] = b.operations.map((o) => ({ ...o }));
  b.abort();
  assert.ok(op.path.includes("if-unchanged=true"));
  assert.deepEqual(op.body, { expected: null, value: { object: "Lezgian" } });
});
