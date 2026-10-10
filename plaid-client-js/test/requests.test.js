// What a client method puts on the wire: method, path, query and body. The
// cases in fixtures/requests.json are shared with the Python client
// (tests/test_requests.py), so the two clients send the same request for the
// same call.
//
// A case calls `js` (bundle.method and its arguments, "$undefined" standing for
// undefined), or for each [bundle, kind] pair in `each`, with "<bundle>" and
// "<kind>" filled in. `sends` lists every request the call made, in order. The
// query is compared decoded, and a request with no query or no body leaves the
// key out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlaidClient } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "fixtures", "requests.json"), "utf8"));

/** The requests `call` makes, from a client whose fetch answers an empty page. */
async function sent([name, ...args]) {
  const out = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const request = { method: opts.method || "GET", path: u.pathname };
    if (u.search) request.query = Object.fromEntries(u.searchParams);
    if (opts.body !== undefined) request.body = JSON.parse(opts.body);
    out.push(request);
    return new Response(JSON.stringify({ entries: [], "next-cursor": null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const client = new PlaidClient("http://example.test", "tok");
    const [bundle, method] = name.split(".");
    const result = client[bundle][method](...args.map((a) => (a === "$undefined" ? undefined : a)));
    if (result && typeof result[Symbol.asyncIterator] === "function") {
      for await (const _page of result) break;
    } else {
      await result;
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return out;
}

/** A case, once per [bundle, kind] of its `each`. */
function expand(c) {
  if (!c.each) return [c];
  const fill = (value, bundle, kind) =>
    JSON.parse(JSON.stringify(value).replaceAll("<bundle>", bundle).replaceAll("<kind>", kind));
  return c.each.map(([bundle, kind]) => ({
    name: `${c.name} (${bundle})`,
    js: fill(c.js, bundle, kind),
    sends: fill(c.sends, bundle, kind),
  }));
}

for (const c of cases.flatMap(expand)) {
  test(c.name, async () => {
    assert.deepEqual(await sent(c.js), c.sends);
  });
}
