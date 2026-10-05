// Small surface points the two clients must share (PARITY 15).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PlaidClient,
  MAX_BATCH_OPS,
  isMachine,
  stampInferred,
  confirmedInferred,
  stampContributed,
} from "../src/index.js";
import { reportRequestEvent } from "../src/services.js";

function stubFetch(sent, pages = [{ entries: [], "next-cursor": null }]) {
  let i = 0;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push({ url: String(url), method: opts.method || "GET" });
    const page = pages[Math.min(i++, pages.length - 1)];
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => page,
    };
  };
}

test("a query is a read, so it takes no audit message", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  try {
    await client.query({ find: ["?t"], where: [] }, "labelled");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].url.includes("audit-message"), sent[0].url);
});

test("a vocabulary's comments page like a project's", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent, [
    { entries: [{ id: "c1" }], "next-cursor": "k" },
    { entries: [{ id: "c2" }], "next-cursor": null },
  ]);
  const pages = [];
  try {
    for await (const page of client.comments.iterInVocabPages("v1", {
      entityId: "e1",
      pageSize: 1,
    })) {
      pages.push(page.map((c) => c.id));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(pages, [["c1"], ["c2"]]);
  const first = new URL(sent[0].url);
  assert.equal(first.pathname, "/api/v1/vocab-layers/v1/comments");
  assert.equal(first.searchParams.get("entity-id"), "e1");
  assert.equal(first.searchParams.get("limit"), "1");
  assert.equal(new URL(sent[1].url).searchParams.get("cursor"), "k");
});

// AU-CLIENTS (2026-10-05): the points below were found different between the
// two clients and made the same. Each has its Python twin in test_surface.py.

test("a request id is one path segment in every service request path", async () => {
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  stubFetch(sent);
  // The attach stream is answered 404, which ends it at once.
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("/service-requests/") && (opts.method || "GET") === "GET") {
      sent.push({ url: String(url), method: "GET" });
      return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null } };
    }
    return inner(url, opts);
  };
  const odd = "a/b?c#d";
  try {
    await reportRequestEvent(client, "p", odd, { status: "completed" });
    await client.messages.cancelServiceRequest("p", odd);
    await client.messages.attachServiceRequest("p", odd).catch((e) => {
      assert.equal(e.status, 404);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(
    sent.map((s) => s.url),
    [
      "http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d/events",
      "http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d",
      "http://x/api/v1/projects/p/service-requests/a%2Fb%3Fc%23d",
    ],
  );
});

test("a timeout of 0 disables it, as in the Python client", async () => {
  const client = new PlaidClient("http://x", "tok", { timeout: 0 });
  const signals = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    signals.push(opts.signal ?? null);
    const body = String(url).endsWith("/batch")
      ? [{ status: 200, headers: {}, body: {} }]
      : {};
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => body,
    };
  };
  try {
    await client.projects.get("p");
    await client.batched(async (b) => {
      b.projects.update("p", "n");
    });
    await client.projects.delete("p", undefined, { timeout: 0 });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(signals, [null, null, null]);
  assert.equal(client.batchTimeout, 0);
});

test("login and redeemInvite forward the client options", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ token: "tk", "user-id": "u", kind: "signup" }),
  });
  try {
    let c = await PlaidClient.login("http://x", "u", "pw", {
      batchTimeout: null,
      retryDelaysMs: [100],
    });
    assert.deepEqual([c.token, c.batchTimeout, c.retryDelaysMs], ["tk", null, [100]]);
    const redeemed = await PlaidClient.redeemInvite(
      "http://x",
      "code",
      { password: "password1" },
      { batchTimeout: 7000, retryDelaysMs: [] },
    );
    c = redeemed.client;
    assert.deepEqual([c.token, c.batchTimeout, c.retryDelaysMs, redeemed.kind], ["tk", 7000, [], "signup"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the index exports what the Python package exports", () => {
  assert.equal(MAX_BATCH_OPS, 1000);
  assert.equal(isMachine(stampInferred("service:x")), true);
  assert.equal(isMachine(confirmedInferred("service:x")), false);
  assert.equal(isMachine(stampContributed("u")), false);
  assert.equal(isMachine(null), false);
  assert.equal(isMachine({ gloss: "dog" }), false);
});
