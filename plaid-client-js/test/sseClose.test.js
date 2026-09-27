// Once a stream is CLOSED, `error` says why: a refusal carries its HTTP
// status (which is what serve() decides to stop on), and a stream the server
// ended is told apart from one this side closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSSEConnection } from "../src/sse.js";

const client = { baseUrl: "http://x", token: "tok" };

async function settled(conn) {
  for (let i = 0; i < 50 && conn.readyState !== 2; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a refused stream records the status", async () => {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden" });
  try {
    const conn = createSSEConnection(client, "p1", () => {});
    await settled(conn);
    assert.equal(conn.readyState, 2);
    assert.equal(conn.error?.status, 403);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
  }
});

test("a stream the server ends says so, and one closed here does not", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
  });
  try {
    const ended = createSSEConnection(client, "p1", () => {});
    await settled(ended);
    assert.equal(ended.error?.name, "StreamClosed");

    const mine = createSSEConnection(client, "p1", () => {});
    mine.close();
    await settled(mine);
    assert.equal(mine.error, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
