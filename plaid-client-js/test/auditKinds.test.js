// Every audit read takes `kinds`, the operation kinds to keep, and sends it
// as `?kinds=` in the same comma-separated form `opTypes` goes in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

function stub() {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    sent.push(new URL(String(url)));
    const body = { entries: [], "next-cursor": null };
    return {
      ok: true,
      status: 200,
      headers: { get: (n) => (/content-type/i.test(n) ? "application/json" : null) },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
  return { sent, restore: () => (globalThis.fetch = real) };
}

const KINDS = ["review", "guess-adoption"];

test("every audit read sends kinds, from a list or a string", async () => {
  const c = new PlaidClient("http://x", "tok");
  const { sent, restore } = stub();
  try {
    await c.documents.audit("d1", undefined, undefined, undefined, KINDS);
    await c.documents.auditPage("d1", { kinds: KINDS });
    await c.projects.audit("p1", undefined, undefined, undefined, KINDS);
    await c.projects.auditPage("p1", { kinds: KINDS });
    await c.users.audit("u1", undefined, undefined, undefined, KINDS);
    await c.users.auditPage("u1", { kinds: KINDS });
    await c.vocabLayers.audit("v1", undefined, undefined, undefined, undefined, KINDS);
    await c.vocabLayers.auditPage("v1", { kinds: KINDS });
    await c.audit.list({ kinds: KINDS });
    await c.audit.listPage({ kinds: "review,guess-adoption" });
    for await (const page of c.audit.iterPages({ kinds: KINDS })) void page;
  } finally {
    restore();
  }
  assert.equal(sent.length, 11);
  for (const u of sent) {
    assert.equal(u.searchParams.get("kinds"), "review,guess-adoption", u.pathname);
  }
});

test("no kinds, or an empty list, sends none", async () => {
  const c = new PlaidClient("http://x", "tok");
  const { sent, restore } = stub();
  try {
    await c.documents.audit("d1");
    await c.projects.auditPage("p1", { kinds: [] });
  } finally {
    restore();
  }
  for (const u of sent) assert.equal(u.searchParams.has("kinds"), false);
});
