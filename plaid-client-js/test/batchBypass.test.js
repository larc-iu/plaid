// Coverage guard for the batch-mode classification (see the note at the top of
// src/http.js).
//
// `client.batched()` sets ONE flag on the whole client, so a call made while it
// is open is queued no matter which code made it. A browser client is shared by
// an editor, an importer and the app's chrome at once, and four separate reads
// were found queued into other people's batches before the rule was written
// down: the query endpoint, the server info probe, service discovery, and the
// document page the `@` list reads. A queued read answers `{batched: true}`
// instead of data, takes a slot in the batch's results that shifts every
// positional read after it, and server-side runs against the batch's
// transaction connection, where `/query` 500s and rolls back every write.
//
// So: no read is ever queued, and neither is an out-of-band signal. The first
// test finds every method on the client by reflection, calls it with a batch
// open, and compares the reads that answered from the wire against READS below.
// The second names the signals, which are shaped like writes and cannot be
// found by their verb.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";
import {
  cancelServiceRequest,
  reportRequestEvent,
  discoverServices,
} from "../src/services.js";

// Every read the client exposes, as `bundle.method`. ADD A NEW READ HERE: the
// test calls every method by reflection and compares what actually went over
// the wire against this list, so a read missing from it fails exactly as
// loudly as one that joined the batch.
const READS = [
  "admin.locks",
  "admin.logFile",
  "admin.logs",
  "admin.rateLimits",
  "admin.server",
  "admin.userData",
  "admin.userDataPage",
  "apiTokens.iterPages",
  "apiTokens.list",
  "apiTokens.listPage",
  "audit.iterPages",
  "audit.list",
  "audit.listPage",
  "audit.tally",
  "comments.counts",
  "comments.countsInVocab",
  "comments.get",
  "comments.iterPages",
  "comments.list",
  "comments.listInVocab",
  "comments.listInVocabPage",
  "comments.listPage",
  "documents.audit",
  "documents.auditPage",
  "documents.checkLock",
  "documents.get",
  "documents.getMedia",
  "invites.iterPages",
  "invites.list",
  "invites.listPage",
  "messages.discoverServices",
  "operationGroups.get",
  "projects.audit",
  "projects.auditPage",
  "projects.get",
  "projects.iterDocuments",
  "projects.iterPages",
  "projects.list",
  "projects.listDocuments",
  "projects.listDocumentsPage",
  "projects.listPage",
  "projects.myLastEdits",
  "relationLayers.get",
  "relations.get",
  "server.health",
  "server.info",
  "spanLayers.get",
  "spans.get",
  "textLayers.get",
  "texts.get",
  "tokenLayers.get",
  "tokens.get",
  "userData.get",
  "userData.iterPages",
  "userData.list",
  "userData.listPage",
  "users.audit",
  "users.auditPage",
  "users.get",
  "users.getAvatar",
  "users.iterPages",
  "users.list",
  "users.listPage",
  "vocabItems.get",
  "vocabLayers.get",
  "vocabLayers.iterPages",
  "vocabLayers.list",
  "vocabLayers.listPage",
  "vocabLinks.get",
];

// The only methods the probe skips. Each opens a stream or runs a loop rather
// than making one request, so calling it with fake arguments would hang or run
// past the request layer. Everything else on the client is probed.
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

test("every read goes over the wire with a batch open, and READS names them all", async () => {
  process.on("unhandledRejection", () => {});
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();

  const overTheWire = new Set();
  const queuedReads = [];
  try {
    const probe = async (label, fn) => {
      const sentBefore = sent.length;
      const queuedBefore = client.batchOperations.length;
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
      for (const op of client.batchOperations.slice(queuedBefore)) {
        if (op.method === "GET") queuedReads.push(`${label} -> ${op.path}`);
      }
      for (const req of sent.slice(sentBefore)) {
        if (req.method === "GET") overTheWire.add(label);
      }
    };

    // Reflection, so a whole new bundle is probed the day it is added rather
    // than the day someone remembers to name it here.
    for (const [name, bundle] of Object.entries(client)) {
      if (typeof bundle === "function") {
        await probe(name, bundle);
        continue;
      }
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
        continue;
      for (const [m, fn] of Object.entries(bundle)) {
        if (typeof fn !== "function") continue;
        if (STREAM_METHODS.has(`${name}.${m}`)) continue;
        await probe(`${name}.${m}`, fn);
      }
    }
  } finally {
    client.abortBatch();
    globalThis.fetch = realFetch;
  }

  assert.deepEqual(
    queuedReads,
    [],
    `these reads joined the batch instead of going over the wire:\n  ${queuedReads.join("\n  ")}`,
  );

  const observed = [...overTheWire].sort();
  const unlisted = observed.filter((n) => !READS.includes(n));
  assert.deepEqual(
    unlisted,
    [],
    `these reads are missing from READS at the top of this file. Add every new read to it:\n  ${unlisted.join("\n  ")}`,
  );
  // `server.limits` is deliberately absent: it returns `server.info()`, which
  // memoizes its one request, so by the time it is probed there is nothing
  // left to send.
  const missing = READS.filter((n) => !observed.includes(n));
  assert.deepEqual(
    missing,
    [],
    `READS names these, but they sent no GET with a batch open:\n  ${missing.join("\n  ")}`,
  );
});

test("a read or a signal shaped like a write goes over the wire", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();

  // None of these is a GET, so the discovery test above cannot see them. The
  // first is a read that travels as a POST. The rest are out-of-band signals:
  // shaped like a write, carrying no project data, and worth having only if
  // they happen now. Queued, each happens when the batch submits, or never if
  // the batch aborts, while its caller reads success.
  const signals = [
    // A query runs against the pool; inside the batch's transaction it 500s
    // and rolls back every write the batch had queued.
    ["run a query", () => client.query({ find: ["?t"], where: [] })],
    // The assistant's Stop button, pressed during an import.
    ["cancel a service request", () => cancelServiceRequest(client, "p1", "r1")],
    // A service reporting from inside its own batch of writes.
    [
      "report a service request event",
      () => reportRequestEvent(client, "p1", "r1", { status: "progress" }),
    ],
    // Discovery, which the availability probe polls.
    ["discover services", () => discoverServices(client, "p1")],
    // A lock taken at submit time is taken after every write it guards.
    ["acquire a document lock", () => client.documents.acquireLock("d1")],
    ["release a document lock", () => client.documents.releaseLock("d1")],
    // Admin actions on the server itself, none of them project data.
    ["take a backup", () => client.admin.backup()],
    ["drop a stranded lock", () => client.admin.releaseLock("d1")],
    ["clear rate limits", () => client.admin.clearRateLimits()],
  ];

  try {
    for (const [label, fn] of signals) {
      const before = sent.length;
      const queuedBefore = client.batchOperations.length;
      await fn();
      assert.equal(sent.length, before + 1, `${label} did not go over the wire`);
      assert.equal(
        client.batchOperations.length,
        queuedBefore,
        `${label} was queued into the batch`,
      );
    }
  } finally {
    client.abortBatch();
    globalThis.fetch = realFetch;
  }
});

test("a write of project data still queues", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();
  try {
    await client.tokens.create("tl1", "t1", 0, 5);
    await client.spans.update("s1", "NOUN");
    await client.relations.delete("r1");
    // Blobless DELETEs beside a multipart upload. The upload cannot be
    // batched; these carry nothing the transport cannot express.
    await client.documents.deleteMedia("d1");
    await client.users.deleteAvatar("u1");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(sent.length, 0, "a queued write must not reach the wire");
  assert.deepEqual(
    client.batchOperations.map((op) => op.method),
    ["POST", "PATCH", "DELETE", "DELETE", "DELETE"],
  );
  client.abortBatch();
});

test("only the calls the batch transport cannot carry refuse a batch", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  client.beginBatch();

  // A batch inside a batch, the two multipart uploads, and the user-data
  // store. Nothing else may throw here: `noBatch` on a read turns a swallowed
  // read into a thrown one, and on a write it refuses work a batch could have
  // done.
  const refuse = [
    ["submit a batch", () => client.batch.submit([])],
    ["upload media", () => client.documents.uploadMedia("d1", "f")],
    ["upload an avatar", () => client.users.setAvatar("u1", "f")],
    ["write user data", () => client.userData.put("u1", "k", 1)],
    ["delete user data", () => client.userData.delete("u1", "k")],
  ];

  try {
    for (const [label, fn] of refuse) {
      await assert.rejects(fn, /cannot be used in batch mode/, label);
    }
    assert.equal(sent.length, 0, "a refused call must not reach the wire");
    assert.equal(client.batchOperations.length, 0);
  } finally {
    client.abortBatch();
    globalThis.fetch = realFetch;
  }
});
