// A service request the server refuses carries the server's reason, as every
// other route's error does: in the message and as `responseData`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { requestService } from "../src/services.js";

const client = { baseUrl: "http://plaid.test", token: "t" };

const answering = async (response, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => response;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};

test("a refused request says why", async () => {
  const error =
    "IGT Assistant is run by Ana, who is not a maintainer of Kalamang. Remove Kalamang from this conversation to go on.";
  await answering(
    {
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ error }),
    },
    () =>
      assert.rejects(requestService(client, "p1", "s1", {}, 60000), (e) => {
        assert.equal(e.status, 403);
        assert.deepEqual(e.responseData, { error });
        assert.ok(e.message.endsWith(error));
        return true;
      }),
  );
});

test("a refusal with no readable body still rejects with its status", async () => {
  await answering(
    {
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => {
        throw new SyntaxError("not json");
      },
    },
    () =>
      assert.rejects(requestService(client, "p1", "s1", {}, 60000), (e) => {
        assert.equal(e.status, 403);
        assert.equal(e.responseData, undefined);
        return true;
      }),
  );
});
