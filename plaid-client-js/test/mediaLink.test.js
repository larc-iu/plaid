// documents.mediaLink asks core for a link an audio or video element can
// stream from without an Authorization header. The answer is recased, its
// URL resolved against the client's base URL, and the call is a read that
// travels as a POST: no Idempotency-Key, and on a batch it goes over the wire.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(answer, seen) {
  return async (url, init) => {
    seen.push({ url, init });
    return {
      ok: answer.status < 300,
      status: answer.status,
      statusText: "",
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
    };
  };
}

async function withFetch(answer, fn) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = stubFetch(answer, seen);
  try {
    return { result: await fn(), seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const LINK = {
  url: "/api/v1/documents/d1/media?v=1-10&media-token=abc.def.ghi",
  "expires-at": "2026-10-09T18:00:00.000000000Z",
};

test("mediaLink answers an absolute url and expiresAt", async () => {
  const { result, seen } = await withFetch({ status: 200, body: LINK }, () =>
    new PlaidClient("http://core:8085/", "tok").documents.mediaLink("d1"),
  );
  assert.deepEqual(result, {
    url: "http://core:8085/api/v1/documents/d1/media?v=1-10&media-token=abc.def.ghi",
    expiresAt: "2026-10-09T18:00:00.000000000Z",
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].url, "http://core:8085/api/v1/documents/d1/media/link");
  const headers = new Headers(seen[0].init.headers);
  assert.equal(headers.get("Idempotency-Key"), null);
});

test("on a batch mediaLink goes over the wire and queues nothing", async () => {
  const client = new PlaidClient("http://core", "tok");
  const b = client.batch();
  try {
    const { result } = await withFetch({ status: 200, body: LINK }, () =>
      b.documents.mediaLink("d1"),
    );
    assert.equal(result.url, `http://core${LINK.url}`);
    assert.equal(b.operations.length, 0);
  } finally {
    b.abort();
  }
});

test("a document with no recording rejects with status 404", async () => {
  await assert.rejects(
    withFetch({ status: 404, body: { error: "No media file found" } }, () =>
      new PlaidClient("http://core", "tok").documents.mediaLink("d1"),
    ),
    (e) => e.status === 404,
  );
});
