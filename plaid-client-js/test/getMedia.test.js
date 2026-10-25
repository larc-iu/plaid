// documents.getMedia reads a document's recording through the client, so a
// reader gets the client's retries and error shape. The answer is a Blob of
// the bytes whose `type` is the served media type, `timeout` replaces the
// client's for this one read (a recording can take longer than 30 s to come
// down), and `onProgress` hears `{ loaded, total }` as the body arrives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);

function mediaResponse({ status = 200, type = "audio/x-wav", chunks = [BYTES] } = {}) {
  if (status !== 200) {
    return new Response(JSON.stringify({ error: "Busy" }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": type, "content-length": String(total) },
  });
}

async function withFetch(fetchImpl, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("getMedia answers a Blob of the bytes, typed as served", async () => {
  const client = new PlaidClient("http://x", "tok");
  const seen = [];
  const blob = await withFetch(
    async (url, init) => {
      seen.push({ url: String(url), init });
      return mediaResponse();
    },
    () => client.documents.getMedia("d1"),
  );
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, "audio/x-wav");
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [...BYTES]);
  assert.equal(seen[0].url, "http://x/api/v1/documents/d1/media");
  assert.equal(seen[0].init.headers.Authorization, "Bearer tok");
});

test("getMedia tells onProgress how far the body is in", async () => {
  const client = new PlaidClient("http://x", "tok");
  const heard = [];
  const chunks = [BYTES.slice(0, 2), BYTES.slice(2, 4), BYTES.slice(4)];
  const blob = await withFetch(
    async () => mediaResponse({ chunks }),
    () => client.documents.getMedia("d1", { onProgress: (p) => heard.push(p) }),
  );
  assert.deepEqual(heard, [
    { loaded: 2, total: 6 },
    { loaded: 4, total: 6 },
    { loaded: 6, total: 6 },
  ]);
  assert.equal(blob.size, 6);
  assert.equal(blob.type, "audio/x-wav");
});

test("getMedia's timeout replaces the client's for that read", async () => {
  const client = new PlaidClient("http://x", "tok", { timeout: 20 });
  // A server that takes 80 ms, unless the request is given up first.
  const slow = (_url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(mediaResponse()), 80);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      });
    });
  await withFetch(slow, async () => {
    await assert.rejects(client.documents.getMedia("d1"), (e) => e.status === 0);
    const blob = await client.documents.getMedia("d1", { timeout: null });
    assert.equal(blob.size, BYTES.length);
  });
});

test("getMedia reads again when the core is busy", async () => {
  const client = new PlaidClient("http://x", "tok");
  let calls = 0;
  const blob = await withFetch(
    async () => (calls++ === 0 ? mediaResponse({ status: 503 }) : mediaResponse()),
    () => client.documents.getMedia("d1"),
  );
  assert.equal(calls, 2);
  assert.equal(blob.size, BYTES.length);
});
