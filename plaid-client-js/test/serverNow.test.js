// The server's clock, as its responses' Date header gives it. A time the
// server stamped (an audit entry's `ts`) is judged against this, never the
// browser's own clock, which can be minutes off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stubFetch(date) {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get: (n) => {
        const name = String(n).toLowerCase();
        if (name === "content-type") return "application/json";
        if (name === "date") return date;
        return null;
      },
    },
    json: async () => ({}),
  });
}

test("serverNow reads the server's clock from the last response", async () => {
  const client = new PlaidClient("http://x", "tok");
  const realFetch = globalThis.fetch;
  // The server is ten minutes behind this machine.
  const server = new Date(Date.now() - 10 * 60e3);
  stubFetch(server.toUTCString());
  try {
    await client.documents.checkLock("d1");
  } finally {
    globalThis.fetch = realFetch;
  }
  const drift = Math.abs(client.serverNow().getTime() - server.getTime());
  assert.ok(drift < 2000, `off by ${drift} ms`);
});

test("with no Date header seen, serverNow is this machine's clock", async () => {
  const client = new PlaidClient("http://x", "tok");
  assert.ok(Math.abs(client.serverNow().getTime() - Date.now()) < 1000);
  const realFetch = globalThis.fetch;
  stubFetch(null);
  try {
    await client.documents.checkLock("d1");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(Math.abs(client.serverNow().getTime() - Date.now()) < 1000);
});
