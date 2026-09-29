import { describe, it, expect, vi, afterEach } from 'vitest';
import { DocumentModel } from './DocumentModel.js';

// A document's writes on a bad network and against other people's edits
// (the concurrency campaign of 2026-09-29): a write that never left the
// browser goes again when the network is back (H5-4), a write whose answer
// was lost is looked for again later (D2), a write to something another user
// deleted is a change elsewhere (D3), and a screen can name what an edit
// changed in History (D14).

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

// A server with one value per key and a version. A strict write stamped with
// an old version is refused 409, as plaid-core does.
function fakeServer() {
  const server = { values: {}, version: 1, reads: 0, labels: [], fail: [] };
  const client = {
    strictModeDocumentId: 'd1',
    documentVersions: { d1: 1 },
    withOperation: async (label, fn) => {
      server.labels.push(label);
      return fn(() => {});
    },
    documents: {
      get: async () => {
        server.reads += 1;
        client.documentVersions = { ...client.documentVersions, d1: server.version };
        return { id: 'd1', values: { ...server.values } };
      },
    },
    write: async (key, value) => {
      const stamp = client.strictModeDocumentId === 'd1' ? client.documentVersions.d1 : null;
      const failure = server.fail.shift();
      if (failure) {
        if (failure.landed) {
          server.values[key] = value;
          server.version += 1;
        }
        throw failure.error();
      }
      if (stamp != null && stamp !== server.version) {
        throw Object.assign(new Error('HTTP 409 Document version mismatch'), {
          status: 409,
          method: 'PATCH',
        });
      }
      server.values[key] = value;
      server.version += 1;
      client.documentVersions = { ...client.documentVersions, d1: server.version };
    },
  };
  return { server, client };
}

class Doc extends DocumentModel {
  set(key, value) {
    this._applyRawPatch((raw) => {
      raw.values = { ...raw.values, [key]: value };
    });
    return this._queueWrite(`Failed to update ${key}`, () => this._client.write(key, value));
  }
}

const open = () => {
  const { server, client } = fakeServer();
  const doc = new Doc({ raw: { id: 'd1', values: {} }, client });
  const errors = [];
  doc.onError = (msg, err) => errors.push({ msg, err });
  return { server, client, doc, errors };
};

const offline = () =>
  Object.assign(new Error('Network error: Failed to fetch'), {
    status: 0,
    method: 'PATCH',
    offline: true,
  });
const lost = () => Object.assign(new Error('Request timed out'), { status: 0, method: 'PATCH' });

afterEach(() => {
  vi.useRealTimers();
});

describe('a write made offline', () => {
  it('is sent once the network is back, and is not refused', async () => {
    const { server, doc, errors } = open();
    doc._writes._retryDelay = () => 60000;
    server.fail.push({ error: offline });
    const saved = doc.set('gloss', 'DOG');
    const later = doc.set('pos', 'N');
    await flush();
    expect(doc.isOffline).toBe(true);
    expect(doc.raw.values).toEqual({ gloss: 'DOG', pos: 'N' });
    window.dispatchEvent(new Event('online'));
    expect(await saved).toBe(true);
    expect(await later).toBe(true);
    expect(server.values).toEqual({ gloss: 'DOG', pos: 'N' });
    expect(errors).toEqual([]);
    expect(doc.isOffline).toBe(false);
  });

  it('is refused, not sent twice, when it did land after all', async () => {
    const { server, doc, errors } = open();
    doc._writes._retryDelay = () => 0;
    server.fail.push({ error: offline, landed: true });
    const saved = doc.set('gloss', 'DOG');
    // The version moved, so the resend is not allowed: nothing is written
    // twice, and the refetch shows what landed.
    expect(await saved).toBe(false);
    await flush();
    expect(server.version).toBe(2);
    expect(errors).toHaveLength(1);
    expect(doc.raw.values).toEqual({ gloss: 'DOG' });
  });

  it('is refused as before outside strict mode, where the server cannot check a resend', async () => {
    const { server, client, doc, errors } = open();
    client.strictModeDocumentId = null;
    server.fail.push({ error: offline });
    expect(await doc.set('gloss', 'DOG')).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe('a write whose answer was lost', () => {
  it('reads the document again 30 s and 90 s later while a screen shows it', async () => {
    vi.useFakeTimers();
    const { server, doc } = open();
    const release = doc.hold();
    server.fail.push({ error: lost });
    const saved = doc.set('gloss', 'DOG');
    await vi.advanceTimersByTimeAsync(10);
    expect(await saved).toBe(false);
    const after = server.reads;
    // The late write lands after the refetch that followed the failure.
    server.values.gloss = 'DOG';
    server.version += 1;
    await vi.advanceTimersByTimeAsync(30000);
    expect(server.reads).toBe(after + 1);
    expect(doc.raw.values).toEqual({ gloss: 'DOG' });
    await vi.advanceTimersByTimeAsync(60000);
    expect(server.reads).toBe(after + 2);
    release();
  });

  it('calls the later reads off once no screen shows the document', async () => {
    vi.useFakeTimers();
    const { server, doc } = open();
    const release = doc.hold();
    server.fail.push({ error: lost });
    await doc.set('gloss', 'DOG');
    await vi.advanceTimersByTimeAsync(0);
    expect(doc._lateReads.size).toBe(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(doc._lateReads.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not read again once no screen shows the document', async () => {
    vi.useFakeTimers();
    const { server, doc } = open();
    server.fail.push({ error: lost });
    const saved = doc.set('gloss', 'DOG');
    await vi.advanceTimersByTimeAsync(10);
    expect(await saved).toBe(false);
    const after = server.reads;
    await vi.advanceTimersByTimeAsync(100000);
    expect(server.reads).toBe(after);
  });

  it('counts a 502 as lost', async () => {
    vi.useFakeTimers();
    const { server, doc } = open();
    const release = doc.hold();
    server.fail.push({
      error: () =>
        Object.assign(new Error('HTTP 502 Unable to read error response'), {
          status: 502,
          method: 'PATCH',
        }),
      landed: true,
    });
    doc.set('gloss', 'DOG');
    await vi.advanceTimersByTimeAsync(10);
    const after = server.reads;
    await vi.advanceTimersByTimeAsync(30000);
    expect(server.reads).toBe(after + 1);
    release();
  });
});

describe('a write to something another user deleted', () => {
  it('is a change elsewhere: the edits made on the same old reading are not sent', async () => {
    const { server, doc, errors } = open();
    server.fail.push({
      error: () =>
        Object.assign(
          new Error(
            'HTTP 403 User b@x.com lacks sufficient privileges to write the project this entity belongs to',
          ),
          { status: 403, method: 'PATCH' },
        ),
    });
    const first = doc.set('gloss', 'DOG');
    const behind = doc.set('pos', 'N');
    expect(await first).toBe(false);
    expect(await behind).toBe(false);
    expect(server.values).toEqual({});
    expect(errors.map((e) => e.err.status)).toEqual([403, 409]);
  });
});

describe('naming an edit in History', () => {
  it('labels the writes a screen queues inside `labelled`, and only those', async () => {
    const { server, doc } = open();
    const result = doc.labelled('Gloss of dogs in sentence 3: DOG', () => doc.set('gloss', 'DOG'));
    doc.set('pos', 'N');
    expect(await result).toBe(true);
    await flush();
    expect(server.labels).toEqual(['Gloss of dogs in sentence 3: DOG', 'Update pos']);
  });
});

// Luke's ruling Q2: a 409 whose changes in between touch nothing the edit
// writes is sent again, once, by itself (rebase.js).
describe('an edit refused because someone else wrote elsewhere in the document', () => {
  const words = [
    { id: 't1', begin: 0, end: 3 },
    { id: 't2', begin: 4, end: 7 },
    { id: 't3', begin: 8, end: 12 },
  ];
  // A server holding a document of the core's shape, with a version.
  const docServer = () => {
    const server = {
      spans: [],
      version: 1,
      writes: 0,
      raw() {
        return {
          id: 'd1',
          version: server.version,
          textLayers: [
            {
              id: 'tl',
              tokenLayers: [
                {
                  id: 'words',
                  tokens: structuredClone(words),
                  spanLayers: [{ id: 'gloss', spans: structuredClone(server.spans) }],
                },
              ],
            },
          ],
        };
      },
    };
    let seq = 0;
    const client = {
      strictModeDocumentId: 'd1',
      documentVersions: { d1: 1 },
      withOperation: async (label, fn) => fn(() => {}),
      documents: {
        get: async () => {
          client.documentVersions = { ...client.documentVersions, d1: server.version };
          return server.raw();
        },
      },
      addGloss: async (token, value) => {
        if (client.documentVersions.d1 !== server.version) {
          throw Object.assign(new Error('HTTP 409 Document version mismatch'), {
            status: 409,
            method: 'POST',
          });
        }
        server.writes += 1;
        server.spans.push({ id: `s${++seq}`, tokens: [token], value });
        server.version += 1;
        client.documentVersions = { ...client.documentVersions, d1: server.version };
      },
    };
    // Another user's gloss.
    server.elsewhere = (token, value) => {
      server.spans.push({ id: `x${++seq}`, tokens: [token], value });
      server.version += 1;
    };
    return { server, client };
  };

  class GlossDoc extends DocumentModel {
    gloss(token, value) {
      this._applyRawPatch((raw) => {
        raw.textLayers[0].tokenLayers[0].spanLayers[0].spans.push({
          id: `pending:${token}`,
          tokens: [token],
          value,
        });
      });
      return this._queueWrite('Failed to update Gloss', () => this._client.addGloss(token, value));
    }
  }

  const openGlossDoc = async () => {
    const { server, client } = docServer();
    const doc = new GlossDoc({ raw: server.raw(), client });
    const errors = [];
    doc.onError = (msg, err) => errors.push(err);
    return { server, client, doc, errors };
  };
  const valuesOn = (raw) =>
    Object.fromEntries(
      raw.textLayers[0].tokenLayers[0].spanLayers[0].spans.map((s) => [s.tokens[0], s.value]),
    );

  it('is sent again when the other write was on another word', async () => {
    const { server, doc, errors } = await openGlossDoc();
    server.elsewhere('t1', 'DEF');
    expect(await doc.gloss('t2', 'CANINE')).toBe(true);
    expect(errors).toEqual([]);
    expect(valuesOn(server.raw())).toEqual({ t1: 'DEF', t2: 'CANINE' });
    expect(valuesOn(doc.raw)).toEqual({ t1: 'DEF', t2: 'CANINE' });
  });

  it('sends the edits waiting behind it too', async () => {
    const { server, doc, errors } = await openGlossDoc();
    server.elsewhere('t1', 'DEF');
    const a = doc.gloss('t2', 'CANINE');
    const b = doc.gloss('t3', 'RUN');
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(errors).toEqual([]);
    expect(valuesOn(server.raw())).toEqual({ t1: 'DEF', t2: 'CANINE', t3: 'RUN' });
  });

  it('is refused and shown when the other write was on the same word', async () => {
    const { server, doc, errors } = await openGlossDoc();
    server.elsewhere('t2', 'HOUND');
    expect(await doc.gloss('t2', 'CANINE')).toBe(false);
    expect(errors.map((e) => e.status)).toEqual([409]);
    expect(valuesOn(server.raw())).toEqual({ t2: 'HOUND' });
    await flush();
    expect(valuesOn(doc.raw)).toEqual({ t2: 'HOUND' });
  });

  it('after a real conflict, still sends a waiting edit the conflict does not touch', async () => {
    const { server, doc, errors } = await openGlossDoc();
    server.elsewhere('t2', 'HOUND');
    const a = doc.gloss('t2', 'CANINE');
    const b = doc.gloss('t3', 'RUN');
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(errors.map((e) => e.status)).toEqual([409]);
    expect(valuesOn(server.raw())).toEqual({ t2: 'HOUND', t3: 'RUN' });
  });

  it('shows again what the edit put beside the document once it goes again', async () => {
    // What a subclass keeps beside the raw document (igt's vocabularies) is
    // replaced by the read after the refusal, so the edit is shown again on
    // top of that read, not under it.
    class BesideDoc extends GlossDoc {
      constructor(args) {
        super(args);
        this.beside = [];
      }
      _patchContext() {
        return [[...this.beside]];
      }
      _afterPatch(next, [beside]) {
        this.beside = beside;
      }
      async _adoptReload() {
        this.beside = [];
      }
      note(token, value) {
        this._applyRawPatch((raw, beside) => {
          raw.textLayers[0].tokenLayers[0].spanLayers[0].spans.push({
            id: `pending:${token}`,
            tokens: [token],
            value,
          });
          beside.push(value);
        });
        return this._queueWrite('Failed to update Gloss', () =>
          this._client.addGloss(token, value),
        );
      }
    }
    const { server, client } = docServer();
    const doc = new BesideDoc({ raw: server.raw(), client });
    server.elsewhere('t1', 'DEF');
    expect(await doc.note('t2', 'CANINE')).toBe(true);
    expect(valuesOn(server.raw())).toEqual({ t1: 'DEF', t2: 'CANINE' });
    expect(doc.beside).toEqual(['CANINE']);
  });

  it('goes again only once', async () => {
    const { server, client, doc, errors } = await openGlossDoc();
    server.elsewhere('t1', 'DEF');
    // Someone writes again between the read and the second try.
    const get = client.documents.get;
    client.documents.get = async () => {
      const raw = await get();
      server.elsewhere('t3', 'RUN');
      return raw;
    };
    expect(await doc.gloss('t2', 'CANINE')).toBe(false);
    expect(errors.map((e) => e.status)).toEqual([409]);
    expect(server.writes).toBe(0);
  });
});

// A cell that shows a lost conflict itself ("Yours: X · Enter to keep
// yours") must not get a second toast saying "Redo your edit".
describe('a write whose screen shows its conflict itself', () => {
  // Someone else stored a value on the same key first.
  const conflictOn = (server) => {
    server.values.gloss = 'HOUND';
    server.version += 1;
  };

  it('tells the screen nothing on a conflict, and keeps the refusal readable', async () => {
    const { server, doc, errors } = open();
    conflictOn(server);
    expect(await doc.handlesConflicts(() => doc.set('gloss', 'DOG'))).toBe(false);
    expect(errors).toEqual([]);
    expect(doc.error).toBe('');
    expect(doc.errorCause?.status).toBe(409);
  });

  it('still reports any other refusal', async () => {
    const { server, doc, errors } = open();
    server.fail.push({
      error: () => Object.assign(new Error('HTTP 500 boom'), { status: 500, method: 'PATCH' }),
    });
    expect(await doc.handlesConflicts(() => doc.set('gloss', 'DOG'))).toBe(false);
    expect(errors.map((e) => e.err.status)).toEqual([500]);
  });

  it('is only for the writes made inside it', async () => {
    const { server, doc, errors } = open();
    conflictOn(server);
    expect(await doc.set('gloss', 'DOG')).toBe(false);
    expect(errors.map((e) => e.err.status)).toEqual([409]);
    expect(doc.error).not.toBe('');
  });
});
