// A refetch puts the server's document on screen. An edit the server has not
// had yet cannot survive it, so what the screen shows afterwards and what the
// server holds must agree: an edit the refetch took off the screen is not sent,
// and an edit made around a reload from outside the queue is waited for.
import { describe, it, expect } from 'vitest';
import { DocumentModel } from './DocumentModel.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// A server holding `values`, a map the document mirrors as `raw.values`. A
// test can hold the next GET or the next write open, or refuse a write.
function fakeServer() {
  const server = { values: {}, gets: [], writes: [] };
  const client = {
    withOperation: (label, fn) => fn(() => {}),
    documents: {
      get: () => {
        const hold = server.gets.shift();
        const snapshot = { id: 'd1', values: { ...server.values } };
        return hold ? hold.promise.then(() => snapshot) : Promise.resolve(snapshot);
      },
    },
    write: async (key, value) => {
      const hold = server.writes.shift();
      if (hold) await hold.promise;
      server.values[key] = value;
    },
  };
  return { server, client };
}

class Doc extends DocumentModel {
  set(key, value) {
    this._applyRawPatch((raw) => {
      raw.values = { ...raw.values, [key]: value };
    });
    return this._queueWrite(`Failed to set ${key}`, () => this._client.write(key, value));
  }
}

const load = () => {
  const { server, client } = fakeServer();
  const doc = new Doc({ raw: { id: 'd1', values: {} }, client });
  doc.onError = () => {};
  return { doc, server };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const drain = async (doc) => {
  while (doc.isSaving) await tick();
  await tick();
};

describe('a refetch and the edits around it', () => {
  it('does not send an edit made while the refetch after a failure is on the wire', async () => {
    const { doc, server } = load();
    const refused = deferred();
    const refetch = deferred();
    server.writes.push(refused);
    server.gets.push(refetch);

    const a = doc.set('a', 'AAA');
    refused.reject(new Error('500'));
    await tick();
    // The failure's refetch is on the wire. The annotator keeps typing.
    const c = doc.set('c', 'CCC');
    expect(doc.raw.values.c).toBe('CCC');
    refetch.resolve();

    expect(await a).toBe(false);
    expect(await c).toBe(false);
    await drain(doc);
    expect(server.values).toEqual({});
    expect(doc.raw.values).toEqual(server.values);
  });

  it('does not send an edit queued behind a send that refetches', async () => {
    const { doc, server } = load();
    const held = deferred();
    doc._applyRawPatch((raw) => {
      raw.values = { a: 'AAA' };
    });
    const a = doc._queueWrite('Failed to rebuild', async () => {
      await held.promise;
      server.values.a = 'AAA';
      await doc._reload();
    });
    const b = doc.set('b', 'BBB');
    held.resolve();

    expect(await a).toBe(true);
    expect(await b).toBe(false);
    await drain(doc);
    expect(doc.raw.values).toEqual(server.values);
  });

  it('waits for queued edits before a reload from outside, and keeps them on screen', async () => {
    const { doc, server } = load();
    const held = deferred();
    server.writes.push(held);
    const a = doc.set('a', 'AAA');
    const reloaded = doc.reload();
    held.resolve();
    await reloaded;
    expect(await a).toBe(true);
    expect(doc.raw.values).toEqual({ a: 'AAA' });
    expect(server.values).toEqual({ a: 'AAA' });
  });

  it('fetches again when an edit is made while a reload from outside is on the wire', async () => {
    const { doc, server } = load();
    const first = deferred();
    server.gets.push(first);
    const reloaded = doc.reload();
    await tick();
    const b = doc.set('b', 'BBB');
    first.resolve();
    await reloaded;
    expect(await b).toBe(true);
    expect(doc.raw.values).toEqual({ b: 'BBB' });
    expect(server.values).toEqual({ b: 'BBB' });
  });
});
