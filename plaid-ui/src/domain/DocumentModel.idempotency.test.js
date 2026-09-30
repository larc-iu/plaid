import { describe, it, expect } from 'vitest';
import { PlaidClient } from '../../../plaid-client-js/src/index.js';
import { DocumentModel } from './DocumentModel.js';
import { isPendingId, newId } from './pendingIds.js';

// A document's edits over the real client, against a fetch that answers as
// plaid-core does with Idempotency-Keys: a key whose request landed is
// answered from what it stored, and a create naming an id used before is
// refused 409 id-taken. (REV-idempotency F1, F3.)

function server() {
  const state = {
    rows: new Map(),
    stored: new Map(),
    writes: 0,
    lose: 0,
    keys: [],
    // A proxy's answer to the next `gateway` sends, without the core seeing
    // them. The first of them is kept in `held`, to land late (`landHeld`).
    gateway: 0,
    held: null,
  };
  const answer = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const key = opts.headers?.['Idempotency-Key'];
    if (opts.method === 'GET') {
      return answer(200, { id: 'd1', rows: [...state.rows].map(([id, value]) => ({ id, value })) });
    }
    state.keys.push(key);
    if (key && state.stored.has(key)) return answer(...state.stored.get(key));
    if (state.gateway > 0) {
      state.gateway -= 1;
      state.held ??= { url, opts: { ...opts } };
      return answer(502, { error: 'Bad gateway' });
    }
    const body = JSON.parse(opts.body);
    let result;
    if (opts.method === 'POST') {
      if (state.rows.has(body.id)) {
        return answer(409, { error: 'id-taken', 'id-taken': true, id: body.id });
      }
      state.rows.set(body.id, body.value);
      result = [201, { id: body.id }];
    } else {
      const id = u.pathname.split('/').at(-1);
      state.rows.set(id, body.value);
      result = [200, {}];
    }
    state.writes += 1;
    if (key) state.stored.set(key, result);
    if (state.lose > 0) {
      state.lose -= 1;
      throw new TypeError('Failed to fetch');
    }
    return answer(...result);
  };
  // The held request reaches the core now and is stored under its key.
  state.landHeld = async () => {
    const { url, opts } = state.held;
    state.held = null;
    await globalThis.fetch(url, opts);
  };
  return state;
}

class Doc extends DocumentModel {
  // `settle: false` is a send that leaves its row's id as the page minted it.
  create(value, { settle = true } = {}) {
    const id = newId();
    this._applyRawPatch((raw) => {
      raw.rows = [...raw.rows, { id, value }];
    });
    const ok = this._queueWrite('Failed to create', async () => {
      const made = await this._client._request('POST', '/api/v1/spans', { body: { id, value } });
      if (settle) this._settle(new Map([[id, made.id]]));
    });
    return { id, ok };
  }

  set(id, value) {
    this._applyRawPatch((raw) => {
      raw.rows = raw.rows.map((r) => (r.id === id ? { ...r, value } : r));
    });
    return this._queueWrite('Failed to update', () =>
      this._client._request('PATCH', `/api/v1/spans/${id}`, { body: { value } }),
    );
  }
}

const open = () => {
  const state = server();
  const client = new PlaidClient('http://x', 'tok', { retryDelaysMs: [] });
  const doc = new Doc({ raw: { id: 'd1', rows: [] }, client });
  doc._writes._retryDelay = () => 0;
  doc._fetch = async () => client.documents.get('d1');
  const errors = [];
  doc.onError = (msg) => errors.push(msg);
  return { state, client, doc, errors };
};

describe('an edit queued inside another open operation', () => {
  it('is sent again under its own keys after a lost answer, and lands once', async () => {
    const { state, client, doc, errors } = open();
    state.lose = 1;
    let result;
    await client.withOperation('Link to the lexicon', async () => {
      result = doc.create('N');
      await result.ok;
    });
    expect(await result.ok).toBe(true);
    expect(state.writes).toBe(1);
    expect(state.keys[0]).toBe(state.keys[1]);
    expect(errors).toEqual([]);
  });
});

describe('a create that landed and is then refused id-taken', () => {
  it('counts as made: the row is there, and a later edit of it is sent', async () => {
    const { state, doc, errors } = open();
    // The create lands with its answer lost, and the resend goes under
    // another key (its key's answer expired, or it was sent afresh). The
    // client answers the id-taken for the id this edit minted as made.
    state.lose = 1;
    const stored = state.stored;
    state.stored = { has: () => false, get: () => undefined, set: () => {} };
    const { id, ok } = doc.create('N');
    expect(await ok).toBe(true);
    state.stored = stored;
    expect(state.rows.get(id)).toBe('N');
    expect(errors).toEqual([]);
    expect(await doc.set(id, 'V')).toBe(true);
    expect(state.rows.get(id)).toBe('V');
    expect(errors).toEqual([]);
  });
});

// REV3 (the ruling after the third review): no send is given up while the
// page is open. A proxy's 502 on every attempt keeps the edit saving, the
// edits made meanwhile queue behind it, and once the server answers they all
// land in order under their own keys, each once.
describe('edits made while a proxy answers 502', () => {
  it('stay saving, and land in order once the server answers', async () => {
    const { state, client, doc, errors } = open();
    doc._writes._retryDelay = () => 5;
    state.gateway = 1000;
    const a = doc.create('A');
    const b = doc.create('B');
    const c = doc.create('C');
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(doc.isSaving).toBe(true);
    expect(doc.isOffline).toBe(true);
    expect(state.rows.size).toBe(0);
    state.gateway = 0;
    expect(await a.ok).toBe(true);
    expect(await b.ok).toBe(true);
    expect(await c.ok).toBe(true);
    expect([...state.rows.values()]).toEqual(['A', 'B', 'C']);
    expect(errors).toEqual([]);
    expect(doc.isOffline).toBe(false);
    expect(client.operationGroup).toBe(null);
  });

  it('a create whose first send lands late is answered from its key, and made once', async () => {
    const { state, doc, errors } = open();
    doc._writes._retryDelay = () => 5;
    state.gateway = 1000;
    const first = doc.create('dog');
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5));
    state.gateway = 0;
    await state.landHeld();
    expect(await first.ok).toBe(true);
    expect([...state.rows.values()]).toEqual(['dog']);
    expect(errors).toEqual([]);
  });
});

// REV4 J1 (s1_letgo): the person leaves the document's screen while its edits
// are being sent again through a 502 run. The page is open, so they keep
// going under their keys and land once the server answers, and the document
// stays saving until then.
describe('edits being sent again when the screen lets the document go', () => {
  it('keep going, and land once the server answers', async () => {
    const { state, doc, errors } = open();
    doc._writes._retryDelay = () => 5;
    const release = doc.hold();
    state.gateway = 1000;
    const a = doc.create('A');
    const b = doc.create('B');
    const c = doc.create('C');
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 5));
    release();
    const settled = [];
    for (const x of [a, b, c]) x.ok.then((v) => settled.push(v));
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(settled).toEqual([]);
    expect(doc.isSaving).toBe(true);
    expect(errors).toEqual([]);
    state.gateway = 0;
    expect([await a.ok, await b.ok, await c.ok]).toEqual([true, true, true]);
    expect([...state.rows.values()]).toEqual(['A', 'B', 'C']);
    expect(errors).toEqual([]);
    expect(doc.isSaving).toBe(false);
  });
});

// REV2 G3: an id-taken inside a batch takes the whole batch back, so the
// rest of the edit is not stored. The row is made (settled), and the edit is
// reported, never passed over in silence.
describe('an edit whose batch is refused id-taken for a row it made', () => {
  it('settles the row and reports the edit', async () => {
    const { state, doc, errors } = open();
    const id = newId();
    state.rows.set(id, 'N');
    doc._applyRawPatch((raw) => {
      raw.rows = [...raw.rows, { id, value: 'N' }];
    });
    const ok = await doc._queueWrite('Failed to gloss', async () => {
      throw Object.assign(new Error('HTTP 409 id-taken'), {
        status: 409,
        method: 'POST',
        responseData: { error: 'id-taken', 'id-taken': true, id },
      });
    });
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(await doc.set(id, 'V')).toBe(true);
    expect(state.rows.get(id)).toBe('V');
  });
});

describe('an edit whose batch is refused id-taken for a row deleted since', () => {
  it('does not take the row for made', async () => {
    const { doc, errors } = open();
    const id = newId();
    doc._applyRawPatch((raw) => {
      raw.rows = [...raw.rows, { id, value: 'N' }];
    });
    const ok = await doc._queueWrite('Failed to gloss', async () => {
      throw Object.assign(new Error('HTTP 409 id-taken'), {
        status: 409,
        method: 'POST',
        responseData: { error: 'id-taken', 'id-taken': true, id, deleted: true },
      });
    });
    expect(ok).toBe(false);
    expect(errors).toHaveLength(1);
    expect(isPendingId(id)).toBe(true);
  });
});
