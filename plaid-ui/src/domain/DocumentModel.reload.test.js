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
  const server = { values: {}, name: 'Doc', gets: [], writes: [], log: [], copyFails: false };
  const client = {
    withOperation: (label, fn) => fn(() => {}),
    documents: {
      get: () => {
        if (server.offline) return Promise.reject(new Error('Network error: Failed to fetch'));
        if (server.getError) return Promise.reject(server.getError);
        const hold = server.gets.shift();
        const snapshot = { id: 'd1', name: server.name, values: { ...server.values } };
        return hold ? hold.promise.then(() => snapshot) : Promise.resolve(snapshot);
      },
      update: async (id, name) => {
        server.name = name;
        server.log.push(`rename ${name}`);
      },
      copy: async () => {
        if (server.copyFails) throw new Error('refused');
        server.log.push(`copy ${JSON.stringify(server.values)}`);
        return { id: 'copy-1' };
      },
    },
    write: async (key, value) => {
      const hold = server.writes.shift();
      if (hold) await hold.promise;
      server.values[key] = value;
      server.log.push(`write ${key}`);
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
  const doc = new Doc({ raw: { id: 'd1', name: 'Doc', values: {} }, client });
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

  it('keeps saving until the screen is back in step, when the refetch after a refusal fails too', async () => {
    // Offline: the gloss is refused and the refetch that would take it back
    // off the screen fails as well. Until a refetch lands, the screen shows a
    // gloss the server does not have, so the document stays saving (the
    // close-tab guard holds) and keeps trying.
    const { doc, server } = load();
    doc._writes._retryDelay = () => 10;
    const refused = deferred();
    server.writes.push(refused);
    server.offline = true;
    const a = doc.set('a', 'GHOST');
    refused.reject(new Error('Network error: Failed to fetch'));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 15));
    expect(doc.isSaving).toBe(true);
    expect(doc.raw.values.a).toBe('GHOST');
    server.offline = false;
    expect(await a).toBe(false);
    await drain(doc);
    expect(doc.isSaving).toBe(false);
    expect(doc.raw.values).toEqual({});
  });

  it('says how many edits made after a refused one were not saved', async () => {
    const { doc, server } = load();
    const errors = [];
    doc.onError = (msg, err, label) => errors.push({ msg, err, label });
    const refused = deferred();
    server.writes.push(refused);
    const a = doc.set('a', 'uno');
    const b = doc.set('b', 'dos');
    const c = doc.set('c', 'tres');
    refused.reject(new Error('500'));
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(await c).toBe(false);
    expect(errors.map((e) => e.label)).toEqual(['Failed to set a', 'Not saved']);
    expect(errors[1].msg).toBe('2 later edits were not saved.');
    expect(errors[1].err).toBe(null);
  });

  it('sends an edit queued behind a send that refetches, and shows it once the queue drains', async () => {
    // A media upload refetches from inside its send. A gloss typed meanwhile
    // was refused by nobody: it is sent, and the screen catches up with it.
    const { doc, server } = load();
    const held = deferred();
    doc._applyRawPatch((raw) => {
      raw.values = { a: 'AAA' };
    });
    const a = doc._queueWrite('Failed to rebuild', async () => {
      await held.promise;
      server.values.a = 'AAA';
      await doc._reloadInSend();
    });
    const b = doc.set('b', 'BBB');
    held.resolve();

    expect(await a).toBe(true);
    expect(await b).toBe(true);
    await drain(doc);
    expect(server.values).toEqual({ a: 'AAA', b: 'BBB' });
    expect(doc.raw.values).toEqual(server.values);
  });

  it('treats a reload from outside that arrives mid-send as outside, and skips nothing', async () => {
    const { doc, server } = load();
    const held = deferred();
    server.writes.push(held);
    const a = doc.set('a', 'AAA');
    const b = doc.set('b', 'BBB');
    const reloaded = doc.reload();
    held.resolve();
    await reloaded;
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(server.values).toEqual({ a: 'AAA', b: 'BBB' });
    expect(doc.raw.values).toEqual(server.values);
  });

  it('sends a rename after the edits made before it, and stays saving until both land', async () => {
    const { doc, server } = load();
    const held = deferred();
    server.writes.push(held);
    const a = doc.set('a', 'AAA');
    const renamed = doc.rename('New');
    // On screen at once, sent in its turn.
    expect(doc.raw.name).toBe('New');
    expect(server.log).toEqual([]);
    held.resolve();
    expect(await a).toBe(true);
    expect(doc.isSaving).toBe(true);
    expect(await renamed).toBe(true);
    await drain(doc);
    expect(doc.isSaving).toBe(false);
    expect(server.log).toEqual(['write a', 'rename New']);
  });

  it('copies the document once the edits made before the copy have landed', async () => {
    const { doc, server } = load();
    const held = deferred();
    server.writes.push(held);
    doc.set('gloss', 'dog');
    const copied = doc.copyTo('Copy');
    held.resolve();
    expect(await copied).toEqual({ id: 'copy-1', name: 'Copy' });
    expect(server.log).toEqual(['write gloss', 'copy {"gloss":"dog"}']);
  });

  it('makes a copy asked for behind an edit that is then refused', async () => {
    const { doc, server } = load();
    const refused = deferred();
    server.writes.push(refused);
    const a = doc.set('a', 'AAA');
    const copied = doc.copyTo('Copy');
    refused.reject(new Error('500'));
    expect(await a).toBe(false);
    expect(await copied).toEqual({ id: 'copy-1', name: 'Copy' });
    expect(server.log).toEqual(['copy {}']);
  });

  it('skips nothing behind a copy that failed, since the copy showed nothing', async () => {
    const { doc, server } = load();
    server.copyFails = true;
    const copied = doc.copyTo('Copy');
    const b = doc.set('b', 'BBB');
    expect(await copied).toBe(null);
    expect(await b).toBe(true);
    await drain(doc);
    expect(server.values).toEqual({ b: 'BBB' });
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

  it('stops refetching once no screen holds it, and says what was not sent', async () => {
    // Offline, a gloss is refused and the refetch keeps failing. The linguist
    // goes back to the project's list: nothing is on screen for a refetch to
    // put right, so it stops and the document is no longer saving.
    const { doc, server } = load();
    const errors = [];
    doc.onError = (msg, err, label) => errors.push({ msg, label });
    doc._writes._retryDelay = () => 60000;
    const release = doc.hold();
    const refused = deferred();
    server.writes.push(refused);
    server.offline = true;
    const a = doc.set('a', 'GHOST');
    const b = doc.set('b', 'LATER');
    refused.reject(new Error('Network error: Failed to fetch'));
    await tick();
    await tick();
    expect(doc.isSaving).toBe(true);
    release();
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(doc.isSaving).toBe(false);
    expect(server.values).toEqual({});
    expect(errors.map((e) => e.label)).toEqual(['Failed to set a', 'Not saved']);
  });

  it('keeps refetching through a release and a hold straight after it', async () => {
    const { doc, server } = load();
    doc._writes._retryDelay = () => 5;
    const release = doc.hold();
    const refused = deferred();
    server.writes.push(refused);
    server.offline = true;
    const a = doc.set('a', 'GHOST');
    refused.reject(new Error('Network error: Failed to fetch'));
    await tick();
    // React's StrictMode, or a remount: let go and held again at once.
    release();
    const again = doc.hold();
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(doc.isSaving).toBe(true);
    server.offline = false;
    expect(await a).toBe(false);
    await drain(doc);
    expect(doc.raw.values).toEqual({});
    again();
  });

  it('refetches when held again after a refetch was left undone', async () => {
    const { doc, server } = load();
    doc._writes._retryDelay = () => 60000;
    const release = doc.hold();
    const refused = deferred();
    server.writes.push(refused);
    server.offline = true;
    const a = doc.set('a', 'GHOST');
    refused.reject(new Error('Network error: Failed to fetch'));
    await tick();
    release();
    expect(await a).toBe(false);
    expect(doc.raw.values.a).toBe('GHOST');
    server.offline = false;
    doc.hold();
    await tick();
    await drain(doc);
    expect(doc.raw.values).toEqual({});
  });

  it('keeps saving when let go with no one to tell about the edits it holds', async () => {
    const { doc, server } = load();
    doc.onError = null;
    doc._writes._retryDelay = () => 5;
    const release = doc.hold();
    const refused = deferred();
    server.writes.push(refused);
    server.offline = true;
    const a = doc.set('a', 'GHOST');
    doc.set('b', 'LATER');
    refused.reject(new Error('Network error: Failed to fetch'));
    await tick();
    release();
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(doc.isSaving).toBe(true);
    server.offline = false;
    expect(await a).toBe(false);
  });

  it('gives up on a refetch the server keeps failing, and says the page is out of date', async () => {
    const { doc, server } = load();
    const errors = [];
    doc.onError = (msg, err, label) => errors.push({ msg, label });
    doc._writes._retryDelay = () => 0;
    const refused = deferred();
    server.writes.push(refused);
    server.getError = Object.assign(new Error('HTTP 500 boom'), { status: 500 });
    const a = doc.set('a', 'GHOST');
    const b = doc.set('b', 'LATER');
    refused.reject(Object.assign(new Error('HTTP 500 boom'), { status: 500 }));
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    await drain(doc);
    expect(doc.isSaving).toBe(false);
    // What was typed stays on screen, for the reader to see before reloading.
    expect(doc.raw.values).toEqual({ a: 'GHOST', b: 'LATER' });
    expect(errors.map((e) => e.label)).toEqual(['Failed to set a', 'Out of date', 'Not saved']);
    expect(errors[1].msg).toBe('Reload the page to see what is saved.');
  });
});
