// users.avatarToken asks core for a token an image element can show profile
// pictures with, and keeps it: one token serves the whole client until under
// ten minutes of it remain, concurrent calls share one request, and a change
// of the client's login token drops it. users.avatarUrl puts that token, never
// the login token, in the picture's URL.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaidClient } from "../src/index.js";

const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

function stubFetch(answers, seen) {
  let i = 0;
  return async (url, init) => {
    seen.push({ url, init });
    const answer = answers[Math.min(i++, answers.length - 1)];
    return {
      ok: answer.status < 300,
      status: answer.status,
      statusText: "",
      headers: {
        get: (n) =>
          String(n).toLowerCase() === "content-type" ? "application/json" : null,
      },
      json: async () => answer.body,
      text: async () => JSON.stringify(answer.body),
    };
  };
}

async function withFetch(answers, fn) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = stubFetch(answers, seen);
  try {
    return { result: await fn(), seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const minted = (token, expiresAt = inHours(24)) => ({
  status: 200,
  body: { token, "expires-at": expiresAt },
});

test("avatarToken posts to /avatar-link and answers token and expiresAt", async () => {
  const expiresAt = inHours(24);
  const { result, seen } = await withFetch([minted("av1", expiresAt)], () =>
    new PlaidClient("http://core:8085/", "tok").users.avatarToken(),
  );
  assert.deepEqual(result, { token: "av1", expiresAt });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].url, "http://core:8085/api/v1/avatar-link");
  assert.equal(new Headers(seen[0].init.headers).get("Idempotency-Key"), null);
});

test("concurrent calls share one mint and later calls reuse it", async () => {
  const client = new PlaidClient("http://core", "tok");
  const { result, seen } = await withFetch([minted("av1")], async () => {
    const all = await Promise.all([
      client.users.avatarUrl("a@x.org", "h1"),
      client.users.avatarUrl("b@x.org", "h2"),
      client.users.avatarToken(),
    ]);
    all.push(await client.users.avatarUrl("c@x.org"));
    return all;
  });
  assert.equal(seen.length, 1);
  assert.equal(result[0], "http://core/api/v1/users/a@x.org/avatar?avatar-token=av1&v=h1");
  assert.equal(result[1], "http://core/api/v1/users/b@x.org/avatar?avatar-token=av1&v=h2");
  assert.equal(result[2].token, "av1");
  assert.equal(result[3], "http://core/api/v1/users/c@x.org/avatar?avatar-token=av1");
});

test("the URL never carries the login token", async () => {
  const { result } = await withFetch([minted("av1")], () =>
    new PlaidClient("http://core", "login-secret").users.avatarUrl("a@x.org", "h"),
  );
  assert.ok(!result.includes("login-secret"));
  assert.ok(!/[?&]token=/.test(result));
});

test("a null hash resolves to null without a request", async () => {
  const { result, seen } = await withFetch([minted("av1")], () =>
    new PlaidClient("http://core", "tok").users.avatarUrl("a@x.org", null),
  );
  assert.equal(result, null);
  assert.equal(seen.length, 0);
});

test("a token with under ten minutes left is minted again", async () => {
  const client = new PlaidClient("http://core", "tok");
  const { result, seen } = await withFetch(
    [minted("old", inHours(9 / 60)), minted("new")],
    async () => {
      await client.users.avatarToken();
      return client.users.avatarToken();
    },
  );
  assert.equal(seen.length, 2);
  assert.equal(result.token, "new");
});

test("a change of the client's token drops the cached one", async () => {
  const client = new PlaidClient("http://core", "tok1");
  const { result, seen } = await withFetch(
    [minted("for-tok1"), minted("for-tok2")],
    async () => {
      await client.users.avatarToken();
      client.token = "tok2";
      return client.users.avatarToken();
    },
  );
  assert.equal(seen.length, 2);
  assert.equal(new Headers(seen[1].init.headers).get("Authorization"), "Bearer tok2");
  assert.equal(result.token, "for-tok2");
});

test("a failed mint rejects and the next call asks again", async () => {
  const client = new PlaidClient("http://core", "tok");
  const { result, seen } = await withFetch(
    [{ status: 401, body: { error: "Token invalid. Obtain a new token." } }, minted("av2")],
    async () => {
      await assert.rejects(client.users.avatarUrl("a@x.org", "h"), (e) => e.status === 401);
      return client.users.avatarToken();
    },
  );
  assert.equal(seen.length, 2);
  assert.equal(result.token, "av2");
});

test("a batch uses its client's token and queues nothing", async () => {
  const client = new PlaidClient("http://core", "tok");
  const b = client.batch();
  try {
    const { result, seen } = await withFetch([minted("av1")], async () => {
      const first = await b.users.avatarToken();
      const second = await client.users.avatarToken();
      return [first, second];
    });
    assert.equal(seen.length, 1);
    assert.equal(result[0].token, "av1");
    assert.equal(result[1].token, "av1");
    assert.equal(b.operations.length, 0);
  } finally {
    b.abort();
  }
});
