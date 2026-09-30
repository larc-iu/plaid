// texts.edit sends the edits from the caret with the digest of the body they
// were made on, and strict mode does not stamp a write that carries `base`:
// the digest is the precondition, and a document version would refuse an
// edit for a gloss written elsewhere meanwhile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(record, answer = {}) {
  globalThis.fetch = async (url, opts = {}) => {
    record.push({
      url: String(url),
      method: opts.method || "GET",
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => answer,
      text: async () => JSON.stringify(answer),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

function strictClient() {
  const client = new PlaidClient("http://x", "tok");
  client.enterStrictMode("d1");
  client.documentVersions = { d1: 7 };
  return client;
}

const versionOf = (url) => new URL(url, "http://x").searchParams.get("document-version");
const edits = [{ type: "insert", index: 3, value: "s" }];

test("texts.edit sends edits and base, unstamped, and answers digest and reshape", async () => {
  const client = strictClient();
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent, {
    "text/id": "t1",
    "text/digest": "d2",
    reshape: { tokens: [{ id: "k", begin: 0, end: 4 }], "vocab-links": [], deleted: { "vocab-links": [] } },
  });
  let answer;
  try {
    answer = await client.texts.edit("t1", edits, undefined, { base: "d1" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "PATCH");
  assert.deepEqual(sent[0].body, { edits, base: "d1" });
  assert.equal(versionOf(sent[0].url), null, "an edit with base carries no document version");
  assert.equal(answer.digest, "d2");
  assert.deepEqual(answer.reshape.vocabLinks, []);
});

test("without base an edit is stamped as any write", async () => {
  const client = strictClient();
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  try {
    await client.texts.edit("t1", edits);
    await client.texts.update("t1", "cats");
    await client.texts.update("t1", edits, undefined, { base: "d1" });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(sent.map((r) => versionOf(r.url)), ["7", "7", null]);
  assert.deepEqual(sent[2].body, { body: edits, base: "d1" });
});

test("an edit queues on a batch with its base and without a stamp", async () => {
  const client = strictClient();
  const b = client.batch();
  b.texts.edit("t1", edits, undefined, { base: "d1" });
  b.tokens.bulkCreate([{ tokenLayerId: "l", text: "t1", begin: 0, end: 4 }]);
  assert.equal(b.operations.length, 2);
  assert.deepEqual(b.operations[0].body, { edits, base: "d1" });
  assert.equal(versionOf(b.operations[0].path), null);
  assert.equal(versionOf(b.operations[1].path), "7");
  b.abort();
});

test("versioned: true keeps the stamp on a write with base, for a batch whose later writes are stamped", () => {
  const client = strictClient();
  const b = client.batch();
  b.texts.edit("t1", edits, undefined, { base: "d1", versioned: true });
  b.texts.update("t1", edits, undefined, { base: "d1", versioned: true });
  assert.deepEqual(b.operations.map((op) => versionOf(op.path)), ["7", "7"]);
  b.abort();
});
