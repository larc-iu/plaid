// Only the bare document GET and the restore POST take `?as-of=`. The server
// answers 400 to it on every other route, so a method elsewhere that offered
// asOf could only fail, and did: igt's historical export passed it to the
// vocabulary read and shipped without its vocabularies.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

const STREAM_METHODS = new Set([
  "messages.listen",
  "messages.serve",
  "messages.requestService",
  "messages.attachServiceRequest",
]);
const TAKES_AS_OF = new Set(["documents.get", "documents.restore"]);

test("no method but the document read and restore sends as-of", async () => {
  process.on("unhandledRejection", () => {});
  const client = new PlaidClient("http://x", "tok");
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push(String(url));
    return {
      ok: true,
      status: 200,
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => ({ entries: [], "next-cursor": null }),
      text: async () => "{}",
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
  // Reads as an id where a string is wanted, and carries asOf where an
  // options object is destructured.
  const arg = () => Object.assign(new String("x"), { asOf: "T" });
  const offenders = [];
  try {
    for (const [name, bundle] of Object.entries(client)) {
      if (!bundle || typeof bundle !== "object" || Array.isArray(bundle))
        continue;
      for (const [m, fn] of Object.entries(bundle)) {
        if (typeof fn !== "function" || STREAM_METHODS.has(`${name}.${m}`))
          continue;
        const before = sent.length;
        try {
          const out = fn(...Array.from({ length: 6 }, arg));
          if (out && typeof out[Symbol.asyncIterator] === "function") {
            for await (const _page of out) break;
          } else {
            await out;
          }
        } catch {
          // Fake arguments may be refused. What went out is the thing checked.
        }
        const label = `${name}.${m}`;
        if (TAKES_AS_OF.has(label)) continue;
        if (sent.slice(before).some((url) => /[?&]as-of=/.test(url)))
          offenders.push(label);
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(offenders, []);
});
