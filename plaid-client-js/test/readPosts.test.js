// The reads that travel as a POST. A lost answer to one saved nothing, so a
// service never tells its requester "may or may not have been saved" about
// it. plaid-ui's errors.js, this client's services.js and the Python twin's
// services.py each keep the list, and they must keep the same one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { requesterMessage } from "../src/services.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// A JS regex literal's source and a Python raw string, written as one
// pattern: JS escapes the slash, Python need not.
const jsPattern = (source) =>
  source.match(/const READ_POSTS =\s*\/(.+)\/;/)[1].replaceAll("\\/", "/");
const pyPattern = (source) =>
  source.match(/_READ_POSTS = re\.compile\(r'(.+)'\)/)[1];

test("errors.js, services.js and services.py keep one list", () => {
  const ui = jsPattern(read("../../plaid-ui/src/lib/errors.js"));
  assert.equal(jsPattern(read("../src/services.js")), ui);
  assert.equal(pyPattern(read("../../plaid-client-py/src/plaid_client/services.py")), ui);
});

test("a read sent as a POST whose answer was lost saved nothing", () => {
  const timedOut = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  for (const path of [
    "/api/v1/query",
    "/api/v1/query/token-counts",
    "/api/v1/login",
    "/api/v1/invites/lookup",
    "/api/v1/token-layers/L1/constraints/check",
    "/api/v1/span-layers/L1/constraints/check",
    "/api/v1/relation-layers/L1/constraints/refused-values?x=1",
  ]) {
    const error = new Error(`Network error: timed out at http://h${path}`);
    Object.assign(error, {
      status: 0,
      url: `http://h${path}`,
      method: "POST",
      originalError: timedOut,
    });
    assert.equal(requesterMessage(error), "The Plaid server did not answer.", path);
  }
});
