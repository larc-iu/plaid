// The research-telemetry recorder: buffered, flushed on an interval, at a
// count and on pagehide, fire and forget, and silent while a project's switch
// is off. Plus the events reads.

import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";
import {
  EventRecorder,
  FLUSH_AT,
  FLUSH_INTERVAL_MS,
  FLAG_TTL_MS,
  resetEventRecorders,
} from "../src/events.js";

let sent;
let realFetch;
let answer;

const settle = () => new Promise((r) => setImmediate(r));

function fakeClient(telemetry, { fail = false } = {}) {
  const client = {
    baseUrl: "http://x",
    token: "tok",
    gets: 0,
    projects: {
      get: async (id) => {
        client.gets += 1;
        if (fail) throw new Error("offline");
        return {
          id,
          config: telemetry === undefined ? {} : { plaid: { research: { telemetry } } },
        };
      },
    },
  };
  return client;
}

beforeEach(() => {
  sent = [];
  answer = () => Promise.resolve({ status: 201, ok: true });
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    sent.push({ url, opts, body: JSON.parse(opts.body) });
    return answer();
  };
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  globalThis.fetch = realFetch;
  resetEventRecorders();
});

const shown = (target, value, extra = {}) => ({
  projectId: "p1",
  documentId: "d1",
  targetId: target,
  data: { value, source: "precedent", field: "Gloss", ...extra },
});

test("a project with the switch on gets its events after the interval, in one request", async () => {
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(true);
  assert.equal(r.record(client, "suggestion.shown", shown("t1", "dog")), true);
  assert.equal(r.record(client, "suggestion.adopted", shown("t1", "dog")), true);
  await settle();
  assert.equal(sent.length, 0, "nothing goes out before the interval");
  mock.timers.tick(FLUSH_INTERVAL_MS);
  await settle();
  assert.equal(sent.length, 1);
  const [{ url, opts, body }] = sent;
  assert.equal(url, "http://x/api/v1/projects/p1/events");
  assert.equal(opts.method, "POST");
  assert.equal(opts.keepalive, false, "only the pagehide send is keepalive");
  assert.equal(opts.headers.Authorization, "Bearer tok");
  assert.deepEqual(
    body.map((e) => e.type),
    ["suggestion.shown", "suggestion.adopted"],
  );
  assert.equal(body[0]["document-id"], "d1");
  assert.equal(body[0]["target-id"], "t1");
  assert.deepEqual(body[0].data, { value: "dog", source: "precedent", field: "Gloss" });
  assert.ok(body[0]["client-ts"]);
  assert.equal(client.gets, 1, "the switch is read once");
});

test("a project with the switch off sends nothing, ever", async () => {
  for (const telemetry of [undefined, false, "yes"]) {
    sent = [];
    const r = new EventRecorder({ window: new EventTarget() });
    const client = fakeClient(telemetry);
    r.record(client, "suggestion.shown", shown("t1", "dog"));
    await settle();
    assert.equal(r.record(client, "suggestion.adopted", shown("t1", "dog")), false);
    mock.timers.tick(FLUSH_INTERVAL_MS);
    r.flush();
    r.flush({ keepalive: true });
    await settle();
    assert.deepEqual(sent, [], `telemetry ${telemetry}`);
    assert.equal(r.buffer.length, 0);
    r.close();
  }
});

test("a switch that cannot be read counts as off", async () => {
  const r = new EventRecorder({ window: new EventTarget() });
  r.record(fakeClient(true, { fail: true }), "plan.opened", { projectId: "p1", targetId: "plan-1" });
  await settle();
  mock.timers.tick(FLUSH_INTERVAL_MS);
  await settle();
  assert.deepEqual(sent, []);
});

test("fifty events flush at once", async () => {
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(true);
  r.record(client, "suggestion.shown", shown("t0", "v"));
  await settle();
  for (let i = 1; i < FLUSH_AT; i++) r.record(client, "suggestion.shown", shown(`t${i}`, "v"));
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.length, FLUSH_AT);
});

// A browser refuses a keepalive request whose body, with the other keepalive
// requests in flight, passes 64 KiB. Found live: a first grid page with 1197
// guesses, drawn while the switch was being read, went out as three requests
// of up to 500 events, and the two of 120 KB were refused, so 1000 of the
// 1197 were lost.
const KEEPALIVE_QUOTA = 64 * 1024;
function browserFetch() {
  let inFlight = 0;
  return (url, opts) => {
    const bytes = Buffer.byteLength(opts.body);
    if (opts.keepalive && inFlight + bytes > KEEPALIVE_QUOTA) {
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    sent.push({ url, opts, body: JSON.parse(opts.body) });
    if (opts.keepalive) inFlight += bytes;
    return Promise.resolve({ status: 201, ok: true });
  };
}

test("a backlog drawn while the switch was being read reaches the server whole", async () => {
  globalThis.fetch = browserFetch();
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(true);
  const n = 1197;
  const long = "a gloss of some length ".repeat(4);
  for (let i = 0; i < n; i++) r.record(client, "suggestion.shown", shown(`target-${i}`, long));
  await settle();
  assert.equal(sent.reduce((k, s) => k + s.body.length, 0), n, "every event was sent");
  assert.ok(sent.every((s) => s.body.length <= FLUSH_AT));
  assert.ok(sent.every((s) => !s.opts.keepalive), "a page that stays sends without keepalive");
});

test("pagehide sends what is buffered with keepalive, and drops what waits on the switch", async () => {
  const win = new EventTarget();
  const r = new EventRecorder({ window: win });
  const on = fakeClient(true);
  r.record(on, "suggestion.shown", shown("t1", "dog"));
  await settle();
  r.record(on, "suggestion.dismissed", { projectId: "p2", targetId: "t9" });
  win.dispatchEvent(new Event("pagehide"));
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].opts.keepalive, true);
  assert.deepEqual(sent[0].body.map((e) => e.type), ["suggestion.shown"]);
  assert.equal(r.buffer.length, 0, "a page going away keeps nothing");
});

test("a failed batch is dropped: no throw, no retry", async () => {
  answer = () => Promise.reject(new TypeError("Failed to fetch"));
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(true);
  r.record(client, "suggestion.shown", shown("t1", "dog"));
  await settle();
  mock.timers.tick(FLUSH_INTERVAL_MS);
  await settle();
  assert.equal(sent.length, 1);
  mock.timers.tick(FLUSH_INTERVAL_MS * 5);
  await settle();
  assert.equal(sent.length, 1, "never sent again");
  assert.equal(r.buffer.length, 0);
});

test("a server error is dropped too, and a fetch that throws is survived", async () => {
  answer = () => Promise.resolve({ status: 500, ok: false });
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(true);
  r.record(client, "suggestion.shown", shown("t1", "dog"));
  await settle();
  r.flush();
  await settle();
  globalThis.fetch = () => {
    throw new Error("boom");
  };
  assert.equal(r.record(client, "suggestion.shown", shown("t2", "cat")), true);
  assert.doesNotThrow(() => r.flush());
  assert.equal(sent.length, 1);
});

test("a refusal turns the switch off here too", async () => {
  answer = () => Promise.resolve({ status: 403, ok: false });
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(true);
  r.record(client, "suggestion.shown", shown("t1", "dog"));
  await settle();
  r.flush();
  await settle();
  assert.equal(r.record(client, "suggestion.shown", shown("t2", "cat")), false);
});

test("a stale switch is read again", async () => {
  let t = 0;
  const r = new EventRecorder({ window: new EventTarget(), now: () => t });
  const client = fakeClient(false);
  r.record(client, "plan.opened", { projectId: "p1", targetId: "a" });
  await settle();
  assert.equal(r.record(client, "plan.opened", { projectId: "p1", targetId: "b" }), false);
  t += FLAG_TTL_MS + 1;
  client.projects.get = async () => ({ config: { plaid: { research: { telemetry: true } } } });
  r.record(client, "plan.opened", { projectId: "p1", targetId: "c" });
  await settle();
  assert.equal(r.record(client, "plan.opened", { projectId: "p1", targetId: "d" }), true);
});

// V7 H7-7: turned on by another maintainer, the switch reached an open page
// only five minutes later, and the answers given meanwhile were lost.
test("a switch turned on elsewhere reaches an open page by the next flush, with the event that found it", async () => {
  let t = 0;
  const r = new EventRecorder({ window: new EventTarget(), now: () => t });
  const client = fakeClient(false);
  assert.equal(r.record(client, "suggestion.adopted", shown("t1", "dog")), true);
  await settle();
  assert.equal(r.record(client, "suggestion.adopted", shown("t1", "dog")), false);
  // Another maintainer turns it on. One flush interval later the next answer
  // is recorded, not dropped while the switch is read again.
  client.projects.get = async (id) => ({
    id,
    config: { plaid: { research: { telemetry: true } } },
  });
  t += FLUSH_INTERVAL_MS;
  assert.equal(r.record(client, "suggestion.adopted", shown("t2", "cat")), true);
  await settle();
  mock.timers.tick(FLUSH_INTERVAL_MS);
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].body.map((e) => e["target-id"] ?? e.targetId),
    ["t2"],
  );
});

test("shown is recorded once per target, field and value in a page session", async () => {
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(true);
  assert.equal(r.record(client, "suggestion.shown", shown("t1", "dog")), true);
  await settle();
  // A re-render shows the same guess again.
  assert.equal(r.record(client, "suggestion.shown", shown("t1", "dog")), false);
  r.flush();
  await settle();
  assert.equal(r.record(client, "suggestion.shown", shown("t1", "dog")), false, "also after a flush");
  assert.equal(r.record(client, "suggestion.shown", shown("t1", "cat")), true, "a new value is new");
  assert.equal(r.record(client, "suggestion.shown", shown("t2", "dog")), true, "a new target is new");
  assert.equal(
    r.record(client, "suggestion.shown", shown("t1", "dog", { field: "POS" })),
    true,
    "a new field is new",
  );
  assert.equal(r.record(client, "suggestion.adopted", shown("t1", "dog")), true);
  assert.equal(r.record(client, "suggestion.adopted", shown("t1", "dog")), true, "only shown is deduplicated");
});

test("an unknown type or a missing project is not recorded", () => {
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(true);
  assert.equal(r.record(client, "keystroke", shown("t1", "dog")), false);
  assert.equal(r.record(client, "suggestion.shown", { targetId: "t1" }), false);
  assert.equal(r.buffer.length, 0);
});

test("setEnabled answers at once, and turning it off drops the buffer", async () => {
  const r = new EventRecorder({ window: new EventTarget() });
  const client = fakeClient(undefined);
  r.setEnabled("p1", true);
  r.record(client, "suggestion.shown", shown("t1", "dog"));
  assert.equal(client.gets, 0, "no read needed");
  r.setEnabled("p1", false);
  assert.equal(r.buffer.length, 0);
  mock.timers.tick(FLUSH_INTERVAL_MS);
  await settle();
  assert.deepEqual(sent, []);
  r.setEnabled("p1", true);
  assert.equal(
    r.record(client, "suggestion.shown", shown("t1", "dog")),
    true,
    "a shown dropped with the switch off counts as never recorded",
  );
});

test("a long value is cut", async () => {
  const r = new EventRecorder({ window: new EventTarget() });
  r.setEnabled("p1", true);
  r.record(fakeClient(true), "suggestion.dismissed", shown("t1", "x".repeat(500)));
  r.flush();
  await settle();
  assert.equal(sent[0].body[0].data.value.length, 200);
});

test("a long value is cut by code points, never inside a character", async () => {
  const r = new EventRecorder({ window: new EventTarget() });
  r.setEnabled("p1", true);
  // U+10437 is two UTF-16 units: a cut at 200 units would split one.
  r.record(fakeClient(true), "suggestion.shown", shown("t1", "a" + "\u{10437}".repeat(300)));
  r.flush();
  await settle();
  const value = sent[0].body[0].data.value;
  assert.equal([...value].length, 200, "200 code points, the server's ceiling");
  assert.ok(!/[\uD800-\uDBFF]$/.test(value), "no lone high surrogate at the end");
});

test("a data key with no value is left out rather than sent as null", async () => {
  const r = new EventRecorder({ window: new EventTarget() });
  r.setEnabled("p1", true);
  r.record(fakeClient(true), "plan.opened", { projectId: "p1", targetId: "plan-7", data: { conversation: null } });
  r.record(fakeClient(true), "suggestion.shown", shown("t1", "dog", { source: undefined }));
  r.flush();
  await settle();
  assert.deepEqual(sent[0].body[0].data, {});
  assert.deepEqual(sent[0].body[1].data, { value: "dog", field: "Gloss" });
});

test("every client of a server shares one recorder, on a batch too", async () => {
  const a = new PlaidClient("http://x", "tok");
  const b = new PlaidClient("http://x", "tok");
  a.events.setEnabled("p1", true);
  assert.equal(a.events.record("suggestion.shown", shown("t1", "dog")), true);
  assert.equal(b.events.record("suggestion.shown", shown("t1", "dog")), false, "the same page session");
  const batch = b.batch();
  assert.equal(batch.events.record("suggestion.adopted", shown("t1", "dog")), true);
  b.events.flush();
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].body.map((e) => e.type),
    ["suggestion.shown", "suggestion.adopted"],
  );
  batch.abort();
});

test("events.create posts straight away and joins no operation", async () => {
  const client = new PlaidClient("http://x", "tok");
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return {
      ok: true,
      status: 201,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
      json: async () => ({ count: 1 }),
    };
  };
  client.beginOperation("Glossing");
  const res = await client.events.create("p1", [{ type: "plan.opened", targetId: "x" }]);
  assert.deepEqual(res, { count: 1 });
  assert.equal(calls[0].url, "http://x/api/v1/projects/p1/events", "no group-id on the URL");
  assert.deepEqual(JSON.parse(calls[0].opts.body), [{ type: "plan.opened", "target-id": "x" }]);
});

test("events.list pages with its filters in the wire spelling", async () => {
  const client = new PlaidClient("http://x", "tok");
  const urls = [];
  const pages = [
    { entries: [{ "client-event/id": 1, "client-event/target-id": "t1" }], "next-cursor": "k" },
    { entries: [{ "client-event/id": 2 }], "next-cursor": null },
  ];
  let i = 0;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const page = pages[i++];
    return {
      ok: true,
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "application/json" : null) },
      json: async () => page,
    };
  };
  const got = await client.events.list("p1", {
    types: ["suggestion.shown", "suggestion.adopted"],
    startTime: "2026-09-29T00:00:00Z",
  });
  assert.deepEqual(got.map((e) => e.id), [1, 2]);
  assert.equal(got[0].targetId, "t1");
  const first = new URL(urls[0]);
  assert.equal(first.pathname, "/api/v1/projects/p1/events");
  assert.equal(first.searchParams.get("types"), "suggestion.shown,suggestion.adopted");
  assert.equal(first.searchParams.get("start-time"), "2026-09-29T00:00:00Z");
  assert.equal(new URL(urls[1]).searchParams.get("cursor"), "k");
});
