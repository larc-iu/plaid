// Who asked for a service run: the JS twin of plaid_client.workflows.requester
// (umr-collab-service-requester). Same wording, same stored key.

import { test } from "node:test";
import assert from "node:assert/strict";
import { REQUESTED_BY, makeRequester, requesterOf } from "../src/index.js";

function clientWith(users, error = null) {
  const asked = [];
  return {
    asked,
    users: {
      get: async (id) => {
        asked.push(id);
        if (error) throw error;
        return users[id];
      },
    },
  };
}

test("the requester is named by display name in the label", async () => {
  const client = clientWith({ "second@x.com": { id: "second@x.com", displayName: "second" } });
  const requester = await requesterOf(client, { documentId: "d1", requesterId: "second@x.com" });
  assert.equal(
    requester.label("AnCast adjudication against lunch"),
    "AnCast adjudication against lunch, requested by second",
  );
  assert.deepEqual(requester.record(), { id: "second@x.com", name: "second" });
  assert.deepEqual(requester.detail({ model: "m" }), { model: "m", [REQUESTED_BY]: "second@x.com" });
  assert.deepEqual(client.asked, ["second@x.com"]);
});

test("a requester whose name cannot be read is named by id", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const requester = await requesterOf(clientWith({}, new Error("HTTP 500")), {
      requesterId: "second@x.com",
    });
    assert.equal(requester.label("Stanza UD parse (en)"), "Stanza UD parse (en), requested by second@x.com");
  } finally {
    console.warn = warn;
  }
});

test("with nobody asking nothing changes and nothing is read", async () => {
  const client = clientWith({});
  for (const data of [{}, { requesterId: null }, null, "text"]) {
    const requester = await requesterOf(client, data);
    assert.equal(requester.label("UMR draft of sentence 3"), "UMR draft of sentence 3");
    assert.equal(requester.record(), null);
    assert.deepEqual(requester.detail({ model: "m" }), { model: "m" });
  }
  assert.deepEqual(client.asked, []);
  assert.deepEqual(makeRequester("a@x.com", "a").detail(), { requestedBy: "a@x.com" });
});
