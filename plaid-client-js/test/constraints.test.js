// Layer constraint writes: paths, bodies and kebab keys on the wire, the
// compare-and-set's `expected`, and violationsOf. A write is read off a
// batch's queue, a read that travels as a POST off the wire. The server's
// side is plaid-core's layer-constraints-test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PlaidClient, valueSetAllows, violationCountOf, violationsOf } from "../src/index.js";

function queued(fn) {
  const client = new PlaidClient("http://localhost:0", "dummy-token");
  const b = client.batch();
  fn(b);
  const ops = b.operations.map((op) => ({ ...op }));
  b.abort();
  return ops;
}

// What `fn(client)` sent over the wire, as method, path (with its query) and
// body: the reads that travel as a POST never queue.
async function sent(fn) {
  const client = new PlaidClient("http://x", "tok");
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    requests.push({ method: opts.method, path: u.pathname + u.search, body: opts.body ? JSON.parse(opts.body) : undefined });
    return {
      ok: true,
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
      json: async () => ({}),
      text: async () => "{}",
    };
  };
  try {
    await fn(client);
  } finally {
    globalThis.fetch = real;
  }
  return requests;
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

  test(`${bundle}.checkConstraints and repairConstraints post the list`, async () => {
    const [check] = await sent((c) =>
      c[bundle].checkConstraints("L1", [{ type: "value-set", values: ["N", "V"], parts: "all" }]),
    );
    const [repair] = queued((b) => {
      b[bundle].repairConstraints("L1", [{ type: "sameAncestor", tokenLayer: "S" }]);
    });
    assert.equal(check.method, "POST");
    assert.ok(check.path.startsWith(`/api/v1/${kind}/L1/constraints/check`));
    assert.deepEqual(check.body, { constraints: [{ type: "value-set", values: ["N", "V"], parts: "all" }] });
    assert.ok(repair.path.startsWith(`/api/v1/${kind}/L1/constraints/repair`));
    assert.deepEqual(repair.body.constraints[0]["token-layer"], "S");
  });

  test(`${bundle}.checkConstraints sends a limit when given one`, async () => {
    const [check] = await sent((c) => c[bundle].checkConstraints("L1", [{ type: "single-span" }], { limit: 250 }));
    assert.deepEqual(check.body, { constraints: [{ type: "single-span" }], limit: 250 });
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

test("violationCountOf reads a 422's total, which may exceed the listed violations", () => {
  // REV-BUGS-1: the answer lists at most 100 violations, and the raw
  // refusal's "violation-count" is the total.
  const listed = Array.from({ length: 100 }, () => ({ constraint: "value-set" }));
  assert.equal(violationCountOf({ status: 422, responseData: { violations: listed, "violation-count": 340 } }), 340);
  assert.equal(violationCountOf({ status: 422, responseData: { violations: [{ constraint: "value-set" }] } }), 1);
  assert.equal(violationCountOf({ status: 422, responseData: { error: "idempotency-key-reused" } }), null);
  assert.equal(violationCountOf({ status: 409, responseData: { "violation-count": 3 } }), null);
  assert.equal(violationCountOf(new Error("x")), null);
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

for (const [bundle, kind] of [["spanLayers", "span-layers"], ["relationLayers", "relation-layers"]]) {
  test(`${bundle}.refusedValues posts the rule and the limit, values as given`, async () => {
    const [op] = await sent((c) =>
      c[bundle].refusedValues("L1", { values: ["snake_case", "1SG"], delimiters: ".", parts: "all" }, { limit: 5 }),
    );
    assert.equal(op.method, "POST");
    assert.ok(op.path.startsWith(`/api/v1/${kind}/L1/constraints/refused-values`), op.path);
    assert.ok(!op.path.includes("audit-message"), op.path);
    assert.deepEqual(op.body, { values: ["snake_case", "1SG"], delimiters: ".", parts: "all", limit: 5 });
    const [plain] = await sent((c) => c[bundle].refusedValues("L1", { values: ["N"] }));
    assert.deepEqual(plain.body, { values: ["N"] });
  });
}

test("a token layer has no value-set, so no refusedValues", () => {
  const client = new PlaidClient("http://localhost:0", "dummy-token");
  assert.equal(client.tokenLayers.refusedValues, undefined);
});

// The rule types and the remediable ones, in the order their remedies run,
// as plaid-core's registry has them (remediable-kinds-test holds the case
// file to it). The client names both in its docs, and they must not drift.
const KINDS = JSON.parse(
  readFileSync(
    new URL("../../plaid-core/src/test/plaid/sql/constraints/remediable_kinds.json", import.meta.url),
    "utf8",
  ),
);

test("the LayerConstraint type lists every rule type core has", () => {
  const src = readFileSync(new URL("../src/constraints.js", import.meta.url), "utf8");
  const union = src.match(/@typedef \{\{type: ([^}]*)\}/)[1];
  const listed = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), KINDS.types);
});

test("repairConstraints names the remediable types in core's order", () => {
  const src = readFileSync(new URL("../src/families.js", import.meta.url), "utf8");
  const named = src.match(/remediable types\s*\n\s*\*\s*\(([^)]*)\)/)[1];
  assert.deepEqual(named.split(", "), KINDS.remediable);
});
