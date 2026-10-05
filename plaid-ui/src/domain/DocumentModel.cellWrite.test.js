import { describe, it, expect } from 'vitest';
import { DocumentModel } from './DocumentModel.js';

// `cellWrite`: a grid cell's write, and what became of it, for the cell
// engine (cells/CellEngine.js). The outcome is the write's own, read from its
// own refusal, never from whatever the document's last error happens to be.

// A server with one value per key and a version. A strict write stamped with
// an old version is refused 409, as plaid-core does. `fail` holds errors the
// next writes throw instead.
function fakeServer() {
  const server = { values: {}, version: 1, fail: [], failOn: {} };
  const client = {
    strictModeDocumentId: 'd1',
    documentVersions: { d1: 1 },
    withOperation: async (_label, fn) => fn(() => {}),
    documents: {
      get: async () => {
        client.documentVersions = { ...client.documentVersions, d1: server.version };
        return { id: 'd1', values: { ...server.values } };
      },
    },
    write: async (key, value) => {
      const stamp = client.documentVersions.d1;
      const failure = server.failOn[key] ?? server.fail.shift();
      if (failure) throw failure();
      if (stamp !== server.version) {
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
  return { server, doc, errors };
};

const failing = (status) => () =>
  Object.assign(new Error(`HTTP ${status} boom`), { status, method: 'PATCH' });

describe('cellWrite', () => {
  it('answers landed with what the write answered', async () => {
    const { server, doc } = open();
    expect(await doc.cellWrite(() => doc.set('gloss', 'DOG'))).toEqual({
      landed: true,
      value: true,
    });
    expect(server.values.gloss).toBe('DOG');
  });

  it('answers a conflict with its status, and the document tells the screen nothing', async () => {
    const { server, doc, errors } = open();
    server.values.gloss = 'HOUND';
    server.version += 1;
    const outcome = await doc.cellWrite(() => doc.set('gloss', 'DOG'), { engine: true });
    expect(outcome).toMatchObject({ landed: false, status: 409, readBack: true });
    expect(outcome.error.status).toBe(409);
    expect(errors).toEqual([]);
    expect(doc.error).toBe('');
    expect(doc.errorCause?.status).toBe(409);
    // The refetch after the refusal has landed: the document holds theirs.
    expect(doc.raw.values.gloss).toBe('HOUND');
  });

  it('answers another refusal with its status, which the document still reports', async () => {
    const { server, doc, errors } = open();
    server.fail.push(failing(500));
    const outcome = await doc.cellWrite(() => doc.set('gloss', 'DOG'));
    expect(outcome).toMatchObject({ landed: false, status: 500 });
    expect(errors.map((e) => e.err.status)).toEqual([500]);
  });

  // REV4 J1: letting the document go stops refetches only.
  it('sends a write whose answer was lost again after no screen waits for it, until it lands', async () => {
    const { server, doc } = open();
    doc._writes._retryDelay = () => 0;
    server.fail.push(failing(502), failing(502));
    const release = doc.hold();
    const pending = doc.cellWrite(() => doc.set('gloss', 'DOG'));
    await new Promise((r) => setTimeout(r, 0));
    release();
    expect(await pending).toEqual({ landed: true, value: true });
    expect(server.values.gloss).toBe('DOG');
  });

  it('sends a write whose answer was lost again until it is answered', async () => {
    const { server, doc } = open();
    doc._writes._retryDelay = () => 0;
    server.fail.push(failing(502));
    expect(await doc.cellWrite(() => doc.set('gloss', 'DOG'))).toEqual({
      landed: true,
      value: true,
    });
  });

  it('says when what the document holds may not be what the server holds', async () => {
    const { server, doc } = open();
    Object.defineProperty(doc, 'outOfStep', { get: () => true });
    server.fail.push(failing(500));
    expect((await doc.cellWrite(() => doc.set('gloss', 'DOG'))).readBack).toBe(false);
  });

  it("answers each write's own outcome, not a later write's", async () => {
    const { server, doc } = open();
    server.failOn.pos = failing(500);
    const first = doc.cellWrite(() => doc.set('gloss', 'DOG'));
    const second = doc.cellWrite(() => doc.set('pos', 'N'));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ landed: true, value: true });
    expect(b).toMatchObject({ landed: false, status: 500 });
    // And the other way round: a refused first write, a landed second.
    delete server.failOn.pos;
    server.failOn.gloss = failing(500);
    const third = doc.cellWrite(() => doc.set('gloss', 'CAT'));
    const fourth = doc.cellWrite(() => doc.set('pos', 'V'));
    expect((await third).landed).toBe(false);
    expect((await fourth).landed).toBe(true);
  });

  it('answers a write refused before it went out (a past state) as not landed', async () => {
    const { client } = fakeServer();
    const doc = new Doc({ raw: { id: 'd1', values: {} }, client, asOf: '2026-01-01T00:00:00Z' });
    doc.onError = () => {};
    const outcome = await doc.cellWrite(() => doc.set('gloss', 'DOG'));
    expect(outcome).toMatchObject({ landed: false, status: null, error: null });
  });

  it('leaves writes made outside it as they were', async () => {
    const { server, doc, errors } = open();
    server.values.gloss = 'HOUND';
    server.version += 1;
    expect(await doc.set('gloss', 'DOG')).toBe(false);
    expect(errors.map((e) => e.err.status)).toEqual([409]);
  });

  // L2-IGT-MULTI-3: a cell shows a refusal for a row deleted meanwhile as a
  // conflict (its note, and the toast naming who cleared it). The document
  // says nothing of its own, neither a second toast nor a banner.
  const gone = () =>
    Object.assign(new Error('HTTP 403 lacks sufficient privileges'), {
      status: 403,
      method: 'PATCH',
      responseData: { unresolved: true },
    });

  it('answers a refusal for a deleted row as it answers a conflict, when an engine settles it', async () => {
    const { server, doc, errors } = open();
    server.fail.push(gone);
    const outcome = await doc.cellWrite(() => doc.set('gloss', 'DOG'), { engine: true });
    expect(outcome).toMatchObject({ landed: false, status: 403, readBack: true });
    expect(errors).toEqual([]);
    expect(doc.error).toBe('');
    expect(doc.errorCause?.status).toBe(403);
  });

  // REV-R4-IGT R4-2: ud's feature box writes through cellWrite with no cell
  // engine behind it. Nobody else says the value was not saved.
  it('reports a refusal for a deleted row, or a conflict, itself when no engine settles it', async () => {
    const { server, doc, errors } = open();
    server.fail.push(gone);
    const outcome = await doc.cellWrite(() => doc.set('gloss', 'DOG'));
    expect(outcome).toMatchObject({ landed: false, status: 403 });
    server.values.pos = 'V';
    server.version += 1;
    await doc.cellWrite(() => doc.set('pos', 'N'));
    expect(errors.map((e) => e.err.status)).toEqual([403, 409]);
  });

  it('answers when the document the edit was made on was last changed', async () => {
    const { server, doc } = open();
    doc._raw = { ...doc._raw, timeModified: '2026-10-05T01:00:00Z' };
    server.fail.push(failing(500));
    expect((await doc.cellWrite(() => doc.set('gloss', 'DOG'))).since).toBe('2026-10-05T01:00:00Z');
  });

  // L2-IGT-MULTI-3: igt's grid draws the banner with its data, so the next
  // save that clears an error moves the data version, and the banner goes.
  it('moves the data version when the next save clears an error', async () => {
    const { server, doc } = open();
    server.fail.push(failing(500));
    await doc.set('gloss', 'DOG');
    expect(doc.error).not.toBe('');
    const before = doc.dataVersion;
    const saving = doc.set('pos', 'N');
    // The optimistic patch is drawn first, with the error still set. The
    // clear that follows when the save starts moves the version again.
    expect(doc.error).toBe('');
    expect(doc.dataVersion).toBeGreaterThan(before + 1);
    await saving;
  });
});
