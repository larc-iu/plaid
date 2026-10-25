// The test client the apps' tests share (src/testing.js, the twin of
// plaid-client-py's plaid_client.testing): the real client, batch and
// operations on a transport that records and answers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultAnswer,
  fakeClient,
  refusal,
  timed,
  withinFactorOf,
} from "@larc-iu/plaid-client/testing";

test("a write is recorded with its arguments and answered, a read only answered", async () => {
  const client = fakeClient({
    answer: ({ kind }) => (kind === "documents.get" ? { id: "d1", name: "Doc" } : undefined),
  });
  assert.deepEqual(await client.documents.get("d1"), { id: "d1", name: "Doc" });
  const made = await client.tokens.create("tl", "t", 0, 3, undefined, undefined, undefined, {
    id: "tok-a",
  });
  assert.deepEqual(made, { id: "tok-a" });
  assert.deepEqual(client.calls, [
    { kind: "tokens.create", args: ["tl", "t", 0, 3, undefined, undefined, undefined, { id: "tok-a" }] },
  ]);
  assert.deepEqual(
    client.requests.map((r) => [r.method, r.path]),
    [
      ["GET", "/api/v1/documents/d1"],
      ["POST", "/api/v1/tokens"],
    ],
  );
  assert.equal(client.requests[1].body["token-layer-id"], "tl");
});

test("a batch queues its writes, sends them as one request and answers one result each", async () => {
  const client = fakeClient();
  const results = await client.batched((b) => {
    b.spans.create("sl", ["t1"], "N");
    b.spans.update("s1", "V");
  });
  assert.deepEqual(
    client.calls.map((c) => c.kind),
    ["spans.create", "spans.update", "batch.submit"],
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].status, 200);
  assert.ok(results[0].body.id);
  const batches = client.requests.filter((r) => r.path === "/api/v1/batch");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].operations.length, 2);
});

test("a ref is filled with the id the op it names made, in the answer's args and body", async () => {
  const seen = [];
  const client = fakeClient({
    answer: (r) => {
      seen.push(r);
      return r.kind === "tokens.bulkCreate" ? { ids: ["w1", "w2"] } : undefined;
    },
  });
  await client.batched((b) => {
    b.tokens.bulkCreate([{ tokenLayerId: "tl", text: "t", begin: 0, end: 1 }]);
    b.spans.create("sl", [b.ref(0, 1)], "N");
  });
  assert.deepEqual(seen[1].args[1], ["w2"]);
  assert.deepEqual(seen[1].body.tokens, ["w2"]);
});

test("a batch refuses what the real batch refuses", async () => {
  const client = fakeClient();
  const b = client.batch();
  assert.throws(() => b.batch(), /not nestable/);
  b.tokens.delete("t1");
  await b.submit();
  await assert.rejects(b.tokens.delete("t2"), /already submitted or aborted/);
  await assert.rejects(b.submit(), /already submitted or aborted/);
});

test("one refused op refuses the whole batch", async () => {
  const client = fakeClient({
    answer: ({ kind }) => {
      if (kind === "spans.delete") throw refusal(404, { error: "Span not found" });
    },
  });
  await assert.rejects(
    client.batched((b) => {
      b.spans.update("s1", "N");
      b.spans.delete("s2");
    }),
    (e) => e.status === 404 && e.committed === 0,
  );
});

test("an operation is relabelled only when a write joined it, and its kind is checked", async () => {
  const client = fakeClient();
  await client.withOperation("Nothing", async (setMessage) => {
    await client.documents.get("d1");
    setMessage("Still nothing");
  });
  assert.deepEqual(client.calls, [{ kind: "beginOperation", args: ["Nothing"] }]);

  await client.withOperation(
    "Merge",
    async (setMessage) => {
      await client.tokens.merge(["a", "b"]);
      setMessage("Merged 2");
    },
    { kind: "bulk-edit" },
  );
  const merge = client.calls.slice(1);
  assert.deepEqual(
    merge.map((c) => c.kind),
    ["beginOperation", "tokens.merge", "operationGroups.update"],
  );
  assert.deepEqual(merge[0].args, ["Merge", { kind: "bulk-edit" }]);
  assert.equal(merge[2].args[1], "Merged 2");
  assert.ok(client.requests.at(-2).query["group-id"], "the write carries the group");
  assert.deepEqual(client.operations, [
    { message: "Nothing", kind: undefined, ref: undefined },
    { message: "Merge", kind: "bulk-edit", ref: undefined },
  ]);

  await assert.rejects(client.withOperation("Bad", async () => {}, { kind: "imports" }), /Unknown operation kind/);
});

test("a nested operation joins the outer one and is not recorded again", async () => {
  const client = fakeClient();
  await client.withOperation("Outer", () => client.withOperation("Inner", () => client.tokens.delete("t")));
  assert.deepEqual(
    client.calls.map((c) => c.kind),
    ["beginOperation", "tokens.delete"],
  );
});

test("a metadata patch that is not a list of ops is refused, as the server refuses it", async () => {
  const client = fakeClient();
  await assert.rejects(client.spans.patchMetadata("s1", { a: 1 }), /must be an array/);
  await assert.rejects(client.tokens.bulkUpdate([{ id: "t", metadata: { a: 1 } }]), /must be an array/);
  await client.spans.patchMetadata("s1", [{ op: "set", path: ["a"], value: 1 }]);
});

test("a ref sent anywhere but a queued body throws, as on the wire", async () => {
  const client = fakeClient();
  const b = client.batch();
  b.tokens.create("tl", "t", 0, 1);
  const ref = b.ref(0);
  await assert.rejects(async () => client.spans.create("sl", [ref], "N"), /b\.ref\(\) stands for an id/);
  b.abort();
});

test("the default answers: a create's id, a bulk create's ids, an empty page for a read", () => {
  assert.deepEqual(defaultAnswer({ kind: "spans.create", method: "POST", body: { id: "s" } }), { id: "s" });
  assert.equal(defaultAnswer({ kind: "tokens.bulkCreate", method: "POST", body: [{}, {}] }).ids.length, 2);
  assert.deepEqual(defaultAnswer({ kind: "projects.list", method: "GET" }), { entries: [], nextCursor: null });
  assert.deepEqual(defaultAnswer({ kind: "spans.update", method: "PATCH" }), {});
});

test("timed gives the value and the quickest of its runs, after the warm ones", () => {
  let n = 0;
  const [value, ms] = timed(() => ++n, { warm: 2, runs: 3 });
  assert.equal(n, 5);
  assert.ok([3, 4, 5].includes(value));
  assert.ok(ms >= 0);
});

test("withinFactorOf bounds the big case by the small one, at least the floor", () => {
  assert.equal(withinFactorOf(10, 5, 49), 49);
  assert.throws(() => withinFactorOf(10, 5, 50, { label: "the sweep" }), {
    message: "the sweep: 50 ms, not under 10 times the small case's 5 ms",
  });
  assert.equal(withinFactorOf(10, 0, 99, { floorMs: 10 }), 99);
  assert.throws(() => withinFactorOf(10, 0, 100, { floorMs: 10 }));
});
