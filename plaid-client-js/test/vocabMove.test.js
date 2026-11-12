// A vocabulary has a home project: create names it, move changes it, the
// home's maintainer lists the borrowers and may end a borrowing, and a
// project delete is refused while a borrower links one of its vocabularies
// (what a delete or an unlink would take: destructiveReads.test.js). The maintainer methods are gone. The same as
// plaid-client-py's tests/test_vocab_move.py.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(status, body) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({
      url: new URL(String(url)),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: status < 300,
      status,
      statusText: status >= 400 ? "Refused" : "OK",
      headers: {
        get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null),
      },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { seen, restore: () => (globalThis.fetch = real) };
}

async function call(status, body, fn) {
  const client = new PlaidClient("http://plaid.test", "tok");
  const { seen, restore } = stubFetch(status, body);
  try {
    return { result: await fn(client), seen };
  } finally {
    restore();
  }
}

test("create sends the home project and keeps a minted id", async () => {
  const { seen } = await call(201, { id: "v1" }, (c) =>
    c.vocabLayers.create("p1", "Lexicon", "made", { id: "0190a000-0000-7000-8000-000000000001" }),
  );
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url.pathname, "/api/v1/vocab-layers");
  assert.deepEqual(seen[0].body, {
    id: "0190a000-0000-7000-8000-000000000001",
    name: "Lexicon",
    "project-id": "p1",
  });
  assert.equal(seen[0].url.searchParams.get("audit-message"), "made");
});

test("a create sent again under its minted id answers as made", async () => {
  const id = "0190a000-0000-7000-8000-000000000002";
  const { result, seen } = await call(409, { error: "id-taken", "id-taken": true, id }, (c) =>
    c.withOperation("Make", () => c.vocabLayers.create("p1", "Lexicon", undefined, { id }), {
      keys: c.keySeed(),
      minted: new Set([id]),
    }),
  );
  assert.deepEqual(result, { id });
  assert.equal(seen[0].body.id, id);
  assert.equal(seen[0].body["project-id"], "p1");
});

test("move posts the new home and answers the vocabulary", async () => {
  const answer = { "vocab/id": "v1", "vocab/name": "Lex", "vocab/project": "p2", config: {} };
  const { result, seen } = await call(200, answer, (c) => c.vocabLayers.move("v1", "p2", "moved"));
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url.pathname, "/api/v1/vocab-layers/v1/move");
  assert.deepEqual(seen[0].body, { "project-id": "p2" });
  assert.equal(seen[0].url.searchParams.get("audit-message"), "moved");
  assert.equal(result.project, "p2");
  assert.equal("maintainers" in result, false);
});

test("a move refused keeps core's sentence", async () => {
  const body = { error: "Moving a vocabulary needs maintainer rights on both projects." };
  await assert.rejects(
    call(403, body, (c) => c.vocabLayers.move("v1", "p2")),
    (err) => err.status === 403 && /needs maintainer rights on both projects\./.test(err.message),
  );
});

test("borrowers lists the projects, a name null where unreadable", async () => {
  const answer = [
    { id: "p2", name: "B" },
    { id: "p3", name: null },
  ];
  const { result, seen } = await call(200, answer, (c) => c.vocabLayers.borrowers("v1"));
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].url.pathname, "/api/v1/vocab-layers/v1/borrowers");
  assert.deepEqual(result, answer);
});

test("unlinking the home is refused with core's sentence", async () => {
  const body = { error: "A vocabulary cannot be unlinked from its own project." };
  await assert.rejects(
    call(409, body, (c) => c.projects.unlinkVocab("p1", "v1")),
    (err) => err.status === 409 && /cannot be unlinked from its own project\./.test(err.message),
  );
});

test("a project delete refused keeps the count of borrowers", async () => {
  const body = { error: "2 other projects use a vocabulary of this project.", "other-projects": 2 };
  await assert.rejects(
    call(409, body, (c) => c.projects.delete("p1")),
    (err) =>
      err.status === 409 &&
      err.responseData["other-projects"] === 2 &&
      /2 other projects use a vocabulary of this project\./.test(err.message),
  );
});

test("a vocabulary has no maintainer methods", () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  assert.equal(client.vocabLayers.addMaintainer, undefined);
  assert.equal(client.vocabLayers.removeMaintainer, undefined);
});
