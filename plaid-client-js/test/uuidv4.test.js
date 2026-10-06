import { test } from "node:test";
import assert from "node:assert/strict";
import { uuidv4 } from "../src/ids.js";

test("uuidv4 is a random version 4 UUID built without crypto.randomUUID", () => {
  const saved = globalThis.crypto.randomUUID;
  // A page served over plain HTTP from another host has no randomUUID.
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv4()));
    assert.equal(ids.size, 1000);
    for (const id of ids) {
      assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: saved, configurable: true });
  }
});
