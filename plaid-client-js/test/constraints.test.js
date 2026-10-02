// Layer constraint writes: paths, bodies and kebab keys on the wire, the
// compare-and-set's `expected`, and violationsOf. The server's side is
// plaid-core's layer-constraints-test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlaidClient, valueSetAllows, violationsOf } from "../src/index.js";

function queued(fn) {
  const client = new PlaidClient("http://localhost:0", "dummy-token");
  const b = client.batch();
  fn(b);
  const ops = b.operations.map((op) => ({ ...op }));
  b.abort();
  return ops;
}

const BUNDLES = { tokenLayers: "token-layers", spanLayers: "span-layers", relationLayers: "relation-layers" };

for (const [bundle, kind] of Object.entries(BUNDLES)) {
  test(`${bundle}.setConstraints sends the list with kebab keys`, () => {
    const [op] = queued((b) =>
      b[bundle].setConstraints("L1", "igt", [{ type: "single-span", joinWith: "+" }], "Set up"),
    );
    assert.equal(op.method, "PUT");
    assert.ok(op.path.startsWith(`/api/v1/${kind}/L1/constraints/igt`), op.path);
    assert.deepEqual(op.body, { constraints: [{ type: "single-span", "join-with": "+" }] });
  });

  test(`${bundle}.setConstraints with expected null asks that nothing was declared`, () => {
    const [op] = queued((b) => b[bundle].setConstraints("L1", "ud", [], undefined, { expected: null }));
    assert.deepEqual(op.body, { constraints: [], expected: null });
    const [absent] = queued((b) => b[bundle].setConstraints("L1", "ud", [], undefined, { expected: undefined }));
    assert.deepEqual(absent.body, { constraints: [], expected: null });
    const [none] = queued((b) => b[bundle].setConstraints("L1", "ud", []));
    assert.deepEqual(none.body, { constraints: [] });
  });

  test(`${bundle}.deleteConstraints sends expected only when given`, () => {
    const [plain] = queued((b) => b[bundle].deleteConstraints("L1", "ud"));
    assert.equal(plain.method, "DELETE");
    assert.equal(plain.body, undefined);
    const [cas] = queued((b) =>
      b[bundle].deleteConstraints("L1", "ud", undefined, { expected: [{ type: "coextensive" }] }),
    );
    assert.deepEqual(cas.body, { expected: [{ type: "coextensive" }] });
  });

  test(`${bundle}.checkConstraints and repairConstraints post the list`, () => {
    const [check, repair] = queued((b) => {
      b[bundle].checkConstraints("L1", [{ type: "value-set", values: ["N", "V"], parts: "all" }]);
      b[bundle].repairConstraints("L1", [{ type: "sameAncestor", tokenLayer: "S" }]);
    });
    assert.ok(check.path.startsWith(`/api/v1/${kind}/L1/constraints/check`));
    assert.deepEqual(check.body, { constraints: [{ type: "value-set", values: ["N", "V"], parts: "all" }] });
    assert.ok(repair.path.startsWith(`/api/v1/${kind}/L1/constraints/repair`));
    assert.deepEqual(repair.body.constraints[0]["token-layer"], "S");
  });
}

test("values are never re-cased", () => {
  const [op] = queued((b) =>
    b.spanLayers.setConstraints("L1", "igt", [{ type: "value-set", values: ["camelCase", "1SG"] }]),
  );
  assert.deepEqual(op.body.constraints[0].values, ["camelCase", "1SG"]);
});

test("violationsOf reads a 422's violations, camelCased", () => {
  const err = {
    status: 422,
    responseData: {
      error: "A token is in 2 spans",
      violations: [{ constraint: "single-span", "layer-name": "Gloss", ids: ["a", "b"] }],
      "violation-count": 1,
    },
  };
  assert.deepEqual(violationsOf(err), [{ constraint: "single-span", layerName: "Gloss", ids: ["a", "b"] }]);
  assert.equal(violationsOf({ status: 422, responseData: { error: "idempotency-key-reused" } }), null);
  assert.equal(violationsOf({ status: 409, responseData: { violations: [] } }), null);
  assert.equal(violationsOf(new Error("x")), null);
});

for (const bundle of Object.keys(BUNDLES)) {
  test(`${bundle}.repairConstraints names one document when given`, () => {
    const [op] = queued((b) =>
      b[bundle].repairConstraints("L1", [{ type: "single-span" }], undefined, { document: "D1" }),
    );
    assert.deepEqual(op.body, { constraints: [{ type: "single-span" }], document: "D1" });
    const [whole] = queued((b) => b[bundle].repairConstraints("L1", [{ type: "single-span" }]));
    assert.deepEqual(whole.body, { constraints: [{ type: "single-span" }] });
  });
}

// The case table plaid-core and plaid-client-py run too.
const VALUE_SET_CASES = JSON.parse(
  readFileSync(
    new URL("../../plaid-core/src/test/plaid/sql/constraints/value_set_cases.json", import.meta.url),
    "utf8",
  ),
);

test("valueSetAllows reads a value as the server does, trimming what trim() trims", () => {
  for (const { constraint, value, allowed } of VALUE_SET_CASES.cases) {
    assert.equal(
      valueSetAllows(VALUE_SET_CASES.constraints[constraint], value),
      allowed,
      `${constraint} ${JSON.stringify(value)}`,
    );
  }
});
