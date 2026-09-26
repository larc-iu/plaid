import { test } from "node:test";
import assert from "node:assert/strict";
import { createdId, createdIds } from "../src/index.js";

test("createdId reads a create's response and its batch result alike", () => {
  assert.equal(createdId({ id: "a" }), "a");
  assert.equal(createdId({ status: 201, body: { id: "a" } }), "a");
  // A create that answers with the whole row, a comment with its own body.
  assert.equal(createdId({ id: "a", body: "a comment" }), "a");
});

test("createdId gives undefined for a response with no id, never the response itself", () => {
  for (const result of [
    undefined,
    null,
    {},
    { body: {} },
    { body: null },
    "a",
    { id: 3 },
  ]) {
    assert.equal(createdId(result), undefined, JSON.stringify(result));
  }
});

test("createdIds reads a bulk create's response and its batch result alike", () => {
  assert.deepEqual(createdIds({ ids: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(createdIds({ status: 201, body: { ids: ["a"] } }), ["a"]);
});

test("createdIds gives an empty array for a response with no ids", () => {
  for (const result of [
    undefined,
    null,
    {},
    { body: {} },
    { ids: "a" },
    { body: null },
  ]) {
    assert.deepEqual(createdIds(result), [], JSON.stringify(result));
  }
});
