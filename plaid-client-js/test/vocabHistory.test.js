// A vocabulary's history: the whole vocabulary at a time, one entry at a
// time (also after it was deleted), its audit log, and putting one entry back.
// The restore bumps every document linking the entry when it sets the form
// back, so its X-Document-Versions (or the omitted marker) is taken up like
// any write's. What each read sends is in fixtures/requests.json. Here: what
// the answers become.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

const T = "2026-06-01T12:00:00Z";

const headers = (h) => ({
  get: (n) => {
    const key = Object.keys(h).find(
      (k) => k.toLowerCase() === String(n).toLowerCase(),
    );
    return key === undefined ? null : h[key];
  },
});

function stub(answer = () => ({ body: {} })) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const method = opts.method || "GET";
    sent.push({ url: u, method });
    const { body, extra = {} } = answer(u, method);
    return {
      ok: true,
      status: 200,
      headers: headers({ "content-type": "application/json", ...extra }),
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { sent, restore: () => (globalThis.fetch = real) };
}

test("the vocabulary read and one entry's read are recased", async () => {
  const client = new PlaidClient("http://x", "tok");
  const { restore } = stub((u) => ({
    body: u.pathname.includes("/items/")
      ? { "vocab-item/id": "i1", "vocab-item/form": "kai" }
      : {
          "vocab/id": "v1",
          "vocab/name": "Lex",
          "vocab/items": [{ "vocab-item/id": "i1", "vocab-item/form": "kai" }],
        },
  }));
  try {
    const at = await client.vocabLayers.get("v1", true, T);
    assert.equal(at.name, "Lex");
    assert.deepEqual(at.items, [{ id: "i1", form: "kai" }]);
    assert.deepEqual(await client.vocabLayers.getItemAt("v1", "i1", T), { id: "i1", form: "kai" });
  } finally {
    restore();
  }
});

test("the vocabulary log pages as the document log does", async () => {
  const client = new PlaidClient("http://x", "tok");
  const { sent, restore } = stub((u) => ({
    body: u.searchParams.get("cursor")
      ? { entries: [{ "audit/id": "a2" }], "next-cursor": null }
      : { entries: [{ "audit/id": "a1" }], "next-cursor": "k" },
  }));
  let all, page;
  try {
    all = await client.vocabLayers.audit("v1");
    page = await client.vocabLayers.auditPage("v1", { limit: 1 });
  } finally {
    restore();
  }
  assert.deepEqual(
    all.map((e) => e.id),
    ["a1", "a2"],
  );
  assert.equal(sent[1].url.searchParams.get("cursor"), "k");
  assert.deepEqual(page, { entries: [{ id: "a1" }], nextCursor: "k" });
});

test("an entry restore takes up the linking documents' new versions", async () => {
  const client = new PlaidClient("http://x", "tok");
  client.documentVersions = { d1: 3, d9: 1 };
  const { restore } = stub(() => ({
    body: { inserted: false, form: true, metadata: false, total: 1 },
    extra: { "X-Document-Versions": JSON.stringify({ d1: 4, d2: 8 }) },
  }));
  try {
    const summary = await client.vocabLayers.restoreItem("v1", "i1", T);
    assert.deepEqual(summary, {
      inserted: false,
      form: true,
      metadata: false,
      total: 1,
    });
  } finally {
    restore();
  }
  assert.deepEqual(client.documentVersions, { d1: 4, d2: 8, d9: 1 });
});

test("past fifty linking documents the restore's marker forgets every version held", async () => {
  const client = new PlaidClient("http://x", "tok");
  client.documentVersions = { d1: 3 };
  const { restore } = stub(() => ({
    body: { inserted: false, form: true, metadata: false, total: 1 },
    extra: { "X-Document-Versions-Omitted": "73" },
  }));
  try {
    await client.vocabLayers.restoreItem("v1", "i1", T);
  } finally {
    restore();
  }
  assert.deepEqual(client.documentVersions, {});
  assert.equal(client.documentVersionsOmitted, true);
});
