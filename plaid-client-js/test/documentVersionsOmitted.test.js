// Past fifty documents the server leaves X-Document-Versions out of a write's
// response and sends X-Document-Versions-Omitted (the number left out). The
// header grew about 43 bytes a document with no limit, and Node's fetch
// refused a response past 16 KB after the write had committed. A client that
// sees the marker forgets every version it held, since any may be one of those
// left out, and learns its strict-mode document's again before it writes there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";
import { extractDocumentVersions } from "../src/http.js";

const headers = (h) => ({
  get: (n) => {
    const key = Object.keys(h).find((k) => k.toLowerCase() === String(n).toLowerCase());
    return key === undefined ? null : h[key];
  },
});

// A fake server: a bulk update answers with the marker, a document read with
// the document's version, anything else with a plain 200.
function stubServer({ docVersion = 42, failRead = false } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || "GET";
    calls.push({ path: u.pathname, method, version: u.searchParams.get("document-version") });
    if (method === "GET" && failRead) throw new TypeError("fetch failed");
    let body = {};
    let extra = {};
    if (u.pathname.endsWith("/bulk")) {
      body = { count: 60 };
      extra = { "X-Document-Versions-Omitted": "60" };
    } else if (method === "GET" && u.pathname.startsWith("/api/v1/documents/")) {
      body = { "document/id": u.pathname.split("/").pop(), "document/version": docVersion };
    }
    return {
      ok: true,
      status: 200,
      headers: headers({ "content-type": "application/json", ...extra }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("the marker forgets every version the client held", () => {
  const client = { documentVersions: { d1: 3, d2: 9 } };
  extractDocumentVersions(client, headers({ "X-Document-Versions-Omitted": "120" }));
  assert.deepEqual(client.documentVersions, {});
  assert.equal(client.documentVersionsOmitted, true);
});

test("a response without the marker keeps the versions and merges the list", () => {
  const client = { documentVersions: { d1: 3 } };
  extractDocumentVersions(client, headers({ "X-Document-Versions": JSON.stringify({ d2: 5 }) }));
  assert.deepEqual(client.documentVersions, { d1: 3, d2: 5 });
  assert.equal(client.documentVersionsOmitted, undefined);
});

test("a strict client reads its document's version right after the marker, and stamps it", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  client.enterStrictMode("d1");
  client.documentVersions = { d1: 7 };
  const { calls, restore } = stubServer({ docVersion: 42 });
  try {
    await client.spans.bulkUpdate([{ id: "s1", value: "X" }]);
    assert.equal(client.documentVersions.d1, 42, "learned again, not the stale 7");
    await client.spans.update("s1", "Y");
  } finally {
    restore();
  }
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.version]),
    [
      ["PATCH", "/api/v1/spans/bulk", "7"],
      ["GET", "/api/v1/documents/d1", null],
      ["PATCH", "/api/v1/spans/s1", "42"],
    ],
  );
});

test("when that read fails the write still succeeds, and the next strict write asks again", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  client.enterStrictMode("d1");
  client.documentVersions = { d1: 7 };
  let server = stubServer({ failRead: true });
  try {
    const result = await client.spans.bulkUpdate([{ id: "s1", value: "X" }]);
    assert.deepEqual(result, { count: 60 }, "the committed write is reported as such");
  } finally {
    server.restore();
  }
  assert.equal(client.documentVersions.d1, undefined);
  server = stubServer({ docVersion: 43 });
  try {
    await client.spans.update("s1", "Y");
  } finally {
    server.restore();
  }
  assert.deepEqual(
    server.calls.map((c) => [c.method, c.path, c.version]),
    [
      ["GET", "/api/v1/documents/d1", null],
      ["PATCH", "/api/v1/spans/s1", "43"],
    ],
    "the write goes out stamped, never unchecked",
  );
});

test("a client not in strict mode does not read anything extra", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  client.documentVersions = { d1: 7 };
  const { calls, restore } = stubServer();
  try {
    await client.spans.bulkUpdate([{ id: "s1", value: "X" }]);
    await client.spans.update("s1", "Y");
  } finally {
    restore();
  }
  assert.deepEqual(calls.map((c) => c.method), ["PATCH", "PATCH"]);
  assert.deepEqual(client.documentVersions, {});
});

test("a write made while that read is in flight waits for it and goes out stamped", async () => {
  const client = new PlaidClient("http://plaid.test", "tok");
  client.enterStrictMode("d1");
  client.documentVersions = { d1: 7 };
  const { calls, restore } = stubServer({ docVersion: 42 });
  // Hold the document read until the second write has started.
  const inner = globalThis.fetch;
  let releaseRead;
  const readHeld = new Promise((resolve) => (releaseRead = resolve));
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || "GET") === "GET") await readHeld;
    return inner(url, opts);
  };
  try {
    const first = client.spans.bulkUpdate([{ id: "s1", value: "X" }]);
    while (!calls.some((c) => c.method === "PATCH")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = client.spans.update("s1", "Y");
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseRead();
    await Promise.all([first, second]);
  } finally {
    restore();
  }
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.version]),
    [
      ["PATCH", "/api/v1/spans/bulk", "7"],
      ["GET", "/api/v1/documents/d1", null],
      ["PATCH", "/api/v1/spans/s1", "42"],
    ],
  );
});
