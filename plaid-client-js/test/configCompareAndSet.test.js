// A config write that names the value it read is a compare-and-set:
// `?if-unchanged=true` with the body `{expected, value}`. The server's side is
// plaid-core's config-compare-and-set-test. These are the network-free paths:
// a batch queues the op exactly as it would go out.

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

const BUNDLES = [
  "projects",
  "textLayers",
  "tokenLayers",
  "spanLayers",
  "relationLayers",
  "vocabLayers",
];

for (const bundle of BUNDLES) {
  test(`${bundle}.setConfig without options sends the value as the body`, () => {
    const [op] = queued((b) => b[bundle].setConfig("L1", "igt", "tagsets", { "a-b": 1 }));
    assert.equal(op.method, "PUT");
    assert.ok(!op.path.includes("if-unchanged"));
    assert.deepEqual(op.body, { "a-b": 1 });
  });

  test(`${bundle}.setConfig with expected sends the envelope`, () => {
    const [op] = queued((b) =>
      b[bundle].setConfig("L1", "igt", "tagsets", { "new-key": 2 }, undefined, {
        expected: { "old-key": 1 },
      }),
    );
    assert.ok(op.path.includes("if-unchanged=true"), op.path);
    assert.deepEqual(op.body, { expected: { "old-key": 1 }, value: { "new-key": 2 } });
  });

  test(`${bundle}.deleteConfig with expected sends it`, () => {
    const [op] = queued((b) =>
      b[bundle].deleteConfig("L1", "ud", "language", "Clear it", { expected: "en" }),
    );
    assert.equal(op.method, "DELETE");
    assert.ok(op.path.includes("if-unchanged=true"));
    assert.ok(op.path.includes("audit-message=Clear%20it"));
    assert.deepEqual(op.body, { expected: "en" });
  });
}

test("an expected key that is present but undefined means the key was absent", () => {
  const [op] = queued((b) =>
    b.projects.setConfig("P1", "igt", "languages", { object: "Lezgian" }, undefined, {
      expected: undefined,
    }),
  );
  assert.ok(op.path.includes("if-unchanged=true"));
  assert.deepEqual(op.body, { expected: null, value: { object: "Lezgian" } });
});

test("options with no expected key write without a check", () => {
  const [op] = queued((b) => b.projects.setConfig("P1", "igt", "x", 1, undefined, {}));
  assert.ok(!op.path.includes("if-unchanged"));
  assert.equal(op.body, 1);
});
