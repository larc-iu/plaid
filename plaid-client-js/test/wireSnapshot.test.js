// The wire snapshot: what every bundle method of the client sends, held in
// fixtures/wire.json, with `client.query` and the static entry points
// (`PlaidClient.login` and the others). Each method is called with stub
// arguments twice, on the client inside an open logical operation and on a
// batch. What goes into the snapshot per method:
//
// - `sends`: each request the call made on the client, in order, as its verb,
//   path, query (keys sorted) and body, with every minted UUID written <uuid>,
//   plus `keyed` when it carried an Idempotency-Key.
// - `batch`: what the same call did on a batch: "queued" with the queued
//   operations, "wire" when it went out at once, "threw" or "nothing".
// - `outcome`: "ok", "threw" or "pending" for the call on the client.
// - `args`: the stub arguments it was called with, "$fn" for a callback and
//   "$undefined" for undefined. The probe calls a method the snapshot holds
//   with these, so a refactor that renames a parameter compares the same call.
//   A method that gains a parameter is given it by deleting its line before
//   regenerating.
//
// A refactor that moves code proves itself by leaving this file unchanged.
// After a change that is meant to change the wire, regenerate it with
//   UPDATE_WIRE=1 node --test test/wireSnapshot.test.js
// and read the diff.
//
// The probe runs in a child process (this file again, with WIRE_PROBE=1), so
// the keep-alive timers some methods start end with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "wire.json");

// The stub arguments, read from the method's own parameter list: "a0", "a1",
// ... one per parameter, an options object written `{ x, y } = {}` gets
// "a2.x", "a2.y" for its keys, a callback (`fn`, `onEvent`) an async no-op, a static
// entry point's `baseUrl` the stub server's. The keys
// below are left out (undefined), since a string there would be a
// timer or a callback.
const SKIPPED_OPTIONS = new Set(["timeout", "signal", "onProgress", "onUploadProgress"]);

/** `src` split at its top-level commas. */
function splitTop(src) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      parts.push(src.slice(start, i));
      start = i + 1;
    }
  }
  if (src.slice(start).trim()) parts.push(src.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The parameter list of `fn`, as written. */
function paramsOf(fn) {
  const src = fn.toString();
  const open = src.indexOf("(");
  const arrow = src.indexOf("=>");
  if (arrow !== -1 && (open === -1 || arrow < open)) {
    // `x => ...`
    return [
      src
        .slice(0, arrow)
        .replace(/^async\s+/, "")
        .trim(),
    ];
  }
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return splitTop(src.slice(open + 1, i));
  }
  return [];
}

const encodeArg = (a) => (typeof a === "function" ? "$fn" : a === undefined ? "$undefined" : a);
const decodeArg = (a) => (a === "$fn" ? async () => {} : a === "$undefined" ? undefined : a);

export function stubArgs(fn) {
  return paramsOf(fn).flatMap((param, i) => {
    if (param.startsWith("...")) return [];
    if (param.startsWith("{")) {
      const inner = param.slice(1, param.lastIndexOf("}"));
      const opts = {};
      for (const part of splitTop(inner)) {
        const key = part.split(/[:=]/)[0].trim();
        if (!SKIPPED_OPTIONS.has(key)) opts[key] = `a${i}.${key}`;
      }
      return [opts];
    }
    const name = param.split("=")[0].trim();
    if (SKIPPED_OPTIONS.has(name)) return [undefined];
    if (name === "fn" || name === "callback" || /^on[A-Z]/.test(name)) return [async () => {}];
    if (name === "baseUrl") return ["http://wire.test"];
    return [`a${i}`];
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

function scrub(value) {
  if (typeof value === "string") return value.replace(UUID, "<uuid>");
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = scrub(value[k]);
    return out;
  }
  return value;
}

function parseBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== "string") return { $form: true };
  try {
    return JSON.parse(body);
  } catch {
    return { $raw: body };
  }
}

function requestOf(url, opts, baseUrl) {
  const u = new URL(String(url));
  const request = { method: (opts.method || "GET").toUpperCase(), path: u.pathname };
  if (!String(url).startsWith(baseUrl)) request.host = u.host;
  if (u.search) {
    const query = {};
    for (const k of [...new Set(u.searchParams.keys())].sort()) {
      const vs = u.searchParams.getAll(k);
      query[k] = vs.length === 1 ? vs[0] : vs;
    }
    request.query = query;
  }
  const body = parseBody(opts.body);
  if (body !== undefined) request.body = body;
  const headers = opts.headers || {};
  if (Object.keys(headers).some((h) => h.toLowerCase() === "idempotency-key")) request.keyed = true;
  return scrub(request);
}

function answer() {
  return new Response(JSON.stringify({ entries: [], "next-cursor": null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const settle = (p, ms) =>
  Promise.race([
    Promise.resolve(p).then(
      () => "ok",
      () => "threw",
    ),
    new Promise((r) => setTimeout(() => r("pending"), ms)),
  ]);

async function drive(result) {
  if (result && typeof result[Symbol.asyncIterator] === "function") {
    for await (const _ of result) break;
    return;
  }
  return await result;
}

/** The snapshot of the client in `indexPath`, as a plain object. A method in
 * `pinned` (an earlier snapshot) is called with the arguments it holds. */
export async function probe(indexPath, pinned = {}) {
  const { PlaidClient } = await import(pathToFileURL(indexPath).href);
  // Requests are told apart by the token of the client that sent them, so a
  // timer a call left running cannot write into another call's record.
  let live = null;
  let sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const auth = (opts.headers || {}).Authorization || (opts.headers || {}).authorization;
    if (auth === `Bearer ${live}` || (!auth && live))
      sent.push(requestOf(url, opts, "http://wire.test"));
    return answer();
  };
  globalThis.EventSource = undefined;
  let n = 0;
  const fresh = () => {
    live = `tok${n++}`;
    sent = [];
    return new PlaidClient("http://wire.test", live, { retryDelaysMs: [] });
  };

  const isBundle = (v) =>
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.values(v).some((f) => typeof f === "function");
  // [bundle, method], with "client" for a function on the client itself
  // (query) and "PlaidClient" for the static entry points.
  const names = [];
  for (const [b, v] of Object.entries(fresh())) {
    if (b.startsWith("_")) continue;
    if (typeof v === "function") names.push(["client", b]);
    else if (isBundle(v)) {
      for (const m of Object.keys(v)) if (typeof v[m] === "function") names.push([b, m]);
    }
  }
  for (const m of Object.getOwnPropertyNames(PlaidClient)) {
    if (typeof PlaidClient[m] === "function") names.push(["PlaidClient", m]);
  }
  names.sort((x, y) => (x.join(".") < y.join(".") ? -1 : 1));

  const bound = (target, b, m) => {
    const owner = b === "PlaidClient" ? PlaidClient : b === "client" ? target : target[b];
    return owner[m].bind(owner);
  };
  const unbound = (target, b, m) =>
    b === "PlaidClient" ? PlaidClient[m] : b === "client" ? target[m] : target[b][m];
  const argsOf = (target, b, m) =>
    pinned[`${b}.${m}`]?.args?.map(decodeArg) ?? stubArgs(unbound(target, b, m));
  const call = (target, b, m, args) =>
    settle(new Promise((resolve) => resolve(drive(bound(target, b, m)(...args)))), 200);

  const out = {};
  for (const [b, m] of names) {
    let client = fresh();
    const args = argsOf(client, b, m);
    const entry = { args: args.map(encodeArg) };
    // On the client, inside an open operation.
    client.beginOperation("op");
    entry.outcome = await call(client, b, m, args);
    entry.sends = sent;
    if (b !== "PlaidClient") {
      // On a batch.
      client = fresh();
      const batch = client.batch();
      const refused = (await call(batch, b, m, args)) === "threw";
      const queued = batch.operations.map(({ path, method, body, ...rest }) => {
        const op = requestOf(
          `http://wire.test${path}`,
          { method, body: JSON.stringify(body) },
          "http://wire.test",
        );
        return { ...op, ...scrub(rest) };
      });
      if (queued.length) entry.batch = { queued };
      else if (sent.length) entry.batch = "wire";
      else entry.batch = refused ? "threw" : "nothing";
      batch.abort();
    }
    out[`${b}.${m}`] = entry;
  }
  live = null;
  return out;
}

if (process.env.WIRE_PROBE) {
  const pinned = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf8")) : {};
  const snapshot = await probe(join(here, "..", "src", "index.js"), pinned);
  process.stdout.write(JSON.stringify(snapshot));
  process.exit(0);
} else {
  test("every bundle method sends what the wire snapshot holds", () => {
    const got = JSON.parse(
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, WIRE_PROBE: "1" },
        maxBuffer: 64 * 1024 * 1024,
      }).toString(),
    );
    assert.ok(Object.keys(got).length > 240, `only ${Object.keys(got).length} methods`);
    if (process.env.UPDATE_WIRE) {
      // One method a line, so a diff names the methods that changed.
      const lines = Object.keys(got).map(
        (k) => `  ${JSON.stringify(k)}: ${JSON.stringify(got[k])}`,
      );
      writeFileSync(FIXTURE, `{\n${lines.join(",\n")}\n}\n`);
      return;
    }
    const want = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const changed = Object.keys({ ...want, ...got }).filter(
      (k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]),
    );
    assert.deepEqual(
      Object.fromEntries(changed.map((k) => [k, got[k] ?? null])),
      Object.fromEntries(changed.map((k) => [k, want[k] ?? null])),
      `${changed.length} methods send other than fixtures/wire.json holds: ${changed.join(", ")}`,
    );
  });
}
