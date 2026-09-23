// metadataOps turns a top-level fragment into the ops a metadata PATCH takes,
// and applyMetadataOps mirrors the server on a local copy. The server's rules
// are in plaid.sql.metadata/patch-metadata!, and these cases follow its tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { metadataOps, applyMetadataOps, mergeMetadata, contributeOnEdit } from "../src/index.js";

test("metadataOps sets each key and deletes a null one", () => {
  assert.deepEqual(metadataOps({ a: 1, b: null, c: { d: 2 } }), [
    { op: "set", path: ["a"], value: 1 },
    { op: "delete", path: ["b"] },
    { op: "set", path: ["c"], value: { d: 2 } },
  ]);
  assert.deepEqual(metadataOps(null), []);
});

test("applyMetadataOps edits nested keys and leaves the rest", () => {
  const m = { corefud: { counts: { c: 9 }, entities: { c8: "animal", c9: "fish" } }, other: 1 };
  const out = applyMetadataOps(m, [
    { op: "set", path: ["corefud", "entities", "c10"], value: "bird" },
    { op: "set", path: ["corefud", "counts", "c"], value: 10 },
    { op: "delete", path: ["corefud", "entities", "c8"] },
  ]);
  assert.deepEqual(out, {
    corefud: { counts: { c: 10 }, entities: { c9: "fish", c10: "bird" } },
    other: 1,
  });
  assert.deepEqual(m.corefud.entities, { c8: "animal", c9: "fish" }, "input untouched");
});

test("set creates missing objects, stores null, and a one-key path replaces whole", () => {
  assert.deepEqual(applyMetadataOps({}, [{ op: "set", path: ["a", "b"], value: null }]), {
    a: { b: null },
  });
  assert.deepEqual(applyMetadataOps({ a: { x: 1 } }, [{ op: "set", path: ["a"], value: { y: 2 } }]), {
    a: { y: 2 },
  });
});

test("delete of an absent key or under an absent object is a no-op", () => {
  const m = { a: 1 };
  assert.deepEqual(
    applyMetadataOps(m, [
      { op: "delete", path: ["b"] },
      { op: "delete", path: ["b", "c"] },
    ]),
    m,
  );
});

test("a path through a non-object throws, as the server refuses it", () => {
  assert.throws(() => applyMetadataOps({ s: "x" }, [{ op: "set", path: ["s", "t"], value: 1 }]));
  assert.throws(() => applyMetadataOps({ l: [1] }, [{ op: "delete", path: ["l", "0"] }]));
  assert.throws(() => applyMetadataOps({}, [{ op: "set", path: [], value: 1 }]));
  assert.throws(() => applyMetadataOps({}, [{ op: "set", path: ["a"] }]));
  assert.throws(() => applyMetadataOps({}, [{ op: "merge", path: ["a"], value: 1 }]));
});

test("mergeMetadata is applyMetadataOps over metadataOps", () => {
  const m = { prov: "inferred", provConfirmed: true, keep: 1 };
  const fragment = contributeOnEdit(m, "u@example.org");
  assert.deepEqual(mergeMetadata(m, fragment), applyMetadataOps(m, metadataOps(fragment)));
});
