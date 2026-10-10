// The guidelines bundle: a project's annotation manual. What each method sends
// (an omitted field left out rather than sent as null, `includeBodies` as the
// kebab-case query) is in fixtures/requests.json. Here: a write queues on a
// batch rather than going over the wire beside it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

test("a write queues on a batch and a read still goes over the wire", async () => {
  const sent = [];
  const client = new PlaidClient("http://example.test", "tok");
  client._request = async (method, path) => {
    sent.push(`${method} ${path}`);
    return { entries: [], nextCursor: null };
  };
  // The bundles captured the ORIGINAL _request when they were installed, so
  // they have to be rebuilt against the stub.
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
  assert.equal(sent.length, 1, "the read was answered from the wire, not queued");
  assert.equal(batch.operations.length, 1);
});
