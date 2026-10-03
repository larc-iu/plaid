// A media delete names the recording it means (H36-SETTINGS-LIVE-1): the
// server refuses it 409 when the stored recording is another one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

test("deleteMedia sends the recording it means as media-version", () => {
  const client = new PlaidClient("http://x", "tok");
  const b = client.batch();
  try {
    b.documents.deleteMedia("d1", undefined, { mediaVersion: "1700000000000-5" });
    b.documents.deleteMedia("d2");
    const [named, bare] = b.operations;
    assert.equal(named.method, "DELETE");
    assert.match(named.path, /^\/api\/v1\/documents\/d1\/media\?(.*&)?media-version=1700000000000-5(&|$)/);
    assert.doesNotMatch(bare.path, /media-version/);
  } finally {
    b.abort();
  }
});
