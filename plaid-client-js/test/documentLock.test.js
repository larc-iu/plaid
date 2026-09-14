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
  DOCUMENT_LOCK_TTL_MS,
  DocumentLockLost,
  LockKeeper,
  lockTtlMs,
} from "../src/documentLock.js";

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

const keeperOn = (clock, refresh, ttlMs = DOCUMENT_LOCK_TTL_MS, onLost = null) =>
  new LockKeeper(refresh, "d1", ttlMs, {
    clock: clock.now,
    sleep: clock.sleep,
    onLost,
  });

const rejectWith = (error) => async () => {
  throw error;
};

// --- reading the window the server actually gave us -------------------------

test("the window comes from the server's own expiresAt", () => {
  // An operator who retunes :plaid.server.locks/config :expiration-ms changes
  // the only number that matters here, and /info does not publish it. The
  // acquire response does.
  assert.equal(lockTtlMs(45000, 0), 45000);
  assert.equal(lockTtlMs(120000, 60000), 60000);
});

test("an unbelievable expiry falls back to the documented default", () => {
  // A clock skew between this machine and the server is the one thing that can
  // produce these, and either a beat that never fires or one that fires
  // constantly is worse than the documented 60 seconds.
  assert.equal(lockTtlMs(undefined, 0), DOCUMENT_LOCK_TTL_MS);
  assert.equal(lockTtlMs(1000, 5000), DOCUMENT_LOCK_TTL_MS);
  assert.equal(lockTtlMs(99999999999, 0), DOCUMENT_LOCK_TTL_MS);
  assert.equal(lockTtlMs("soon", 0), DOCUMENT_LOCK_TTL_MS);
});

test("the beat is half the window and the retry a tenth", () => {
  const short = new LockKeeper(async () => {}, "d1", 20000);
  assert.equal(short.intervalMs, 10000);
  assert.equal(short.retryMs, 2000);
  // A window too short to leave room for a retry is a misconfiguration, not an
  // instruction to hammer the server.
  assert.equal(
    new LockKeeper(async () => {}, "d1", 500).intervalMs,
    DOCUMENT_LOCK_TTL_MS / 2,
  );
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
  const keeper = keeperOn(clock, rejectWith(err), DOCUMENT_LOCK_TTL_MS, (l) =>
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
function stubbedClient(lockReplies) {
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
        get: (n) =>
          String(n).toLowerCase() === "content-type"
            ? "application/json"
            : null,
      },
      json: async () => body,
      text: async () => "{}",
    });
    if (String(url).endsWith("/lock") && method === "POST") {
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
      return ok({ "user-id": "me", "expires-at": Date.now() + reply });
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
    const locks = sent.filter((r) => r.url.endsWith("/lock"));
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
      sent.filter((r) => r.url.endsWith("/lock")).map((r) => r.method),
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
