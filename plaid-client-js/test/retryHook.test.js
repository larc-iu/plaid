// client.onRetry: a screen that writes through the client directly (igt's
// Bulk Edit) hears that a request is being sent again, so it can say the
// server is not answering though the browser is online (H10-CONC-5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

const answer = (status, body = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("onRetry hears a busy read and a write whose answer was lost, until unsubscribed", async () => {
  const replies = [answer(503, { error: "Database busy" }), answer(200, { id: "p1" }),
    answer(502, { error: "Bad gateway" }), answer(200, {})];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => replies.shift();
  try {
    const client = new PlaidClient("http://localhost:0", "t", { retryDelaysMs: [1] });
    const heard = [];
    const stop = client.onRetry((info) => heard.push([info.attempt, info.error.status]));
    await client.projects.get("p1");
    await client.spans.delete("s1");
    assert.deepEqual(heard, [[1, 503], [1, 502]]);
    stop();
    replies.push(answer(503), answer(200, { id: "p1" }));
    await client.projects.get("p1");
    assert.equal(heard.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
