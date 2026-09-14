import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

// The private key/value store is a paginated collection like every other one:
// a value runs to 1 MB, so a listing with values and no bound was the largest
// response the API could be asked for. `list` follows the cursors and hands
// back the flat array, `listPage` hands back the envelope.

// A client whose request layer answers from `pages` in turn, recording the
// query params each page was asked with.
function makeClient(pages) {
  const calls = [];
  const client = new PlaidClient("http://example.test", "tok");
  client._request = (method, path, options = {}) => {
    calls.push({ method, path, options });
    return Promise.resolve(pages[calls.length - 1]);
  };
  return { client, calls };
}

const entry = (key) => ({
  key,
  updatedAt: "2026-09-14T00:00:00Z",
  value: { key },
});

test("list follows the cursors and returns every entry flat", async () => {
  const { client, calls } = makeClient([
    { entries: [entry("a"), entry("b")], nextCursor: "cur-1" },
    { entries: [entry("c")], nextCursor: null },
  ]);

  const entries = await client.userData.list("u1", {
    pattern: "igt:assistant:*:meta:*",
    includeValues: true,
  });

  assert.deepEqual(
    entries.map((e) => e.key),
    ["a", "b", "c"],
  );
  assert.equal(calls.length, 2);
  // The narrowings ride along on every page, and so does the default bound.
  for (const call of calls) {
    assert.equal(call.path, "/api/v1/users/u1/data");
    assert.equal(call.options.queryParams.pattern, "igt:assistant:*:meta:*");
    assert.equal(call.options.queryParams["include-values"], true);
    assert.equal(call.options.queryParams.limit, 100);
  }
  assert.equal(calls[0].options.queryParams.cursor, undefined);
  assert.equal(calls[1].options.queryParams.cursor, "cur-1");
});

test("pageSize replaces the default bound", async () => {
  const { client, calls } = makeClient([{ entries: [], nextCursor: null }]);
  await client.userData.list("u1", { prefix: "igt:prefs:", pageSize: 500 });
  assert.equal(calls[0].options.queryParams.limit, 500);
  assert.equal(calls[0].options.queryParams.prefix, "igt:prefs:");
});

test("listPage hands back the envelope, cursor and all", async () => {
  const { client, calls } = makeClient([
    { entries: [entry("a")], nextCursor: "cur-1" },
  ]);

  const page = await client.userData.listPage("u1", {
    prefix: "igt:assistant:p1:meta:",
    limit: 1,
  });

  assert.deepEqual(
    page.entries.map((e) => e.key),
    ["a"],
  );
  assert.equal(page.nextCursor, "cur-1");
  assert.equal(calls[0].options.queryParams.limit, 1);
  assert.equal(calls[0].options.queryParams.prefix, "igt:assistant:p1:meta:");
});

test("iterPages yields one page at a time", async () => {
  const { client } = makeClient([
    { entries: [entry("a")], nextCursor: "cur-1" },
    { entries: [entry("b")], nextCursor: null },
  ]);

  const seen = [];
  for await (const page of client.userData.iterPages("u1", { pageSize: 1 })) {
    seen.push(page.map((e) => e.key));
  }
  assert.deepEqual(seen, [["a"], ["b"]]);
});
