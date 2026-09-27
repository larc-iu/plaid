// The edits queued behind a refused one (ruling err-queued-edit-after-refusal:
// they are still sent). The refetch after the refusal takes the refused edit
// off the screen. The edits behind it stay on screen while they wait their
// turn, since every edit shows before the server answers. After a conflict
// (409) the edits made on the same out-of-date document are refused as well,
// without being sent: they were planned against what someone else has since
// changed, and sending them with the refetched version would get past the
// check that refused the first.
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

// A server holding `values` (single values) and `lists` (append-only rows,
// like spans), mirrored on `raw`. A GET teaches the client the version, as
// plaid-client does, and a strict write stamped with an old version is 409.
function fakeServer() {
  const server = { values: {}, lists: {}, version: 1, gets: [], writes: [], log: [] };
  const client = {
    strictModeDocumentId: null,
    documentVersions: {},
    withOperation: (label, fn) => fn(() => {}),
    documents: {
      get: () => {
        const hold = server.gets.shift();
        const snapshot = () => {
          client.documentVersions = { ...client.documentVersions, d1: server.version };
          return {
            id: 'd1',
            values: { ...server.values },
            lists: JSON.parse(JSON.stringify(server.lists)),
          };
        };
        return hold ? hold.promise.then(snapshot) : Promise.resolve(snapshot());
      },
    },
    write: async (fn) => {
      const stamp = client.strictModeDocumentId ? client.documentVersions.d1 : null;
      const hold = server.writes.shift();
      if (hold) await hold.promise;
      if (stamp != null && stamp !== server.version) {
        throw Object.assign(new Error('HTTP 409 Document version mismatch'), {
          status: 409,
          method: 'POST',
        });
      }
      fn();
      server.version += 1;
      if (client.strictModeDocumentId) {
        client.documentVersions = { ...client.documentVersions, d1: server.version };
      }
    },
  };
  // Someone else's edit, in another tab.
  server.elsewhere = (key, value) => {
    server.values[key] = value;
    server.version += 1;
  };
  return { server, client };
}

class Doc extends DocumentModel {
  set(key, value) {
    this._applyRawPatch((raw) => {
      raw.values = { ...raw.values, [key]: value };
    });
    return this._queueWrite(`Failed to set ${key}`, () =>
      this._client.write(() => {
        this._server.values[key] = value;
        this._server.log.push(`set ${key}=${value}`);
      }),
    );
  }

  add(list, row) {
    this._applyRawPatch((raw) => {
      raw.lists = { ...raw.lists, [list]: [...(raw.lists?.[list] || []), row] };
    });
    return this._queueWrite(`Failed to add to ${list}`, () =>
      this._client.write(() => {
        this._server.lists[list] = [...(this._server.lists[list] || []), row];
        this._server.log.push(`add ${list}:${row}`);
      }),
    );
  }

  // A write whose send patches the screen once it has landed, the way a
  // create settles the server's ids.
  count() {
    return this._queueWrite('Failed to count', async () => {
      await this._client.write(() => {
        this._server.log.push('count');
      });
      this._applyRawPatch((raw) => {
        raw.counted = (raw.counted || 0) + 1;
      });
    });
  }
}

const load = ({ strict = false } = {}) => {
  const { server, client } = fakeServer();
  if (strict) {
    client.strictModeDocumentId = 'd1';
    client.documentVersions = { d1: server.version };
  }
  const doc = new Doc({ raw: { id: 'd1', values: {}, lists: {} }, client });
  doc._server = server;
  const errors = [];
  doc.onError = (message, err, label) => errors.push({ message, err, label });
  return { doc, server, errors };
};

const tick = () => new Promise((r) => setTimeout(r, 0));
const drain = async (doc) => {
  while (doc.isSaving) await tick();
  await tick();
};

describe('the edits queued behind a refused one', () => {
  it('stay on screen from the refetch after the refusal until they have landed', async () => {
    const { doc, server } = load();
    const refused = deferred();
    const holdB = deferred();
    server.writes.push(refused, holdB);
    const a = doc.set('a', 'UNO');
    const b = doc.set('b', 'DOS');
    const c = doc.set('c', 'TRES');
    refused.reject(Object.assign(new Error('HTTP 500 boom'), { status: 500 }));
    expect(await a).toBe(false);
    // The refetch has landed and b's send is on the wire.
    await tick();
    expect(doc.raw.values).toEqual({ b: 'DOS', c: 'TRES' });
    holdB.resolve();
    expect(await b).toBe(true);
    expect(await c).toBe(true);
    await drain(doc);
    expect(server.log).toEqual(['set b=DOS', 'set c=TRES']);
    expect(doc.raw.values).toEqual({ b: 'DOS', c: 'TRES' });
  });

  it('keeps an edit made while the refetch was on the wire on screen too', async () => {
    const { doc, server } = load();
    const refused = deferred();
    const refetch = deferred();
    const holdC = deferred();
    server.writes.push(refused, holdC);
    server.gets.push(refetch);
    const a = doc.set('a', 'UNO');
    refused.reject(Object.assign(new Error('HTTP 500 boom'), { status: 500 }));
    await tick();
    const c = doc.set('c', 'TRES');
    refetch.resolve();
    expect(await a).toBe(false);
    await tick();
    expect(doc.raw.values).toEqual({ c: 'TRES' });
    holdC.resolve();
    expect(await c).toBe(true);
    await drain(doc);
    expect(doc.raw.values).toEqual({ c: 'TRES' });
  });

  it('does not show a patch a landed send made twice', async () => {
    const { doc, server } = load();
    const refused = deferred();
    const holdB = deferred();
    await doc.count();
    await drain(doc);
    expect(doc.raw.counted).toBe(1);
    server.writes.push(undefined, refused, holdB);
    doc.count();
    const a = doc.set('a', 'UNO');
    const b = doc.set('b', 'DOS');
    refused.reject(Object.assign(new Error('HTTP 500 boom'), { status: 500 }));
    // count lands and patches, a is refused, b waits.
    await a;
    await tick();
    expect(doc.raw.values).toEqual({ b: 'DOS' });
    expect(doc.raw.counted ?? 0).toBe(0);
    holdB.resolve();
    await b;
    await drain(doc);
    expect(doc.raw.values).toEqual({ b: 'DOS' });
  });
});

describe('a refetch from inside a send', () => {
  it('keeps the edits queued behind it on screen', async () => {
    const { doc, server } = load();
    const holdB = deferred();
    server.writes.push(undefined, holdB);
    const upload = doc._queueWrite('Failed to upload', async () => {
      await doc._client.write(() => {
        server.values.m = 'MEDIA';
      });
      await doc._reloadInSend();
    });
    const b = doc.set('b', 'DOS');
    await upload;
    expect(doc.raw.values).toEqual({ m: 'MEDIA', b: 'DOS' });
    holdB.resolve();
    await b;
    await drain(doc);
    expect(doc.raw.values).toEqual({ m: 'MEDIA', b: 'DOS' });
  });
});

describe('after a conflict', () => {
  it('refuses the edits made on the same out-of-date document without sending them, and sends the ones made after the refetch', async () => {
    const { doc, server, errors } = load({ strict: true });
    // Someone else glosses d, and this screen has not seen it.
    server.elsewhere('d', 'THEIRS');
    const refetch = deferred();
    server.gets.push(refetch);
    const holdA = deferred();
    server.writes.push(holdA);
    const a = doc.set('a', 'UNO');
    const b = doc.add('d-gloss', 'MINE');
    holdA.resolve();
    await tick();
    // The refetch after the 409 is on the wire: an edit made now was still
    // planned on the old document.
    const c = doc.set('c', 'TRES');
    refetch.resolve();
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(await c).toBe(false);
    // Made on what the screen now shows.
    const e = doc.set('e', 'CINCO');
    expect(await e).toBe(true);
    await drain(doc);
    expect(server.log).toEqual(['set e=CINCO']);
    expect(server.lists).toEqual({});
    expect(doc.raw.values).toEqual({ d: 'THEIRS', e: 'CINCO' });
    expect(errors.map((x) => x.label)).toEqual([
      'Failed to set a',
      'Failed to add to d-gloss',
      'Failed to set c',
    ]);
    expect(errors.every((x) => x.err.status === 409)).toBe(true);
  });

  it('still sends the edits behind a refusal that was not a conflict, though the document changed elsewhere', async () => {
    const { doc, server } = load({ strict: true });
    const refused = deferred();
    server.writes.push(refused);
    const a = doc.set('a', 'UNO');
    const b = doc.set('b', 'DOS');
    server.elsewhere('d', 'THEIRS');
    refused.reject(Object.assign(new Error('HTTP 500 boom'), { status: 500 }));
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    await drain(doc);
    expect(server.values).toEqual({ b: 'DOS', d: 'THEIRS' });
    expect(doc.raw.values).toEqual({ b: 'DOS', d: 'THEIRS' });
  });

  it('refuses nothing behind a conflict when strict mode is off', async () => {
    const { doc, server } = load();
    const refused = deferred();
    server.writes.push(refused);
    const a = doc.set('a', 'UNO');
    const b = doc.set('b', 'DOS');
    refused.reject(Object.assign(new Error('HTTP 409 conflict'), { status: 409 }));
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    await drain(doc);
    expect(server.log).toEqual(['set b=DOS']);
  });
});
