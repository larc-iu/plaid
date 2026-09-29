// b.ref() stands in for the id an earlier queued op will create. The client
// takes it out of the body when the write is queued and sends where it was
// beside the body, as `refs`, which the server fills in (plaid-core's
// batch-ref-test). The body is never searched for anything else, so user
// data shaped like a ref goes out as it was given (D19, REV-F-CORE-API
// REV-1). Here: what goes on the wire, and a batch split past MAX_BATCH_OPS
// counting each request's refs from its own first op.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

const client = () => new PlaidClient("http://localhost:0", "dummy-token");

test("a ref names the op it was taken after, and goes beside the body", () => {
  const b = client().batch();
  b.vocabItems.create("V", "dog");
  const entry = b.ref();
  b.vocabItems.bulkCreate([{ vocabLayerId: "V", form: "a" }]);
  b.vocabLinks.create(entry, ["t1"]);
  b.vocabLinks.create(b.ref(1, 0), ["t2"]);
  assert.deepEqual(b.operations[2].body, { "vocab-item": null, tokens: ["t1"] });
  assert.deepEqual(b.operations[2].refs, [{ at: ["vocab-item"], op: 0 }]);
  assert.deepEqual(b.operations[3].body, { "vocab-item": null, tokens: ["t2"] });
  assert.deepEqual(b.operations[3].refs, [{ at: ["vocab-item"], op: 1, index: 0 }]);
  assert.equal(b.operations[0].refs, undefined);
  // What callers read off a ref keeps its meaning.
  assert.equal(entry.$ref, 0);
  assert.equal(b.ref(1, 0).index, 0);
  assert.throws(() => b.ref(4));
  assert.throws(() => b.ref(-5));
  assert.throws(() => b.ref(0, -1));
  b.abort();
});

test("a ref at any depth, including in a list and in metadata", () => {
  const b = client().batch();
  b.tokens.bulkCreate([{ tokenLayerId: "L", text: "x", begin: 0, end: 1 }]);
  b.spans.create("S", ["t0", b.ref(0, 0)], "v", { parent: b.ref(0, 0) });
  assert.deepEqual(b.operations[1].body.tokens, ["t0", null]);
  assert.equal(b.operations[1].body.metadata.parent, null);
  assert.deepEqual(b.operations[1].refs, [
    { at: ["tokens", 1], op: 0, index: 0 },
    { at: ["metadata", "parent"], op: 0, index: 0 },
  ]);
  b.abort();
});

test("user data shaped like a ref goes out as given, and gets no refs", () => {
  const b = client().batch();
  const shapes = [{ $ref: 0 }, { $ref: 0, index: 0 }, { $ref: "#/defs/tag" }];
  b.vocabItems.create("V", "first");
  b.vocabItems.create("V", "second", { x: shapes[0], all: shapes });
  b.projects.setConfig("P", "t", "schema", shapes[2]);
  assert.deepEqual(b.operations[1].body.metadata, { x: shapes[0], all: shapes });
  assert.equal(b.operations[1].refs, undefined);
  assert.deepEqual(b.operations[2].body, shapes[2]);
  assert.equal(b.operations[2].refs, undefined);
  b.abort();
});

test("user data shaped like a ref past op 1000 goes out as given", async () => {
  const c = client();
  const sent = [];
  c._postBatch = async (_url, chunk) => {
    sent.push(chunk);
    return chunk.map(() => ({ status: 201, body: { id: "x" } }));
  };
  const b = c.batch();
  for (let i = 0; i < 1001; i++) b.vocabItems.create("V", `w${i}`);
  const metadata = { a: { $ref: "#/x" }, b: { $ref: 3 }, c: { $ref: 1000 } };
  b.vocabItems.create("V", "late", metadata);
  await b.submit();
  assert.deepEqual(sent[1][1].body.metadata, metadata);
  assert.equal(sent[1][1].refs, undefined);
});

test("a batch split in two counts each request's refs from its own first op", async () => {
  const c = client();
  const sent = [];
  c._postBatch = async (_url, chunk) => {
    sent.push(chunk);
    return chunk.map(() => ({ status: 201, body: { id: "x" } }));
  };
  const b = c.batch();
  for (let i = 0; i < 1001; i++) b.vocabItems.create("V", `w${i}`);
  b.vocabLinks.create(b.ref(1000), ["t"]);
  await b.submit();
  assert.equal(sent.length, 2);
  assert.equal(sent[1][1].body["vocab-item"], null);
  assert.deepEqual(sent[1][1].refs, [{ at: ["vocab-item"], op: 0 }]);
});

test("a ref across the split refuses the whole batch before anything goes", async () => {
  const c = client();
  let posts = 0;
  c._postBatch = async (_url, chunk) => {
    posts++;
    return chunk.map(() => ({ status: 201, body: { id: "x" } }));
  };
  const b = c.batch();
  b.vocabItems.create("V", "first");
  const first = b.ref();
  for (let i = 0; i < 1000; i++) b.vocabItems.create("V", `w${i}`);
  b.vocabLinks.create(first, ["t"]);
  await assert.rejects(b.submit(), (e) => e.committed === 0);
  assert.equal(posts, 0);
});

test("a ref anywhere but a later body on its own batch is refused", async () => {
  const c = client();
  const b = c.batch();
  b.vocabItems.create("V", "dog");
  const ref = b.ref();
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetched.push(args);
    throw new Error("nothing should be sent");
  };
  try {
    // In a path.
    await assert.rejects(async () => b.vocabItems.delete(ref), /b\.ref\(\)/);
    // On another batch.
    const other = c.batch();
    other.vocabItems.create("V", "cat");
    await assert.rejects(async () => other.vocabLinks.create(ref, ["t"]), /b\.ref\(\)/);
    other.abort();
    // In a call made on the client, which would send it now.
    await assert.rejects(async () => c.vocabLinks.create(ref, ["t"]), /b\.ref\(\)/);
    assert.equal(fetched.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(b.operations.length, 1);
  b.abort();
});
