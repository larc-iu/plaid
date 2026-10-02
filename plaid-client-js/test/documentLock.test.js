// The keep-alive on `client.documents.locked()`.
//
// plaid-core expires a document lock 60 seconds after it was taken
// (`plaid.server.locks/default-lock-expiration-ms`) and the holder's own writes
// are what renew it. A service that reads a document, loads a model, parses for
// minutes and only then writes therefore held the lock for its first minute and
// nothing after that: it lapsed in silence, a person's edit could land between
// the read the work was planned from and the write about to go out, and the
// write clobbered it.
//
// So the block renews on a timer, and a renewal it cannot make ends the run
// rather than letting it write unlocked. Every test here runs on a fake clock:
// the policy tests drive the keeper's own loop, the end-to-end ones fake
// setTimeout and Date.
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import PlaidClient from "../src/index.js";
import {
  DocumentLockLost,
  LockKeeper,
  lockTtlMs,
} from "../src/documentLock.js";

// What plaid-core holds a lock for by default.
const TTL_MS = 60000;

/**
 * A clock the keeper's own sleeps advance, plus a stop after N of them.
 * `sleep` resolves true once the block holding the lock has exited, which is
 * how `run()` terminates.
 */
class FakeClock {
  constructor(stopAfter) {
    this.t = 0;
    this.slept = [];
    this.stopAfter = stopAfter;
  }
  now = () => this.t;
  sleep = async (delay) => {
    if (this.slept.length >= this.stopAfter) return true;
    this.slept.push(delay);
    this.t += delay;
    return false;
  };
}

const keeperOn = (
  clock,
  refresh,
  ttlMs = TTL_MS,
  onLost = null,
) =>
  new LockKeeper(refresh, "d1", ttlMs, {
    clock: clock.now,
    sleep: clock.sleep,
    onLost,
  });

const rejectWith = (error) => async () => {
  throw error;
};

// --- reading the window the server actually gave us -------------------------

test("the window comes from the server's own expiresAt, on the server's clock", () => {
  // An operator who retunes :plaid.server.locks/config :expiration-ms changes
  // the only number that matters here. /info publishes the window; the acquire
  // response names the moment, which is what a renewal plans against, read
  // against the server's clock (`serverNow`), so this machine's clock cannot
  // skew it.
  assert.equal(lockTtlMs(45000, 0), 45000);
  assert.equal(lockTtlMs(120000, 60000), 60000);
});

test("the beat is half the window and the retry a tenth", () => {
  const short = new LockKeeper(async () => {}, "d1", 20000);
  assert.equal(short.intervalMs, 10000);
  assert.equal(short.retryMs, 2000);
  // A window too short to leave room for a retry still beats at most once a
  // second.
  assert.equal(new LockKeeper(async () => {}, "d1", 500).intervalMs, 1000);
});

// --- the beat ---------------------------------------------------------------

test("a long quiet run keeps the lock", async () => {
  const clock = new FakeClock(4);
  const calls = [];
  const keeper = keeperOn(clock, async (id) => calls.push(id));
  await keeper.run();
  // Four minutes of a parse that writes nothing, and the lock was renewed
  // every thirty seconds rather than lapsing after the first.
  assert.deepEqual(clock.slept, [30000, 30000, 30000, 30000]);
  assert.deepEqual(calls, ["d1", "d1", "d1", "d1"]);
  assert.equal(keeper.lost, null);
});

test("one failed renewal is retried before the lock runs out", async () => {
  const clock = new FakeClock(4);
  const attempts = [];
  const keeper = keeperOn(clock, async () => {
    attempts.push(clock.now());
    if (attempts.length === 1) {
      const err = new Error("Network error");
      err.status = 0;
      throw err;
    }
  });
  await keeper.run();
  // Failed at 30s, retried at 36s, well inside the 60s the lock had left.
  assert.deepEqual(clock.slept, [30000, 6000, 30000, 30000]);
  assert.deepEqual(attempts, [30000, 36000, 66000, 96000]);
  assert.equal(keeper.lost, null);
});

test("failures that outlast the window lose the lock", async () => {
  const clock = new FakeClock(20);
  const lost = [];
  const err = new Error("Network error");
  err.status = 0;
  const keeper = keeperOn(clock, rejectWith(err), TTL_MS, (l) =>
    lost.push(l),
  );
  await keeper.run();
  // 30, 36, 42, 48, 54, 60: the sixth attempt is the first at or past the
  // moment the lock we were renewing actually expired.
  assert.deepEqual(clock.slept, [30000, 6000, 6000, 6000, 6000, 6000]);
  assert.ok(keeper.lost instanceof DocumentLockLost);
  assert.equal(keeper.lost.documentId, "d1");
  assert.deepEqual(lost, [keeper.lost]);
});

test("a 423 loses the lock at once", async () => {
  // Somebody else holds the document now, so ours had already expired. There is
  // nothing to retry.
  const clock = new FakeClock(20);
  const err = new Error("Locked");
  err.status = 423;
  const keeper = keeperOn(clock, rejectWith(err));
  await keeper.run();
  assert.deepEqual(clock.slept, [30000]);
  assert.ok(keeper.lost instanceof DocumentLockLost);
});

// --- what a lost lock does to the block that was holding it -----------------

/**
 * A real client whose fetch is stubbed. `lockReplies` is consulted per POST to
 * the lock route; anything else answers 200 with an empty object.
 */
const isLock = (url) => new URL(url).pathname.endsWith("/lock");

function stubbedClient(lockReplies, { skewMs = null } = {}) {
  const client = new PlaidClient("http://plaid.internal:8085", "tok");
  const sent = [];
  let locks = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    sent.push({ method, url: String(url) });
    const ok = (body) => ({
      ok: true,
      status: 200,
      headers: {
        get: (n) => {
          const name = String(n).toLowerCase();
          if (name === "content-type") return "application/json";
          if (name === "date" && skewMs !== null)
            return new Date(Date.now() + skewMs).toUTCString();
          return null;
        },
      },
      json: async () => body,
      text: async () => "{}",
    });
    if (isLock(url) && method === "POST") {
      const reply = lockReplies[Math.min(locks++, lockReplies.length - 1)];
      if (reply === 423) {
        return {
          ok: false,
          status: 423,
          statusText: "Locked",
          headers: {
            get: (n) =>
              String(n).toLowerCase() === "content-type"
                ? "application/json"
                : null,
          },
          json: async () => ({ "user-id": "someone@else.com" }),
          text: async () => "{}",
        };
      }
      return ok({
        "lock-id": "L1",
        "user-id": "me",
        "expires-at": Date.now() + (skewMs ?? 0) + reply,
      });
    }
    return ok({});
  };
  return { client, sent };
}

const withStub = async (fn) => {
  const realFetch = globalThis.fetch;
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
    globalThis.fetch = realFetch;
  }
};

/**
 * Move the fake clock and let everything the fired timer started run.
 * `mock.timers.tick` is synchronous, so the beat's own awaits (the acquire, its
 * response, the next sleep it schedules) need real turns after it.
 */
const advance = async (ms) => {
  mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

test("a block renews while it runs, and stops renewing on the way out", async () => {
  await withStub(async () => {
    const { client, sent } = stubbedClient([60000]);
    await client.documents.locked("d1", async () => {
      // Two minutes of a parse that writes nothing.
      for (let i = 0; i < 4; i++) await advance(30000);
    });
    const locks = sent.filter((r) => isLock(r.url));
    // Take, renew at 30/60/90/120, release. Without the beat the lock would
    // have been gone from the 60-second mark.
    assert.deepEqual(
      locks.map((r) => r.method),
      ["POST", "POST", "POST", "POST", "POST", "DELETE"],
    );
    // And nothing keeps beating once the block is done.
    const after = sent.length;
    await advance(120000);
    assert.equal(sent.length, after);
  });
});

test("a server clock half an hour ahead of this machine's does not stretch the beat", async () => {
  await withStub(async () => {
    // The lock's expiresAt is the server's moment. Read against this
    // machine's clock it looked 31 minutes away, and the block went 15
    // minutes between renewals of a one-minute lock.
    const { client, sent } = stubbedClient([60000], { skewMs: 30 * 60000 });
    await client.documents.locked("d1", async () => {
      for (let i = 0; i < 4; i++) await advance(30000);
    });
    const locks = sent.filter((r) => isLock(r.url));
    assert.deepEqual(
      locks.map((r) => r.method),
      ["POST", "POST", "POST", "POST", "POST", "DELETE"],
    );
  });
});

test("a lost lock stops the next write and ends the block", async () => {
  await withStub(async () => {
    const { client, sent } = stubbedClient([60000, 423]);
    let writeError = null;
    let readOk = false;
    await assert.rejects(
      client.documents.locked("d1", async () => {
        await advance(30000);
        try {
          await client.tokens.create("tl1", "t1", 0, 5);
        } catch (e) {
          writeError = e;
        }
        // A read is still fine: it cannot clobber anyone.
        await client.documents.get("d1");
        readOk = true;
      }),
      (e) => e instanceof DocumentLockLost && e.documentId === "d1",
    );
    assert.ok(writeError instanceof DocumentLockLost);
    assert.equal(readOk, true);
    // The write never went out; the read and the release did.
    assert.equal(
      sent.some((r) => r.url.endsWith("/api/v1/tokens")),
      false,
    );
    assert.ok(sent.some((r) => r.method === "DELETE"));
    // The flag is cleared on the way out, so a later block can write.
    assert.equal(client.documentLockLost, null);
    await client.tokens.create("tl1", "t1", 0, 5);
    assert.ok(sent.some((r) => r.url.endsWith("/api/v1/tokens")));
  });
});

test("the block's own error is never masked by the loss", async () => {
  await withStub(async () => {
    const { client } = stubbedClient([60000, 423]);
    await assert.rejects(
      client.documents.locked("d1", async () => {
        await advance(30000);
        throw new Error("no gloss field by that name");
      }),
      /no gloss field by that name/,
    );
  });
});

test("the handle lets work give up before its next write", async () => {
  await withStub(async () => {
    const { client } = stubbedClient([60000, 423]);
    const seen = [];
    await assert.rejects(
      client.documents.locked("d1", async (lock) => {
        assert.equal(lock.lost, null);
        lock.raiseIfLost();
        await advance(30000);
        seen.push(lock.lost);
        lock.raiseIfLost();
        throw new Error("never reached");
      }),
      (e) => e instanceof DocumentLockLost,
    );
    assert.ok(seen[0] instanceof DocumentLockLost);
  });
});

test("keepAlive false takes the lock and starts nothing", async () => {
  await withStub(async () => {
    const { client, sent } = stubbedClient([60000]);
    const out = await client.documents.locked(
      "d1",
      async (lock) => {
        assert.equal(lock.lost, null);
        await advance(120000);
        return "done";
      },
      { keepAlive: false },
    );
    assert.equal(out, "done");
    assert.deepEqual(
      sent.filter((r) => isLock(r.url)).map((r) => r.method),
      ["POST", "DELETE"],
    );
  });
});

test("another user's lock still refuses before the block runs", async () => {
  await withStub(async () => {
    const { client } = stubbedClient([423]);
    let ran = false;
    await assert.rejects(
      client.documents.locked("d1", async () => {
        ran = true;
      }),
      (e) => e.status === 423 && /someone@else\.com/.test(e.message),
    );
    assert.equal(ran, false);
  });
});

test("the block renews and releases with the holder id the acquire named", async () => {
  await withStub(async () => {
    const { client, sent } = stubbedClient([60000]);
    await client.documents.locked("d1", async (lock) => {
      assert.equal(lock.lockId, "L1");
      await advance(30000);
    });
    const locks = sent
      .filter((r) => isLock(r.url))
      .map((r) => [r.method, r.url]);
    assert.equal(locks[0][0], "POST");
    assert.match(
      locks[0][1],
      /^http:\/\/plaid\.internal:8085\/api\/v1\/documents\/d1\/lock\?new-lock-id=[0-9a-f-]{36}$/,
    );
    assert.deepEqual(locks.slice(1), [
      [
        "POST",
        "http://plaid.internal:8085/api/v1/documents/d1/lock?lock-id=L1",
      ],
      [
        "DELETE",
        "http://plaid.internal:8085/api/v1/documents/d1/lock?lock-id=L1",
      ],
    ]);
  });
});

test("a second block of the same user is refused and cannot release the first", async () => {
  // Two approvals by one person on one document at once. plaid-core's rule is
  // per holder: an acquire without an id is a new holder, refused while anyone
  // holds the document, and only the holder's id renews or releases it.
  await withStub(async () => {
    let holder = null;
    let minted = 0;
    const reply = (status, body) => ({
      ok: status < 400,
      status,
      statusText: status === 423 ? "Locked" : "OK",
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
    globalThis.fetch = async (url, opts = {}) => {
      const method = opts.method || "GET";
      const params = new URL(url).searchParams;
      const lockId = params.get("lock-id") ?? params.get("new-lock-id");
      if (method === "POST") {
        if (holder !== null && holder !== lockId)
          return reply(423, { error: "Document is locked", "user-id": "me" });
        const id = lockId ?? `L${++minted}`;
        holder = id;
        return reply(200, {
          "lock-id": id,
          "user-id": "me",
          "expires-at": Date.now() + 60000,
        });
      }
      if (method === "DELETE" && holder === lockId) holder = null;
      return reply(200, {});
    };
    const first = new PlaidClient("http://plaid.internal:8085", "tok");
    const second = new PlaidClient("http://plaid.internal:8085", "tok");
    await first.documents.locked("d1", async (held) => {
      let ran = false;
      await assert.rejects(
        second.documents.locked("d1", async () => {
          ran = true;
        }),
        (e) => e.status === 423,
      );
      assert.equal(ran, false);
      assert.equal(holder, held.lockId);
      // The first's beat still renews it.
      await advance(30000);
      assert.equal(holder, held.lockId);
    });
    assert.equal(holder, null);
  });
});

// An acquire whose answer was lost. plaid-core's per-holder rule behind a
// network that loses the answers to the first `lose` acquires: the core took
// the lock each time.
function lostAnswerCore(lose) {
  const core = { holder: null, acquires: [] };
  const reply = (status, body) => ({
    ok: status < 400,
    status,
    statusText: status === 423 ? "Locked" : "OK",
    headers: {
      get: (n) =>
        String(n).toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  core.fetch = async (url, opts = {}) => {
    const method = opts.method || "GET";
    const params = new URL(url).searchParams;
    const lockId = params.get("lock-id") ?? params.get("new-lock-id");
    if (method === "POST") {
      if (core.holder !== null && core.holder !== lockId)
        return reply(423, { error: "Document is locked", "user-id": "me" });
      core.holder = lockId;
      if (params.has("new-lock-id")) {
        core.acquires.push(url);
        if (core.acquires.length <= lose) throw new TypeError("fetch failed");
      }
      return reply(200, {
        "lock-id": lockId,
        "user-id": "me",
        "expires-at": Date.now() + 60000,
      });
    }
    if (method === "DELETE" && core.holder === lockId) core.holder = null;
    return reply(200, {});
  };
  return core;
}

test("an acquire whose answer was lost is sent again under the same id", async () => {
  const realFetch = globalThis.fetch;
  try {
    const core = lostAnswerCore(1);
    globalThis.fetch = core.fetch;
    const client = new PlaidClient("http://plaid.internal:8085", "tok");
    await client.documents.locked(
      "d1",
      async (lock) => {
        assert.equal(core.holder, lock.lockId);
      },
      { keepAlive: false, acquireRetryMs: 0 },
    );
    assert.equal(core.acquires.length, 2);
    assert.equal(core.acquires[0], core.acquires[1]);
    assert.equal(core.holder, null, "the block released it on the way out");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an acquire never answered releases what it may hold", async () => {
  const realFetch = globalThis.fetch;
  try {
    const core = lostAnswerCore(3);
    globalThis.fetch = core.fetch;
    const client = new PlaidClient("http://plaid.internal:8085", "tok");
    let ran = false;
    await assert.rejects(
      client.documents.locked(
        "d1",
        async () => {
          ran = true;
        },
        { keepAlive: false, acquireRetryMs: 0 },
      ),
      (e) => e.status === 0,
    );
    assert.equal(ran, false);
    assert.equal(core.acquires.length, 3);
    assert.equal(
      core.holder,
      null,
      "the lock it took unseen is released, not left to expire",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an acquire made offline is not sent again", async () => {
  // The request never left, as any write's resend rule has it (retryUnknown).
  const realFetch = globalThis.fetch;
  const had = Object.getOwnPropertyDescriptor(globalThis.navigator, "onLine");
  Object.defineProperty(globalThis.navigator, "onLine", {
    value: false,
    configurable: true,
  });
  try {
    const core = lostAnswerCore(3);
    globalThis.fetch = core.fetch;
    const client = new PlaidClient("http://plaid.internal:8085", "tok");
    await assert.rejects(
      client.documents.locked("d1", async () => assert.fail("the block ran"), {
        keepAlive: false,
        acquireRetryMs: 0,
      }),
      (e) => e.status === 0 && e.offline === true,
    );
    assert.equal(core.acquires.length, 1);
  } finally {
    if (had) Object.defineProperty(globalThis.navigator, "onLine", had);
    else delete globalThis.navigator.onLine;
    globalThis.fetch = realFetch;
  }
});

test("the refusal names the holder and no document id", async () => {
  const realFetch = globalThis.fetch;
  try {
    const core = lostAnswerCore(0);
    core.holder = "someone-else";
    globalThis.fetch = core.fetch;
    const client = new PlaidClient("http://plaid.internal:8085", "tok");
    await assert.rejects(
      client.documents.locked(
        "01a0ee8b-fe96-7000-9884-d5be54bc5a86",
        async () => assert.fail("the block ran"),
        { keepAlive: false },
      ),
      (e) =>
        e.status === 423 &&
        e.message ===
          "This document is being edited by me. Try again once they're done.",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});
