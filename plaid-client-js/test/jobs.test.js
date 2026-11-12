// The jobs bundle (CONTRACT 9 of the jobs round): what each method sends and
// what it answers. The whole request of every method is also in
// fixtures/wire.json. Here: a 204 answers null, a key given as null is sent
// as null (clear) and a key left out is not sent (leave), the worker's calls
// carry no Idempotency-Key and go over the wire from a batch, a person's
// calls never join an open operation, and the answers are recased.
// plaid-client-py's tests/test_jobs.py is the twin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

/** Answer each request with the next of `answers` ({status, body}), the
 *  last repeated, and keep what was sent. */
function capture(answers) {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    sent.push({
      method: opts.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      body: opts.body === undefined ? undefined : JSON.parse(opts.body),
      key: opts.headers?.["Idempotency-Key"],
    });
    const answer = answers[Math.min(sent.length, answers.length) - 1];
    const json = answer.body !== undefined;
    return {
      ok: answer.status < 400,
      status: answer.status,
      statusText: "",
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" && json ? "application/json" : null,
      },
      json: async () => answer.body,
      text: async () => (json ? JSON.stringify(answer.body) : ""),
    };
  };
  return { sent, restore: () => (globalThis.fetch = realFetch) };
}

const WIRE_JOB = {
  "job/id": "j1",
  "job/project": "p1",
  "job/app": "igt",
  "job/tasks": ["gloss", "link"],
  "job/started-by": "a@b.com",
  "job/started-by-name": "A",
  "job/state": "running",
  "job/waiting-for": null,
  "job/current-document": "d1",
  "job/lease-s": 120,
  "job/documents": [
    {
      "document-id": "d1",
      name: "One",
      position: 0,
      state: "working",
      targets: 4,
      done: 1,
      "last-sentence": "s1",
      counts: { words: 3, links: 2 },
      skipped: [{ sentence: "s2", "sentence-id": "t2", reason: "failed", kind: "budget" }],
      "gloss-group": "g1",
    },
  ],
  "job/report": null,
};

test("a person's calls: create, list, get, active, cancel, worker", async () => {
  const net = capture([
    { status: 201, body: WIRE_JOB },
    { status: 200, body: { entries: [WIRE_JOB], "next-cursor": null } },
    { status: 200, body: WIRE_JOB },
    { status: 200, body: WIRE_JOB },
    { status: 204 },
    { status: 200, body: WIRE_JOB },
    { status: 200, body: { "seen-at": null, model: null, "note-max-chars": 2000 } },
  ]);
  try {
    const client = new PlaidClient("http://x", "tok");
    const made = await client.jobs.create("p1", {
      app: "igt",
      tasks: ["gloss", "link"],
      note: "Gloss -ka as PST.",
      id: "j1",
    });
    assert.equal(made.startedBy, "a@b.com");
    assert.equal(made.documents[0].documentId, "d1");
    assert.equal(made.documents[0].lastSentence, "s1");
    assert.deepEqual(made.documents[0].skipped[0], {
      sentence: "s2",
      sentenceId: "t2",
      reason: "failed",
      kind: "budget",
    });
    assert.equal(made.leaseS, 120);
    const listed = await client.jobs.list("p1");
    assert.equal(listed[0].id, "j1");
    assert.equal((await client.jobs.get("j1")).currentDocument, "d1");
    assert.equal((await client.jobs.active("p1")).state, "running");
    assert.equal(await client.jobs.active("p1"), null, "204: no active job");
    assert.equal((await client.jobs.cancel("j1")).id, "j1");
    assert.deepEqual(await client.jobs.worker(), {
      seenAt: null,
      model: null,
      noteMaxChars: 2000,
    });
    assert.deepEqual(
      net.sent.map((s) => `${s.method} ${s.path}`),
      [
        "POST /api/v1/projects/p1/jobs",
        "GET /api/v1/projects/p1/jobs",
        "GET /api/v1/jobs/j1",
        "GET /api/v1/projects/p1/jobs/active",
        "GET /api/v1/projects/p1/jobs/active",
        "POST /api/v1/jobs/j1/cancel",
        "GET /api/v1/jobs/worker",
      ],
    );
    assert.deepEqual(net.sent[0].body, {
      id: "j1",
      app: "igt",
      tasks: ["gloss", "link"],
      note: "Gloss -ka as PST.",
    });
    assert.ok(net.sent[0].key, "a create is keyed, so a lost answer is sent again safely");
  } finally {
    net.restore();
  }
});

test("a create with its documents sends them in order, and the list pages", async () => {
  const net = capture([
    { status: 201, body: WIRE_JOB },
    { status: 200, body: { entries: [WIRE_JOB], "next-cursor": "c2" } },
  ]);
  try {
    const client = new PlaidClient("http://x", "tok");
    await client.jobs.create("p1", { app: "igt", tasks: ["translate"], documents: ["d2", "d1"] });
    const page = await client.jobs.listPage("p1", { limit: 1, cursor: "c1" });
    assert.equal(page.nextCursor, "c2");
    assert.deepEqual(net.sent[0].body, { app: "igt", tasks: ["translate"], documents: ["d2", "d1"] });
    assert.deepEqual(net.sent[1].query, { limit: "1", cursor: "c1" });
  } finally {
    net.restore();
  }
});

test("a job's create and cancel never join an open operation", async () => {
  const net = capture([{ status: 201, body: WIRE_JOB }]);
  try {
    const client = new PlaidClient("http://x", "tok");
    await client.withOperation("Edit", async () => {
      await client.jobs.create("p1", { app: "igt", tasks: ["gloss"] });
      await client.jobs.cancel("j1");
    });
    for (const s of net.sent) assert.equal(s.query["group-id"], undefined, s.path);
  } finally {
    net.restore();
  }
});

test("claim answers the job and its token, and null on 204", async () => {
  const net = capture([
    { status: 200, body: { job: WIRE_JOB, token: "jwt", "heartbeat-s": 30 } },
    { status: 204 },
  ]);
  try {
    const client = new PlaidClient("http://x", "tok");
    const claimed = await client.jobs.claim("w1", { model: "m", apps: ["igt"] });
    assert.equal(claimed.token, "jwt");
    assert.equal(claimed.heartbeatS, 30);
    assert.equal(claimed.job.state, "running");
    assert.equal(await client.jobs.claim("w1", { model: "m", apps: ["igt"] }), null);
    assert.deepEqual(net.sent[0].body, { "worker-id": "w1", model: "m", apps: ["igt"] });
  } finally {
    net.restore();
  }
});

test("heartbeat sends null to clear a field and leaves out a field it leaves", async () => {
  const net = capture([{ status: 200, body: { state: "running", token: "jwt2", "lease-s": 120 } }]);
  try {
    const client = new PlaidClient("http://x", "tok");
    const beat = await client.jobs.heartbeat("j1", "w1", {
      phase: "glossing",
      waitingFor: null,
      currentDocument: "d1",
    });
    assert.deepEqual(beat, { state: "running", token: "jwt2", leaseS: 120 });
    await client.jobs.heartbeat("j1", "w1");
    assert.deepEqual(net.sent[0].body, {
      "worker-id": "w1",
      phase: "glossing",
      "waiting-for": null,
      "current-document": "d1",
    });
    assert.deepEqual(net.sent[1].body, { "worker-id": "w1" });
    assert.equal(net.sent[0].path, "/api/v1/jobs/j1/heartbeat");
  } finally {
    net.restore();
  }
});

test("updateDocument, finish and the decisions send the contract's bodies", async () => {
  const net = capture([
    { status: 200, body: WIRE_JOB["job/documents"][0] },
    { status: 200, body: { ...WIRE_JOB, "job/state": "done" } },
    { status: 204 },
    { status: 200, body: [{ form: "ka", key: "k1", analysis: "{}", count: 2, "first-document": "d1", "first-sentence": "t1" }] },
    { status: 200, body: { entries: [{ form: "ka", key: "k1", analysis: "{}", count: 2 }], "next-cursor": null } },
    { status: 200, body: { "in-flight": 1, "last-finished-at": null } },
  ]);
  try {
    const client = new PlaidClient("http://x", "tok");
    const row = await client.jobs.updateDocument("j1", "d1", "w1", {
      state: "working",
      lastSentence: "s1",
      counts: { words: 3 },
      skipped: [{ sentence: "s2", sentenceId: "t2", reason: "too-long", kind: null }],
      glossGroup: "g1",
      harmonizeGroup: null,
    });
    assert.equal(row.glossGroup, "g1");
    const ended = await client.jobs.finish("j1", "w1", {
      state: "done",
      report: { pausedForPeopleS: 0, totals: { documentsDone: 1 } },
    });
    assert.equal(ended.state, "done");
    assert.equal(
      await client.jobs.addDecisions("j1", "w1", [
        { form: "ka", key: "k1", analysis: '{"morphemes":[]}', count: 2, documentId: "d1", sentenceId: "t1" },
      ]),
      undefined,
    );
    const found = await client.jobs.lookupDecisions("j1", ["ka"]);
    assert.equal(found[0].firstDocument, "d1");
    assert.equal((await client.jobs.decisions("j1"))[0].count, 2);
    assert.deepEqual(await client.jobs.modelBusy("glm"), { inFlight: 1, lastFinishedAt: null });

    const [put, fin, dec, look, all, busy] = net.sent;
    assert.equal(`${put.method} ${put.path}`, "PUT /api/v1/jobs/j1/documents/d1");
    assert.deepEqual(put.body, {
      "worker-id": "w1",
      state: "working",
      "last-sentence": "s1",
      counts: { words: 3 },
      skipped: [{ sentence: "s2", "sentence-id": "t2", reason: "too-long", kind: null }],
      "gloss-group": "g1",
      "harmonize-group": null,
    });
    assert.deepEqual(fin.body, {
      "worker-id": "w1",
      state: "done",
      report: { "paused-for-people-s": 0, totals: { "documents-done": 1 } },
    });
    assert.deepEqual(dec.body, {
      "worker-id": "w1",
      decisions: [
        {
          form: "ka",
          key: "k1",
          analysis: '{"morphemes":[]}',
          count: 2,
          "document-id": "d1",
          "sentence-id": "t1",
        },
      ],
    });
    assert.equal(`${look.method} ${look.path}`, "POST /api/v1/jobs/j1/decisions/lookup");
    assert.deepEqual(look.body, { forms: ["ka"] });
    assert.equal(`${all.method} ${all.path}`, "GET /api/v1/jobs/j1/decisions");
    assert.equal(`${busy.method} ${busy.path}`, "GET /api/v1/jobs/model-busy");
    assert.deepEqual(busy.query, { pool: "glm" });
  } finally {
    net.restore();
  }
});

test("the worker's calls are signals: unkeyed, outside any operation, sent from a batch", async () => {
  const net = capture([{ status: 200, body: { state: "running", token: "t", "lease-s": 120 } }]);
  try {
    const client = new PlaidClient("http://x", "tok");
    client.enterStrictMode("d1");
    client.documentVersions.d1 = 7;
    const batch = client.batch();
    await client.withOperation("Edit", async () => {
      await batch.jobs.heartbeat("j1", "w1", { message: "Sentences 1 to 5 of 40." });
      await batch.jobs.claim("w1", { model: "m", apps: ["igt"] });
      await batch.jobs.updateDocument("j1", "d1", "w1", { done: 3 });
      await batch.jobs.finish("j1", "w1", { state: "failed", reason: "no-lexicon", report: {} });
      await batch.jobs.addDecisions("j1", "w1", []);
      await batch.jobs.lookupDecisions("j1", ["ka"]);
    });
    assert.equal(batch.operations.length, 0, "nothing queued");
    assert.equal(net.sent.length, 6);
    for (const s of net.sent) {
      assert.equal(s.key, undefined, `${s.path} carries no Idempotency-Key`);
      assert.equal(s.query["group-id"], undefined, `${s.path} joins no operation`);
      assert.equal(s.query["document-version"], undefined, `${s.path} claims no version`);
    }
  } finally {
    net.restore();
  }
});
