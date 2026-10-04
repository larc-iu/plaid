import { describe, it, expect, vi, afterEach } from 'vitest';
import { DocumentModel, LOCKED_WAITING } from './DocumentModel.js';

// A document's writes on a bad network and against other people's edits
// (the concurrency campaign of 2026-09-29): a write that never left the
// browser goes again when the network is back (H5-4), a write whose answer
// was lost is sent again under the same Idempotency-Keys until it is
// answered, and lands once (idempotent writes, 2026-09-30), a write to
// something another user deleted is a change elsewhere (D3), and a screen can
// name what an edit changed in History (D14).

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

// A server with one value per key and a version. A strict write stamped with
// an old version is refused 409, as plaid-core does. A write carries the
// Idempotency-Key the client gives the nth write of an operation opened with
// a key seed (`<seed>.<n>`), with the version its first attempt claimed, and
// one whose key landed before is answered from it and writes nothing.
function fakeServer() {
  const server = {
    values: {},
    version: 1,
    reads: 0,
    labels: [],
    fail: [],
    keys: [],
    groups: [],
    stored: new Map(),
    writes: 0,
  };
  let seeds = 0;
  // The open operation's key frames, nesting as the client's do: an inner
  // operation that brings its own seed numbers its writes until it ends.
  const frames = [];
  let open = null;
  const client = {
    strictModeDocumentId: 'd1',
    documentVersions: { d1: 1 },
    keySeed: () => ({ seed: `seed${++seeds}`, stamps: new Map() }),
    withOperation: async (label, fn, { id, keys } = {}) => {
      const outermost = frames.length === 0;
      if (outermost) {
        server.labels.push(label);
        server.groups.push(id);
      }
      const frame = outermost || keys ? { keys, n: 0 } : frames.at(-1);
      frames.push(frame);
      open = frame;
      try {
        return await fn(() => {});
      } finally {
        frames.pop();
        open = frames.at(-1) ?? null;
      }
    },
    documents: {
      get: async () => {
        server.reads += 1;
        client.documentVersions = { ...client.documentVersions, d1: server.version };
        return { id: 'd1', values: { ...server.values } };
      },
    },
    write: async (key, value) => {
      let stamp = client.strictModeDocumentId === 'd1' ? client.documentVersions.d1 : null;
      let idem = null;
      if (open?.keys) {
        const n = open.n++;
        idem = `${open.keys.seed}.${n}`;
        if (open.keys.stamps.has(n)) stamp = open.keys.stamps.get(n);
        else open.keys.stamps.set(n, stamp);
      }
      server.keys.push(idem);
      if (idem && server.stored.has(idem)) {
        const version = server.stored.get(idem);
        const held = client.documentVersions.d1;
        client.documentVersions = { ...client.documentVersions, d1: Math.max(held, version) };
        return;
      }
      const failure = server.fail.shift();
      if (failure) {
        if (failure.landed) {
          server.values[key] = value;
          server.version += 1;
          server.writes += 1;
          if (idem) server.stored.set(idem, server.version);
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
      server.writes += 1;
      if (idem) server.stored.set(idem, server.version);
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

  // REV-F-NET D-6: the resend was refused as a conflict with the edit's own
  // write, and the page said "Changed elsewhere. Redo your edit." about an
  // edit that was saved. Now the resend carries the first send's key and is
  // answered from it.
  it('is not sent twice when it did land after all, and counts as saved', async () => {
    const { server, doc, errors } = open();
    doc._writes._retryDelay = () => 0;
    server.fail.push({ error: offline, landed: true });
    const saved = doc.set('gloss', 'DOG');
    expect(await saved).toBe(true);
    await flush();
    expect(server.version).toBe(2);
    expect(server.writes).toBe(1);
    expect(server.keys[0]).toBe(server.keys[1]);
    expect(errors).toEqual([]);
    expect(doc.raw.values).toEqual({ gloss: 'DOG' });
    expect(doc.isSaving).toBe(false);
  });

  it('is still refused when the read after the refusal holds something else there', async () => {
    const { server, doc, errors } = open();
    doc._writes._retryDelay = () => 60000;
    server.fail.push({ error: offline });
    const saved = doc.set('gloss', 'DOG');
    await flush();
    // Another user's value lands while this browser is offline.
    server.values.gloss = 'CAT';
    server.version += 1;
    window.dispatchEvent(new Event('online'));
    expect(await saved).toBe(false);
    await flush();
    expect(errors.map((e) => e.err.status)).toEqual([409]);
    expect(doc.raw.values).toEqual({ gloss: 'CAT' });
  });

  it('is sent again outside strict mode too, since its key makes a resend safe', async () => {
    const { server, client, doc, errors } = open();
    client.strictModeDocumentId = null;
    doc._writes._retryDelay = () => 0;
    server.fail.push({ error: offline, landed: true });
    expect(await doc.set('gloss', 'DOG')).toBe(true);
    expect(server.writes).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe('a write whose answer was lost', () => {
  for (const [what, error] of [
    ['no response', lost],
    [
      'a 502',
      () =>
        Object.assign(new Error('HTTP 502 Unable to read error response'), {
          status: 502,
          method: 'PATCH',
        }),
    ],
    [
      'a 504',
      () => Object.assign(new Error('HTTP 504 Gateway timeout'), { status: 504, method: 'PATCH' }),
    ],
  ]) {
    it(`(${what}) stays saving, is sent again under the same keys, and lands once`, async () => {
      const { server, doc, errors } = open();
      doc._writes._retryDelay = () => 60000;
      server.fail.push({ error, landed: true });
      const saved = doc.set('gloss', 'DOG');
      await flush();
      expect(doc.isSaving).toBe(true);
      expect(doc.isOffline).toBe(true);
      window.dispatchEvent(new Event('online'));
      expect(await saved).toBe(true);
      expect(server.writes).toBe(1);
      expect(server.keys).toHaveLength(2);
      expect(server.keys[0]).toBe(server.keys[1]);
      expect(errors).toEqual([]);
      expect(doc.raw.values).toEqual({ gloss: 'DOG' });
    });
  }

  it('one that never landed is sent again on the version its first attempt claimed, and lands', async () => {
    const { server, doc, errors } = open();
    doc._writes._retryDelay = () => 0;
    server.fail.push({ error: lost });
    expect(await doc.set('gloss', 'DOG')).toBe(true);
    expect(server.writes).toBe(1);
    expect(errors).toEqual([]);
    expect(server.values).toEqual({ gloss: 'DOG' });
  });

  it('queued inside another open operation, it is sent again under its own keys, and lands once', async () => {
    const { server, client, doc, errors } = open();
    doc._writes._retryDelay = () => 0;
    server.fail.push({ error: lost, landed: true });
    await client.withOperation('Link to the lexicon', async () => {
      expect(await doc.set('gloss', 'DOG')).toBe(true);
    });
    expect(server.writes).toBe(1);
    expect(server.keys[0]).toBe(server.keys[1]);
    expect(server.keys[0]).toMatch(/^seed\d+\.0$/);
    expect(errors).toEqual([]);
  });

  it('every attempt of one edit joins the same operation, and the next edit its own', async () => {
    const { server, doc } = open();
    doc._writes._retryDelay = () => 0;
    server.fail.push({ error: lost, landed: true });
    await doc.set('gloss', 'DOG');
    await doc.set('pos', 'N');
    expect(server.groups[0]).toBe(server.groups[1]);
    expect(server.groups[2]).not.toBe(server.groups[0]);
    expect(server.keys[2]).not.toBe(server.keys[0]);
  });

  // REV4 J1: letting the document go stops refetches only.
  it('once no screen shows the document it is still sent again, under its keys, until it lands', async () => {
    const { server, doc, errors } = open();
    doc._writes._retryDelay = () => 5;
    const release = doc.hold();
    server.fail.push({ error: lost }, { error: lost }, { error: lost });
    const saved = doc.set('gloss', 'DOG');
    await flush();
    release();
    expect(await saved).toBe(true);
    expect(server.keys).toHaveLength(4);
    expect(new Set(server.keys).size).toBe(1);
    expect(server.values).toEqual({ gloss: 'DOG' });
    expect(errors).toEqual([]);
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
      // A gloss, opted in to the rule by entity as igt's are.
      return this.resendsByEntity(() =>
        this._queueWrite('Failed to update Gloss', () => this._client.addGloss(token, value)),
      );
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
        return this.resendsByEntity(() =>
          this._queueWrite('Failed to update Gloss', () => this._client.addGloss(token, value)),
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

// H35-CORE: a write refused 423 while someone else held the document's lock
// left the banner "Try again in a moment" up after the lock was gone, and its
// cell unsent until the person pressed Enter on it again.
describe('a write refused for another lock', () => {
  const locked = () =>
    Object.assign(new Error('HTTP 423 Document d1 is locked by b@x.com'), {
      status: 423,
      method: 'PATCH',
    });

  it('waits, saying so, and is sent once the lock is gone, with the edits behind it', async () => {
    const { server, doc, errors } = open();
    doc._writes._retryDelay = () => 5;
    // Held until the lock goes, however long the wait.
    for (let i = 0; i < 10000; i++) server.fail.push({ error: locked });
    const saved = doc.set('gloss', 'DOG');
    const later = doc.set('pos', 'N');
    const shown = doc.dataVersion;
    await flush();
    expect(doc.isLocked).toBe(true);
    // A screen that draws the error with its data (igt's grid) draws again.
    expect(doc.dataVersion).toBeGreaterThan(shown);
    const waiting = doc.dataVersion;
    expect(doc.isOffline).toBe(false);
    expect(doc.error).toBe(LOCKED_WAITING);
    expect(doc.raw.values).toEqual({ gloss: 'DOG', pos: 'N' });
    server.fail.length = 0;
    expect(await saved).toBe(true);
    expect(await later).toBe(true);
    expect(server.values).toEqual({ gloss: 'DOG', pos: 'N' });
    expect(server.writes).toBe(2);
    expect(errors).toEqual([]);
    expect(doc.isLocked).toBe(false);
    expect(doc.error).toBe('');
    expect(doc.dataVersion).toBeGreaterThan(waiting);
  });

  it("is refused as before when the page's own lock lapsed", async () => {
    const { server, doc, errors } = open();
    doc._writes._retryDelay = () => 0;
    server.fail.push({
      error: () =>
        Object.assign(new Error('The lock on document d1 lapsed'), {
          name: 'DocumentLockLost',
          status: 423,
        }),
    });
    expect(await doc.set('gloss', 'DOG')).toBe(false);
    expect(errors).toHaveLength(1);
    expect(doc.isLocked).toBe(false);
  });
});
