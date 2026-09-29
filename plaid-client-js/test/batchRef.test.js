// b.ref() stands in for the id an earlier queued op will create. The server
// resolves it (plaid-core's batch-ref-test). Here: what goes on the wire, and
// a batch split past MAX_BATCH_OPS counting each request's refs from its own
// first op.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

test("a ref names the op it was taken after, and survives the body transform", () => {
  const client = new PlaidClient("http://localhost:0", "dummy-token");
  const b = client.batch();
  b.vocabItems.create("V", "dog");
  const entry = b.ref();
  b.vocabItems.bulkCreate([{ vocabLayerId: "V", form: "a" }]);
  b.vocabLinks.create(entry, ["t1"]);
  b.vocabLinks.create(b.ref(1, 0), ["t2"]);
  assert.deepEqual(b.operations[2].body, { "vocab-item": { $ref: 0 }, tokens: ["t1"] });
  assert.deepEqual(b.operations[3].body, {
    "vocab-item": { $ref: 1, index: 0 },
    tokens: ["t2"],
  });
  assert.throws(() => b.ref(4));
  assert.throws(() => b.ref(-5));
  b.abort();
});

test("a batch split in two counts each request's refs from its own first op", async () => {
  const client = new PlaidClient("http://localhost:0", "dummy-token");
  const sent = [];
  client._postBatch = async (_url, chunk) => {
    sent.push(chunk);
    return chunk.map(() => ({ status: 201, body: { id: "x" } }));
  };
  const b = client.batch();
  for (let i = 0; i < 1001; i++) b.vocabItems.create("V", `w${i}`);
  b.vocabLinks.create(b.ref(1000), ["t"]);
  await b.submit();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1][1].body["vocab-item"], { $ref: 0 });
});

test("a ref across the split refuses the whole batch before anything goes", async () => {
  const client = new PlaidClient("http://localhost:0", "dummy-token");
  let posts = 0;
  client._postBatch = async (_url, chunk) => {
    posts++;
    return chunk.map(() => ({ status: 201, body: { id: "x" } }));
  };
  const b = client.batch();
  b.vocabItems.create("V", "first");
  const first = b.ref();
  for (let i = 0; i < 1000; i++) b.vocabItems.create("V", `w${i}`);
  b.vocabLinks.create(first, ["t"]);
  await assert.rejects(b.submit(), (e) => e.committed === 0);
  assert.equal(posts, 0);
});
