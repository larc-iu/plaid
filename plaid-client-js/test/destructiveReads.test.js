// What a vocabulary delete, a project delete or an unlink would take is a GET
// on a route of its own (`vocabLayers.deletion`, `projects.deletion`,
// `projects.vocabUnlinking`), never the destructive request with a flag. The
// destructive methods take no `dryRun` any more, and one passed (a caller from
// before) throws before anything is sent, since it would now delete. The same
// as plaid-client-py's tests/test_destructive_reads.py.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(status, body) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: new URL(String(url)), method: init?.method });
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
  const client = new PlaidClient("http://plaid.test", "tok", { retryDelays: [] });
  const { seen, restore } = stubFetch(status, body);
  try {
    return { result: await fn(client), seen };
  } finally {
    restore();
  }
}

const READS = [
  ["vocabLayers.deletion", (c) => c.vocabLayers.deletion("v1"), "/api/v1/vocab-layers/v1/deletion", { links: 4 }],
  [
    "projects.deletion",
    (c) => c.projects.deletion("p1"),
    "/api/v1/projects/p1/deletion",
    { vocabularies: [{ id: "v1", name: "Lex" }] },
  ],
  [
    "projects.vocabUnlinking",
    (c) => c.projects.vocabUnlinking("p2", "v1"),
    "/api/v1/projects/p2/vocabs/v1/unlinking",
    { links: 3 },
  ],
];

for (const [name, fn, path, answer] of READS) {
  test(`${name} is a GET on its own route, with no query, and answers core's body`, async () => {
    const { result, seen } = await call(200, answer, fn);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "GET");
    assert.equal(seen[0].url.pathname, path);
    assert.equal(seen[0].url.search, "");
    assert.deepEqual(result, answer);
  });
}

test("a read refused keeps core's count of the projects in the way", async () => {
  const body = { error: "2 other projects use this vocabulary.", "other-projects": 2 };
  await assert.rejects(
    call(409, body, (c) => c.vocabLayers.deletion("v1")),
    (err) => err.status === 409 && err.responseData["other-projects"] === 2,
  );
});

const LEFTOVERS = [
  ["vocabLayers.delete", (c) => c.vocabLayers.delete("v1", undefined, { dryRun: true })],
  ["projects.delete", (c) => c.projects.delete("p1", undefined, { dryRun: true })],
  ["projects.delete with a timeout", (c) => c.projects.delete("p1", undefined, { timeout: 5, dryRun: true })],
  ["projects.unlinkVocab", (c) => c.projects.unlinkVocab("p2", "v1", undefined, { dryRun: true })],
];

for (const [name, fn] of LEFTOVERS) {
  test(`${name} given a leftover { dryRun: true } throws and sends nothing`, async () => {
    const client = new PlaidClient("http://plaid.test", "tok", { retryDelays: [] });
    const { seen, restore } = stubFetch(204, null);
    try {
      assert.throws(() => fn(client), (err) => err instanceof TypeError && /dryRun/.test(err.message));
    } finally {
      restore();
    }
    assert.equal(seen.length, 0, "nothing was sent");
  });
}

test("the destructive methods still send the plain request", async () => {
  for (const [fn, method, path] of [
    [(c) => c.vocabLayers.delete("v1"), "DELETE", "/api/v1/vocab-layers/v1"],
    [(c) => c.projects.delete("p1", "Gone", { timeout: 5000 }), "DELETE", "/api/v1/projects/p1"],
    [(c) => c.projects.unlinkVocab("p2", "v1"), "DELETE", "/api/v1/projects/p2/vocabs/v1"],
  ]) {
    const { seen } = await call(204, null, fn);
    assert.equal(seen[0].method, method);
    assert.equal(seen[0].url.pathname, path);
    assert.equal(seen[0].url.searchParams.get("dry-run"), null);
  }
});
