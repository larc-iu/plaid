// The limits a client read from GET /info are read again when they may have
// changed, and only then: after the client's connection to the server dropped
// and came back (a core restart always drops it, and a restart is the only way
// the limits change), and after a private data write refused as too large.
// Against a small fake core over HTTP whose cap changes across a simulated
// restart. The Python twin is plaid-client-py/tests/test_server_limits_refresh.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { PlaidClient } from "../src/index.js";

function fakeCore(cap) {
  const core = { cap, infoReads: 0, streams: new Set() };
  const server = http.createServer((req, res) => {
    if (req.url === "/api/v1/info") {
      core.infoReads += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ limits: { "user-data-value-bytes": core.cap } }));
    } else if (req.url.endsWith("/listen")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('event: connected\ndata: {"client-id": "c"}\n\n');
      core.streams.add(res);
      res.on("close", () => core.streams.delete(res));
    } else if (req.method === "PUT") {
      let n = 0;
      req.on("data", (chunk) => (n += chunk.length));
      req.on("end", () => {
        const refused = n > core.cap;
        res.writeHead(refused ? 413 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(refused ? { error: `Value exceeds ${core.cap} bytes` } : { key: "k", version: 1 }));
      });
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    }
  });
  core.restart = (next) => {
    core.cap = next;
    for (const res of core.streams) res.destroy();
  };
  core.start = () =>
    new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        core.url = `http://127.0.0.1:${server.address().port}`;
        resolve(core);
      }),
    );
  core.stop = () => {
    for (const res of core.streams) res.destroy();
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    return closed;
  };
  return core;
}

const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

const cap = async (client) => (await client.server.limits()).userDataValueBytes;

const open = async (client) => {
  const stream = client.messages.listen("p1", () => {});
  assert.ok(await until(() => stream.readyState === 1));
  return stream;
};

test("a reconnect after a restart reads the limits again, once", async () => {
  const core = await fakeCore(1048576).start();
  try {
    const client = new PlaidClient(core.url, "tok");
    assert.equal(await cap(client), 1048576);
    let streams = [await open(client), await open(client)];
    assert.equal(await cap(client), 1048576);
    assert.equal(core.infoReads, 1, "read once, then kept");

    core.restart(2097152);
    assert.ok(await until(() => streams.every((s) => s.readyState === 2)));
    assert.equal(await cap(client), 1048576, "nothing is read while the server is away");
    assert.equal(core.infoReads, 1);

    streams = [await open(client), await open(client)];
    assert.ok(await until(async () => (await cap(client)) === 2097152));
    assert.equal(core.infoReads, 2, "read again once between the two streams");
    for (const s of streams) s.close();
  } finally {
    await core.stop();
  }
});

test("a stream this side closed reads nothing again", async () => {
  const core = await fakeCore(1048576).start();
  try {
    const client = new PlaidClient(core.url, "tok");
    await cap(client);
    (await open(client)).close();
    core.cap = 2097152;
    (await open(client)).close();
    assert.equal(await cap(client), 1048576);
    assert.equal(core.infoReads, 1);
  } finally {
    await core.stop();
  }
});

test("a 413 reads the cap again before it is thrown", async () => {
  const core = await fakeCore(3000000).start();
  try {
    const client = new PlaidClient(core.url, "tok");
    assert.equal(await cap(client), 3000000);
    // The server restarted with a lower cap, and no stream of this client saw it.
    core.cap = 1000;
    await assert.rejects(client.userData.put("u1", "k", "x".repeat(2000)), (e) => e.status === 413);
    assert.equal(await cap(client), 1000);
    assert.equal(core.infoReads, 2);
  } finally {
    await core.stop();
  }
});

test("a refresh the server does not answer keeps the figures known before", async () => {
  const core = await fakeCore(1048576).start();
  const client = new PlaidClient(core.url, "tok", { timeout: 2000 });
  assert.equal(await cap(client), 1048576);
  await core.stop();
  await assert.rejects(client.server.refresh());
  assert.equal(await cap(client), 1048576);
});
