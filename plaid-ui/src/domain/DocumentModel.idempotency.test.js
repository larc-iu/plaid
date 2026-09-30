import { describe, it, expect } from 'vitest';
import { PlaidClient } from '../../../plaid-client-js/src/index.js';
import { DocumentModel } from './DocumentModel.js';
import { newId } from './pendingIds.js';

// A document's edits over the real client, against a fetch that answers as
// plaid-core does with Idempotency-Keys: a key whose request landed is
// answered from what it stored, and a create naming an id used before is
// refused 409 id-taken. (REV-idempotency F1, F3.)

function server() {
  const state = { rows: new Map(), stored: new Map(), writes: 0, lose: 0, keys: [] };
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
    // another key (its key's answer expired, or it was sent afresh).
    state.lose = 1;
    const stored = state.stored;
    state.stored = { has: () => false, get: () => undefined, set: () => {} };
    const { id, ok } = doc.create('N');
    expect(await ok).toBe(false);
    state.stored = stored;
    expect(state.rows.get(id)).toBe('N');
    expect(errors).toEqual([]);
    expect(await doc.set(id, 'V')).toBe(true);
    expect(state.rows.get(id)).toBe('V');
    expect(errors).toEqual([]);
  });
});
