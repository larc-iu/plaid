import { describe, it, expect } from 'vitest';
import { PlaidClient } from '../../../plaid-client-js/src/index.js';
import { DocumentModel } from './DocumentModel.js';
import { newId } from './pendingIds.js';

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
  create(value) {
    const id = newId();
    this._applyRawPatch((raw) => {
      raw.rows = [...raw.rows, { id, value }];
    });
    const ok = this._queueWrite('Failed to create', async () => {
      const made = await this._client._request('POST', '/api/v1/spans', { body: { id, value } });
      this._settle(new Map([[id, made.id]]));
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

// REV2 G1, G6: the queue gives a send up only on a proxy's 502 or 504, after
// its resend window. The edit keeps its keys and ids, and the next edit sends
// it again first: when it landed late it is answered from its key, and the
// edit planned without it (a create of the same row) is refused as a conflict
// rather than making a second row.
describe('an edit given up on a 502 that then lands late', () => {
  it('is sent again under its keys before the next edit, and the row is made once', async () => {
    const { state, doc, errors } = open();
    doc._writes._resendForMs = 0;
    state.gateway = 1;
    const first = doc.create('dog');
    expect(await first.ok).toBe(false);
    expect(errors).toHaveLength(1);
    await state.landHeld();
    expect(state.rows.size).toBe(1);
    // The page's retry: the same value again, planned as a new create.
    const retry = doc.create('dog');
    expect(await retry.ok).toBe(false);
    expect([...state.rows.values()]).toEqual(['dog']);
    expect(doc.raw.rows.map((r) => r.value)).toEqual(['dog']);
    expect(state.keys.filter((k) => k === state.keys[0]).length).toBeGreaterThan(1);
  });

  it('a connection refused is resent past the window until the server answers', async () => {
    const { state, doc, errors } = open();
    doc._writes._resendForMs = 0;
    state.lose = 0;
    let refusals = 3;
    const real = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      if (opts.method !== 'GET' && refusals > 0) {
        refusals -= 1;
        throw new TypeError('fetch failed: connect ECONNREFUSED');
      }
      return real(url, opts);
    };
    const { ok } = doc.create('dog');
    expect(await ok).toBe(true);
    expect(errors).toEqual([]);
    expect(state.rows.size).toBe(1);
  });
});

// REV2 G2: a row that lands after the read that followed its refusal, and
// comes back on another read, is made: the next edit of it is sent.
describe('a given-up create that comes back on a later read', () => {
  it('is settled by that read, and an edit of it is sent', async () => {
    const { state, doc, errors } = open();
    doc._writes._resendForMs = 0;
    state.gateway = 1;
    const { id, ok } = doc.create('dog');
    expect(await ok).toBe(false);
    await state.landHeld();
    await doc.reload();
    expect(doc.raw.rows.map((r) => r.id)).toEqual([id]);
    expect(await doc.set(id, 'hound')).toBe(true);
    expect(state.rows.get(id)).toBe('hound');
    expect(errors).toHaveLength(1);
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
