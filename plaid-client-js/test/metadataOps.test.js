// metadataOps turns a top-level fragment into the ops a metadata PATCH takes,
// and applyMetadataOps mirrors the server on a local copy. The server's rules
// are in plaid.sql.metadata/patch-metadata!, and the cases are the shared table
// in plaid-core/src/test/plaid/sql/metadata_op_cases.json.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  metadataOps,
  applyMetadataOps,
  isReservedMetadataKey,
  mergeMetadata,
  contributeOnEdit,
} from "../src/index.js";

test("metadataOps sets each key and deletes a null one", () => {
  assert.deepEqual(metadataOps({ a: 1, b: null, c: { d: 2 } }), [
    { op: "set", path: ["a"], value: 1 },
    { op: "delete", path: ["b"] },
    { op: "set", path: ["c"], value: { d: 2 } },
  ]);
  assert.deepEqual(metadataOps(null), []);
});

test("applyMetadataOps leaves its input alone", () => {
  const m = { corefud: { entities: { c8: "animal", c9: "fish" } } };
  applyMetadataOps(m, [
    { op: "set", path: ["corefud", "entities", "c10"], value: "bird" },
    { op: "delete", path: ["corefud", "entities", "c8"] },
  ]);
  assert.deepEqual(m, { corefud: { entities: { c8: "animal", c9: "fish" } } });
});

// The case table plaid-core and plaid-client-py run too.
const { cases } = JSON.parse(
  readFileSync(new URL("../../plaid-core/src/test/plaid/sql/metadata_op_cases.json", import.meta.url), "utf8"),
);

test("the shared metadata op case table is there", () => {
  assert.ok(cases.length > 40);
});

for (const c of cases) {
  test(`shared case: ${c.name}`, () => {
    if ("error" in c) {
      assert.throws(
        () => applyMetadataOps(c.metadata, c.ops),
        (e) => e.message.includes(c.error),
      );
    } else {
      assert.deepEqual(applyMetadataOps(c.metadata, c.ops), c.result);
    }
  });
}

test("mergeMetadata is applyMetadataOps over metadataOps", () => {
  const m = { prov: "inferred", provConfirmed: true, keep: 1 };
  const fragment = contributeOnEdit(m, "u@example.org");
  assert.deepEqual(mergeMetadata(m, fragment), applyMetadataOps(m, metadataOps(fragment)));
});

test("isReservedMetadataKey is true for the plaid namespace and the provenance keys only", () => {
  for (const k of ["plaid", "prov", "provSource", "provConfirmed", "provProb", "provDetail"]) {
    assert.equal(isReservedMetadataKey(k), true, k);
  }
  for (const k of ["Plaid", "plaid.x", "author", "review", "provenance", "", undefined]) {
    assert.equal(isReservedMetadataKey(k), false, String(k));
  }
});
