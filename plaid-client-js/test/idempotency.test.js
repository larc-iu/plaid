// Idempotent writes: every write that is not a signal, an upload or a secret
// goes out with an Idempotency-Key, a write whose answer was lost is sent
// again under the same key, and a create can name its own id. See the
// Idempotency-Key note in src/http.js and the manual, "Retrying a write".

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient, MAX_BATCH_OPS, uuidv7, wasReplayed } from "../src/index.js";
import { retryUnknown, isUnknownOutcome, mintedTaken } from "../src/http.js";

const KEY = "idempotency-key";

function headerOf(opts, name) {
  const headers = opts?.headers || {};
  const found = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return found ? headers[found] : undefined;
}

function response(status, body = {}, headers = {}) {
  const all = { "content-type": "application/json", ...headers };
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: { get: (name) => all[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// Records every request and answers with `answer(request, n)`, a response or
// an Error to throw (a lost answer).
function stubServer(answer = () => response(200, { id: "x" })) {
  const requests = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const request = {
      url: String(url),
      method: opts.method,
      key: headerOf(opts, KEY),
      body: opts.body ? JSON.parse(opts.body) : undefined,
    };
    requests.push(request);
    const r = await answer(request, requests.length - 1);
    if (r instanceof Error) throw r;
    return r;
  };
  return { requests, restore: () => (globalThis.fetch = real) };
}

const fast = { retryDelaysMs: [0, 0, 0] };

test("every write carries a key, a read does not", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { requests, restore } = stubServer();
  try {
    await client.spans.create("L", ["t"], "N");
    await client.spans.update("s", "V");
    await client.documents.get("d");
  } finally {
    restore();
  }
  assert.ok(requests[0].key);
  assert.ok(requests[1].key);
  assert.notEqual(requests[0].key, requests[1].key);
  assert.equal(requests[2].key, undefined);
});

test("signals, uploads and minted secrets carry none", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { requests, restore } = stubServer(() =>
    response(200, { "lock-id": "l", id: "x", token: "t", code: "c" }),
  );
  try {
    await client.documents.acquireLock("d");
    await client.apiTokens.create("u@x", "name");
    await client.invites.create();
    await client._request("PUT", "/api/v1/users/u/data/k", {
      body: { a: 1 },
      noBatch: true,
    });
  } finally {
    restore();
  }
  assert.deepEqual(
    requests.map((r) => r.key),
    [undefined, undefined, undefined, undefined],
  );
});

test("a queued op has no key of its own, its batch request has one", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { requests, restore } = stubServer((r) =>
    response(
      200,
      r.body.map(() => ({ status: 201, headers: {}, body: { id: "x" } })),
    ),
  );
  try {
    await client.batched((b) => {
      b.spans.create("L", ["t"], "A");
      b.spans.create("L", ["t"], "B");
    });
  } finally {
    restore();
  }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].key);
  assert.ok(requests[0].body.every((op) => !("headers" in op)));
});

for (const lost of [
  ["no response", () => new TypeError("fetch failed")],
  ["502", () => response(502, { error: "Bad gateway" })],
  ["504", () => response(504, { error: "Gateway timeout" })],
]) {
  test(`a write whose answer is lost (${lost[0]}) is sent again under the same key`, async () => {
    const client = new PlaidClient("http://x", "tok", fast);
    const { requests, restore } = stubServer((_, n) =>
      n < 2 ? lost[1]() : response(201, { id: "s1" }),
    );
    let result;
    try {
      result = await client.spans.create("L", ["t"], "N");
    } finally {
      restore();
    }
    assert.equal(result.id, "s1");
    assert.equal(requests.length, 3);
    assert.equal(new Set(requests.map((r) => r.key)).size, 1);
    assert.deepEqual(requests[0].body, requests[2].body);
  });
}

test("three resends, then the error escapes with the key", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { requests, restore } = stubServer(() => response(502, {}));
  try {
    await assert.rejects(client.spans.update("s", "V"), (e) => {
      assert.equal(e.status, 502);
      assert.equal(e.idempotencyKey, requests[0].key);
      return true;
    });
  } finally {
    restore();
  }
  assert.equal(requests.length, 4);
});

test("a refusal is not resent, and a read is never resent", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { requests, restore } = stubServer((r) =>
    r.method === "GET" ? response(502, {}) : response(409, { error: "no" }),
  );
  try {
    await assert.rejects(client.spans.update("s", "V"), (e) => e.status === 409);
    await assert.rejects(client.documents.get("d"), (e) => e.status === 502);
  } finally {
    restore();
  }
  assert.equal(requests.length, 2);
});

test("retryUnknown does not resend when the browser says it is offline", async () => {
  let attempts = 0;
  await assert.rejects(
    retryUnknown(
      async () => {
        attempts += 1;
        throw Object.assign(new Error("offline"), { status: 0, offline: true });
      },
      { delaysMs: [0, 0, 0] },
    ),
  );
  assert.equal(attempts, 1);
  assert.ok(isUnknownOutcome({ status: 0 }));
  assert.ok(!isUnknownOutcome({ status: 500 }));
});

test("a batch past the cap takes one key per request, and a lost second request is resent alone", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  let lostOnce = false;
  const { requests, restore } = stubServer((r) => {
    if (r.body.length === 1 && !lostOnce) {
      lostOnce = true;
      return response(504, {});
    }
    return response(
      200,
      r.body.map(() => ({ status: 200, headers: {}, body: {} })),
    );
  });
  try {
    await client.batched((b) => {
      for (let i = 0; i < MAX_BATCH_OPS + 1; i += 1) b.spans.update(`s${i}`, i);
    });
  } finally {
    restore();
  }
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body.length, MAX_BATCH_OPS);
  assert.notEqual(requests[0].key, requests[1].key);
  assert.equal(requests[1].key, requests[2].key);
});

test("inside an operation with keys, the nth write takes <seed>.<n> and its first claim", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  client.enterStrictMode("d1");
  client.documentVersions = { d1: 5 };
  const keys = client.keySeed();
  const id = uuidv7();
  const { requests, restore } = stubServer(() =>
    response(200, { id: "x" }, { "x-document-versions": '{"d1": 6}' }),
  );
  const run = () =>
    client.withOperation(
      "Gloss",
      async () => {
        await client.spans.update("s1", "A");
        // A comment beside the edit is outside its numbering.
        await client._request("POST", "/api/v1/projects/p/message", {
          body: { m: 1 },
          noOperation: true,
        });
        await client.spans.update("s2", "B");
      },
      { keys, groupId: id },
    );
  try {
    await run();
    await run();
  } finally {
    restore();
  }
  const keysOf = (rs) => rs.map((r) => r.key);
  assert.equal(requests[0].key, `${keys.seed}.0`);
  assert.equal(requests[2].key, `${keys.seed}.1`);
  assert.ok(!requests[1].key.startsWith(keys.seed));
  // The second run sends the same keys and the same claims as the first,
  // although the client has since learned version 6.
  assert.deepEqual(keysOf([requests[3], requests[5]]), keysOf([requests[0], requests[2]]));
  assert.equal(requests[3].url, requests[0].url);
  assert.equal(requests[5].url, requests[2].url);
  assert.match(requests[0].url, /document-version=5/);
  assert.match(requests[2].url, /document-version=6/);
});

test("a replayed answer only raises a version the client holds", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  client.documentVersions = { d1: 9, d2: 1 };
  const { restore } = stubServer(() =>
    response(
      200,
      { id: "x" },
      {
        "x-document-versions": '{"d1": 7, "d2": 3}',
        "idempotent-replayed": "true",
      },
    ),
  );
  try {
    await client.spans.update("s", "V");
  } finally {
    restore();
  }
  assert.deepEqual(client.documentVersions, { d1: 9, d2: 3 });
});

test("a replayed batch only raises a version too", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  client.documentVersions = { d1: 9 };
  const { restore } = stubServer(() =>
    response(
      200,
      [{ status: 200, headers: { "X-Document-Versions": '{"d1": 7}' }, body: {} }],
      { "idempotent-replayed": "true" },
    ),
  );
  try {
    await client.batched((b) => b.spans.update("s", "V"));
  } finally {
    restore();
  }
  assert.equal(client.documentVersions.d1, 9);
});

test("uuidv7: version, variant, and order within one millisecond", () => {
  const ids = Array.from({ length: 4096 + 10 }, () => uuidv7());
  for (const id of ids.slice(0, 5)) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  const sorted = [...ids].sort();
  assert.deepEqual(sorted, ids);
  assert.equal(new Set(ids).size, ids.length);
  const ms = parseInt(ids[0].replace(/-/g, "").slice(0, 12), 16);
  assert.ok(Math.abs(ms - Date.now()) < 5000);
});

// Every create that answers an id takes the id to use. A new create method
// belongs in this table.
const creates = [
  ["projects.create", (c, o) => c.projects.create("P", undefined, o)],
  ["documents.create", (c, o) => c.documents.create("p", "D", undefined, undefined, o)],
  ["documents.copy", (c, o) => c.documents.copy("d", "C", o)],
  ["texts.create", (c, o) => c.texts.create("tl", "d", "x", undefined, undefined, o)],
  ["textLayers.create", (c, o) => c.textLayers.create("p", "T", undefined, o)],
  ["tokenLayers.create", (c, o) => c.tokenLayers.create("tl", "W", undefined, undefined, undefined, o)],
  ["spanLayers.create", (c, o) => c.spanLayers.create("tk", "S", undefined, o)],
  ["relationLayers.create", (c, o) => c.relationLayers.create("sl", "R", undefined, o)],
  ["vocabLayers.create", (c, o) => c.vocabLayers.create("V", undefined, o)],
  ["tokens.create", (c, o) => c.tokens.create("tk", "t", 0, 1, undefined, undefined, undefined, o)],
  ["tokens.split", (c, o) => c.tokens.split("t", 1, undefined, o)],
  ["spans.create", (c, o) => c.spans.create("sl", ["t"], "N", undefined, undefined, o)],
  ["relations.create", (c, o) => c.relations.create("rl", "a", "b", "r", undefined, undefined, o)],
  ["vocabItems.create", (c, o) => c.vocabItems.create("v", "dog", undefined, undefined, o)],
  ["vocabLinks.create", (c, o) => c.vocabLinks.create("i", ["t"], undefined, undefined, o)],
  ["guidelines.create", (c, o) => c.guidelines.create("p", "G", o)],
  ["comments.create", (c, o) => c.comments.create("document", "d", "hi", o)],
];

for (const [name, call] of creates) {
  test(`${name} sends the id it is given`, async () => {
    const client = new PlaidClient("http://x", "tok", fast);
    const id = uuidv7();
    const { requests, restore } = stubServer(() => response(201, { id }));
    try {
      await call(client, { id });
      await call(client, {});
    } finally {
      restore();
    }
    assert.equal(requests[0].body.id, id);
    assert.equal("id" in requests[1].body, false);
  });
}

test("tokens.split sends keep only when it is given", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { requests, restore } = stubServer(() => response(201, { id: "l" }));
  try {
    await client.tokens.split("t", 3, undefined, { keep: "right" });
    await client.tokens.split("t", 3);
  } finally {
    restore();
  }
  assert.deepEqual(requests[0].body, { keep: "right", position: 3 });
  assert.deepEqual(requests[1].body, { position: 3 });
});

// REV-idempotency F1: an edit queued inside a longer operation (igt's autoPass
// link phase, a transcribe run, the repair on open) brought its seed to a
// nested begin, which dropped it, so its resend got fresh keys.
test("a nested operation that brings its own seed numbers its keys, then the outer one resumes", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const outer = client.keySeed();
  const inner = client.keySeed();
  const { requests, restore } = stubServer();
  try {
    await client.withOperation(
      "Link to the lexicon",
      async () => {
        await client.spans.update("s0", "O");
        await client.withOperation("Gloss", async () => {
          await client.spans.update("s1", "A");
          await client.spans.update("s2", "B");
        }, { keys: inner });
        await client.spans.update("s3", "O2");
      },
      { keys: outer },
    );
    // No outer seed: the inner seed still numbers the inner requests.
    await client.withOperation("Run", async () => {
      await client.withOperation("Gloss", () => client.spans.update("s4", "C"), { keys: inner });
    });
  } finally {
    restore();
  }
  assert.deepEqual(
    requests.map((r) => r.key),
    [`${outer.seed}.0`, `${inner.seed}.0`, `${inner.seed}.1`, `${outer.seed}.1`, `${inner.seed}.0`],
  );
  // One operation in the audit log: the inner joins the outer's group.
  const group = (r) => new URL(r.url).searchParams.get("group-id");
  assert.equal(group(requests[1]), group(requests[0]));
});

// REV-idempotency F2: a comment made while an edit's operation is open took
// one of the edit's numbered keys, so the edit's resend met a key used for
// the comment.
test("a comment made while an operation is open takes none of its keys and joins nothing", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const keys = client.keySeed();
  const { requests, restore } = stubServer(() => response(201, { id: "x" }));
  try {
    await client.withOperation(
      "Gloss",
      async () => {
        await client.spans.update("s1", "A");
        await client.comments.create("span", "s1", "hmm");
        await client.spans.update("s1", "B");
      },
      { keys },
    );
  } finally {
    restore();
  }
  assert.equal(requests[0].key, `${keys.seed}.0`);
  assert.ok(!requests[1].key.startsWith(keys.seed));
  assert.equal(new URL(requests[1].url).searchParams.get("group-id"), null);
  assert.equal(requests[2].key, `${keys.seed}.1`);
});

// REV2 G7: a key frame is ended by the call that opened it. Two keyed
// operations whose runs overlap in time end in either order, and each end
// takes away its own frame, never the other's.
test("a keyed operation that ends while a later one is still open ends its own frame", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const a = client.keySeed();
  const b = client.keySeed();
  const { requests, restore } = stubServer();
  let releaseB;
  const bHeld = new Promise((r) => (releaseB = r));
  let bDone;
  try {
    await client.withOperation(
      "A",
      async () => {
        await client.spans.update("a0", "x");
        bDone = client.withOperation(
          "B",
          async () => {
            await client.spans.update("b0", "x");
            await bHeld;
            await client.spans.update("b1", "x");
          },
          { keys: b },
        );
        // A's run goes on only once B's first write is out.
        await new Promise((r) => setTimeout(r, 0));
      },
      { keys: a },
    );
    // A has ended. B's frame is still open, and B numbers on under its own.
    releaseB();
    await bDone;
    await client.spans.update("after", "x");
  } finally {
    restore();
  }
  assert.deepEqual(requests.slice(0, 3).map((r) => r.key), [
    `${a.seed}.0`,
    `${b.seed}.0`,
    `${b.seed}.1`,
  ]);
  assert.ok(!requests[3].key.startsWith(a.seed) && !requests[3].key.startsWith(b.seed));
  assert.equal(client.operationGroup, null);
});

// REV2 G3: a create refused 409 id-taken for an id the operation itself
// minted was made by an earlier send of it, so it answers as made and the
// operation's later writes go on.
test("an id-taken for an id the operation minted answers as made, and the rest is sent", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const id = uuidv7();
  const { requests, restore } = stubServer((r) =>
    r.method === "POST"
      ? response(409, { error: "id-taken", "id-taken": true, id })
      : response(200, {}),
  );
  let made;
  try {
    await client.withOperation(
      "Gloss",
      async () => {
        made = await client.spans.create("L", ["t"], "N", undefined, undefined, { id });
        await client.spans.update("other", "NEW");
      },
      { keys: client.keySeed(), minted: new Set([id]) },
    );
    // Outside such an operation the same refusal is thrown.
    await assert.rejects(
      client.spans.create("L", ["t"], "N", undefined, undefined, { id }),
      (e) => e.status === 409,
    );
  } finally {
    restore();
  }
  assert.equal(made.id, id);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].method, "PATCH");
});

// REV3 H7: a bulk create refused id-taken was refused whole and made none of
// its rows, so it is thrown as a refusal, never answered as made. The ids
// may come as any iterable.
test("a bulk create refused id-taken is a refusal, even for an id the operation minted", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const a = uuidv7();
  const b = uuidv7();
  const { restore } = stubServer(() =>
    response(409, { error: "id-taken", "id-taken": true, id: a }),
  );
  let single;
  try {
    await assert.rejects(
      client.withOperation(
        "Gloss",
        () =>
          client.spans.bulkCreate([
            { id: a, spanLayerId: "L", tokens: ["t"], value: "N" },
            { id: b, spanLayerId: "L", tokens: ["u"], value: "M" },
          ]),
        { minted: [a, b] },
      ),
      (e) => e.status === 409,
    );
    single = await client.withOperation(
      "Gloss",
      () => client.spans.create("L", ["t"], "N", undefined, undefined, { id: a }),
      { minted: [a] },
    );
  } finally {
    restore();
  }
  assert.equal(single.id, a);
});

// REV3 H8: an id-taken for a row since deleted names nothing to open, so it
// is a refusal even for an id the operation minted.
test("an id-taken for a deleted row is a refusal, even for an id the operation minted", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const id = uuidv7();
  const { restore } = stubServer(() =>
    response(409, { error: "id-taken", "id-taken": true, id, deleted: true }),
  );
  try {
    await assert.rejects(
      client.withOperation(
        "Gloss",
        () => client.spans.create("L", ["t"], "N", undefined, undefined, { id }),
        { minted: [id] },
      ),
      (e) => e.status === 409,
    );
  } finally {
    restore();
  }
});

// A replay inside the client's own resend (the first answer lost, the resend
// answered from what the first send stored) is marked on the answer, so an
// app can tell it wrote nothing new. The mark is not enumerable: the answer
// reads, compares and serializes as before.
test("an answer replayed from a key's first send is marked replayed", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { restore } = stubServer((r, n) =>
    n === 0
      ? new TypeError("fetch failed")
      : response(201, { id: "s1" }, { "idempotent-replayed": "true" }),
  );
  let made;
  let fresh;
  try {
    made = await client.spans.create("L", ["t"], "N");
    restore();
    const again = stubServer(() => response(201, { id: "s2" }));
    fresh = await client.spans.create("L", ["t"], "M");
    again.restore();
  } finally {
    restore();
  }
  assert.equal(wasReplayed(made), true);
  assert.equal(made.replayed, true);
  assert.deepEqual(Object.keys(made), ["id"]);
  assert.equal(JSON.stringify(made), '{"id":"s1"}');
  assert.equal(wasReplayed(fresh), false);
  assert.equal(wasReplayed(null), false);
  assert.equal(wasReplayed("text"), false);
});

test("a replayed list answer is marked, and a batch's too", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { restore } = stubServer(() =>
    response(200, [{ id: "a" }], { "idempotent-replayed": "true" }),
  );
  let answer;
  try {
    answer = await client._request("POST", "/api/v1/batch", { body: [] });
  } finally {
    restore();
  }
  assert.equal(wasReplayed(answer), true);
  assert.equal(answer.length, 1);
});

// A batch's results are marked as a single answer's are. A batch past the cap
// goes as several requests, each answered on its own: each request's results
// are marked when that request was replayed, and the combined results when
// any request was, since then some of the batch stored nothing new.
test("a replayed batch's results are marked", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { restore } = stubServer((r, n) =>
    n === 0
      ? new TypeError("fetch failed")
      : response(
          200,
          [{ status: 200, headers: {}, body: { id: "s" } }],
          { "idempotent-replayed": "true" },
        ),
  );
  let results;
  try {
    results = await client.batched((b) => b.spans.update("s", "V"));
  } finally {
    restore();
  }
  assert.equal(wasReplayed(results), true);
  assert.deepEqual(results, [{ status: 200, headers: {}, body: { id: "s" } }]);
  assert.equal(JSON.stringify(Object.keys(results)), '["0"]');
});

test("a fresh batch's results are not marked", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { restore } = stubServer(() =>
    response(200, [{ status: 200, headers: {}, body: {} }]),
  );
  let results;
  try {
    results = await client.batched((b) => b.spans.update("s", "V"));
  } finally {
    restore();
  }
  assert.equal(wasReplayed(results), false);
});

test("a split batch is marked when any request was replayed, and so is each replayed request", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const answers = (r, replayed) =>
    response(
      200,
      r.body.map(() => ({ status: 200, headers: {}, body: {} })),
      replayed ? { "idempotent-replayed": "true" } : {},
    );
  const chunkMarks = [];
  const post = client._postBatch.bind(client);
  client._postBatch = async (...args) => {
    const out = await post(...args);
    chunkMarks.push(wasReplayed(out));
    return out;
  };
  const { restore } = stubServer((r) => answers(r, r.body.length === 1));
  let results;
  try {
    results = await client.batched((b) => {
      for (let i = 0; i < MAX_BATCH_OPS + 1; i += 1) b.spans.update(`s${i}`, i);
    });
  } finally {
    restore();
  }
  assert.deepEqual(chunkMarks, [false, true]);
  assert.equal(results.length, MAX_BATCH_OPS + 1);
  assert.equal(wasReplayed(results), true);

  const none = stubServer((r) => answers(r, false));
  let fresh;
  try {
    fresh = await client.batched((b) => {
      for (let i = 0; i < MAX_BATCH_OPS + 1; i += 1) b.spans.update(`s${i}`, i);
    });
  } finally {
    none.restore();
  }
  assert.equal(wasReplayed(fresh), false);
});

test("what a failed split batch saved is marked when a saved request was replayed", async () => {
  const client = new PlaidClient("http://x", "tok", fast);
  const { restore } = stubServer((r) =>
    r.body.length === 1
      ? response(409, { error: "conflict" })
      : response(
          200,
          r.body.map(() => ({ status: 200, headers: {}, body: {} })),
          { "idempotent-replayed": "true" },
        ),
  );
  let caught;
  try {
    await client.batched((b) => {
      for (let i = 0; i < MAX_BATCH_OPS + 1; i += 1) b.spans.update(`s${i}`, i);
    });
  } catch (e) {
    caught = e;
  } finally {
    restore();
  }
  assert.equal(caught.committed, MAX_BATCH_OPS);
  assert.equal(wasReplayed(caught.committedResults), true);
});

test("a taken id is made only when it was minted and its row is not deleted", () => {
  // The Python twin is plaid_client.http.minted_taken (R1-DEBT-CORE-6).
  const mine = new Set(["a", "b"]);
  assert.equal(mintedTaken(409, { error: "id-taken", id: "a" }, mine), true);
  assert.equal(
    mintedTaken(409, { error: "id-taken", id: "a", deleted: true }, mine),
    false,
  );
  assert.equal(mintedTaken(409, { error: "id-taken", id: "c" }, mine), false);
  assert.equal(mintedTaken(409, { error: "Document version mismatch" }, mine), false);
  assert.equal(mintedTaken(422, { error: "id-taken", id: "a" }, mine), false);
  assert.equal(mintedTaken(409, { error: "id-taken", id: "a" }, null), false);
  assert.equal(mintedTaken(409, null, mine), false);
});
