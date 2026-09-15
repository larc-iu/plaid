/**
 * The guidelines bundle: a project's annotation manual.
 *
 * Three things here are easy to get wrong and expensive to notice later, so
 * each has a test: an omitted field must be OMITTED rather than sent as null
 * (a PATCH that sends `title: null` would blank the handle the assistant
 * addresses the guideline by), `includeBodies` must reach the wire as the
 * kebab-case query the server reads, and a write must queue on a batch rather
 * than going over the wire beside it.
 *
 * Uses Node's built-in test runner — no new dependencies. Run with `npm test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

/** A client whose requests are recorded rather than sent. */
function recordingClient() {
  const client = new PlaidClient("http://example.test", "tok");
  client.calls = [];
  client._request = async function (method, path, options = {}) {
    client.calls.push({ method, path, ...options });
    return { entries: [], nextCursor: null };
  };
  // The bundles captured the ORIGINAL _request when they were installed, so
  // they have to be rebuilt against the stub.
  client._installResources();
  return client;
}

test("create sends only the fields it was given", async () => {
  const client = recordingClient();
  await client.guidelines.create("p1", "Glossing", "How this project glosses.");

  const [call] = client.calls;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/v1/projects/p1/guidelines");
  assert.deepEqual(
    call.body,
    { title: "Glossing", summary: "How this project glosses." },
    "an omitted body or pinned flag is absent, not null",
  );
});

test("create passes body, pinned and the audit message through", async () => {
  const client = recordingClient();
  await client.guidelines.create(
    "p1",
    "Glossing",
    "How this project glosses.",
    { body: "Loanwords are **not** segmented.", pinned: true },
    "seeding the manual",
  );

  const [call] = client.calls;
  assert.deepEqual(call.body, {
    title: "Glossing",
    summary: "How this project glosses.",
    body: "Loanwords are **not** segmented.",
    pinned: true,
  });
  assert.equal(call.auditMessage, "seeding the manual");
});

test("update sends only what changed, so a body edit cannot blank the title", async () => {
  const client = recordingClient();
  await client.guidelines.update("g1", { body: "New text." });

  const [call] = client.calls;
  assert.equal(call.method, "PATCH");
  assert.equal(call.path, "/api/v1/guidelines/g1");
  assert.deepEqual(call.body, { body: "New text." });
});

test("update can unpin, since false is a value and not an omission", async () => {
  const client = recordingClient();
  await client.guidelines.update("g1", { pinned: false });
  assert.deepEqual(client.calls[0].body, { pinned: false });
});

test("list asks for the whole set, and include-bodies reaches the wire kebab-cased", async () => {
  const client = recordingClient();
  await client.guidelines.list("p1");
  assert.equal(client.calls[0].path, "/api/v1/projects/p1/guidelines");
  assert.equal(
    client.calls[0].queryParams["include-bodies"],
    undefined,
    "an unasked-for flag is not sent",
  );

  client.calls.length = 0;
  await client.guidelines.list("p1", { includeBodies: true });
  assert.equal(client.calls[0].queryParams["include-bodies"], true);
});

test("listPage threads limit and cursor", async () => {
  const client = recordingClient();
  await client.guidelines.listPage("p1", { limit: 2, cursor: "c1" });
  const { queryParams } = client.calls[0];
  assert.equal(queryParams.limit, 2);
  assert.equal(queryParams.cursor, "c1");
});

test("get and delete address one guideline by id", async () => {
  const client = recordingClient();
  await client.guidelines.get("g1");
  await client.guidelines.delete("g1", "tidying up");
  assert.deepEqual(
    client.calls.map((c) => [c.method, c.path]),
    [
      ["GET", "/api/v1/guidelines/g1"],
      ["DELETE", "/api/v1/guidelines/g1"],
    ],
  );
  assert.equal(client.calls[1].auditMessage, "tidying up");
});

test("a write queues on a batch and a read still goes over the wire", async () => {
  const sent = [];
  const client = new PlaidClient("http://example.test", "tok");
  client._request = async (method, path) => {
    sent.push(`${method} ${path}`);
    return { entries: [], nextCursor: null };
  };
  client._installResources();

  const batch = client.batch();
  const queued = await batch.guidelines.create("p1", "T", "S");
  assert.deepEqual(
    queued,
    { batched: true },
    "a guideline write is ordinary project data, so it queues with no flag",
  );
  assert.equal(batch.operations.length, 1);
  assert.equal(batch.operations[0].path, "/api/v1/projects/p1/guidelines");

  await batch.guidelines.list("p1");
  assert.equal(
    sent.length,
    1,
    "the read was answered from the wire, not queued",
  );
  assert.equal(batch.operations.length, 1);
});
