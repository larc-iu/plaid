// vocabItems.merge and vocabItems.delete's expectedLinkCount, as queued in a
// batch (exactly the request that would go out). The server's side is
// plaid-core's vocab-item-merge-test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function queued(fn) {
  const client = new PlaidClient("http://localhost:0", "dummy-token");
  const b = client.batch();
  fn(b);
  const ops = b.operations.map((op) => ({ ...op }));
  b.abort();
  return ops;
}

test("merge posts the losers to the survivor's merge route", () => {
  const [op] = queued((b) => b.vocabItems.merge("S", ["L1", "L2"], "Merge"));
  assert.equal(op.method, "POST");
  assert.ok(op.path.startsWith("/api/v1/vocab-items/S/merge"), op.path);
  assert.ok(op.path.includes("audit-message=Merge"));
  assert.deepEqual(op.body, { losers: ["L1", "L2"] });
});

test("delete sends expected-link-count only when given, zero included", () => {
  const [plain, zero, two] = queued((b) => {
    b.vocabItems.delete("I");
    b.vocabItems.delete("I", undefined, { expectedLinkCount: 0 });
    b.vocabItems.delete("I", undefined, { expectedLinkCount: 2 });
  });
  assert.ok(!plain.path.includes("expected-link-count"));
  assert.ok(zero.path.includes("expected-link-count=0"), zero.path);
  assert.ok(two.path.includes("expected-link-count=2"), two.path);
});
