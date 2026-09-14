// What a batch carries, and what goes over the wire regardless (see the note
// at the top of src/http.js).
//
// A batch is a view of the client. A write of project data made on it queues;
// a read, or a signal that carries no project data, goes over the wire even
// when made on the batch; and a call made on the CLIENT is never touched by a
// batch, however many are open. The last is the point: a browser client is
// shared by an editor, an importer and the app's chrome at once, and under the
// old one-flag-on-the-client model four separate reads and a lock keep-alive
// were found queued into other people's batches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";
import {
  cancelServiceRequest,
  reportRequestEvent,
  discoverServices,
} from "../src/services.js";

// The only methods the probe skips. Each opens a stream or runs a loop rather
// than making one request, so calling it with fake arguments would hang or run
// past the request layer. Everything else on the batch is probed.
const STREAM_METHODS = new Set([
  "messages.listen",
  "messages.serve",
  "messages.requestService",
  "messages.attachServiceRequest",
]);

// A stubbed fetch that answers anything with an empty paginated envelope, so a
// probe of a read method runs to completion whatever shape it expects.
function stubFetch(record) {
  globalThis.fetch = async (url, opts = {}) => {
    record.push({ url: String(url), method: opts.method || "GET" });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => ({ entries: [], "next-cursor": null }),
      text: async () => "{}",
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

test("a write made on the client goes over the wire while a batch is open", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  const b = client.batch();
  try {
    await b.tokens.create("tl1", "t1", 0, 5);
    // Chrome writing on the shared client while the importer's batch is open.
    await client.spans.update("s1", "NOUN");
  } finally {
    b.abort();
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.ok(sent[0].url.endsWith("/api/v1/spans/s1"));
});

test("every read made on a batch goes over the wire, none queues", async () => {
  process.on("unhandledRejection", () => {});
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  const b = client.batch();

  const queuedReads = [];
  let overTheWire = 0;
  try {
    const probe = async (label, fn) => {
      const sentBefore = sent.length;
      const queuedBefore = b.operations.length;
      try {
        const out = fn(...Array(Math.max(fn.length, 0)).fill("x"));
        // An async generator is only work once it is iterated.
        if (out && typeof out[Symbol.asyncIterator] === "function") {
          for await (const _page of out) break;
        } else {
          await out;
        }
      } catch {
        // A probe with fake arguments may reject; what it did with the batch
        // before rejecting is still the thing under test.
      }
      for (const op of b.operations.slice(queuedBefore)) {
        if (op.method === "GET") queuedReads.push(`${label} -> ${op.path}`);
      }
      for (const req of sent.slice(sentBefore)) {
        if (req.method === "GET") overTheWire += 1;
      }
    };

    // Reflection over the batch's own bundles, so a whole new bundle is
    // probed the day it is added.
    for (const [name, bundle] of Object.entries(b)) {
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
        continue;
      for (const [m, fn] of Object.entries(bundle)) {
        if (typeof fn !== "function") continue;
        if (STREAM_METHODS.has(`${name}.${m}`)) continue;
        await probe(`${name}.${m}`, fn);
      }
    }
    await probe("query", b.query);
  } finally {
    b.abort();
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(queuedReads, [], `these reads joined the batch:\n  ${queuedReads.join("\n  ")}`);
  assert.ok(overTheWire > 40, `only ${overTheWire} reads went over the wire`);
});

test("a read or a signal shaped like a write goes over the wire from a batch", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  const b = client.batch();

  // None of these is a GET. The first is a read that travels as a POST. The
  // rest are out-of-band signals: shaped like a write, carrying no project
  // data, and worth having only if they happen now. Queued, each would happen
  // when the batch submits, or never if the batch aborts, while its caller
  // read success.
  const signals = [
    ["run a query", () => b.query({ find: ["?t"], where: [] })],
    ["cancel a service request", () => cancelServiceRequest(b, "p1", "r1")],
    [
      "report a service request event",
      () => reportRequestEvent(b, "p1", "r1", { status: "progress" }),
    ],
    ["discover services", () => discoverServices(b, "p1")],
    ["acquire a document lock", () => b.documents.acquireLock("d1")],
    ["release a document lock", () => b.documents.releaseLock("d1")],
    ["forget a service", () => b.messages.discardService("p1", "s1")],
    ["take a backup", () => b.admin.backup()],
    ["drop a stranded lock", () => b.admin.releaseLock("d1")],
    ["clear rate limits", () => b.admin.clearRateLimits()],
  ];

  try {
    for (const [label, fn] of signals) {
      const before = sent.length;
      const queuedBefore = b.operations.length;
      await fn();
      assert.equal(sent.length, before + 1, `${label} did not go over the wire`);
      assert.equal(b.operations.length, queuedBefore, `${label} was queued into the batch`);
    }
  } finally {
    b.abort();
    globalThis.fetch = realFetch;
  }
});

test("a write of project data queues on the batch and answers a marker", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  const b = client.batch();
  try {
    assert.deepEqual(await b.tokens.create("tl1", "t1", 0, 5), { batched: true });
    await b.spans.update("s1", "NOUN");
    await b.relations.delete("r1");
    // Blobless DELETEs beside a multipart upload. The upload cannot be
    // batched; these carry nothing the transport cannot express.
    await b.documents.deleteMedia("d1");
    await b.users.deleteAvatar("u1");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(sent.length, 0, "a queued write must not reach the wire");
  assert.deepEqual(
    b.operations.map((op) => op.method),
    ["POST", "PATCH", "DELETE", "DELETE", "DELETE"],
  );
  b.abort();
});

test("only the calls the batch transport cannot carry refuse a batch", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  const b = client.batch();

  // The two multipart uploads and the user-data store. Nothing else may throw
  // here: `noBatch` on a read turns a read into a thrown one, and on a write it
  // refuses work a batch could have done.
  const refuse = [
    ["upload media", () => b.documents.uploadMedia("d1", "f")],
    ["upload an avatar", () => b.users.setAvatar("u1", "f")],
    ["write user data", () => b.userData.put("u1", "k", 1)],
    ["delete user data", () => b.userData.delete("u1", "k")],
  ];

  try {
    for (const [label, fn] of refuse) {
      await assert.rejects(fn, /cannot be used in a batch/, label);
    }
    assert.equal(sent.length, 0, "a refused call must not reach the wire");
    assert.equal(b.operations.length, 0);
  } finally {
    b.abort();
    globalThis.fetch = realFetch;
  }
});
