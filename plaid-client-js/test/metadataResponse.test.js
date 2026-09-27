// A metadata write answers the entity, recased like every other write's
// answer, whether it went alone or on a batch (where every result is
// recased). It used to come back as the raw wire map when sent alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (n) =>
        String(n).toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => ({
      "token/id": "e1",
      "token/begin": 0,
      metadata: { "kebab-key": 1, "ns/k": 2 },
    }),
  });
}

test("every metadata write answers the recased entity", async () => {
  const client = new PlaidClient("http://x", "tok");
  const bundles = Object.entries(client).filter(
    ([, v]) => v && typeof v === "object" && typeof v.setMetadata === "function",
  );
  assert.equal(bundles.length, 7, "the seven entity types with metadata");
  const realFetch = globalThis.fetch;
  stubFetch();
  try {
    for (const [name, bundle] of bundles) {
      for (const [method, args] of [
        ["setMetadata", ["e1", { a: 1 }]],
        ["patchMetadata", ["e1", [{ op: "set", path: ["a"], value: 1 }]]],
        ["deleteMetadata", ["e1"]],
      ]) {
        const answer = await bundle[method](...args);
        assert.deepEqual(
          answer,
          { id: "e1", begin: 0, metadata: { "kebab-key": 1, "ns/k": 2 } },
          `${name}.${method}`,
        );
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
