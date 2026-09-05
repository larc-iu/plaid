import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDocumentVersions } from "../src/http.js";

const headers = (map) => ({ get: (k) => map[k] ?? null });

test("a live document read teaches the client the document version", () => {
  const client = { documentVersions: {} };
  extractDocumentVersions(client, headers({}), {
    "document/id": "d1",
    "document/version": 12,
  });
  assert.deepEqual(client.documentVersions, { d1: 12 });
});

test("an as-of read does not: its body carries a version that is no longer current", () => {
  const client = { documentVersions: { d1: 12 } };
  extractDocumentVersions(
    client,
    headers({}),
    { "document/id": "d1", "document/version": 3 },
    { historical: true },
  );
  assert.deepEqual(client.documentVersions, { d1: 12 });
});

test("the header is learned from either way, since it always carries the live version", () => {
  const client = { documentVersions: {} };
  extractDocumentVersions(
    client,
    headers({ "X-Document-Versions": JSON.stringify({ d1: 13 }) }),
    { "document/id": "d1", "document/version": 3 },
    { historical: true },
  );
  assert.deepEqual(client.documentVersions, { d1: 13 });
});
