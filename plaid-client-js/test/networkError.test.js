// A request that failed with no answer: whether the browser said it was
// offline, which is what lets a document write go again once the network is
// back rather than be refused (V5, H5-4).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeNetworkError } from "../src/http.js";

const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const setOnline = (onLine) =>
  Object.defineProperty(globalThis, "navigator", {
    value: { onLine },
    configurable: true,
    writable: true,
  });

afterEach(() => {
  if (had) Object.defineProperty(globalThis, "navigator", had);
  else delete globalThis.navigator;
});

test("a failure while the browser is offline says so", () => {
  setOnline(false);
  const e = makeNetworkError(
    new TypeError("Failed to fetch"),
    "http://x/api/v1/spans",
    "POST",
  );
  assert.equal(e.status, 0);
  assert.equal(e.offline, true);
});

test("a failure while online does not", () => {
  setOnline(true);
  const e = makeNetworkError(
    new TypeError("Failed to fetch"),
    "http://x/api/v1/spans",
    "POST",
  );
  assert.equal(e.offline, undefined);
});

test("a timeout is never offline: the request went, and may still land", () => {
  setOnline(false);
  const t = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const e = makeNetworkError(t, "http://x/api/v1/spans", "POST");
  assert.equal(e.offline, undefined);
});
